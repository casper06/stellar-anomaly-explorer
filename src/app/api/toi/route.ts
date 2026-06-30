import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * @description NASA Exoplanet Archive TAP endpoint for the TOI (TESS
 * Object of Interest) table. Selects only the columns we render or
 * score against. The disposition filter is applied client-side (in the
 * parse step) rather than in ADQL because the TFOPWG disposition set
 * has several "confirmed" variants (CP, KP) and we want to include
 * all of them — easier to manage in TypeScript.
 *
 * NOTE on column names: the spec called the TIC ID column `tic_id`
 * but the actual schema uses `tid`. Confirmed live against the API.
 */
const TOI_TAP_URL =
  'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' +
  'query=' +
  encodeURIComponent(
    'select toi,tid,ra,dec,tfopwg_disp,pl_trandep,pl_trandurh,pl_orbper,st_tmag ' +
      'from toi',
  ) +
  '&format=json'

/**
 * @description Disk cache TTL. TOI catalog updates are weekly to monthly;
 * a day-old copy is fine for interactive viewing. Same TTL as KOI for
 * consistency.
 */
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const DISK_CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')
const DISK_CACHE_FILE = path.join(DISK_CACHE_DIR, 'toi-catalog.json')

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
  fetchedAt: number
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
 * @description Reads a cached TOI catalog from disk. Returns null on
 * miss, stale, or malformed. Same semantics as /api/koi's helper.
 * @param tag Log prefix.
 */
async function readDiskCache(tag: string): Promise<ToiRow[] | null> {
  try {
    const stat = await fs.stat(DISK_CACHE_FILE)
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs > DISK_CACHE_TTL_MS) {
      console.error(`${tag} disk cache is stale (${Math.round(ageMs / 3600000)}h old); refetching`)
      return null
    }
    const raw = await fs.readFile(DISK_CACHE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { rows: ToiRow[] }
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
      console.error(`${tag} disk cache malformed; ignoring`)
      return null
    }
    console.error(`${tag} disk cache HIT (${parsed.rows.length} TOIs, age ${Math.round(ageMs / 3600000)}h)`)
    return parsed.rows
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${tag} disk cache read error:`, e)
    }
    return null
  }
}

/**
 * @description Atomic temp+rename write. Identical to the KOI helper.
 * @param rows Parsed catalog.
 * @param tag Log prefix.
 */
async function writeDiskCache(rows: ToiRow[], tag: string): Promise<void> {
  const tmp = `${DISK_CACHE_FILE}.${process.pid}.tmp`
  try {
    await fs.mkdir(DISK_CACHE_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify({ rows }), 'utf8')
    await fs.rename(tmp, DISK_CACHE_FILE)
    console.error(`${tag} disk cache WROTE ${rows.length} TOIs → ${DISK_CACHE_FILE}`)
  } catch (e) {
    console.error(`${tag} disk cache write error:`, e)
    try { await fs.unlink(tmp) } catch { /* ignore */ }
  }
}

/**
 * @description GET /api/toi — returns the TOI catalog. Disk cache first
 * (24h TTL); on miss, hits the NASA Exoplanet Archive TAP endpoint,
 * filters dispositions, parses to ToiRow, writes to disk, returns. On
 * total failure returns `{ source: 'unavailable', rows: [], error }`
 * so the client can show a "TESS catalog unavailable" state.
 * @returns JSON `ToiResponse`.
 */
export async function GET() {
  const tag = '[toi]'
  console.error(`${tag} GET /api/toi`)

  const cached = await readDiskCache(tag)
  if (cached) {
    return NextResponse.json<ToiResponse>({
      source: 'cached',
      rows: cached,
      fetchedAt: Date.now(),
    })
  }

  try {
    console.error(`${tag} fetching from NASA Exoplanet Archive…`)
    const res = await fetch(TOI_TAP_URL, { signal: AbortSignal.timeout(60000) })
    console.error(`${tag} TAP status: ${res.status} ${res.statusText}`)
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>')
      console.error(`${tag} TAP body (first 500): ${body.slice(0, 500)}`)
      return NextResponse.json<ToiResponse>({
        source: 'unavailable',
        rows: [],
        fetchedAt: 0,
        error: `TAP returned HTTP ${res.status}`,
      })
    }
    const text = await res.text()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      console.error(`${tag} TAP JSON parse error:`, e)
      console.error(`${tag} TAP body (first 500): ${text.slice(0, 500)}`)
      return NextResponse.json<ToiResponse>({
        source: 'unavailable',
        rows: [],
        fetchedAt: 0,
        error: 'TAP response was not valid JSON',
      })
    }
    if (!Array.isArray(raw)) {
      console.error(`${tag} TAP response was not an array`)
      return NextResponse.json<ToiResponse>({
        source: 'unavailable',
        rows: [],
        fetchedAt: 0,
        error: 'TAP response was not an array',
      })
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
    if (rows.length === 0) {
      return NextResponse.json<ToiResponse>({
        source: 'unavailable',
        rows: [],
        fetchedAt: 0,
        error: 'TAP returned 0 usable rows',
      })
    }
    void writeDiskCache(rows, tag)
    return NextResponse.json<ToiResponse>({
      source: 'real',
      rows,
      fetchedAt: Date.now(),
    })
  } catch (e) {
    console.error(`${tag} fetch failed:`, e)
    return NextResponse.json<ToiResponse>({
      source: 'unavailable',
      rows: [],
      fetchedAt: 0,
      error: (e as Error).message ?? 'unknown error',
    })
  }
}
