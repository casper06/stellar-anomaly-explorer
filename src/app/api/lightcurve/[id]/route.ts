import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  generateSyntheticLightcurve,
  KEPLER_PROVENANCE,
  SYNTHETIC_PROVENANCE,
  TESS_PROVENANCE,
  UNAVAILABLE_PROVENANCE,
} from '@/lib/anomalyDetector'
import { readMastLightcurveColumns } from '@/lib/fitsReader'
import {
  mastTapQueryUrl,
  mastConeSearchUrl,
  resolveSegmentDownloadUrl,
} from '@/lib/externalEndpoints'

/**
 * @description Recommended canvas-line gap-break threshold (in days) per
 * mission. Kepler has 1–4 day inter-quarter gaps so 5 cleanly separates
 * real observation windows from intra-quarter cadence; TESS has more
 * frequent sector boundaries (~1 day between sectors) so 2 is tighter
 * but still safely above the 2-min intra-sector cadence.
 */
const GAP_DAYS_KEPLER = 5
const GAP_DAYS_TESS = 2

/**
 * @description Cache successful real fetches for the lifetime of the server
 * process. L1 cache — instant, but lost on restart. The L2 disk cache
 * below survives restarts.
 */
const cache = new Map<string, { times: number[]; flux: number[] }>()

/**
 * @description Two-week TTL for the disk cache. Kepler PDC files are static
 * so we could cache forever, but expiring lets us retry occasionally
 * in case MAST publishes corrected data, and bounds local disk usage.
 */
const DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * @description Schema/provenance version of disk-cache entries. BUMP THIS
 * whenever the fetch pipeline changes in a way that can alter the cached
 * arrays: segment-file filtering rules, per-segment normalization,
 * stitching/sorting, FITS parsing, or the TAP query itself. Entries
 * written under a different version are treated as cache MISSES and
 * refetched, never served.
 *
 * Why: during the 2026-06/07 dev period the route was edited while
 * 7-day-TTL entries written by older iterations kept being served —
 * K02357.02's dip measured 1.08% deep from a stale-provenance entry vs
 * 1.00% from a fresh fetch of the same star (same reader code, different
 * write-time code). Quarter availability was quantitatively ruled out
 * (leave-one-quarter-out moves depth ≤0.0001 pp); mixed-provenance cache
 * data was the remaining cause. Versioning eliminates the class.
 */
const CACHE_SCHEMA_VERSION = 1

/**
 * @description Shape of a disk-cache entry. Metadata fields sit
 * before the big arrays so `head`-ing the JSON file answers "when was
 * this fetched, by which schema, from which segment files" without
 * parsing megabytes — drift investigations become a file read.
 */
interface DiskCacheEntry {
  schemaVersion: number
  /** ISO timestamp of the MAST fetch that produced this entry. */
  fetchedAt: string
  /** Number of samples in `times`/`flux`. */
  sampleCount: number
  /** Archive filenames of the segments that parsed successfully. */
  segmentFiles: string[]
  times: number[]
  flux: number[]
}

/** @description Directory under OS temp where parsed light curves are cached. */
const DISK_CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')

/**
 * @description Returns the cache file path for a given star id. Sanitizes
 * the id so unexpected characters can't escape the cache directory.
 * @param id Catalog id (e.g. "KIC8462852").
 */
function diskCachePath(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_')
  return path.join(DISK_CACHE_DIR, `${safe}.json`)
}

/**
 * @description Reads the disk cache for a star id. Returns null if the file
 * doesn't exist, is older than TTL, or fails to parse. Logs the reason
 * either way so cache misses are visible alongside hits.
 * @param id Catalog id.
 * @param tag Log prefix.
 */
