import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { KNOWN_ANOMALIES } from '@/lib/starCatalog'
import { VIZIER_HIP_URL, VIZIER_REQUIRED_COLUMNS } from '@/lib/externalEndpoints'

// VizieR query for the Hipparcos main catalog (I/239/hip_main) lives in
// `@/lib/externalEndpoints` (single source of truth shared with the
// external-health check). It is the FULL-catalog form — no `Vmag` ceiling,
// so all ~118,000 Hipparcos entries are requested, not just the ~8,800
// naked-eye stars. Position columns are the catalog-native ICRS degrees
// (`RAICRS`/`DEICRS`); columns are located BY NAME from the header row and
// a missing required column throws (contract-change detection, not garbage
// coordinates).

/** @description Columns the parser requires, by VizieR name. */
const REQUIRED_COLUMNS = VIZIER_REQUIRED_COLUMNS

interface StarRow {
  id: string
  name: string
  ra: number
  dec: number
  magnitude: number
  colorIndex: number
  hasAnomaly: boolean
  anomalyScore: number
}

/**
 * @description In-process cache of the parsed catalog. Hipparcos is static,
 * so we only ever pay the ~118k-row parse cost once per server process.
 * The disk cache below survives restarts.
 */
let cached: { stars: StarRow[]; source: 'real' | 'fallback' } | null = null

/** @description Directory + file for the on-disk parsed-catalog cache. */
const DISK_CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')
const DISK_CACHE_FILE = path.join(DISK_CACHE_DIR, 'hipparcos-catalog.json')

/**
 * @description Disk-cache schema version. Bump when the parse output shape
 * changes (new fields, different id format) so stale-shaped entries are
 * treated as misses and refetched rather than served.
 */
const DISK_CACHE_SCHEMA_VERSION = 2

/**
 * @description Long TTL for the Hipparcos disk cache. The Hipparcos catalog
 * is a FIXED historical dataset (ESA, 1997) — it does not change — so a
 * 30-day TTL is purely a bound on local disk staleness / a periodic
 * re-fetch to recover from a cache written during a VizieR outage.
 */
const DISK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * @description Shape of the on-disk catalog cache. `count` and
 * `fetchedAt` sit before the big array so `head`-ing the file answers
 * "how many stars, fetched when, which schema" without parsing megabytes.
 */
interface DiskCacheEntry {
  schemaVersion: number
  fetchedAt: string
  count: number
  stars: StarRow[]
}

/**
 * @description Reads the parsed catalog from disk. Returns null on missing
 * file, stale TTL, schema mismatch, or a suspiciously small row count
 * (which would indicate a cache written during a partial/failed fetch).
 * @returns Parsed real catalog (KNOWN_ANOMALIES already prepended at write
 * time), or null to trigger a fresh VizieR fetch.
 */
async function readDiskCache(): Promise<StarRow[] | null> {
  try {
    const stat = await fs.stat(DISK_CACHE_FILE)
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs > DISK_CACHE_TTL_MS) {
      console.error(`[stars] disk cache stale (${Math.round(ageMs / 86400000)}d); refetching`)
      return null
    }
    const parsed = JSON.parse(await fs.readFile(DISK_CACHE_FILE, 'utf8')) as Partial<DiskCacheEntry>
    if (parsed.schemaVersion !== DISK_CACHE_SCHEMA_VERSION) {
      console.error(`[stars] disk cache schema v${parsed.schemaVersion ?? '<none>'} ≠ v${DISK_CACHE_SCHEMA_VERSION}; refetching`)
      return null
    }
    if (!Array.isArray(parsed.stars) || parsed.stars.length < 10000) {
      console.error(`[stars] disk cache has only ${parsed.stars?.length ?? 0} stars (expected ~118k); refetching`)
      return null
    }
    console.error(`[stars] disk cache HIT: ${parsed.stars.length} stars (age ${Math.round(ageMs / 3600000)}h)`)
    return parsed.stars
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[stars] disk cache read error:', e)
    }
    return null
  }
}

