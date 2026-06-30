import type { StarSource } from './store'
import { quadrantFor } from './quadrants'

/**
 * @description A single entry in the star catalog. RA/Dec are in degrees, magnitude follows
 * the standard astronomical scale (lower = brighter), and colorIndex is the
 * B-V index used to map a star to its visual color in the renderer.
 *
 * `source` tags which mission catalog the entry came from (Kepler / TESS /
 * Hipparcos), if any. Undefined for synthetic fillers and entries that
 * predate the merge passes (e.g. raw Hipparcos rows before mission-merge
 * tags them). Drives the per-mission color in the renderer.
 */
export interface CatalogStar {
  id: string
  name: string
  ra: number
  dec: number
  magnitude: number
  colorIndex: number
  hasAnomaly: boolean
  anomalyScore: number
  source?: StarSource
  /**
   * @description Kepler-field quadrant id (e.g. "C4") for stars
   * inside RA 290–305 / Dec 36–52. Assigned by the KOI and TOI
   * merges. Undefined for non-anomaly entries and any star outside
   * the grid. Drives the per-quadrant HUD overlay.
   */
  quadrant?: string
}

/**
 * @description Hand-curated list of real stars known for anomalous light curves. These act
 * as guaranteed seeds in the catalog so the explorer always has something
 * interesting to find, even when the synthetic catalog fills in the rest.
 */
export const KNOWN_ANOMALIES: CatalogStar[] = [
  {
    id: 'KIC8462852',
    name: "Tabby's Star",
    ra: 301.5642,
    dec: 44.4567,
    magnitude: 11.7,
    colorIndex: 0.64,
    hasAnomaly: true,
    anomalyScore: 0.94,
  },
  {
    id: 'KIC6543674',
    name: 'KIC 6543674',
    ra: 291.12,
    dec: 41.88,
    magnitude: 12.3,
    colorIndex: 0.71,
    hasAnomaly: true,
    anomalyScore: 0.67,
  },
  {
    id: 'KIC4150804',
    name: 'KIC 4150804',
    ra: 288.55,
    dec: 39.42,
    magnitude: 13.1,
    colorIndex: 0.58,
    hasAnomaly: true,
    anomalyScore: 0.72,
  },
  {
    id: 'KIC11610797',
    name: 'KIC 11610797',
    ra: 298.77,
    dec: 49.21,
    magnitude: 12.8,
    colorIndex: 0.81,
    hasAnomaly: true,
    anomalyScore: 0.61,
  },
  {
    id: 'EPIC201637175',
    name: 'EPIC 201637175',
    ra: 174.32,
    dec: -4.67,
    magnitude: 12.1,
    colorIndex: 0.55,
    hasAnomaly: true,
    anomalyScore: 0.58,
  },
  {
    id: 'KIC11852982',
    name: 'KIC 11852982',
    ra: 294.87,
    dec: 47.48,
    magnitude: 12.4,
    colorIndex: 0.71,
    hasAnomaly: true,
    anomalyScore: 0.63,
  },
  {
    id: 'KIC3542116',
    name: 'KIC 3542116',
    ra: 284.22,
    dec: 38.71,
    magnitude: 13.1,
    colorIndex: 0.58,
    hasAnomaly: true,
    anomalyScore: 0.61,
  },
  {
    id: 'KIC8548587',
    name: 'KIC 8548587',
    ra: 296.34,
    dec: 44.82,
    magnitude: 11.9,
    colorIndex: 0.82,
    hasAnomaly: true,
    anomalyScore: 0.59,
  },
  {
    id: 'KIC5955033',
    name: 'KIC 5955033',
    ra: 290.11,
    dec: 41.23,
    magnitude: 12.7,
    colorIndex: 0.65,
    hasAnomaly: true,
    anomalyScore: 0.57,
  },
  {
    id: 'KIC12557548',
    name: 'KIC 12557548',
    ra: 295.54,
    dec: 51.09,
    magnitude: 15.7,
    colorIndex: 0.95,
    hasAnomaly: true,
    anomalyScore: 0.71,
  },
  {
    id: 'KIC10195478',
    name: 'KIC 10195478',
    ra: 291.78,
    dec: 47.35,
    magnitude: 13.2,
    colorIndex: 0.73,
    hasAnomaly: true,
    anomalyScore: 0.58,
  },
]