async function readDiskCache(
  id: string,
  tag: string,
): Promise<{ times: number[]; flux: number[] } | null> {
  const file = diskCachePath(id)
  try {
    const stat = await fs.stat(file)
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs > DISK_CACHE_TTL_MS) {
      console.error(`${tag} disk cache for ${id} is stale (${Math.round(ageMs / 86400000)}d old); ignoring`)
      return null
    }
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DiskCacheEntry>
    if (!Array.isArray(parsed.times) || !Array.isArray(parsed.flux) || parsed.times.length < 10) {
      console.error(`${tag} disk cache for ${id} parsed but malformed; ignoring`)
      return null
    }
    // Provenance guard: an entry written under a different (or missing —
    // pre-v1) schema version may have been produced by a different fetch/
    // normalization pipeline. Serving it would mix data provenances across
    // code changes, so treat it as a miss and refetch.
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      console.error(
        `${tag} disk cache for ${id} has schema v${parsed.schemaVersion ?? '<none>'} ≠ current v${CACHE_SCHEMA_VERSION}; ignoring (will refetch)`,
      )
      return null
    }
    console.error(
      `${tag} disk cache HIT for ${id} (schema v${parsed.schemaVersion}, ${parsed.times.length} samples, ` +
        `fetchedAt ${parsed.fetchedAt ?? 'unknown'}, age ${Math.round(ageMs / 3600000)}h)`,
    )
    return { times: parsed.times, flux: parsed.flux }
  } catch (e) {
    // ENOENT is the common case — file doesn't exist yet. Don't spam logs.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${tag} disk cache read error for ${id}:`, e)
    }
    return null
  }
}

/**
 * @description Writes a successful MAST fetch to the disk cache as a
 * `DiskCacheEntry` stamped with the current `CACHE_SCHEMA_VERSION` —
 * schema version + fetch timestamp + segment file list + sample count
 * ahead of the arrays. Uses write-to-temp + rename so a
 * crash mid-write can't leave a corrupted file that would then be
 * returned on next read.
 * @param id Catalog id.
 * @param data Parsed light curve (times + flux) plus the archive
 * filenames of the segments that produced it.
 * @param tag Log prefix.
 */
async function writeDiskCache(
  id: string,
  data: { times: number[]; flux: number[]; segmentFiles?: string[] },
  tag: string,
): Promise<void> {
  const file = diskCachePath(id)
  const tmp = `${file}.${process.pid}.tmp`
  const entry: DiskCacheEntry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    sampleCount: data.times.length,
    segmentFiles: data.segmentFiles ?? [],
    times: data.times,
    flux: data.flux,
  }
  try {
    await fs.mkdir(DISK_CACHE_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(entry), 'utf8')
    await fs.rename(tmp, file)
    console.error(
      `${tag} disk cache WROTE ${id} (schema v${entry.schemaVersion}, ${entry.sampleCount} samples, ` +
        `${entry.segmentFiles.length} segment files) → ${file}`,
    )
  } catch (e) {
    console.error(`${tag} disk cache write error for ${id}:`, e)
    // Best-effort cleanup of the temp file
    try { await fs.unlink(tmp) } catch { /* ignore */ }
  }
}

/**
 * @description Identifies which MAST archive collection (if any) a star id
 * should be fetched against. Returns `null` for ids that don't carry a
 * direct mission cross-reference — those go through the position-based
 * cone-search path instead. Prefix-based dispatch:
 *   - `KIC{N}` (KOI catalog, KNOWN_ANOMALIES seeds) → Kepler.
 *   - Bare integer (legacy / numeric kepid) → Kepler.
 *   - `TIC{N}` (TOI catalog) → TESS.
 *   - Anything else (HIP*, SYN*, EPIC*, etc.) → null.
 * @param id Catalog id.
 * @returns The mission and its archive `target_name` form, or null.
 */
