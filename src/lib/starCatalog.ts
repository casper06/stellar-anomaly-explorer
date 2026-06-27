/**
 * @description A single entry in the star catalog. RA/Dec are in degrees, magnitude follows
 * the standard astronomical scale (lower = brighter), and colorIndex is the
 * B-V index used to map a star to its visual color in the renderer.
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