/**
 * @description Returns the catalog used by the renderer. Calls our own
 * `/api/stars` proxy so we hit VizieR server-side and avoid browser CORS.
 * If the proxy returns the fallback shape (or fails entirely) we fill the
 * sky with synthetic stars so the user always sees something to navigate.
 * @returns Catalog of known anomalies followed by either real Hipparcos
 * stars or synthetic fillers.
 */
export async function fetchHipparcosCatalog(): Promise<CatalogStar[]> {
  try {
    const res = await fetch('/api/stars')
    if (!res.ok) throw new Error(`stars proxy returned ${res.status}`)
    const data = (await res.json()) as { stars: CatalogStar[]; source: 'real' | 'fallback' }
    // Real responses already include KNOWN_ANOMALIES + ~5000 Hipparcos stars.
    // Fallback responses are just KNOWN_ANOMALIES — pad with synthetic fillers
    // so the sky doesn't look empty.
    if (data.source === 'real') return data.stars
    return generateSyntheticCatalog()
  } catch {
    return generateSyntheticCatalog()
  }
}

/**
 * @description Builds an ~8000-star synthetic catalog with uniformly random sky positions
 * and plausible magnitudes/colors. KNOWN_ANOMALIES is prepended so they
 * always appear regardless of seeding.
 * @returns Combined catalog (known anomalies first, then synthetic fillers).
 */
function generateSyntheticCatalog(): CatalogStar[] {
  const stars: CatalogStar[] = [...KNOWN_ANOMALIES]
  for (let i = 0; i < 8000; i++) {
    stars.push({
      id: `SYN${i}`,
      name: `Star ${i}`,
      ra: Math.random() * 360,
      dec: (Math.random() - 0.5) * 180,
      magnitude: 2 + Math.random() * 10,
      colorIndex: -0.3 + Math.random() * 2.0,
      hasAnomaly: false,
      anomalyScore: 0,
    })
  }
  return stars
}

/**
 * @description Wire-shape of one KOI row returned by `/api/koi`. Mirrors
 * the route's `KoiRow` interface (kept in sync by hand because crossing
 * the route boundary with a shared type adds bundler complexity for one
 * field set).
 */
interface KoiClientRow {
  id: string
  name: string
  ra: number
  dec: number
  disposition: 'CONFIRMED' | 'CANDIDATE'
  period: number
  depth: number
  duration: number
  score: number
}

interface KoiClientResponse {
  source: 'real' | 'cached' | 'unavailable'
  rows: KoiClientRow[]
  fetchedAt: number
  error?: string
}

/**
 * @description Result of `fetchKOICatalog`. `stars` is the merged catalog
 * the renderer should display. `koiCount` is the number of unique KOI
 * stars (deduped by kepid) — drives the HUD anomaly counter so it shows
 * the global scientific count, not the per-selected-star dip count.
 * `error` is non-null when the KOI fetch failed; the catalog may still
 * be usable (Hipparcos + KNOWN_ANOMALIES only) but the UI should
 * surface the degraded state.
 */
export interface MergedCatalog {
  stars: CatalogStar[]
  koiCount: number
  error?: string
}

/**
 * @description Distance threshold for declaring two stars "the same" when
 * merging KOI rows with Hipparcos entries. 0.01° ≈ 36 arcsec — generous
 * for a position match. In practice Hipparcos tops out at mag ~9 and
 * KOIs are mag 11–17, so the catalogs barely overlap; this merge is
 * mostly defensive correctness rather than a frequent join.
 */
const KOI_HIPPARCOS_MATCH_DEG = 0.01

/**
 * @description Computes the anomalyScore for a KOI row using the formula
 * specified in the catalog rollout: half of koi_score + depth bonus
 * (capped at 0.3 for very deep transits, ~20,000 ppm = 2% dip) +
 * confirmation bonus. CONFIRMED planets always score at least 0.2, so
 * the HUD shows them as at least NOTABLE.
 * @param koi One KOI row.
 * @returns anomalyScore in [0, 1], clamped.
 */
