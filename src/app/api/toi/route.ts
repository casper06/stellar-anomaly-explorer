import { NextResponse } from 'next/server'
import * as os from 'node:os'
import * as path from 'node:path'
import { TOI_TAP_URL } from '@/lib/externalEndpoints'
import { readCatalogCache, writeCatalogCache } from '@/lib/catalogCache'

// NASA Exoplanet Archive TAP endpoint for the TOI (TESS Object of Interest)
// table lives in `@/lib/externalEndpoints` (shared with the external-health
// check). Disposition filtering is applied client-side in the parse step —
// the TFOPWG set has several "confirmed" variants (CP, KP) we want to keep.
// The TIC id column is `tid` (NOT `tic_id`, which is an invalid identifier).

/**
 * @description Freshness target for the TOI catalog: 24 hours —
 * deliberately tighter than KOI's 7 days. TESS is still observing:
 * new TOIs land continuously and TFOPWG dispositions get revised (a PC
 * can become CP or FP), so the mission counter and the anomaly overlay
 * deserve a daily cadence. Past this age the cache is still SERVED
 * (stale-while-revalidate, see `lib/catalogCache.ts`) — the TTL decides
 * when a background refresh fires, not whether data is available.
 */
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const DISK_CACHE_FILE = path.join(os.tmpdir(), 'stellar-cache', 'toi-catalog.json')

/**
 * @description TFOPWG dispositions we keep. Per the user's catalog
 * rollout decision:
 *   - CP = Confirmed Planet (TESS-confirmed)
 *   - KP = Known Planet (confirmed externally before TESS — the most
 *     vetted status; would have been wrong to exclude)
 *   - PC = Planet Candidate (pending follow-up)
 * Excluded: FP (false positive), FA (false alarm), APC (ambiguous PC),
 * EB (eclipsing binary), and rare/unset values.
 */
type ToiDisposition = 'CP' | 'KP' | 'PC'
const KEPT_DISPOSITIONS = new Set<string>(['CP', 'KP', 'PC'])

/**
 * @description Shape of a parsed TOI row as returned to the client.
 * Field names mirror the TAP columns but with cleaner names. `id` is
 * formatted as `TIC{tid}` to parallel KOI's `KIC{kepid}` convention so
 * downstream code can route by id prefix.
 */
interface ToiRow {
  id: string                 // `TIC{tid}`
  name: string               // `TOI {toi}`, e.g. "TOI 1019.01"
  ra: number
  dec: number
  disposition: ToiDisposition
  period: number             // days (pl_orbper)
  depth: number              // ppm (pl_trandep)
  duration: number           // hours (pl_trandurh)
  magnitude: number          // TESS magnitude (st_tmag); 0 if unknown
}

/**
 * @description Response shape — same envelope as /api/koi for client-side
 * symmetry. `source` and `error` mirror the KOI/lightcurve convention.
 */
interface ToiResponse {
  source: 'real' | 'cached' | 'unavailable'
  rows: ToiRow[]
  /**
   * Epoch ms of the upstream TAP fetch that produced `rows` (0 for
   * unavailable). For `source: 'cached'` this is the REAL fetch time
   * persisted in the cache file, not the response time.
   */
  fetchedAt: number
  /** True when `rows` exceeded the TTL and a background refresh fired. */
  stale?: boolean
  error?: string
}

/**
 * @description Parses one TAP row. Returns null when essential fields
 * are missing OR when the disposition isn't one we want to surface.
 * Numeric fields the renderer doesn't strictly need (period, depth,
 * duration, magnitude) are coerced to 0 if absent.
 * @param r Raw TAP row object.
 */
function parseTapRow(r: Record<string, unknown>): ToiRow | null {
  const tid = r['tid']
  const ra = r['ra']
  const dec = r['dec']
  const disp = r['tfopwg_disp']
  if (
    typeof tid !== 'number' ||
    typeof ra !== 'number' ||
    typeof dec !== 'number' ||
    typeof disp !== 'string' ||
    !KEPT_DISPOSITIONS.has(disp)
  ) {
    return null
  }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const toi = r['toi']
  return {
    id: `TIC${tid}`,
    name: typeof toi === 'string' ? `TOI ${toi}` : `TIC ${tid}`,
    ra,
    dec,
    disposition: disp as ToiDisposition,
    period: num(r['pl_orbper']),
    depth: num(r['pl_trandep']),
    duration: num(r['pl_trandurh']),
    magnitude: num(r['st_tmag']),
  }
}

/**
 * @description Fetches and parses the TOI table from the NASA TAP
 * endpoint. Shared by the cold (blocking) path and the background
 * revalidation, so both go through identical parsing and error taxonomy.
 * @param tag Log prefix.
 * @returns Parsed rows, or a short error tag on any failure.
 */
