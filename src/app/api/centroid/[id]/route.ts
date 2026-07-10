import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { mastTapQueryUrl, resolveSegmentDownloadUrl, deriveTessTpfUrl } from '@/lib/externalEndpoints'
import { readTpf } from '@/lib/tpfReader'
import {
  runCentroidVet,
  isSaturatedMag,
  type CentroidQuarterInput,
  type CentroidVetResult,
} from '@/lib/centroidVet'

/**
 * @description GET /api/centroid/[id] — on-demand, per-star pixel-level
 * centroid vetting. Downloads a handful of the star's Kepler Target Pixel
 * File quarters from MAST, stacks in-transit vs out-of-transit pixel
 * stamps at the caller-supplied ephemeris, and returns the
 * difference-image centroid offset measurement (see `lib/centroidVet.ts`
 * for the method and its calibration).
 *
 * STRICTLY on-demand:
 * - Never called by the batch classifier or on ordinary selection — only
 *   from the explicit opt-in button in the fullscreen light-curve overlay.
 * - `KIC{N}` ids → Kepler quarters (obscore-listed `_lpd-targ.fits.gz`).
 * - `TIC{N}` ids → TESS sectors. MAST's obscore does NOT list TESS
 *   `_tp.fits` products, so the URLs are DERIVED from the listed
 *   `-s_lc.fits` rows via `deriveTessTpfUrl` — the naming-pattern
 *   contract monitored by external-health check 6. TESS results are
 *   UNVALIDATED (no public per-TOI centroid ground truth) and the UI
 *   labels them qualitative.
 *
 * Query params (all required, from the confident BLS detection):
 * - `period`   — signal period in days.
 * - `epoch`    — mid-transit epoch in BKJD/TJD (the TPF TIME system).
 * - `duration` — box duration in hours.
 *
 * Saturation refusal: the authoritative magnitude comes from the FIRST
 * downloaded segment's primary header (KEPMAG / TESSMAG), not from the
 * catalog (merged KOI/TOI entries carry defaults, not the real value).
 * A saturated target is refused after that single download — the
 * remaining segments are never fetched.
 */

/** @description How many Kepler TPF quarters to fetch, spread evenly across the mission. */
const TPF_QUARTERS_TO_FETCH = 6

/**
 * @description How many TESS sectors to fetch. Lower than Kepler's 6
 * because a TESS 2-min sector TPF is ~47 MB (vs 1–7 MB per Kepler
 * quarter): 4 sectors ≈ 190 MB keeps the on-demand download bounded
 * while staying above the 3-segment error-bar minimum. Targets with
 * fewer observed sectors just use what exists.
 */
const TESS_SECTORS_TO_FETCH = 4

/**
 * @description Max simultaneous TPF downloads. Same rationale as the
 * lightcurve route's bounded pool (archive.stsci.edu drops connections
 * under large bursts), sized lower because TPF quarters are ~10× bigger
 * than lightcurve quarters.
 */
const TPF_DOWNLOAD_CONCURRENCY = 3

/** @description Per-file download timeout. TPF quarters run 1–7 MB. */
const TPF_FETCH_TIMEOUT_MS = 120000

/**
 * @description Schema version for centroid disk-cache entries. Bump on any
 * change to the fetch pipeline, the TPF parser, or the centroid engine
 * that can alter the result — same provenance lesson as the lightcurve
 * route's CACHE_SCHEMA_VERSION.
 *
 * v1 → v2 (phase 2): offsets are now measured against the target's
 * CATALOG POSITION through each segment's WCS (was: moment photocenter
 * at a fixed pixel scale — subject to a ~1–2″ crowding bias, see
 * centroidVet.ts calibration notes). Every v1 entry is invalid.
 */
const CENTROID_CACHE_SCHEMA_VERSION = 2

/**
 * @description Disk-cache TTL. TPF pixel data is static; the entry only
 * goes stale if our pipeline changes (schema version) or the caller's
 * ephemeris changes (input tolerance check below).
 */