function scoreFromKoi(koi: KoiClientRow): number {
  const raw =
    koi.score * 0.5 +
    Math.min(koi.depth / 20000, 0.3) +
    (koi.disposition === 'CONFIRMED' ? 0.2 : 0)
  return Math.max(0, Math.min(1, raw))
}

/**
 * @description Result of `fetchKOICatalog` (raw KOI rows only, no merge).
 * The page-level orchestrator handles merging with Hipparcos so that the
 * two fetches can show independent loading states in the UI.
 */
export interface KoiFetchResult {
  rows: KoiClientRow[]
  source: 'real' | 'cached' | 'unavailable'
  error?: string
}

/**
 * @description Fetches the KOI catalog from `/api/koi` and dedupes by
 * kepid (a single Kepler star can host multiple KOIs — Kepler-90 has 8).
 * Returns the deduped rows so the page can merge them with the
 * Hipparcos catalog at its leisure. Doesn't fall back to the Hipparcos
 * catalog itself — that decoupling is what lets the page show two
 * independent loading messages.
 * @returns Deduped KOI rows + source/error metadata.
 */
export async function fetchKOICatalog(): Promise<KoiFetchResult> {
  let koiData: KoiClientResponse
  try {
    const res = await fetch('/api/koi')
    if (!res.ok) throw new Error(`koi route returned ${res.status}`)
    koiData = (await res.json()) as KoiClientResponse
  } catch (e) {
    return { rows: [], source: 'unavailable', error: (e as Error).message ?? 'KOI fetch failed' }
  }

  if (koiData.source === 'unavailable' || koiData.rows.length === 0) {
    return { rows: [], source: 'unavailable', error: koiData.error ?? 'KOI catalog unavailable' }
  }

  // Dedupe KOI rows by kepid (= the `id` field), keeping the highest score.
  const koiByKepid = new Map<string, KoiClientRow>()
  for (const row of koiData.rows) {
    const existing = koiByKepid.get(row.id)
    if (!existing || row.score > existing.score) {
      koiByKepid.set(row.id, row)
    }
  }
  return { rows: [...koiByKepid.values()], source: koiData.source }
}

/**
 * @description Merges a deduped KOI catalog into a Hipparcos catalog by
 * position. For each KOI row, looks for a Hipparcos entry within
 * `KOI_HIPPARCOS_MATCH_DEG` (also checks by id first so seeded
 * `KNOWN_ANOMALIES` are recognized). If found, marks the existing entry
 * `hasAnomaly: true` and bumps `anomalyScore` if the KOI score is
 * higher. Otherwise adds the KOI star as a new entry with default
 * magnitude/color (the KOI table doesn't carry photometry).
 *
 * Uses a sparse RA/Dec grid for O(N + M) lookups instead of the naive
 * O(N×M) inner product — ~6,000 KOIs × ~5,000 Hipparcos would be 30M
 * comparisons every page load otherwise.
 *
 * Mutates the input `hipparcos` array's entries in place (cheaper than
 * cloning ~5,000 objects) but returns a new array reference so React
 * state updates correctly detect the change.
 * @param hipparcos Hipparcos catalog from `fetchHipparcosCatalog`.
 * @param kois Deduped KOI rows from `fetchKOICatalog`.
 * @returns Merged catalog + counts useful for debugging.
 */
