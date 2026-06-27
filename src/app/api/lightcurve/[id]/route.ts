import { NextResponse } from 'next/server'
import { KNOWN_ANOMALIES } from '@/lib/starCatalog'
import {
  generateSyntheticLightcurve,
  KEPLER_PROVENANCE,
  SYNTHETIC_PROVENANCE,
  UNAVAILABLE_PROVENANCE,
} from '@/lib/anomalyDetector'
import { readKeplerLightcurveColumns } from '@/lib/fitsReader'

/**
 * @description Cache successful real fetches for the lifetime of the server
 * process. Kepler PDC files are static so this is safe; first request pays
 * the network cost, subsequent ones are instant.
 */
const cache = new Map<string, { times: number[]; flux: number[] }>()

/**
 * @description Returns true if the given id is a known anomaly we'll try to
 * fetch real data for. Anything else short-circuits to the synthetic/
 * unavailable path without hitting MAST.
 * @param id Catalog id like "KIC8462852".
 */
function isKnownAnomaly(id: string): boolean {
  return KNOWN_ANOMALIES.some(s => s.id === id)
}

/**
 * @description Converts a catalog id like "KIC8462852" into Kepler's
 * archive naming convention `kplr008462852` (lowercase prefix, 9-digit
 * zero-padded KIC number). MAST's `target_name` column uses this form;
 * a query for the raw "KIC8462852" returns zero rows.
 * @param id Catalog id (must start with "KIC").
 * @returns Kepler archive target name, or null if `id` isn't a KIC.
 */
function kicIdToKeplerTargetName(id: string): string | null {
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

  try {
    const fitsRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) })
    if (!fitsRes.ok) {
      console.error(`${tag} FITS ${downloadUrl} → ${fitsRes.status} ${fitsRes.statusText}`)
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
      console.error(`${tag} FITS parse error for ${downloadUrl}:`, e)
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
    if (pairs.length < 50) return null

    // Per-quarter median normalization so concatenated quarters join smoothly
    const sortedFlux = pairs.map(p => p[1]).sort((a, b) => a - b)
    const median = sortedFlux[Math.floor(sortedFlux.length / 2)] || 1
    return {
      times: pairs.map(p => p[0]),
      flux: pairs.map(p => p[1] / median),
    }
  } catch (e) {
    console.error(`${tag} fetchAndParseQuarter caught:`, e)
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
    console.error(`${tag} ${lcUrls.length} _llc.fits quarters to download in parallel`)
    if (lcUrls.length === 0) return null

    // Download + parse all quarters in parallel
    const quarters = await Promise.all(lcUrls.map(fetchAndParseQuarter))
    const ok = quarters.filter((q): q is { times: number[]; flux: number[] } => q !== null)
    console.error(`${tag} ${ok.length}/${quarters.length} quarters parsed successfully`)
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

  if (cache.has(id)) {
    console.error(`${tag} cache hit for ${id}`)
    const cached = cache.get(id)!
    return NextResponse.json({
      ...cached,
      source: 'real' as const,
      provenance: KEPLER_PROVENANCE,
    })
  }

  const targetName = isKnownAnomaly(id) ? kicIdToKeplerTargetName(id) : null
  if (targetName) {
    console.error(`${tag} ${id} → Kepler target_name='${targetName}'; querying MAST TAP`)
    const real = await tryFetchRealLightcurve(targetName)
    if (real) {
      console.error(`${tag} returning REAL data for ${id}`)
      cache.set(id, real)
      return NextResponse.json({
        ...real,
        source: 'real' as const,
        provenance: KEPLER_PROVENANCE,
      })
    }
    console.error(`${tag} MAST fetch returned null for ${id}`)
  } else {
    console.error(`${tag} ${id} is not a known KIC anomaly; skipping MAST`)
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
