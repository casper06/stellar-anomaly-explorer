import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  generateSyntheticLightcurve,
  KEPLER_PROVENANCE,
  SYNTHETIC_PROVENANCE,
  UNAVAILABLE_PROVENANCE,
} from '@/lib/anomalyDetector'
import { readKeplerLightcurveColumns } from '@/lib/fitsReader'

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
    const parsed = JSON.parse(raw) as { times: number[]; flux: number[] }
    if (!Array.isArray(parsed.times) || !Array.isArray(parsed.flux) || parsed.times.length < 10) {
      console.error(`${tag} disk cache for ${id} parsed but malformed; ignoring`)
      return null
    }
    console.error(`${tag} disk cache HIT for ${id} (${parsed.times.length} samples, age ${Math.round(ageMs / 3600000)}h)`)
    return parsed
  } catch (e) {
    // ENOENT is the common case — file doesn't exist yet. Don't spam logs.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${tag} disk cache read error for ${id}:`, e)
    }
    return null
  }
}

/**
 * @description Writes a successful MAST fetch to the disk cache. Uses
 * write-to-temp + rename so a crash mid-write can't leave a corrupted
 * file that would then be returned on next read.
 * @param id Catalog id.
 * @param data Parsed light curve (times + flux).
 * @param tag Log prefix.
 */
async function writeDiskCache(
  id: string,
  data: { times: number[]; flux: number[] },
  tag: string,
): Promise<void> {
  const file = diskCachePath(id)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.mkdir(DISK_CACHE_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
    await fs.rename(tmp, file)
    console.error(`${tag} disk cache WROTE ${id} (${data.times.length} samples) → ${file}`)
  } catch (e) {
    console.error(`${tag} disk cache write error for ${id}:`, e)
    // Best-effort cleanup of the temp file
    try { await fs.unlink(tmp) } catch { /* ignore */ }
  }
}

/**
 * @description Converts a Kepler ID (numeric or "KIC{N}"-prefixed string)
 * into Kepler's archive naming convention `kplrNNNNNNNNN` — lowercase
 * prefix, 9-digit zero-padded number. MAST's `target_name` column uses
 * this form; querying the raw KIC integer or unpadded id returns zero
 * rows. Used for ALL light-curve fetches now (KOI stars too, not just
 * the 11 hardcoded seeds), so any star with a valid KIC id can return
 * real Kepler PDC data from MAST.
 * @param id Either a numeric `kepid` or a `KIC{digits}` string.
 * @returns Kepler archive target name, or null if `id` can't be parsed.
 */
function kepidToTargetName(id: string | number): string | null {
  if (typeof id === 'number') {
    if (!Number.isFinite(id) || id <= 0) return null
    return `kplr${String(Math.floor(id)).padStart(9, '0')}`
  }
  const match = id.match(/^KIC(\d+)$/)
  if (!match) return null
  return `kplr${match[1].padStart(9, '0')}`
}

/**
 * @description Builds the MAST VO-TAP synchronous query URL for the
 * `ivoa.obscore` view. We pull a small set of columns for Kepler timeseries
 * products tied to a given target_name — each row carries an `access_url`
 * that downloads the FITS directly, so no second hop is needed.
 * @param targetName Kepler archive target name (e.g. "kplr008462852").
 * @returns Fully-formed GET URL.
 */
function mastTapQueryUrl(targetName: string): string {
  // Kepler had 17 quarters; cap at 100 to be safe across the full mission.
  const adql = `SELECT TOP 100 obs_id, access_url, access_format FROM ivoa.obscore WHERE obs_collection='Kepler' AND dataproduct_type='timeseries' AND target_name='${targetName}'`
  const params = new URLSearchParams({
    LANG: 'ADQL',
    FORMAT: 'json',
    REQUEST: 'doQuery',
    QUERY: adql,
  })
  return `https://mast.stsci.edu/vo-tap/api/v0.1/caom/sync?${params.toString()}`
}

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
 * @description Downloads and parses one Kepler PDC FITS quarter, returning
 * its TIME and per-quarter-median-normalized flux as parallel arrays. Each
 * quarter is normalized independently because Kepler's instrument throughput
 * drifts across quarter boundaries — joining unnormalized quarters produces
 * stepwise jumps at the seams. Returns null on any failure.
 * @param accessUrl The TAP-provided `access_url` (we extract the embedded
 * `uri=` since the portal Download proxy returns 400 as of 2026).
 * @returns Parallel `times`/`flux` arrays for the quarter, or null.
 */
