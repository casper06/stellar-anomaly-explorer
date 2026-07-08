import { NextResponse } from 'next/server'
import * as os from 'node:os'
import * as path from 'node:path'
import { KOI_TAP_URL } from '@/lib/externalEndpoints'
import { readCatalogCache, writeCatalogCache } from '@/lib/catalogCache'

// NASA Exoplanet Archive TAP endpoint for the KOI cumulative table lives in
// `@/lib/externalEndpoints` (single source of truth shared with the
// external-health check so the two can never drift). Selects only the
// columns we render or score against, filtered to CONFIRMED + CANDIDATE
// dispositions. ~9,500 rows as of 2026, one per Kepler Object of Interest.

/**
 * @description Freshness target for the KOI catalog: 7 days. Kepler
 * stopped observing in 2013 and the cumulative table only sees
 * occasional batch disposition revisions (a CONFIRMED can be demoted
 * after a published refutation), so weekly is a comfortable cadence —
 * deliberately looser than TOI's 24 h (TESS is still observing and its
 * table grows continuously). Past this age the cache is still SERVED
 * (stale-while-revalidate, see `lib/catalogCache.ts`) — the TTL decides
 * when a background refresh fires, not whether data is available.
 */
const DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DISK_CACHE_FILE = path.join(os.tmpdir(), 'stellar-cache', 'koi-catalog.json')

/**
 * @description Shape of a parsed KOI row as returned to the client. Field
 * names mirror the TAP columns but renamed where they're awkward; numeric
 * fields are coerced to `number` so the client doesn't have to guess.
 */
interface KoiRow {
  id: string          // `KIC{kepid}` so it matches lightcurve route's id format
  name: string        // `kepoi_name`, e.g. "K00752.01"
  ra: number
  dec: number
  disposition: 'CONFIRMED' | 'CANDIDATE'
  period: number      // days
  depth: number       // ppm
  duration: number    // hours
  score: number       // koi_score in [0, 1]; raw, NOT the UI's anomalyScore
}

/**
 * @description Response shape. `error` is a short tag the client can use
 * to surface state to the user without parsing free text. `source` mirrors
 * the lightcurve route convention.
 */
interface KoiResponse {
  source: 'real' | 'cached' | 'unavailable'
  rows: KoiRow[]
  /**
   * Epoch ms of the upstream TAP fetch that produced `rows` (0 for
   * unavailable). For `source: 'cached'` this is the REAL fetch time
   * persisted in the cache file — previously the route reported
   * `Date.now()` for cached data, making staleness invisible.
   */
  fetchedAt: number
  /**
   * True when `rows` are older than the freshness TTL and a background
   * revalidation was triggered (stale-while-revalidate). Consumers can
   * surface the age via `fetchedAt`.
   */
  stale?: boolean
  error?: string
}

/**
 * @description Parses one TAP row into our internal shape. The TAP server
 * sometimes returns `null` for missing numeric columns; we coerce those
 * to 0 rather than dropping the row because the disposition + RA/Dec
 * are still useful even when score/period/depth are missing.
 * @param r Raw TAP row object.
 * @returns Cleaned KoiRow, or null if essential fields are missing.
 */
function parseTapRow(r: Record<string, unknown>): KoiRow | null {
  const kepid = r['kepid']
  const ra = r['ra']
  const dec = r['dec']
  const disp = r['koi_disposition']
  if (
    typeof kepid !== 'number' ||
    typeof ra !== 'number' ||
    typeof dec !== 'number' ||
    (disp !== 'CONFIRMED' && disp !== 'CANDIDATE')
  ) {
    return null
  }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    id: `KIC${kepid}`,
    name: typeof r['kepoi_name'] === 'string' ? (r['kepoi_name'] as string) : `KIC${kepid}`,
    ra,
    dec,
    disposition: disp,
    period: num(r['koi_period']),
    depth: num(r['koi_depth']),
    duration: num(r['koi_duration']),
    score: num(r['koi_score']),
  }
}

/**
 * @description Fetches and parses the KOI cumulative table from the NASA
 * TAP endpoint. Shared by the cold (blocking) path and the background
 * revalidation, so both go through identical parsing and error taxonomy.
 * @param tag Log prefix.
 * @returns Parsed rows, or a short error tag on any failure.
 */
async function fetchFromTap(tag: string): Promise<{ rows: KoiRow[] } | { error: string }> {
  try {
    console.error(`${tag} fetching from NASA Exoplanet Archive…`)
    const res = await fetch(KOI_TAP_URL, { signal: AbortSignal.timeout(60000) })
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
    const rows: KoiRow[] = []
    let dropped = 0
    for (const item of raw) {
      const parsed = parseTapRow(item as Record<string, unknown>)
      if (parsed) rows.push(parsed)
      else dropped++
    }
    console.error(`${tag} parsed ${rows.length} KOI rows (${dropped} dropped for missing required fields)`)
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
 * @description GET /api/koi — returns the KOI cumulative catalog with
 * stale-while-revalidate freshness: any cached copy is served
 * immediately with its TRUE `fetchedAt`; when older than the 7-day TTL
 * it is additionally flagged `stale: true` and a background refresh is
 * kicked off (deduped). Only a missing/legacy cache blocks on the TAP
 * fetch. On total failure with no cache, returns
 * `{ source: 'unavailable', rows: [], error }` so the client renders a
 * visible "catalog unavailable" state instead of pretending the sky is
 * empty.
 * @returns JSON `KoiResponse`.
 */
export async function GET() {
  const tag = '[koi]'
  console.error(`${tag} GET /api/koi`)

  const cached = await readCatalogCache<KoiRow>(DISK_CACHE_FILE, tag)
  if (cached) {
    const stale = cached.ageMs > DISK_CACHE_TTL_MS
    console.error(
      `${tag} disk cache HIT (${cached.rows.length} KOIs, age ${Math.round(cached.ageMs / 3600000)}h${stale ? ' — STALE, revalidating in background' : ''})`,
    )
    if (stale) void revalidateInBackground(tag)
    return NextResponse.json<KoiResponse>({
      source: 'cached',
      rows: cached.rows,
      fetchedAt: cached.fetchedAt,
      ...(stale ? { stale: true } : {}),
    })
  }

  const result = await fetchFromTap(tag)
  if ('error' in result) {
    return NextResponse.json<KoiResponse>({
      source: 'unavailable',
      rows: [],
      fetchedAt: 0,
      error: result.error,
    })
  }
  const fetchedAt = await writeCatalogCache(DISK_CACHE_FILE, result.rows, tag)
  return NextResponse.json<KoiResponse>({
    source: 'real',
    rows: result.rows,
    fetchedAt,
  })
}