function identifyMastTarget(
  id: string,
): { mission: 'Kepler' | 'TESS'; targetName: string } | null {
  const kicMatch = id.match(/^KIC(\d+)$/)
  if (kicMatch) {
    return { mission: 'Kepler', targetName: `kplr${kicMatch[1].padStart(9, '0')}` }
  }
  const ticMatch = id.match(/^TIC(\d+)$/)
  if (ticMatch) {
    // TESS `target_name` in `ivoa.obscore` is the bare TIC integer (no
    // prefix, no padding). Verified against a live TAP query — using
    // any padded form or the `TIC` prefix returns zero rows.
    return { mission: 'TESS', targetName: String(parseInt(ticMatch[1], 10)) }
  }
  const numeric = Number(id)
  if (Number.isFinite(numeric) && numeric > 0 && /^\d+$/.test(id)) {
    return { mission: 'Kepler', targetName: `kplr${String(Math.floor(numeric)).padStart(9, '0')}` }
  }
  return null
}

// `mastTapQueryUrl` and `mastConeSearchUrl` are imported from
// `@/lib/externalEndpoints` — the single source of truth shared with the
// external-health check so probe URLs can't drift from production URLs.

/**
 * @description One row of the VO-TAP JSON response. The TAP server returns
 * `{ info: [...columns], data: [[row], [row], ...] }`, so each row is a
 * positional array aligned with `info`. We index by position rather than
 * name to keep things simple.
 */
interface TapResponse {
  info?: Array<{ name: string }>
  data?: Array<Array<string | number | null>>
}

/**
 * @description Downloads and parses one MAST PDC FITS segment (a Kepler
 * quarter OR a TESS sector — both have the same BINTABLE structure and
 * column names), returning its TIME and per-segment-median-normalized
 * flux as parallel arrays. Each segment is normalized independently
 * because both missions' instrument throughputs drift across segment
 * boundaries — joining unnormalized segments produces stepwise jumps at
 * the seams. Returns null on any failure.
 * @param accessUrl The TAP-provided `access_url` (we extract the embedded
 * `uri=` since the portal Download proxy returns 400 as of 2026).
 * @returns Parallel `times`/`flux` arrays for the segment, or null.
 */
async function fetchAndParseSegment(
  accessUrl: string,
): Promise<{ times: number[]; flux: number[] } | null> {
  const tag = '[lightcurve]'
  // The TAP `access_url` points at the MAST portal's Download/file proxy,
  // which returns 400 as of 2026 — the embedded `uri=` param is the real,
  // public archive URL. `resolveSegmentDownloadUrl` (shared with the health
  // check) extracts it, routing TESS `mast:TESS/...` URIs through the MAST
  // Download API and upgrading Kepler `http://archive...` URLs to HTTPS.
  const downloadUrl = resolveSegmentDownloadUrl(accessUrl)

  // Short-name label for per-segment logs so a long URL doesn't dominate
  // the line. Kepler filenames look like
  // `kplrNNNNNNNNN-YYYYDDDHHMMSS_llc.fits`; TESS filenames look like
  // `tessYYYYDDDHHMMSS-sSSSS-TTTTTTTTTTTTT-NNNN-s_lc.fits`.
  const fname = downloadUrl.split('/').pop() ?? downloadUrl

  try {
    const fitsRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) })
    if (!fitsRes.ok) {
      console.error(`${tag} segment ${fname} → HTTP ${fitsRes.status} ${fitsRes.statusText}`)
      return null
    }
    const fitsBuf = Buffer.from(await fitsRes.arrayBuffer())

    let rawTimes: (number | null)[]
    let rawFlux: (number | null)[]
    try {
      const cols = readMastLightcurveColumns(fitsBuf, ['TIME', 'PDCSAP_FLUX'])
      rawTimes = cols.col1
      rawFlux = cols.col2
    } catch (e) {
      console.error(`${tag} segment ${fname} → FITS parse error:`, e)
      return null
    }

    // Drop NaN rows
    const pairs: Array<[number, number]> = []
    for (let i = 0; i < rawTimes.length; i++) {
      const t = rawTimes[i]
      const f = rawFlux[i]
      if (t != null && f != null && Number.isFinite(t) && Number.isFinite(f)) {
        pairs.push([t, f])
      }
    }
    if (pairs.length < 50) {
      // Used to silently return null here. Make the drop visible so a
      // missing segment shows up in the log instead of just shrinking
      // the success count.
      console.error(`${tag} segment ${fname} → only ${pairs.length} valid rows (need 50); dropping`)
      return null
    }

    // Per-segment median normalization so concatenated segments join smoothly
    const sortedFlux = pairs.map(p => p[1]).sort((a, b) => a - b)
    const median = sortedFlux[Math.floor(sortedFlux.length / 2)] || 1
    return {
      times: pairs.map(p => p[0]),
      flux: pairs.map(p => p[1] / median),
    }
  } catch (e) {
    console.error(`${tag} segment ${fname} → caught:`, e)
    return null
  }
}