async function fetchAndParseQuarter(
  accessUrl: string,
): Promise<{ times: number[]; flux: number[] } | null> {
  const tag = '[lightcurve]'
  // The TAP `access_url` points at the MAST portal's Download/file proxy
  // (`https://mast.stsci.edu/portal/Download/file?uri=http://archive...`).
  // That proxy returns 400 Bad Request as of 2026 — but the embedded
  // `uri=` param IS the real, public archive URL and serves the FITS
  // directly. Pull it out and upgrade to HTTPS.
  let downloadUrl = accessUrl
  const uriMatch = accessUrl.match(/[?&]uri=([^&]+)/)
  if (uriMatch) {
    downloadUrl = decodeURIComponent(uriMatch[1]).replace(/^http:\/\//, 'https://')
  }

  // Short-name label for per-quarter logs so a long URL doesn't dominate
  // the line. Filenames look like `kplrNNNNNNNNN-YYYYDDDHHMMSS_llc.fits`;
  // the timestamp suffix is the only part that varies per quarter.
  const fname = downloadUrl.split('/').pop() ?? downloadUrl

  try {
    const fitsRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) })
    if (!fitsRes.ok) {
      console.error(`${tag} quarter ${fname} → HTTP ${fitsRes.status} ${fitsRes.statusText}`)
      return null
    }
    const fitsBuf = Buffer.from(await fitsRes.arrayBuffer())

    let rawTimes: (number | null)[]
    let rawFlux: (number | null)[]
    try {
      const cols = readKeplerLightcurveColumns(fitsBuf, ['TIME', 'PDCSAP_FLUX'])
      rawTimes = cols.col1
      rawFlux = cols.col2
    } catch (e) {
      console.error(`${tag} quarter ${fname} → FITS parse error:`, e)
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
      // missing quarter shows up in the log instead of just shrinking
      // the success count.
      console.error(`${tag} quarter ${fname} → only ${pairs.length} valid rows (need 50); dropping`)
      return null
    }

    // Per-quarter median normalization so concatenated quarters join smoothly
    const sortedFlux = pairs.map(p => p[1]).sort((a, b) => a - b)
    const median = sortedFlux[Math.floor(sortedFlux.length / 2)] || 1
    return {
      times: pairs.map(p => p[0]),
      flux: pairs.map(p => p[1] / median),
    }
  } catch (e) {
    console.error(`${tag} quarter ${fname} → caught:`, e)
    return null
  }
}

/**
 * @description Tries to fetch and parse a real Kepler PDC light curve from
 * MAST via the VO-TAP service. One TAP query returns one row per Kepler
 * quarter for the target; we download all `_llc.fits` files in parallel,
 * normalize each by its own median (so quarter seams don't jump), then
 * concatenate and sort by time. This is what makes the famous Tabby's Star
 * dips (Q8, Q16) visible — the first quarter alone is just commissioning
 * data with no anomalies.
 * @param targetName Kepler archive target name (e.g. "kplr008462852").
 * @returns Concatenated multi-quarter light curve, or null on failure.
 */
async function tryFetchRealLightcurve(
  targetName: string,
): Promise<{ times: number[]; flux: number[] } | null> {
  const tag = '[lightcurve]'
  try {
    const tapUrl = mastTapQueryUrl(targetName)
    console.error(`${tag} TAP query URL: ${tapUrl}`)
    const tapRes = await fetch(tapUrl, { signal: AbortSignal.timeout(60000) })
    console.error(`${tag} TAP status: ${tapRes.status} ${tapRes.statusText}`)
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
    console.error(`${tag} TAP returned ${rows.length} rows for ${targetName}`)

    // Filter to PDC light curves only (skip `_tpf.fits` target pixel files,
    // which need a completely different extraction pipeline)
    const lcUrls: string[] = []
    for (const row of rows) {
      const u = row[accessUrlIdx]
      if (typeof u === 'string' && u.includes('_llc.fits')) lcUrls.push(u)
    }
    // Resolve each TAP `access_url` to its underlying archive filename so
    // logs identify quarters by their kplrNNNNNNNNN-YYYYDDDHHMMSS_llc.fits
    // name. Helps diagnose "missing quarters" — if TAP returned only N
    // rows you'll see exactly which timestamps came back.
    const lcFilenames = lcUrls.map(u => {
      const m = u.match(/[?&]uri=([^&]+)/)
      const inner = m ? decodeURIComponent(m[1]) : u
      return inner.split('/').pop() ?? inner
    })
    console.error(
      `${tag} ${lcUrls.length} _llc.fits quarters to download in parallel: ${lcFilenames.join(', ')}`,
    )
    if (lcUrls.length === 0) return null

    // Download + parse all quarters in parallel
    const quarters = await Promise.all(lcUrls.map(fetchAndParseQuarter))
    const ok = quarters.filter((q): q is { times: number[]; flux: number[] } => q !== null)
    if (ok.length < quarters.length) {
      // Identify which inputs failed so the user doesn't have to cross-
      // reference per-quarter error logs with the input list manually.
      const failed: string[] = []
      quarters.forEach((q, i) => { if (q === null) failed.push(lcFilenames[i]) })
      console.error(
        `${tag} ${ok.length}/${quarters.length} quarters parsed successfully; failed: ${failed.join(', ')}`,
      )
    } else {
      console.error(`${tag} ${ok.length}/${quarters.length} quarters parsed successfully`)
    }
    if (ok.length === 0) return null

    // Sort quarters by first timestamp, then flatten. Within each quarter the
    // FITS rows are already chronological, so a per-quarter sort isn't needed.
    ok.sort((a, b) => a.times[0] - b.times[0])
    const times: number[] = []
    const flux: number[] = []
    for (const q of ok) {
      times.push(...q.times)
      flux.push(...q.flux)
    }
    console.error(
      `${tag} success: ${ok.length} quarters concatenated → ${times.length} samples, ` +
        `time range BKJD ${times[0].toFixed(1)} → ${times[times.length - 1].toFixed(1)}`,
    )
    return { times, flux }
  } catch (e) {
    console.error(`${tag} caught error in tryFetchRealLightcurve:`, e)
    return null
  }
}

