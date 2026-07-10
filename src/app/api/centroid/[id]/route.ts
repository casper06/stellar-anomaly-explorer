import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { mastTapQueryUrl, resolveSegmentDownloadUrl } from '@/lib/externalEndpoints'
import { readKeplerTpf } from '@/lib/tpfReader'
import {
  runCentroidVet,
  isSaturatedKepmag,
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
 * STRICTLY on-demand and Kepler-only:
 * - Never called by the batch classifier or on ordinary selection — only
 *   from the explicit opt-in button in the fullscreen light-curve overlay.
 * - Only `KIC{N}` ids are accepted. TESS TPF support is deferred (its
 *   discovery URL is a derived naming pattern, not a documented MAST
 *   contract — see the external-health check's derivation probe).
 *
 * Query params (all required, from the confident BLS detection):
 * - `period`   — signal period in days.
 * - `epoch`    — mid-transit epoch in BKJD (the TPF TIME system).
 * - `duration` — box duration in hours.
 *
 * Saturation refusal: the authoritative Kepler magnitude comes from the
 * FIRST downloaded quarter's primary header (KEPMAG), not from the
 * catalog (merged KOI entries carry a default magnitude, not the real
 * one). A saturated target is refused after that single download —
 * the remaining quarters are never fetched.
 */

/** @description How many TPF quarters to fetch, spread evenly across the mission. */
const TPF_QUARTERS_TO_FETCH = 6

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
 */
const CENTROID_CACHE_SCHEMA_VERSION = 1

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

/** @description Provenance block returned with every successful measurement. */
const CENTROID_PROVENANCE = {
  sourceName: 'NASA/MAST Kepler Target Pixel Files',
  mission: 'Kepler',
  dataType: 'Per-quarter pixel stamps (difference-image centroid)',
} as const

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
 * @description Discovers the target's long-cadence TPF quarters via the
 * SAME obscore query the lightcurve route uses (Kepler TPF rows come back
 * from `dataproduct_type='timeseries'`; only the filename filter differs:
 * `_lpd-targ.fits.gz` instead of `_llc.fits`). Returns download URLs in
 * chronological order (the archive filename embeds the timestamp).
 * @param targetName Archive target name (`kplrNNNNNNNNN`).
 * @param tag Log prefix.
 * @returns Chronologically-sorted TPF download URLs (empty on failure).
 */
async function discoverTpfQuarters(targetName: string, tag: string): Promise<string[]> {
  const tapUrl = mastTapQueryUrl('Kepler', targetName)
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
  const urls: string[] = []
  for (const row of tap.data ?? []) {
    const u = row[urlIdx]
    // Long-cadence TPFs only — the `_spd-targ` short-cadence product is
    // 10–30× bigger and adds nothing for a 30-min-cadence box signal.
    if (typeof u === 'string' && u.includes('_lpd-targ.fits')) urls.push(u)
  }
  return urls.sort()
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
 * @description Downloads and parses one TPF quarter.
 * @param accessUrl TAP access_url for the quarter.
 * @param tag Log prefix.
 * @returns Parsed quarter as engine input plus the header kepmag, or null
 * on any failure (logged, never thrown — one bad quarter shouldn't kill
 * the measurement).
 */
async function fetchQuarter(
  accessUrl: string,
  tag: string,
): Promise<{ input: CentroidQuarterInput; kepmag: number | null } | null> {
  const downloadUrl = resolveSegmentDownloadUrl(accessUrl)
  const fname = downloadUrl.split('/').pop() ?? downloadUrl
  try {
    const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(TPF_FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      console.error(`${tag} quarter ${fname} → HTTP ${res.status}`)
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const tpf = readKeplerTpf(buf)
    console.error(
      `${tag} quarter ${fname} → Q${tpf.quarter ?? '?'} ${tpf.nx}×${tpf.ny}, ${tpf.times.length} cadences, Kp=${tpf.kepmag ?? '?'}`,
    )
    return {
      input: {
        label: fname,
        nx: tpf.nx,
        ny: tpf.ny,
        times: tpf.times,
        quality: tpf.quality,
        flux: tpf.flux,
        apertureMask: tpf.apertureMask,
      },
      kepmag: tpf.kepmag,
    }
  } catch (e) {
    console.error(`${tag} quarter ${fname} → failed:`, e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * @description Downloads a list of quarters through a small bounded pool.
 * Order of results matches input; failures are dropped (logged in
 * `fetchQuarter`).
 * @param urls Quarter access_urls.
 * @param tag Log prefix.
 * @returns Successfully-parsed quarters.
 */
async function fetchQuartersBounded(
  urls: string[],
  tag: string,
): Promise<Array<{ input: CentroidQuarterInput; kepmag: number | null }>> {
  const results = new Array<{ input: CentroidQuarterInput; kepmag: number | null } | null>(urls.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < urls.length) {
      const i = next++
      results[i] = await fetchQuarter(urls[i], tag)
    }
  }
  await Promise.all(Array.from({ length: Math.min(TPF_DOWNLOAD_CONCURRENCY, urls.length) }, worker))
  return results.filter((r): r is { input: CentroidQuarterInput; kepmag: number | null } => r !== null)
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
  if (!kicMatch) {
    return NextResponse.json(
      { status: 'unsupported' as const, message: 'Pixel-level vetting is available for Kepler (KIC) targets only.' },
      { status: 400 },
    )
  }
  if (!(periodDays > 0) || !Number.isFinite(epochDays) || !(durationHours > 0)) {
    return NextResponse.json(
      { status: 'bad-request' as const, message: 'period, epoch and duration query params are required.' },
      { status: 400 },
    )
  }
  const inputs: CentroidInputs = { periodDays, epochDays, durationHours }
  console.error(`${tag} GET ${id} P=${periodDays}d t0=${epochDays} dur=${durationHours}h`)

  const cached = await readCache(id, inputs, tag)
  if (cached) {
    return NextResponse.json({ status: 'ok' as const, result: cached, provenance: CENTROID_PROVENANCE })
  }

  try {
    const targetName = `kplr${kicMatch[1].padStart(9, '0')}`
    const allQuarters = await discoverTpfQuarters(targetName, tag)
    console.error(`${tag} ${allQuarters.length} TPF quarters discoverable for ${targetName}`)
    if (allQuarters.length === 0) {
      return NextResponse.json({
        status: 'error' as const,
        message: 'No Kepler Target Pixel Files found at MAST for this star.',
      })
    }
    const picks = spreadQuarters(allQuarters, TPF_QUARTERS_TO_FETCH)

    // Saturation gate: download ONE quarter first and read the
    // authoritative KEPMAG from its header. Refusing here saves the
    // remaining downloads for targets we won't measure anyway.
    const first = await fetchQuarter(picks[0], tag)
    if (!first) {
      return NextResponse.json({
        status: 'error' as const,
        message: 'Could not download pixel data from MAST (first quarter failed).',
      })
    }
    if (isSaturatedKepmag(first.kepmag)) {
      const result = runCentroidVet([], periodDays, epochDays, durationHours, first.kepmag)
      await writeCache(id, inputs, result, tag)
      return NextResponse.json({ status: 'ok' as const, result, provenance: CENTROID_PROVENANCE })
    }

    const rest = await fetchQuartersBounded(picks.slice(1), tag)
    const quarterInputs = [first.input, ...rest.map(r => r.input)]
    const result = runCentroidVet(quarterInputs, periodDays, epochDays, durationHours, first.kepmag)
    console.error(
      `${tag} ${id} → status=${result.status} verdict=${result.verdict ?? '-'} ` +
        `offset=${result.offsetArcsec?.toFixed(2) ?? '-'}″ ±${result.offsetErrArcsec?.toFixed(2) ?? '-'} ` +
        `σ=${result.sigma?.toFixed(1) ?? '-'} quarters=${result.quartersUsed}`,
    )
    await writeCache(id, inputs, result, tag)
    return NextResponse.json({ status: 'ok' as const, result, provenance: CENTROID_PROVENANCE })
  } catch (e) {
    console.error(`${tag} caught:`, e)
    return NextResponse.json({
      status: 'error' as const,
      message: 'Pixel-level vetting failed (MAST fetch or parse error).',
    })
  }
}