export function mergeKoiIntoHipparcos(
  hipparcos: CatalogStar[],
  kois: KoiClientRow[],
): MergedCatalog {
  // Index Hipparcos stars into a sparse RA/Dec grid for cheap proximity
  // lookups. Bucket size = match threshold so each KOI checks at most 9
  // buckets (its own + 8 neighbors).
  const bucketKey = (ra: number, dec: number) =>
    `${Math.floor(ra / KOI_HIPPARCOS_MATCH_DEG)}|${Math.floor(dec / KOI_HIPPARCOS_MATCH_DEG)}`
  const hipparcosGrid = new Map<string, CatalogStar[]>()
  for (const s of hipparcos) {
    const key = bucketKey(s.ra, s.dec)
    const bucket = hipparcosGrid.get(key)
    if (bucket) bucket.push(s)
    else hipparcosGrid.set(key, [s])
  }
  const byId = new Map<string, CatalogStar>(hipparcos.map(s => [s.id, s]))

  const merged: CatalogStar[] = [...hipparcos]
  let addedAsNew = 0
  let matchedExisting = 0

  for (const koi of kois) {
    // Id match first — handles KNOWN_ANOMALIES seeds and any other case
    // where the same KIC already appears in the Hipparcos response.
    const existingById = byId.get(koi.id)
    if (existingById) {
      existingById.hasAnomaly = true
      existingById.source = 'Kepler'
      existingById.quadrant = quadrantFor(existingById.ra, existingById.dec) ?? undefined
      const koiScore = scoreFromKoi(koi)
      if (koiScore > existingById.anomalyScore) existingById.anomalyScore = koiScore
      matchedExisting++
      continue
    }

    // Position match: check the 9 buckets around the KOI's bucket since
    // a star near a bucket edge could fall in any neighbor.
    let match: CatalogStar | null = null
    const baseRaBucket = Math.floor(koi.ra / KOI_HIPPARCOS_MATCH_DEG)
    const baseDecBucket = Math.floor(koi.dec / KOI_HIPPARCOS_MATCH_DEG)
    let bestDist = KOI_HIPPARCOS_MATCH_DEG
    for (let dRa = -1; dRa <= 1; dRa++) {
      for (let dDec = -1; dDec <= 1; dDec++) {
        const bucket = hipparcosGrid.get(`${baseRaBucket + dRa}|${baseDecBucket + dDec}`)
        if (!bucket) continue
        for (const cand of bucket) {
          const d = Math.hypot(cand.ra - koi.ra, cand.dec - koi.dec)
          if (d < bestDist) { bestDist = d; match = cand }
        }
      }
    }

    if (match) {
      match.hasAnomaly = true
      match.source = 'Kepler'
      match.quadrant = quadrantFor(match.ra, match.dec) ?? undefined
      const koiScore = scoreFromKoi(koi)
      if (koiScore > match.anomalyScore) match.anomalyScore = koiScore
      matchedExisting++
    } else {
      // No Hipparcos counterpart — add the KOI as a new sky entry. KOIs
      // are Kepler PDC targets, mag ~11–17 with unknown color (TAP
      // doesn't give us photometry). Default mag 13.5 (midpoint) and
      // colorIndex 0.65 (solar-yellow) so they render as visible
      // yellowish points rather than disappearing.
      const newEntry: CatalogStar = {
        id: koi.id,
        name: koi.name,
        ra: koi.ra,
        dec: koi.dec,
        magnitude: 13.5,
        colorIndex: 0.65,
        hasAnomaly: true,
        anomalyScore: scoreFromKoi(koi),
        source: 'Kepler',
        quadrant: quadrantFor(koi.ra, koi.dec) ?? undefined,
      }
      merged.push(newEntry)
      byId.set(koi.id, newEntry)
      addedAsNew++
    }
  }

  console.log(
    `[koi-merge] ${kois.length} unique KOIs · ${matchedExisting} matched existing entries · ${addedAsNew} added as new sky points`,
  )

  return { stars: merged, koiCount: kois.length }
}

// ─── TOI catalog (TESS Object of Interest) ─────────────────────────────────

/**
 * @description Wire-shape of one TOI row from /api/toi. Mirrors the
 * route's `ToiRow`. We don't share the type across the route/client
 * boundary to avoid bundler weirdness around importing server-only code.
 */
interface ToiClientRow {
  id: string
  name: string
  ra: number
  dec: number
  disposition: 'CP' | 'KP' | 'PC'
  period: number
  depth: number
  duration: number
  magnitude: number
}

interface ToiClientResponse {
  source: 'real' | 'cached' | 'unavailable'
  rows: ToiClientRow[]
  fetchedAt: number
  error?: string
}

/**
 * @description Result of `fetchTOICatalog` (raw, deduped rows). Same
 * shape as KOI's `KoiFetchResult` so the page-level orchestrator can
 * treat the two missions symmetrically.
 */
