import { NextResponse } from 'next/server'
import { KNOWN_ANOMALIES } from '@/lib/starCatalog'

/**
 * @description VizieR query for the Hipparcos main catalog (I/239/hip_main).
 * - Endpoint is `/viz-bin/asu-tsv` — the older `/viz-bin/TSV` path started
 *   returning 404 (discovered 2026-07-04 after the app had been silently
 *   serving the synthetic fallback).
 * - Position columns are the catalog's native ICRS degrees, `RAICRS` /
 *   `DEICRS` — the previously-requested `RArad`/`DErad` names are no
 *   longer honored and were being silently dropped from the response.
 * - `Vmag=%3C6.5` (Vmag < 6.5) selects the ~8,800 naked-eye stars,
 *   properly distributed across the WHOLE sky. This replaced the old
 *   unfiltered `-out.max=5000` request, which — because HIP ids are
 *   assigned in RA order — accidentally returned a thin RA 0–16° slice
 *   instead of a sky.
 * - `-out.max=12000` is safely above the ~8,785 rows the filter passes.
 */
const VIZIER_URL =
  'https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=I/239/hip_main&-out=HIP,RAICRS,DEICRS,Vmag,B-V&Vmag=%3C6.5&-out.max=12000&-oc.form=dec'

/** @description Columns the parser requires, by VizieR name. */
const REQUIRED_COLUMNS = ['HIP', 'RAICRS', 'DEICRS', 'Vmag'] as const

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
 * @description Cached parsed catalog. Hipparcos is static, so we only ever
 * pay the parse cost once per server process.
 */
let cached: { stars: StarRow[]; source: 'real' | 'fallback' } | null = null

/**
 * @description Parses VizieR's TSV response into our CatalogStar shape.
 * VizieR emits `#`-prefixed comment lines, then a column-name row, a unit
 * row, a dash-separator row, then tab-separated data (numeric fields are
 * whitespace-padded). Columns are located BY NAME from the header row
 * rather than by position — VizieR silently drops unknown requested
 * columns, and a positional parser turns that into garbage coordinates
 * (this exact failure shipped the RArad/DErad breakage undetected).
 * @param tsv Raw TSV body from VizieR.
 * @returns Parsed rows in our internal star shape.
 * @throws Error when any REQUIRED_COLUMNS name is missing from the header
 * — the caller treats that as a contract change, not an empty sky.
 */
function parseVizierTsv(tsv: string): StarRow[] {
  const lines = tsv.split(/\r?\n/).filter(l => l && !l.startsWith('#'))
  // First remaining line is the column-name row.
  const header = lines[0]?.split('\t').map(c => c.trim()) ?? []
  const col: Record<string, number> = {}
  header.forEach((name, i) => { col[name] = i })
  for (const required of REQUIRED_COLUMNS) {
    if (!(required in col)) {
      throw new Error(
        `VizieR response missing column '${required}' — got [${header.join(', ')}]. ` +
          'The VizieR contract likely changed; see the health check.',
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
 * @description GET /api/stars — proxies the Hipparcos main catalog from
 * VizieR (server-side, so the browser doesn't hit CORS), parses the TSV,
 * and merges in the KNOWN_ANOMALIES seeds so they're always present.
 * Falls back to KNOWN_ANOMALIES alone if VizieR is unreachable — and LOGS
 * the reason loudly: a silent fallback is how a VizieR endpoint change
 * once went undetected while users saw a synthetic sky.
 * @returns JSON `{ stars, source: 'real' | 'fallback' }`.
 */
export async function GET() {
  if (cached) return NextResponse.json(cached)

  try {
    const res = await fetch(VIZIER_URL, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`VizieR returned ${res.status}`)
    const tsv = await res.text()
    const parsed = parseVizierTsv(tsv)
    if (parsed.length < 1000) {
      throw new Error(`VizieR returned only ${parsed.length} usable rows (expected ~8,800)`)
    }
    console.error(`[stars] VizieR OK: ${parsed.length} Hipparcos stars (Vmag < 6.5, all-sky)`)
    // Prepend known anomalies so they always appear up front
    const stars: StarRow[] = [...KNOWN_ANOMALIES, ...parsed]
    cached = { stars, source: 'real' }
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