const CENTROID_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** @description Relative period tolerance for serving a cached result. */
const CACHE_PERIOD_REL_TOL = 1e-3

/** @description Epoch tolerance (days) for serving a cached result. */
const CACHE_EPOCH_TOL_DAYS = 0.1

/** @description Relative duration tolerance for serving a cached result. */
const CACHE_DURATION_REL_TOL = 0.25

/** @description Directory under OS temp where results are cached (shared cache root). */
const DISK_CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')

/**
 * @description Provenance block per mission, returned with every
 * successful measurement.
 * @param mission Which mission served the pixel data.
 * @returns Provenance labels for the UI citation line.
 */
function centroidProvenance(mission: 'Kepler' | 'TESS') {
  return {
    sourceName: `NASA/MAST ${mission} Target Pixel Files`,
    mission,
    dataType:
      mission === 'Kepler'
        ? 'Per-quarter pixel stamps (difference-image centroid)'
        : 'Per-sector pixel stamps (difference-image centroid, unvalidated)',
  }
}

/** @description Ephemeris inputs the measurement ran against. */
interface CentroidInputs {
  periodDays: number
  epochDays: number
  durationHours: number
}

/** @description Disk-cache entry: metadata first, then the result payload. */
interface CentroidCacheEntry {
  schemaVersion: number
  fetchedAt: string
  inputs: CentroidInputs
  result: CentroidVetResult
}

/**
 * @description Cache file path for a star id (sanitized).
 * @param id Catalog id (e.g. "KIC5991936").
 * @returns Absolute cache file path.
 */
function cachePath(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_')
  return path.join(DISK_CACHE_DIR, `centroid-${safe}.json`)
}

/**
 * @description Reads a cached measurement if it matches the current schema
 * version AND the requested ephemeris within tolerance. A BLS re-run can
 * shift period/epoch slightly without changing the physical answer; a
 * larger shift means the measurement windows moved and the cached stacks
 * no longer describe the requested signal.
 * @param id Star id.
 * @param inputs Requested ephemeris.
 * @param tag Log prefix.
 * @returns Cached result, or null on miss.
 */