export interface ToiFetchResult {
  rows: ToiClientRow[]
  source: 'real' | 'cached' | 'unavailable'
  error?: string
}

/**
 * @description Result of `mergeToiIntoCatalog`. Returns the merged
 * catalog plus the unique TOI star count for the HUD counter.
 */
export interface ToiMergeResult {
  stars: CatalogStar[]
  toiCount: number
}

/** @description Hipparcos↔TOI position match threshold; same as KOI's. */
const TOI_HIPPARCOS_MATCH_DEG = 0.01

/**
 * @description Scoring formula for TOI rows. Mirrors KOI's depth-based
 * approach: depth term capped at 0.3 (saturates at 20,000 ppm = 2%
 * dip) + a 0.2 confirmation bonus for CP/KP (TESS-confirmed and
 * externally-confirmed planets). PC (candidate) gets no bonus.
 *
 * The literal spec asked for the dip-detector formula (`depth*3 +
 * sigma/8 + asymmetry*0.1`) but TOI doesn't carry sigma or asymmetry
 * and `pl_trandep` is in ppm — applying that formula naively would
 * make a 1% dip score 0.03 (NORMAL band). Using KOI's shape keeps the
 * score scale comparable across both missions.
 * @param toi One TOI row.
 * @returns anomalyScore in [0, 1], clamped.
 */
function scoreFromToi(toi: ToiClientRow): number {
  const depthBonus = Math.min(toi.depth / 20000, 0.3)
  const confirmedBonus = toi.disposition === 'CP' || toi.disposition === 'KP' ? 0.2 : 0
  return Math.max(0, Math.min(1, depthBonus + confirmedBonus))
}

/**
 * @description Fetches the TOI catalog from `/api/toi` and dedupes by
 * TIC id (a single TIC can host multiple TOIs — TIC 290131778 hosts
 * the TRAPPIST-1 system, for example). Returns the deduped rows so
 * the page can merge them at its leisure. Mirrors `fetchKOICatalog`
 * exactly so the page can treat both missions symmetrically.
 * @returns Deduped TOI rows + source/error metadata.
 */
export async function fetchTOICatalog(): Promise<ToiFetchResult> {
  let toiData: ToiClientResponse
  try {
    const res = await fetch('/api/toi')
    if (!res.ok) throw new Error(`toi route returned ${res.status}`)
    toiData = (await res.json()) as ToiClientResponse
  } catch (e) {
    return { rows: [], source: 'unavailable', error: (e as Error).message ?? 'TOI fetch failed' }
  }

  if (toiData.source === 'unavailable' || toiData.rows.length === 0) {
    return { rows: [], source: 'unavailable', error: toiData.error ?? 'TOI catalog unavailable' }
  }

  // Dedupe by TIC id (= the `id` field), keeping the highest-scoring
  // entry per star. The score function reflects depth + confirmation,
  // so the "best" surviving TOI per star is the most-confirmed-and-
  // deepest of that star's candidates.
  const toiByTid = new Map<string, ToiClientRow>()
  for (const row of toiData.rows) {
    const existing = toiByTid.get(row.id)
    if (!existing || scoreFromToi(row) > scoreFromToi(existing)) {
      toiByTid.set(row.id, row)
    }
  }
  return { rows: [...toiByTid.values()], source: toiData.source }
}