async function fetchFromTap(tag: string): Promise<{ rows: ToiRow[] } | { error: string }> {
  try {
    console.error(`${tag} fetching from NASA Exoplanet Archive…`)
    const res = await fetch(TOI_TAP_URL, { signal: AbortSignal.timeout(60000) })
    console.error(`${tag} TAP status: ${res.status} ${res.statusText}`)
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>')
      console.error(`${tag} TAP body (first 500): ${body.slice(0, 500)}`)
      return { error: `TAP returned HTTP ${res.status}` }
    }
    const text = await res.text()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      console.error(`${tag} TAP JSON parse error:`, e)
      console.error(`${tag} TAP body (first 500): ${text.slice(0, 500)}`)
      return { error: 'TAP response was not valid JSON' }
    }
    if (!Array.isArray(raw)) {
      console.error(`${tag} TAP response was not an array`)
      return { error: 'TAP response was not an array' }
    }
    const rows: ToiRow[] = []
    let droppedByDisposition = 0
    let droppedByFields = 0
    for (const item of raw) {
      const r = item as Record<string, unknown>
      const disp = r['tfopwg_disp']
      const parsed = parseTapRow(r)
      if (parsed) {
        rows.push(parsed)
      } else if (typeof disp === 'string' && !KEPT_DISPOSITIONS.has(disp)) {
        droppedByDisposition++
      } else {
        droppedByFields++
      }
    }
    console.error(
      `${tag} parsed ${rows.length} TOI rows ` +
        `(dropped ${droppedByDisposition} by disposition, ${droppedByFields} by missing fields)`,
    )
    if (rows.length === 0) return { error: 'TAP returned 0 usable rows' }
    return { rows }
  } catch (e) {
    console.error(`${tag} fetch failed:`, e)
    return { error: (e as Error).message ?? 'unknown error' }
  }
}

/**
 * @description True while a background revalidation is in flight, so a
 * burst of requests against a stale cache triggers exactly one TAP
 * fetch. Module-scope; resets when the refresh settles.
 */
let revalidating = false

/**
 * @description Background refresh of the disk cache (stale-while-
 * revalidate). Failures are logged and swallowed — the stale cache
 * stays in place and the next stale read retries.
 * @param tag Log prefix.
 */
async function revalidateInBackground(tag: string): Promise<void> {
  if (revalidating) return
  revalidating = true
  try {
    const result = await fetchFromTap(tag)
    if ('rows' in result) {
      await writeCatalogCache(DISK_CACHE_FILE, result.rows, tag)
      console.error(`${tag} background revalidation complete (${result.rows.length} rows)`)
    } else {
      console.error(`${tag} background revalidation failed (${result.error}); stale cache stays`)
    }
  } finally {
    revalidating = false
  }
}

/**
 * @description GET /api/toi — returns the TOI catalog with stale-while-
 * revalidate freshness: any cached copy is served immediately with its
 * TRUE `fetchedAt`; when older than the 24 h TTL it is additionally
 * flagged `stale: true` and a background refresh is kicked off
 * (deduped). Only a missing/legacy cache blocks on the TAP fetch. On
 * total failure with no cache, returns `{ source: 'unavailable', rows:
 * [], error }` so the client can show a "TESS catalog unavailable"
 * state.
 * @returns JSON `ToiResponse`.
 */
export async function GET() {
  const tag = '[toi]'
  console.error(`${tag} GET /api/toi`)

  const cached = await readCatalogCache<ToiRow>(DISK_CACHE_FILE, tag)
  if (cached) {
    const stale = cached.ageMs > DISK_CACHE_TTL_MS
    console.error(
      `${tag} disk cache HIT (${cached.rows.length} TOIs, age ${Math.round(cached.ageMs / 3600000)}h${stale ? ' — STALE, revalidating in background' : ''})`,
    )
    if (stale) void revalidateInBackground(tag)
    return NextResponse.json<ToiResponse>({
      source: 'cached',
      rows: cached.rows,
      fetchedAt: cached.fetchedAt,
      ...(stale ? { stale: true } : {}),
    })
  }

  const result = await fetchFromTap(tag)
  if ('error' in result) {
    return NextResponse.json<ToiResponse>({
      source: 'unavailable',
      rows: [],
      fetchedAt: 0,
      error: result.error,
    })
  }
  const fetchedAt = await writeCatalogCache(DISK_CACHE_FILE, result.rows, tag)
  return NextResponse.json<ToiResponse>({
    source: 'real',
    rows: result.rows,
    fetchedAt,
  })
}