/**
 * @description Writes the parsed catalog to disk (temp + rename so a crash
 * mid-write can't leave a corrupt file). Stores the full array with
 * KNOWN_ANOMALIES already prepended so a cache hit needs no post-processing.
 * @param stars The full parsed catalog (anomaly seeds + Hipparcos rows).
 */
async function writeDiskCache(stars: StarRow[]): Promise<void> {
  const tmp = `${DISK_CACHE_FILE}.${process.pid}.tmp`
  const entry: DiskCacheEntry = {
    schemaVersion: DISK_CACHE_SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    count: stars.length,
    stars,
  }
  try {
    await fs.mkdir(DISK_CACHE_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(entry), 'utf8')
    await fs.rename(tmp, DISK_CACHE_FILE)
    console.error(`[stars] disk cache WROTE ${stars.length} stars → ${DISK_CACHE_FILE}`)
  } catch (e) {
    console.error('[stars] disk cache write error:', e)
    try { await fs.unlink(tmp) } catch { /* ignore */ }
  }
}

/**
 * @description Parses VizieR's TSV response into our CatalogStar shape.
 * VizieR emits `#`-prefixed comment lines, then a column-name row, a unit
 * row, a dash-separator row, then tab-separated data (numeric fields are
 * whitespace-padded). Columns are located BY NAME from the header row
 * rather than by position — VizieR silently drops unknown requested
 * columns, and a positional parser turns that into garbage coordinates
 * (this exact failure shipped the RArad/DErad breakage undetected).
 *
 * Also tolerates VizieR's error-envelope response (backend DB outage,
 * etc.), which carries `#INFO QUERY_STATUS=ERROR` and no data rows — that
 * surfaces as "0 usable rows" and the caller falls back loudly.
 * @param tsv Raw TSV body from VizieR.
 * @returns Parsed rows in our internal star shape.
 * @throws Error when any REQUIRED_COLUMNS name is missing from the header.
 */
function parseVizierTsv(tsv: string): StarRow[] {
  if (/QUERY_STATUS=ERROR/.test(tsv)) {
    const errLine = tsv.split(/\r?\n/).find(l => /#INFO\s+Error=/.test(l)) ?? '#INFO Error=<unknown>'
    throw new Error(`VizieR upstream error: ${errLine.replace(/^#INFO\s+Error=/, '').trim()}`)
  }
  // Drop comment lines AND the HTTP-header-echo lines VizieR prepends to the
  // body (`Content-Type:`, `Content-Disposition:`, `DocumentRef:`).
  const lines = tsv
    .split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && !l.startsWith('Content-') && !l.startsWith('DocumentRef'))
  const header = lines[0]?.split('\t').map(c => c.trim()) ?? []
  const col: Record<string, number> = {}
  header.forEach((name, i) => { col[name] = i })
  for (const required of REQUIRED_COLUMNS) {
    if (!(required in col)) {
      throw new Error(
        `VizieR response missing column '${required}' — got [${header.join(', ')}]. ` +
          'The VizieR contract likely changed; see the external-health check.',
      )
    }
  }
  const stars: StarRow[] = []
  for (const line of lines) {
    const cols = line.split('\t')
    const hip = cols[col.HIP]?.trim()
    // Skips the header/unit/separator rows too — none start with digits.
    if (!hip || !/^\d+$/.test(hip)) continue
    const ra = parseFloat(cols[col.RAICRS])
    const dec = parseFloat(cols[col.DEICRS])
    const mag = parseFloat(cols[col.Vmag])
    const bv = parseFloat(cols[col['B-V']] ?? '')
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(mag)) continue
    stars.push({
      id: `HIP${hip}`,
      name: `HIP ${hip}`,
      ra,
      dec,
      magnitude: mag,
      colorIndex: Number.isFinite(bv) ? bv : 0.6,
      hasAnomaly: false,
      anomalyScore: 0,
    })
  }
  return stars
}