/**
 * @description Returns true when an `access_url` points at a PDC
 * light-curve FITS file for the given mission. Skips target-pixel
 * files, data-validation reports, etc.
 *
 * Mission-specific suffix rules:
 *   - Kepler: `_llc.fits` (long-cadence light curve).
 *   - TESS: `_lc.fits` BUT NOT `_dvt.fits` / `_dvm.fits` / etc.
 *     Note `_llc.fits` (Kepler) contains `_lc.fits` as a substring,
 *     so the TESS filter has to check the URL ALSO contains `/TESS/`
 *     or starts with `tess` — otherwise a Kepler URL passed to this
 *     helper as TESS would incorrectly match.
 */
function isPdcLightcurveUrl(url: string, mission: 'Kepler' | 'TESS'): boolean {
  if (mission === 'Kepler') return url.includes('_llc.fits')
  // TESS: require `_lc.fits` (which catches both the standard `_s_lc.fits`
  // and `_a_fast-lc.fits` cases) and a TESS path/filename indicator.
  if (!url.includes('_lc.fits')) return false
  if (url.includes('_llc.fits')) return false // Kepler, not TESS
  if (url.includes('_fast-lc.fits')) return false // 20-second cadence; skip, the 2-min cadence is the main product
  return url.includes('mast:TESS/') || url.includes('/tess/') || url.includes('/tess20')
}

/**
 * @description Tries to fetch and parse a real PDC light curve from MAST
 * via the VO-TAP service for either Kepler or TESS. One TAP query
 * returns one row per mission-segment (Kepler quarter / TESS sector)
 * for the target; we download all the PDC `_lc.fits` / `_llc.fits`
 * files in parallel, normalize each by its own median (so the seams
 * don't jump), then concatenate and sort by time. This is what makes
 * the famous Tabby's Star dips (Q8, Q16) visible — the first quarter
 * alone is just commissioning data with no anomalies.
 * @param mission The mission whose collection to query.
 * @param targetName Archive target name (mission-specific format).
 * @returns Concatenated multi-segment light curve plus the archive
 * filenames of the segments that parsed successfully (cache provenance
 * metadata), or null on failure.
 */
