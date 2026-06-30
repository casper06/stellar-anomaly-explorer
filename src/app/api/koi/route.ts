import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * @description NASA Exoplanet Archive TAP endpoint for the KOI cumulative
 * table. Selects only the columns we render or score against, filters to
 * dispositions a user would care about (CONFIRMED planets and pending
 * CANDIDATEs). Returns ~9,500 rows as of 2026, one per Kepler Object of
 * Interest (a single star can have multiple KOIs — see dedupe in the
 * starCatalog client).
 */
const KOI_TAP_URL =
  'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' +
  'query=' +
  encodeURIComponent(
    "select kepid,kepoi_name,koi_disposition,koi_period,koi_depth,koi_duration,koi_score,ra,dec " +
      "from cumulative " +
      "where koi_disposition in ('CONFIRMED','CANDIDATE')",
  ) +
  '&format=json'

/**
 * @description Disk cache TTL. KOI catalog changes infrequently (new
 * dispositions are pushed in batches every few months) and a stale day-old
 * copy is fine for an interactive sky viewer.
 */
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const DISK_CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')
const DISK_CACHE_FILE = path.join(DISK_CACHE_DIR, 'koi-catalog.json')

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
  fetchedAt: number  // epoch ms (or 0 for unavailable)
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
 * @description Reads a cached KOI catalog from disk. Returns null if the
 * file is missing, stale, or unparseable. Mirrors the lightcurve route's
 * disk-cache semantics so behavior is predictable across both routes.
 * @param tag Log prefix.
 */
async function readDiskCache(tag: string): Promise<KoiRow[] | null> {
  try {
    const stat = await fs.stat(DISK_CACHE_FILE)
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs > DISK_CACHE_TTL_MS) {
      console.error(`${tag} disk cache is stale (${Math.round(ageMs / 3600000)}h old); refetching`)
      return null
    }
    const raw = await fs.readFile(DISK_CACHE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { rows: KoiRow[] }
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
      console.error(`${tag} disk cache malformed; ignoring`)
      return null
    }
    console.error(`${tag} disk cache HIT (${parsed.rows.length} KOIs, age ${Math.round(ageMs / 3600000)}h)`)
    return parsed.rows
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${tag} disk cache read error:`, e)
    }
    return null
  }
}

/**
 * @description Atomically writes the catalog to disk via temp + rename so
 * a partial write can't surface as a corrupt cache file.
 * @param rows Parsed catalog.
 * @param tag Log prefix.
 */
async function writeDiskCache(rows: KoiRow[], tag: string): Promise<void> {
  const tmp = `${DISK_CACHE_FILE}.${process.pid}.tmp`
  try {
    await fs.mkdir(DISK_CACHE_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify({ rows }), 'utf8')
    await fs.rename(tmp, DISK_CACHE_FILE)
    console.error(`${tag} disk cache WROTE ${rows.length} KOIs → ${DISK_CACHE_FILE}`)
  } catch (e) {
    console.error(`${tag} disk cache write error:`, e)
    try { await fs.unlink(tmp) } catch { /* ignore */ }
  }
}

/**
 * @description GET /api/koi — returns the KOI cumulative catalog. Disk
 * cache first (24h TTL); on miss, hits the NASA Exoplanet Archive TAP
 * endpoint, parses the JSON response, writes to disk, returns. On
 * total failure returns `{ source: 'unavailable', rows: [], error }`
 * so the client can render a visible "catalog unavailable" state
 * instead of pretending the sky is empty.
 * @returns JSON `KoiResponse`.
 */
export async function GET() {
  const tag = '[koi]'
  console.error(`${tag} GET /api/koi`)

  const cached = await readDiskCache(tag)
  if (cached) {
    return NextResponse.json<KoiResponse>({
      source: 'cached',
      rows: cached,
      fetchedAt: Date.now(),
    })
  }

  try {
    console.error(`${tag} fetching from NASA Exoplanet Archive…`)
    const res = await fetch(KOI_TAP_URL, { signal: AbortSignal.timeout(60000) })
    console.error(`${tag} TAP status: ${res.status} ${res.statusText}`)
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>')
      console.error(`${tag} TAP body (first 500): ${body.slice(0, 500)}`)
      return NextResponse.json<KoiResponse>({
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
      return NextResponse.json<KoiResponse>({
        source: 'unavailable',
        rows: [],
        fetchedAt: 0,
        error: 'TAP response was not valid JSON',
      })
    }
    if (!Array.isArray(raw)) {
      console.error(`${tag} TAP response was not an array`)
      return NextResponse.json<KoiResponse>({
        source: 'unavailable',
        rows: [],
        fetchedAt: 0,
        error: 'TAP response was not an array',
      })
    }
    const rows: KoiRow[] = []
    let dropped = 0
    for (const item of raw) {
      const parsed = parseTapRow(item as Record<string, unknown>)
      if (parsed) rows.push(parsed)
      else dropped++
    }
    console.error(`${tag} parsed ${rows.length} KOI rows (${dropped} dropped for missing required fields)`)
    if (rows.length === 0) {
      return NextResponse.json<KoiResponse>({
        source: 'unavailable',
        rows: [],
        fetchedAt: 0,
        error: 'TAP returned 0 usable rows',
      })
    }
    void writeDiskCache(rows, tag)
    return NextResponse.json<KoiResponse>({
      source: 'real',
      rows,
      fetchedAt: Date.now(),
    })
  } catch (e) {
    console.error(`${tag} fetch failed:`, e)
    return NextResponse.json<KoiResponse>({
      source: 'unavailable',
      rows: [],
      fetchedAt: 0,
      error: (e as Error).message ?? 'unknown error',
    })
  }
}