/**
 * @description Merges a deduped TOI catalog into the working star
 * catalog (which may already contain Hipparcos entries and previously-
 * merged KOIs). Same algorithm as `mergeKoiIntoHipparcos`:
 *
 *   1. Id match — if the TIC id is already present, mark hasAnomaly,
 *      bump the score, tag source as 'TESS' (overwriting Kepler tag
 *      is fine; same star, different mission catalog).
 *   2. Position match within `TOI_HIPPARCOS_MATCH_DEG` via a sparse
 *      RA/Dec bucket grid (O(N+M) lookup).
 *   3. Otherwise add as a new sky entry with default colorIndex 0.65
 *      and magnitude from `st_tmag` (TESS magnitude — bright TESS
 *      targets are mag 6–13, much brighter than Kepler PDC).
 *
 * Important: id collisions between KIC and TIC are vanishingly rare
 * (different mission, different ID space, prefixed). Position
 * collisions between KOI and TOI ARE possible (many Kepler stars
 * were re-observed by TESS) — when both catalogs claim the same
 * star, the LAST merge wins the source tag. TESS runs after KOI in
 * `page.tsx`, so dual-mission stars end up tagged 'TESS'. This is
 * acceptable for visual distinction since the mission overlap is
 * small relative to the per-mission catalog size.
 * @param catalog Working catalog (Hipparcos + KOI merged).
 * @param tois Deduped TOI rows.
 * @returns Merged catalog + TOI count.
 */
export function mergeToiIntoCatalog(
  catalog: CatalogStar[],
  tois: ToiClientRow[],
): ToiMergeResult {
  const bucketKey = (ra: number, dec: number) =>
    `${Math.floor(ra / TOI_HIPPARCOS_MATCH_DEG)}|${Math.floor(dec / TOI_HIPPARCOS_MATCH_DEG)}`
  const grid = new Map<string, CatalogStar[]>()
  for (const s of catalog) {
    const key = bucketKey(s.ra, s.dec)
    const bucket = grid.get(key)
    if (bucket) bucket.push(s)
    else grid.set(key, [s])
  }
  const byId = new Map<string, CatalogStar>(catalog.map(s => [s.id, s]))

  const merged: CatalogStar[] = [...catalog]
  let addedAsNew = 0
  let matchedExisting = 0

  for (const toi of tois) {
    const existingById = byId.get(toi.id)
    if (existingById) {
      existingById.hasAnomaly = true
      existingById.source = 'TESS'
      existingById.quadrant = quadrantFor(existingById.ra, existingById.dec) ?? undefined
      const toiScore = scoreFromToi(toi)
      if (toiScore > existingById.anomalyScore) existingById.anomalyScore = toiScore
      matchedExisting++
      continue
    }

    let match: CatalogStar | null = null
    const baseRa = Math.floor(toi.ra / TOI_HIPPARCOS_MATCH_DEG)
    const baseDec = Math.floor(toi.dec / TOI_HIPPARCOS_MATCH_DEG)
    let bestDist = TOI_HIPPARCOS_MATCH_DEG
    for (let dRa = -1; dRa <= 1; dRa++) {
      for (let dDec = -1; dDec <= 1; dDec++) {
        const bucket = grid.get(`${baseRa + dRa}|${baseDec + dDec}`)
        if (!bucket) continue
        for (const cand of bucket) {
          const d = Math.hypot(cand.ra - toi.ra, cand.dec - toi.dec)
          if (d < bestDist) { bestDist = d; match = cand }
        }
      }
    }

    if (match) {
      match.hasAnomaly = true
      match.source = 'TESS'
      match.quadrant = quadrantFor(match.ra, match.dec) ?? undefined
      const toiScore = scoreFromToi(toi)
      if (toiScore > match.anomalyScore) match.anomalyScore = toiScore
      matchedExisting++
    } else {
      // New sky entry. TESS magnitude (`st_tmag`) is reported when
      // available; fall back to 11 (median TESS target brightness)
      // when missing. ColorIndex unknown → 0.65 (solar-yellow).
      const newEntry: CatalogStar = {
        id: toi.id,
        name: toi.name,
        ra: toi.ra,
        dec: toi.dec,
        magnitude: toi.magnitude > 0 ? toi.magnitude : 11,
        colorIndex: 0.65,
        hasAnomaly: true,
        anomalyScore: scoreFromToi(toi),
        source: 'TESS',
        quadrant: quadrantFor(toi.ra, toi.dec) ?? undefined,
      }
      merged.push(newEntry)
      byId.set(toi.id, newEntry)
      addedAsNew++
    }
  }

  console.log(
    `[toi-merge] ${tois.length} unique TOIs · ${matchedExisting} matched existing entries · ${addedAsNew} added as new sky points`,
  )

  return { stars: merged, toiCount: tois.length }
}