async function tryFetchRealLightcurve(
  mission: 'Kepler' | 'TESS',
  targetName: string,
): Promise<{ times: number[]; flux: number[]; segmentFiles: string[] } | null> {
  const tag = '[lightcurve]'
  try {
    const tapUrl = mastTapQueryUrl(mission, targetName)
    console.error(`${tag} ${mission} TAP query URL: ${tapUrl}`)
    const tapRes = await fetch(tapUrl, { signal: AbortSignal.timeout(60000) })
    console.error(`${tag} ${mission} TAP status: ${tapRes.status} ${tapRes.statusText}`)
    if (!tapRes.ok) {
      const body = await tapRes.text().catch(() => '<unreadable>')
      console.error(`${tag} TAP body (first 500): ${body.slice(0, 500)}`)
      return null
    }
    const tapText = await tapRes.text()
    let tap: TapResponse
    try {
      tap = JSON.parse(tapText) as TapResponse
    } catch (e) {
      console.error(`${tag} TAP JSON parse error:`, e)
      return null
    }
    const colIdx = Object.fromEntries((tap.info ?? []).map((c, i) => [c.name, i]))
    const accessUrlIdx = colIdx['access_url']
    if (accessUrlIdx === undefined) {
      console.error(`${tag} TAP response missing 'access_url' column; have: ${Object.keys(colIdx).join(', ')}`)
      return null
    }
    const rows = tap.data ?? []
    console.error(`${tag} ${mission} TAP returned ${rows.length} rows for ${targetName}`)

    // Filter to PDC light curves only (skip TPF target-pixel files,
    // DV reports, etc.)
    const lcUrls: string[] = []
    for (const row of rows) {
      const u = row[accessUrlIdx]
      if (typeof u === 'string' && isPdcLightcurveUrl(u, mission)) lcUrls.push(u)
    }
    // Resolve each TAP `access_url` to its underlying archive filename so
    // logs identify segments by their canonical name. Helps diagnose
    // "missing segments" — if TAP returned only N rows you'll see
    // exactly which timestamps came back.
    const lcFilenames = lcUrls.map(u => {
      const m = u.match(/[?&]uri=([^&]+)/)
      const inner = m ? decodeURIComponent(m[1]) : u
      return inner.split('/').pop() ?? inner
    })
    const segmentLabel = mission === 'Kepler' ? '_llc.fits quarters' : '_lc.fits sectors'
    console.error(
      `${tag} ${lcUrls.length} ${segmentLabel} to download in parallel: ${lcFilenames.join(', ')}`,
    )
    if (lcUrls.length === 0) return null

    // Download + parse all segments in parallel. Keep each segment paired
    // with its archive filename — the successful list is written into the
    // disk-cache entry as provenance metadata.
    const segments = await Promise.all(lcUrls.map(fetchAndParseSegment))
    const ok: Array<{ times: number[]; flux: number[]; file: string }> = []
    const failed: string[] = []
    segments.forEach((q, i) => {
      if (q === null) failed.push(lcFilenames[i])
      else ok.push({ ...q, file: lcFilenames[i] })
    })
    if (failed.length > 0) {
      console.error(
        `${tag} ${ok.length}/${segments.length} segments parsed successfully; failed: ${failed.join(', ')}`,
      )
    } else {
      console.error(`${tag} ${ok.length}/${segments.length} segments parsed successfully`)
    }
    if (ok.length === 0) return null

    // Sort segments by first timestamp, then flatten. Within each segment
    // the FITS rows are already chronological.
    ok.sort((a, b) => a.times[0] - b.times[0])
    const times: number[] = []
    const flux: number[] = []
    const segmentFiles: string[] = []
    for (const q of ok) {
      times.push(...q.times)
      flux.push(...q.flux)
      segmentFiles.push(q.file)
    }
    // BKJD for Kepler, TJD for TESS — both are just labels for the raw
    // time offset reported by the FITS TIME column.
    const tUnit = mission === 'Kepler' ? 'BKJD' : 'TJD'
    console.error(
      `${tag} ${mission} success: ${ok.length} segments concatenated → ${times.length} samples, ` +
        `time range ${tUnit} ${times[0].toFixed(1)} → ${times[times.length - 1].toFixed(1)}`,
    )
    return { times, flux, segmentFiles }
  } catch (e) {
    console.error(`${tag} caught error in tryFetchRealLightcurve:`, e)
    return null
  }
}

/**
 * @description Cone-searches MAST for ANY Kepler or TESS light curve
 * near (ra, dec). Used by the on-demand path for stars without a
 * KIC/TIC catalog id — we check whether MAST has observed that
 * patch of sky and, if so, route to the same fetch pipeline.
 * Returns the first MAST target found (with mission tag), or null
 * if nothing was observed within the search radius.
 * @param ra Right ascension in degrees.
 * @param dec Declination in degrees.
 * @returns Resolved target spec, or null on miss / TAP failure.
 */