/**
 * @description Prepends the KNOWN_ANOMALIES seeds to a parsed catalog,
 * guaranteeing they are present and appear first — REGARDLESS of the
 * source path (live fetch, disk cache, or fallback). The seeds are
 * hand-curated fixed entries (Tabby's Star et al.) that must always be
 * searchable / flaggable / visible even though most aren't ordinary
 * Hipparcos rows; they carry real Kepler light-curve data.
 *
 * Deduped by id: if a seed's id already appears in `parsed` (a rare
 * overlap, e.g. a seed that IS in Hipparcos), the seed wins and the
 * duplicate parsed row is dropped, so the seed's curated
 * position/score/anomaly flag is authoritative.
 *
 * This is defensive on purpose: earlier the seeds were baked into the
 * stored array at write time and NOT re-added on read, so any disk cache
 * written without them (e.g. injected test data during a VizieR outage)
 * silently dropped Tabby's Star from the app. Guaranteeing seeds at
 * serve time on every path removes that whole failure class.
 * @param parsed Hipparcos rows (or synthetic-scale rows).
 * @returns Seeds first, then every parsed row whose id isn't a seed.
 */
function withKnownAnomalies(parsed: StarRow[]): StarRow[] {
  const seedIds = new Set(KNOWN_ANOMALIES.map(s => s.id))
  const deduped = parsed.filter(s => !seedIds.has(s.id))
  return [...KNOWN_ANOMALIES, ...deduped]
}

/**
 * @description GET /api/stars — proxies the FULL ~118k-star Hipparcos main
 * catalog from VizieR (server-side, so the browser doesn't hit CORS),
 * parses the TSV, and ALWAYS merges in the KNOWN_ANOMALIES seeds (via
 * `withKnownAnomalies`) so they're present on every path. Serves an
 * on-disk cache first (30-day TTL, since the Hipparcos dataset is fixed),
 * then the in-process cache, then a live VizieR fetch. Falls back to
 * KNOWN_ANOMALIES alone if VizieR is unreachable — and LOGS the reason
 * loudly: a silent fallback is how a VizieR endpoint change once went
 * undetected while users saw a synthetic sky.
 * @returns JSON `{ stars, source: 'real' | 'fallback' }`.
 */
export async function GET() {
  if (cached) return NextResponse.json(cached)

  // L2 disk cache — the 118k parse is worth persisting across restarts.
  // Re-inject seeds at serve time in case the cached file predates the
  // seed guarantee or was written without them.
  const onDisk = await readDiskCache()
  if (onDisk) {
    cached = { stars: withKnownAnomalies(onDisk), source: 'real' }
    return NextResponse.json(cached)
  }

  try {
    // 90s timeout — the full catalog is a multi-MB TSV and VizieR can be
    // slow cold; the old 20s bound was fine for the 8,800-row query but
    // risks a spurious abort on the full pull.
    const res = await fetch(VIZIER_HIP_URL, { signal: AbortSignal.timeout(90000) })
    if (!res.ok) throw new Error(`VizieR returned ${res.status}`)
    const tsv = await res.text()
    const parsed = parseVizierTsv(tsv)
    if (parsed.length < 10000) {
      throw new Error(`VizieR returned only ${parsed.length} usable rows (expected ~118,000)`)
    }
    console.error(`[stars] VizieR OK: ${parsed.length} Hipparcos stars (full all-sky catalog)`)
    // Prepend known anomalies (deduped) so they always appear up front.
    const stars: StarRow[] = withKnownAnomalies(parsed)
    cached = { stars, source: 'real' }
    void writeDiskCache(stars)
    return NextResponse.json(cached)
  } catch (e) {
    console.error(
      '[stars] VizieR fetch FAILED — serving fallback (client will render a synthetic sky):',
      e instanceof Error ? e.message : e,
    )
    const fallback: { stars: StarRow[]; source: 'fallback' } = {
      stars: [...KNOWN_ANOMALIES],
      source: 'fallback',
    }
    // Don't cache fallback — retry on the next request.
    return NextResponse.json(fallback)
  }
}
