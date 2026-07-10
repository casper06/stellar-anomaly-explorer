/**
 * @description App-side lightcurve CLIENT: fetches curves from our
 * `/api/lightcurve/[id]` route, carries the provenance labels, and holds
 * the dev-only synthetic generator. The dip DETECTOR itself (detectDips,
 * Dip, the noise-guard constants) lives in the extracted MIT engine
 * package (`packages/stellar-vetting-engine`, via the `./dipDetector`
 * shim) — this module re-exports it so existing app imports keep working.
 */
export {
  detectDips,
  robustFluxSigma,
  DIP_NOISE_SIGMA_K,
  DIP_NOISE_GATE_SIGMA,
  DIP_MERGE_GAP_DAYS,
  MIN_DIP_DURATION_DAYS,
  type Dip,
} from './dipDetector'

/**
 * @description Provenance of a fetched light curve.
 * - `'real'`: we successfully pulled and parsed Kepler PDC data from MAST.
 * - `'unavailable'`: the real fetch failed and we explicitly did NOT
 *   substitute synthetic data (production behavior). The UI should make
 *   this state visible, not paper over it with fake data.
 * - `'synthetic'`: a synthetic curve was substituted. Only emitted in local
 *   development (`NODE_ENV === 'development'`) so the dev workflow doesn't
 *   require a network round-trip to MAST.
 */
export type LightcurveSource = 'real' | 'unavailable' | 'synthetic'

/**
 * @description Where the light curve data came from. Surfaced per-dip in
 * the UI so the user can cite/trust the source. All three fields are
 * short, display-ready strings.
 * - `sourceName`: archive/provider (e.g. "NASA/MAST", "Synthetic generator").
 * - `mission`: telescope/mission (e.g. "Kepler", "TESS", "—" for synthetic).
 * - `dataType`: photometric pipeline output (e.g. "PDCSAP flux").
 */
export interface LightcurveProvenance {
  sourceName: string
  mission: string
  dataType: string
}

/**
 * @description Light curve payload returned by `fetchLightcurve`. The
 * `source` field tells the UI whether to show a "REAL DATA" or "SYNTHETIC"
 * badge so the user knows what they're looking at; `provenance` carries
 * the human-readable archive/mission/pipeline labels.
 *
 * `mission` is the actual archive that served the data ('Kepler' | 'TESS'),
 * or null when the curve is synthetic / unavailable. `gapDays` is the
 * recommended threshold (in days) for breaking the canvas line at
 * observation-gap boundaries — Kepler has 1–4 day inter-quarter gaps so 5
 * is safe; TESS has more frequent ~1-day sector boundaries so 2 is
 * tighter and still safely above intra-sector cadence.
 */
export interface LightcurveResult {
  times: number[]
  flux: number[]
  source: LightcurveSource
  provenance: LightcurveProvenance
  mission?: 'Kepler' | 'TESS' | null
  gapDays?: number
  /**
   * @description True when MAST served fewer segments than its TAP listing
   * said exist (an incomplete curve). Threaded through to the UI's PARTIAL
   * badge. Undefined/false = complete or not-real data.
   */
  partial?: boolean
  /** @description Segment coverage `{ recovered, expected }`; drives the "N/M" in the PARTIAL badge. */
  segments?: { recovered: number; expected: number }
}

/**
 * @description Options for `fetchLightcurve`. `ra`/`dec` are passed
 * through to the route as a hint for the cone-search path (stars
 * without a KIC/TIC id). `onDemand` disables the dev-only synthetic
 * fallback — required for non-catalog stars, where we promise the
 * user "real data or unavailable", never fake.
 */
export interface FetchLightcurveOptions {
  ra?: number
  dec?: number
  onDemand?: boolean
}

/**
 * @description Fetches a star's light curve from our `/api/lightcurve/[id]`
 * route. The route tries real Kepler or TESS PDC data via MAST first
 * (mission picked from the id prefix — KIC → Kepler, TIC → TESS). For
 * ids that don't carry a mission cross-reference (HIP*, SYN*, etc.) we
 * pass through `ra`/`dec` so the route can cone-search MAST for any
 * observation at that position.
 *
 * If MAST has no data:
 *   - `onDemand=false` (catalog click): synthetic in dev, unavailable
 *     in production.
 *   - `onDemand=true` (clicked a Hipparcos / synthetic star): NEVER
 *     synthetic — `'unavailable'` immediately, in any environment.
 *
 * This client mirrors the route's policy if the route itself is
 * unreachable (e.g. dev server stopped).
 * @param starId Catalog id (e.g. "KIC8462852").
 * @param opts Optional position hint + on-demand flag.
 * @returns Times, normalized flux, source, provenance, mission tag,
 * and the recommended gap-break threshold.
 */