async function readCache(id: string, inputs: CentroidInputs, tag: string): Promise<CentroidVetResult | null> {
  const file = cachePath(id)
  try {
    const stat = await fs.stat(file)
    if (Date.now() - stat.mtimeMs > CENTROID_CACHE_TTL_MS) return null
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<CentroidCacheEntry>
    if (parsed.schemaVersion !== CENTROID_CACHE_SCHEMA_VERSION || !parsed.result || !parsed.inputs) {
      console.error(`${tag} cache for ${id} has schema v${parsed.schemaVersion ?? '<none>'} ≠ v${CENTROID_CACHE_SCHEMA_VERSION}; ignoring`)
      return null
    }
    const c = parsed.inputs
    const periodOk = Math.abs(c.periodDays - inputs.periodDays) / inputs.periodDays <= CACHE_PERIOD_REL_TOL
    const epochOk = Math.abs(c.epochDays - inputs.epochDays) <= CACHE_EPOCH_TOL_DAYS
    const durationOk =
      Math.abs(c.durationHours - inputs.durationHours) / inputs.durationHours <= CACHE_DURATION_REL_TOL
    if (!periodOk || !epochOk || !durationOk) {
      console.error(`${tag} cache for ${id} was computed at a different ephemeris; ignoring (will remeasure)`)
      return null
    }
    console.error(`${tag} disk cache HIT for ${id} (fetchedAt ${parsed.fetchedAt})`)
    return parsed.result
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${tag} cache read error for ${id}:`, e)
    }
    return null
  }
}

/**
 * @description Writes a measurement to the disk cache (atomic temp+rename).
 * @param id Star id.
 * @param inputs Ephemeris the measurement ran against.
 * @param result Measurement result.
 * @param tag Log prefix.
 */
async function writeCache(id: string, inputs: CentroidInputs, result: CentroidVetResult, tag: string): Promise<void> {
  const file = cachePath(id)
  const tmp = `${file}.${process.pid}.tmp`
  const entry: CentroidCacheEntry = {
    schemaVersion: CENTROID_CACHE_SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    inputs,
    result,
  }
  try {
    await fs.mkdir(DISK_CACHE_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(entry), 'utf8')
    await fs.rename(tmp, file)
    console.error(`${tag} cache WROTE ${id} (status ${result.status}) → ${file}`)
  } catch (e) {
    console.error(`${tag} cache write error for ${id}:`, e)
    try { await fs.unlink(tmp) } catch { /* ignore */ }
  }
}

/** @description Minimal TAP response shape (positional rows aligned with `info`). */
interface TapResponse {
  info?: Array<{ name: string }>
  data?: Array<Array<string | number | null>>
}

/**
 * @description Discovers the target's TPF segments via the SAME obscore
 * query the lightcurve route uses (`dataproduct_type='timeseries'`).
 * - Kepler: TPF rows are listed directly — filter `_lpd-targ.fits.gz`
 *   (never the `_spd-targ` short-cadence product, 10–30× bigger and
 *   useless for a 30-min box signal).
 * - TESS: obscore does NOT list `_tp.fits` rows, so the TPF URLs are
 *   DERIVED from the listed `-s_lc.fits` rows via `deriveTessTpfUrl`
 *   (the naming-pattern contract watched by external-health check 6).
 * Returns download-ready URLs in chronological order (the archive
 * filenames embed timestamps/sector numbers).
 * @param mission Which collection to query.
 * @param targetName Archive target name (`kplrNNNNNNNNN` / bare TIC int).
 * @param tag Log prefix.
 * @returns Chronologically-sorted TPF URLs (empty on failure).
 */
async function discoverTpfSegments(
  mission: 'Kepler' | 'TESS',
  targetName: string,
  tag: string,
): Promise<string[]> {
  const tapUrl = mastTapQueryUrl(mission, targetName)
  const res = await fetch(tapUrl, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) {
    console.error(`${tag} TAP status ${res.status} for ${targetName}`)
    return []
  }
  const tap = (await res.json()) as TapResponse
  const colIdx = Object.fromEntries((tap.info ?? []).map((c, i) => [c.name, i]))
  const urlIdx = colIdx['access_url']
  if (urlIdx === undefined) {
    console.error(`${tag} TAP response missing access_url column`)
    return []
  }
  const urls = new Set<string>()
  for (const row of tap.data ?? []) {
    const u = row[urlIdx]
    if (typeof u !== 'string') continue
    if (mission === 'Kepler') {
      if (u.includes('_lpd-targ.fits')) urls.add(u)
    } else {
      const derived = deriveTessTpfUrl(u)
      if (derived !== null) urls.add(derived)
    }
  }
  return [...urls].sort()
}

/**
 * @description Picks `count` quarters spread evenly across the mission
 * (same selection the calibration prototype used) so the vector average
 * samples independent roll orientations and epochs.
 * @param urls Chronologically-sorted quarter URLs.
 * @param count How many to pick.
 * @returns Evenly-spread subset (all of them when fewer than `count`).
 */
function spreadQuarters(urls: string[], count: number): string[] {
  if (urls.length <= count) return urls
  const picks: string[] = []
  for (let i = 0; i < count; i++) {
    picks.push(urls[Math.floor(((i + 0.5) / count) * urls.length)])
  }
  return [...new Set(picks)]
}

/**
 * @description Downloads and parses one TPF segment.
 * @param accessUrl TAP access_url (Kepler) or derived download URL (TESS).
 * `resolveSegmentDownloadUrl` is idempotent on already-resolved URLs.
 * @param tag Log prefix.
 * @returns Parsed segment as engine input plus the header magnitude, or
 * null on any failure (logged, never thrown — one bad segment shouldn't
 * kill the measurement).
 */
/** @description Download attempts per segment (TESS sectors are ~47 MB; connection resets are routine). */
const SEGMENT_MAX_ATTEMPTS = 3

/** @description Linear backoff between segment retry attempts (ms). */
const SEGMENT_RETRY_BACKOFF_MS = 500

async function fetchSegment(
  accessUrl: string,
  tag: string,
): Promise<{ input: CentroidQuarterInput; mag: number | null } | null> {
  const downloadUrl = resolveSegmentDownloadUrl(accessUrl)
  const fname = decodeURIComponent(downloadUrl.split('/').pop() ?? downloadUrl).split('/').pop() ?? downloadUrl
  for (let attempt = 1; attempt <= SEGMENT_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(TPF_FETCH_TIMEOUT_MS) })
      if (!res.ok) {
        console.error(`${tag} segment ${fname} → HTTP ${res.status}`)
        // 4xx won't fix itself; 5xx/429 might.
        if (res.status < 500 && res.status !== 429) return null
        if (attempt === SEGMENT_MAX_ATTEMPTS) return null
        await new Promise(r => setTimeout(r, SEGMENT_RETRY_BACKOFF_MS * attempt))
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const tpf = readTpf(buf)
      console.error(
        `${tag} segment ${fname} → ${tpf.mission ?? '?'} seg ${tpf.segment ?? '?'} ${tpf.nx}×${tpf.ny}, ${tpf.times.length} cadences, mag=${tpf.mag ?? '?'}, wcs=${tpf.wcs ? 'yes' : 'NO'}${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
      )
      return {
        input: {
          label: fname,
          nx: tpf.nx,
          ny: tpf.ny,
          times: tpf.times,
          quality: tpf.quality,
          flux: tpf.flux,
          wcs: tpf.wcs,
          apertureMask: tpf.apertureMask,
        },
        mag: tpf.mag,
      }
    } catch (e) {
      // Connection-level failure (ECONNRESET / timeout) — the class the
      // lightcurve route's pool retries. Big TESS sectors hit it often
      // (observed live: 2/4 sectors dropped on first attempt).
      console.error(
        `${tag} segment ${fname} → attempt ${attempt}/${SEGMENT_MAX_ATTEMPTS} failed:`,
        e instanceof Error ? e.message : e,
      )
      if (attempt === SEGMENT_MAX_ATTEMPTS) return null
      await new Promise(r => setTimeout(r, SEGMENT_RETRY_BACKOFF_MS * attempt))
    }
  }
  return null
}

