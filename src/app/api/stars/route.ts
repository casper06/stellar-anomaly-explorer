import { NextResponse } from 'next/server'
import { KNOWN_ANOMALIES } from '@/lib/starCatalog'

const VIZIER_URL =
  'https://vizier.cds.unistra.fr/viz-bin/TSV?-source=I/239/hip_main&-out=HIP,RArad,DErad,Vmag,B-V&-out.max=5000&-oc.form=dec'

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
 * VizieR puts a few `#`-prefixed header lines, then a column-name row,
 * a unit row, a separator row of dashes, and finally tab-separated data.
 * Empty/non-numeric rows are dropped.
 * @param tsv Raw TSV body from VizieR.
 * @returns Parsed rows in our internal star shape.
 */
function parseVizierTsv(tsv: string): StarRow[] {
  const lines = tsv.split(/\r?\n/)
  const stars: StarRow[] = []
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue
    const cols = line.split('\t')
    // First non-comment line is the column-name row; skip it (and any row
    // whose first column isn't a number).
    const hip = cols[0]?.trim()
    if (!hip || !/^\d+$/.test(hip)) continue
    const ra = parseFloat(cols[1])
    const dec = parseFloat(cols[2])
    const mag = parseFloat(cols[3])
    const bv = parseFloat(cols[4])
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
 * Falls back to KNOWN_ANOMALIES alone if VizieR is unreachable.
 * @returns JSON `{ stars, source: 'real' | 'fallback' }`.
 */
export async function GET() {
  if (cached) return NextResponse.json(cached)

  try {
    const res = await fetch(VIZIER_URL, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`VizieR returned ${res.status}`)
    const tsv = await res.text()
    const parsed = parseVizierTsv(tsv)
    if (parsed.length < 100) throw new Error('VizieR returned too few rows')
    // Prepend known anomalies so they always appear up front
    const stars: StarRow[] = [...KNOWN_ANOMALIES, ...parsed]
    cached = { stars, source: 'real' }
    return NextResponse.json(cached)
  } catch {
    const fallback: { stars: StarRow[]; source: 'fallback' } = {
      stars: [...KNOWN_ANOMALIES],
      source: 'fallback',
    }
    // Don't cache fallback — retry on the next request.
    return NextResponse.json(fallback)
  }
}