async function resolveTargetByPosition(
  ra: number,
  dec: number,
): Promise<{ mission: 'Kepler' | 'TESS'; targetName: string } | null> {
  const tag = '[lightcurve]'
  try {
    const url = mastConeSearchUrl(ra, dec)
    console.error(`${tag} cone search URL: ${url}`)
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) {
      console.error(`${tag} cone search failed: HTTP ${res.status}`)
      return null
    }
    const tap = (await res.json()) as TapResponse
    const colIdx = Object.fromEntries((tap.info ?? []).map((c, i) => [c.name, i]))
    const collIdx = colIdx['obs_collection']
    const tnameIdx = colIdx['target_name']
    if (collIdx === undefined || tnameIdx === undefined) {
      console.error(`${tag} cone search missing expected columns`)
      return null
    }
    const rows = tap.data ?? []
    console.error(`${tag} cone search returned ${rows.length} rows at (${ra}, ${dec})`)
    if (rows.length === 0) return null
    // Prefer TESS if both missions have data — broader sky coverage
    // and shorter cadence make it the better default for the
    // on-demand path, where the user clicked something the catalogs
    // didn't already index.
    let kepler: { mission: 'Kepler'; targetName: string } | null = null
    let tess: { mission: 'TESS'; targetName: string } | null = null
    for (const row of rows) {
      const coll = row[collIdx]
      const tname = row[tnameIdx]
      if (typeof tname !== 'string' || tname === '') continue
      if (coll === 'Kepler' && !kepler) kepler = { mission: 'Kepler', targetName: tname }
      if (coll === 'TESS' && !tess) tess = { mission: 'TESS', targetName: tname }
      if (kepler && tess) break
    }
    return tess ?? kepler
  } catch (e) {
    console.error(`${tag} cone search caught:`, e)
    return null
  }
}

/**
 * @description Picks the right provenance + gap-day pair for a mission.
 * @param mission Mission tag from `identifyMastTarget` / cone search.
 * @returns Provenance and gap-day threshold.
 */
function missionMeta(mission: 'Kepler' | 'TESS') {
  return mission === 'Kepler'
    ? { provenance: KEPLER_PROVENANCE, gapDays: GAP_DAYS_KEPLER }
    : { provenance: TESS_PROVENANCE, gapDays: GAP_DAYS_TESS }
}

/**
 * @description Successful real-data response shape.
 */
function realResponse(
  data: { times: number[]; flux: number[] },
  mission: 'Kepler' | 'TESS',
) {
  const m = missionMeta(mission)
  return NextResponse.json({
    ...data,
    source: 'real' as const,
    provenance: m.provenance,
    mission,
    gapDays: m.gapDays,
  })
}