export async function fetchLightcurve(
  starId: string,
  opts: FetchLightcurveOptions = {},
): Promise<LightcurveResult> {
  const params = new URLSearchParams()
  if (opts.ra !== undefined && Number.isFinite(opts.ra)) params.set('ra', String(opts.ra))
  if (opts.dec !== undefined && Number.isFinite(opts.dec)) params.set('dec', String(opts.dec))
  if (opts.onDemand) params.set('onDemand', '1')
  const qs = params.toString()
  const url = `/api/lightcurve/${encodeURIComponent(starId)}${qs ? `?${qs}` : ''}`
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`lightcurve route returned ${res.status}`)
    const data = (await res.json()) as LightcurveResult
    return data
  } catch (err) {
    // Surface why we're falling back. Silent synthesis here hides real bugs
    // (CORS, JSON parse, route 500) and makes the UI lie about provenance.
    console.error(`[fetchLightcurve] ${url} failed, falling back:`, err)
    // On-demand never synthesizes; mirror the route's promise.
    if (process.env.NODE_ENV === 'development' && !opts.onDemand) {
      return {
        ...generateSyntheticLightcurve(starId),
        source: 'synthetic',
        provenance: SYNTHETIC_PROVENANCE,
        mission: null,
        gapDays: 5,
      }
    }
    return {
      times: [],
      flux: [],
      source: 'unavailable',
      provenance: UNAVAILABLE_PROVENANCE,
      mission: null,
      gapDays: 5,
    }
  }
}

/** @description Provenance label used when the synthetic generator runs (dev only). */
export const SYNTHETIC_PROVENANCE: LightcurveProvenance = {
  sourceName: 'Synthetic generator',
  mission: '—',
  dataType: 'Synthetic flux',
}

/** @description Provenance label used when the real fetch failed in production. */
export const UNAVAILABLE_PROVENANCE: LightcurveProvenance = {
  sourceName: 'NASA/MAST',
  mission: 'Kepler',
  dataType: 'PDCSAP flux (unavailable)',
}

/** @description Provenance label used for real Kepler PDC data from MAST. */
export const KEPLER_PROVENANCE: LightcurveProvenance = {
  sourceName: 'NASA/MAST',
  mission: 'Kepler',
  dataType: 'PDCSAP flux',
}

/** @description Provenance label used for real TESS PDC data from MAST. */
export const TESS_PROVENANCE: LightcurveProvenance = {
  sourceName: 'NASA/MAST',
  mission: 'TESS',
  dataType: 'PDCSAP flux',
}

/**
 * @description Generates a deterministic-feeling synthetic light curve with characteristic
 * dip patterns for known anomalies (Tabby's Star, KIC 6543674, KIC 4150804)
 * and a generic two-dip baseline for everything else. Noise is sampled at
 * ~0.3% so detection has plausible signal-to-noise.
 * @param starId Catalog id; controls which dip pattern is overlaid.
 * @returns Paired arrays of times (BKJD) and flux values clamped to ≥0.5.
 */
export function generateSyntheticLightcurve(starId: string): { times: number[]; flux: number[] } {
  const isTabbys = starId.includes('8462852')
  const isKIC6 = starId.includes('6543674')
  const isKIC4 = starId.includes('4150804')
  const nPoints = 1200
  const times = Array.from({ length: nPoints }, (_, i) => 130 + i * 0.02043)
  const flux: number[] = []

  for (let i = 0; i < nPoints; i++) {
    let f = 1.0
    f += (Math.random() - 0.5) * 0.003
    f += 0.0002 * Math.sin(i / 200)

    if (isTabbys) {
      if (i >= 180 && i <= 210) { const t = (i - 180) / 30; f -= 0.15 * Math.sin(Math.PI * t) * (t < 0.5 ? 1 : 0.6) }
      if (i >= 420 && i <= 465) { const t = (i - 420) / 45; f -= 0.22 * Math.pow(Math.sin(Math.PI * t), 1.3) * (t < 0.4 ? 1.2 : 0.5) }
      if (i >= 680 && i <= 700) { const t = (i - 680) / 20; f -= 0.08 * Math.sin(Math.PI * t) }
      if (i >= 900 && i <= 950) { const t = (i - 900) / 50; f -= 0.18 * Math.pow(Math.sin(Math.PI * t), 0.8) }
    } else if (isKIC6) {
      if (i >= 200 && i <= 230) { const t = (i - 200) / 30; f -= 0.06 * (t < 0.3 ? t / 0.3 : Math.exp(-(t - 0.3) * 3)) }
      if (i >= 600 && i <= 640) { const t = (i - 600) / 40; f -= 0.09 * (t < 0.2 ? t / 0.2 : Math.exp(-(t - 0.2) * 4)) }
    } else if (isKIC4) {
      const phase = (i % 80) / 80
      f -= 0.04 * Math.pow(Math.sin(Math.PI * phase), 2)
      if (i >= 500 && i <= 530) { const t = (i - 500) / 30; f -= 0.13 * Math.sin(Math.PI * t) }
    } else {
      if (i >= 300 && i <= 325) { const t = (i - 300) / 25; f -= 0.11 * Math.sin(Math.PI * t) }
      if (i >= 750 && i <= 790) { const t = (i - 750) / 40; f -= 0.16 * Math.sin(Math.PI * t) }
    }
    flux.push(Math.max(0.5, f))
  }
  return { times, flux }
}