/**
 * @description Downloads a list of segments through a small bounded pool.
 * Order of results matches input; failures are dropped (logged in
 * `fetchSegment`).
 * @param urls Segment URLs.
 * @param tag Log prefix.
 * @returns Successfully-parsed segments.
 */
async function fetchSegmentsBounded(
  urls: string[],
  tag: string,
): Promise<Array<{ input: CentroidQuarterInput; mag: number | null }>> {
  const results = new Array<{ input: CentroidQuarterInput; mag: number | null } | null>(urls.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < urls.length) {
      const i = next++
      results[i] = await fetchSegment(urls[i], tag)
    }
  }
  await Promise.all(Array.from({ length: Math.min(TPF_DOWNLOAD_CONCURRENCY, urls.length) }, worker))
  return results.filter((r): r is { input: CentroidQuarterInput; mag: number | null } => r !== null)
}

/**
 * @description GET handler — see the module doc for the contract.
 * @param req Request carrying `period` / `epoch` / `duration` query params.
 * @param ctx Route context with the dynamic `id` segment.
 * @returns JSON `{ status: 'ok', result, provenance }` on success;
 * `{ status: 'unsupported' | 'bad-request' | 'error', message }` otherwise.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const tag = '[centroid]'
  const url = new URL(req.url)
  const periodDays = Number(url.searchParams.get('period'))
  const epochDays = Number(url.searchParams.get('epoch'))
  const durationHours = Number(url.searchParams.get('duration'))

  const kicMatch = id.match(/^KIC(\d+)$/)
  const ticMatch = id.match(/^TIC(\d+)$/)
  if (!kicMatch && !ticMatch) {
    return NextResponse.json(
      {
        status: 'unsupported' as const,
        message: 'Pixel-level vetting is available for Kepler (KIC) and TESS (TIC) targets only.',
      },
      { status: 400 },
    )
  }
  if (!(periodDays > 0) || !Number.isFinite(epochDays) || !(durationHours > 0)) {
    return NextResponse.json(
      { status: 'bad-request' as const, message: 'period, epoch and duration query params are required.' },
      { status: 400 },
    )
  }
  const mission: 'Kepler' | 'TESS' = kicMatch ? 'Kepler' : 'TESS'
  const provenance = centroidProvenance(mission)
  const inputs: CentroidInputs = { periodDays, epochDays, durationHours }
  console.error(`${tag} GET ${id} (${mission}) P=${periodDays}d t0=${epochDays} dur=${durationHours}h`)

  const cached = await readCache(id, inputs, tag)
  if (cached) {
    return NextResponse.json({ status: 'ok' as const, result: cached, mission, provenance })
  }

  try {
    // TESS `target_name` in obscore is the bare TIC integer (same rule as
    // the lightcurve route); Kepler uses the 9-digit-padded kplr form.
    const targetName = kicMatch
      ? `kplr${kicMatch[1].padStart(9, '0')}`
      : String(parseInt(ticMatch![1], 10))
    const allSegments = await discoverTpfSegments(mission, targetName, tag)
    console.error(`${tag} ${allSegments.length} TPF segments discoverable for ${mission}/${targetName}`)
    if (allSegments.length === 0) {
      return NextResponse.json({
        status: 'error' as const,
        message: `No ${mission} Target Pixel Files found at MAST for this star.`,
      })
    }
    const picks = spreadQuarters(
      allSegments,
      mission === 'Kepler' ? TPF_QUARTERS_TO_FETCH : TESS_SECTORS_TO_FETCH,
    )

    // Saturation gate: download ONE segment first and read the
    // authoritative KEPMAG/TESSMAG from its header. Refusing here saves
    // the remaining downloads for targets we won't measure anyway.
    const first = await fetchSegment(picks[0], tag)
    if (!first) {
      return NextResponse.json({
        status: 'error' as const,
        message: 'Could not download pixel data from MAST (first segment failed).',
      })
    }
    if (isSaturatedMag(mission, first.mag)) {
      const result = runCentroidVet([], periodDays, epochDays, durationHours, first.mag, mission)
      await writeCache(id, inputs, result, tag)
      return NextResponse.json({ status: 'ok' as const, result, mission, provenance })
    }

    const rest = await fetchSegmentsBounded(picks.slice(1), tag)
    const segmentInputs = [first.input, ...rest.map(r => r.input)]
    const result = runCentroidVet(segmentInputs, periodDays, epochDays, durationHours, first.mag, mission)
    console.error(
      `${tag} ${id} → status=${result.status} verdict=${result.verdict ?? '-'} ` +
        `offset=${result.offsetArcsec?.toFixed(2) ?? '-'}″ ±${result.offsetErrArcsec?.toFixed(2) ?? '-'} ` +
        `σ=${result.sigma?.toFixed(1) ?? '-'} ref=${result.referenceFrame ?? '-'} segments=${result.quartersUsed}`,
    )
    // Cache `measured` and `saturated` only. An `insufficient` outcome is
    // usually a transient artifact (segment downloads dropped, as observed
    // live on the TESS path) — freezing it for the TTL would make a
    // recoverable failure sticky for 30 days.
    if (result.status !== 'insufficient') {
      await writeCache(id, inputs, result, tag)
    }
    return NextResponse.json({ status: 'ok' as const, result, mission, provenance })
  } catch (e) {
    console.error(`${tag} caught:`, e)
    return NextResponse.json({
      status: 'error' as const,
      message: 'Pixel-level vetting failed (MAST fetch or parse error).',
    })
  }
}