/**
 * @description GET /api/lightcurve/[id] — returns a star's light curve as
 * JSON. The id determines which path runs:
 *
 *   - `KIC{N}` / bare numeric: query MAST Kepler collection.
 *   - `TIC{N}`: query MAST TESS collection.
 *   - Anything else (`HIP*`, `SYN*`, etc.): if `?ra=…&dec=…` were
 *     provided, do a MAST cone search at that position to find any
 *     observed mission target. Otherwise skip MAST entirely.
 *
 * Synthetic fallback policy:
 *   - On-demand requests (`?onDemand=1`) NEVER receive synthetic data,
 *     even in dev. They get `source: 'unavailable'` immediately on
 *     MAST miss. This is the contract for stars the user clicked from
 *     the Hipparcos background — we promise "real or nothing".
 *   - Catalog-driven requests (default) get the existing behavior:
 *     synthetic in dev, unavailable in production.
 *
 * @param req Request — we read `ra`/`dec`/`onDemand` from the query string.
 * @param ctx Route context carrying the dynamic `id` segment.
 * @returns JSON `{ times, flux, source, provenance, mission, gapDays }`.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const tag = '[lightcurve]'
  const url = new URL(req.url)
  const onDemand = url.searchParams.get('onDemand') === '1'
  const raParam = url.searchParams.get('ra')
  const decParam = url.searchParams.get('dec')
  const ra = raParam !== null ? Number(raParam) : NaN
  const dec = decParam !== null ? Number(decParam) : NaN
  const havePos = Number.isFinite(ra) && Number.isFinite(dec)
  console.error(
    `${tag} GET /api/lightcurve/${id}` +
      ` (onDemand=${onDemand}, pos=${havePos ? `${ra},${dec}` : 'none'}, NODE_ENV=${process.env.NODE_ENV})`,
  )

  // Dispatch the id to a mission archive when possible.
  let target = identifyMastTarget(id)
  // If we couldn't infer a mission from the id and the caller supplied
  // a position, cone-search MAST to see whether the patch of sky has
  // ever been observed. This is the on-demand path for non-catalog
  // stars (Hipparcos clicks, etc).
  if (!target && havePos) {
    console.error(`${tag} ${id} has no mission id; cone-searching at ${ra}, ${dec}`)
    target = await resolveTargetByPosition(ra, dec)
    if (target) {
      console.error(`${tag} cone search resolved ${id} → ${target.mission}/${target.targetName}`)
    }
  }

  if (target) {
    // L1: in-process cache (instant, lost on restart). Keyed by id +
    // mission so that a Kepler hit and a TESS hit at the same RA/Dec
    // can both cache independently — won't happen often but it's the
    // right semantics.
    const cacheKey = `${id}|${target.mission}`
    if (cache.has(cacheKey)) {
      console.error(`${tag} in-process cache HIT for ${cacheKey}`)
      return realResponse(cache.get(cacheKey)!, target.mission)
    }

    // L2: disk cache (survives restarts; 7-day TTL). Same key.
    const onDisk = await readDiskCache(cacheKey, tag)
    if (onDisk) {
      cache.set(cacheKey, onDisk)
      return realResponse(onDisk, target.mission)
    }

    console.error(`${tag} ${id} → ${target.mission} target_name='${target.targetName}'; querying MAST TAP`)
    const real = await tryFetchRealLightcurve(target.mission, target.targetName)
    if (real) {
      console.error(`${tag} returning REAL ${target.mission} data for ${id}`)
      cache.set(cacheKey, real)
      void writeDiskCache(cacheKey, real, tag)
      return realResponse(real, target.mission)
    }
    console.error(`${tag} MAST fetch returned null for ${id} (${target.mission})`)
  } else {
    console.error(`${tag} ${id} is not a parseable KIC/TIC id and no position supplied; skipping MAST`)
  }

  // Synthetic fallback — gated. On-demand requests NEVER get synthetic,
  // even in dev: the user explicitly clicked a star outside the catalog
  // and the UI should make MAST coverage gaps visible, not paper them
  // over with fake data.
  if (process.env.NODE_ENV === 'development' && !onDemand) {
    console.error(`${tag} dev mode → returning SYNTHETIC for ${id}`)
    const synthetic = generateSyntheticLightcurve(id)
    return NextResponse.json({
      ...synthetic,
      source: 'synthetic' as const,
      provenance: SYNTHETIC_PROVENANCE,
      mission: null,
      gapDays: GAP_DAYS_KEPLER,
    })
  }

  console.error(`${tag} returning UNAVAILABLE for ${id}${onDemand ? ' (onDemand)' : ''}`)
  return NextResponse.json({
    times: [],
    flux: [],
    source: 'unavailable' as const,
    provenance: UNAVAILABLE_PROVENANCE,
    mission: null,
    gapDays: GAP_DAYS_KEPLER,
  })
}