/**
 * @description GET /api/lightcurve/[id] — returns a star's light curve as
 * JSON. Tries real Kepler PDC data via MAST first. On failure, behavior
 * splits by environment so we never silently serve fake data in production:
 * - `NODE_ENV === 'development'`: returns a synthetic curve with
 *   `source: 'synthetic'` so the dev workflow doesn't depend on the network.
 * - Otherwise: returns empty arrays with `source: 'unavailable'`. The UI
 *   makes this state visible to the user instead of papering over it.
 * @param _req Unused Request object.
 * @param ctx Route context carrying the dynamic `id` segment.
 * @returns JSON `{ times, flux, source: 'real' | 'unavailable' | 'synthetic' }`.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const tag = '[lightcurve]'
  console.error(`${tag} GET /api/lightcurve/${id} (NODE_ENV=${process.env.NODE_ENV})`)

  // L1: in-process cache (instant, lost on restart)
  if (cache.has(id)) {
    console.error(`${tag} in-process cache HIT for ${id}`)
    const cached = cache.get(id)!
    return NextResponse.json({
      ...cached,
      source: 'real' as const,
      provenance: KEPLER_PROVENANCE,
    })
  }

  // L2: disk cache (survives restarts; 7-day TTL)
  const onDisk = await readDiskCache(id, tag)
  if (onDisk) {
    cache.set(id, onDisk) // promote to L1 for the rest of this process
    return NextResponse.json({
      ...onDisk,
      source: 'real' as const,
      provenance: KEPLER_PROVENANCE,
    })
  }

  // Try MAST for any KIC id, not just the 11 hardcoded seeds — the KOI
  // catalog adds thousands of real Kepler targets and they all have
  // archived PDC light curves. The MAST cone search will either
  // return data or 0 rows; either way the fallback path below catches
  // it. The previous `isKnownAnomaly` gate predated the KOI catalog
  // and is now obsolete.
  const targetName = kepidToTargetName(id)
  if (targetName) {
    console.error(`${tag} ${id} → Kepler target_name='${targetName}'; querying MAST TAP`)
    const real = await tryFetchRealLightcurve(targetName)
    if (real) {
      console.error(`${tag} returning REAL data for ${id}`)
      cache.set(id, real)
      // Fire-and-forget the disk write so we don't delay the response.
      // Failures inside writeDiskCache are logged but don't bubble up.
      void writeDiskCache(id, real, tag)
      return NextResponse.json({
        ...real,
        source: 'real' as const,
        provenance: KEPLER_PROVENANCE,
      })
    }
    console.error(`${tag} MAST fetch returned null for ${id}`)
  } else {
    console.error(`${tag} ${id} is not a parseable KIC id; skipping MAST`)
  }

  if (process.env.NODE_ENV === 'development') {
    console.error(`${tag} dev mode → returning SYNTHETIC for ${id}`)
    const synthetic = generateSyntheticLightcurve(id)
    return NextResponse.json({
      ...synthetic,
      source: 'synthetic' as const,
      provenance: SYNTHETIC_PROVENANCE,
    })
  }

  console.error(`${tag} prod mode → returning UNAVAILABLE for ${id}`)
  return NextResponse.json({
    times: [],
    flux: [],
    source: 'unavailable' as const,
    provenance: UNAVAILABLE_PROVENANCE,
  })
}
