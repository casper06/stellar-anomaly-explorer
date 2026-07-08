/**
 * @description One detected dip in a light curve, with everything needed to render it on
 * the curve chart and to summarize it in the side panel. Index fields point
 * into the original flux/times arrays; time fields are precomputed for
 * convenience.
 */
export interface Dip {
  startIdx: number
  endIdx: number
  minIdx: number
  startTime: number
  endTime: number
  peakTime: number
  minFlux: number
  depth: number
  duration: number
  asymmetry: number
  score: number
  label: 'NORMAL' | 'NOTABLE' | 'INTERESTING' | 'WOW'
}

/**
 * @description Sigma multiple for the noise-relative threshold floor. When
 * a curve's robust noise is high enough that the fixed 1% threshold stops
 * being a meaningful cut (see DIP_NOISE_GATE_SIGMA), the in-dip threshold
 * becomes `1 − 3σ_rob` — the classic detection floor — so "dip" always
 * means "at least a 3-sigma excursion below baseline" regardless of the
 * mission's typical noise level.
 */
export const DIP_NOISE_SIGMA_K = 3

/**
 * @description Robust-noise gate above which the sigma-relative floor
 * replaces the fixed threshold. The fixed 0.990 was calibrated on Kepler
 * PDC photometry; the noisiest star in the frozen calibration set
 * (K01725.01) measures σ_rob = 0.575%, and the pathological TESS case
 * (TOI 5523.02) measures 1.43% — 0.75% sits between them with margin on
 * both sides, so the detector's calibrated Kepler-domain behavior is
 * bit-identical below the gate and the noise floor takes over beyond it.
 * (At σ_rob = 0.75% the fixed threshold is only a 1.3σ cut — already
 * outside any meaningful detection regime.)
 */
export const DIP_NOISE_GATE_SIGMA = 0.0075

/**
 * @description Runs separated by less than this many days of
 * above-threshold flux are merged into one dip — noise crossing back
 * over the threshold for a couple of samples must not split one physical
 * event into fragments. Deliberately below Kepler's 30-min cadence
 * (0.0204 d), so at Kepler sampling this pass is a structural no-op and
 * legacy behavior is preserved exactly; at TESS 2-min cadence it heals
 * gaps of up to ~7 samples.
 */
export const DIP_MERGE_GAP_DAYS = 0.01

/**
 * @description Minimum dip duration in days (start to recovery sample).
 * Kills sample-scale noise blips on high-cadence data: a single 2-min
 * TESS sample below threshold spans ~0.0014 d and is dropped, while a
 * single 30-min Kepler sample spans 0.0204 d and is kept — so, like the
 * merge pass, this is a structural no-op at Kepler cadence. Real
 * transits last hours and clear it by an order of magnitude.
 */
export const MIN_DIP_DURATION_DAYS = 0.02

/**
 * @description Robust noise estimate: 1.4826 × the median absolute
 * deviation around the median. Insensitive to transits/eclipses (which
 * occupy a minority of samples) where a plain standard deviation is not.
 * @param flux Flux samples; non-finite entries are ignored.
 * @returns Robust sigma, or 0 when no finite samples exist.
 */
export function robustFluxSigma(flux: number[]): number {
  const valid = flux.filter(f => Number.isFinite(f)).sort((a, b) => a - b)
  if (valid.length === 0) return 0
  const median = valid[Math.floor(valid.length / 2)]
  const deviations = valid.map(f => Math.abs(f - median)).sort((a, b) => a - b)
  return 1.4826 * deviations[Math.floor(deviations.length / 2)]
}

/**
 * @description Scans a normalized flux time series for dips (sustained drops below a
 * fraction of mean flux) and scores each one by depth, sigma above noise,
 * asymmetry between pre/post baselines, and duration. Returns dips sorted
 * by score (highest first) so the panel can show the most notable events
 * up top.
 *
 * Weights and label thresholds were recalibrated against real Kepler PDC
 * data — the prior tuning was set for the noisier synthetic generator and
 * under-scored truly anomalous events (a 20% dip in Tabby's Star scored
 * NOTABLE instead of WOW). The new tuning weights depth more heavily and
 * shifts the label cutoffs down so real-world dips land in the right bin.
 *
 * High-noise guard (2026-07-07, the TOI 5523.02 fix): the fixed 1%
 * threshold was calibrated for Kepler-level noise (σ ~0.1–0.3%). On a
 * σ≈1.6% TESS 2-min curve it sat at 0.6σ, so ~24% of samples counted as
 * "in a dip" and fragmented into 12,431 single-sample runs. Three
 * measures fix this without changing behavior on any of the frozen
 * Kepler fixtures (verified: all 7 counts bit-identical):
 * 1. When σ_rob > DIP_NOISE_GATE_SIGMA, the threshold becomes
 *    `1 − DIP_NOISE_SIGMA_K·σ_rob` (a consistent 3σ cut).
 * 2. Runs separated by < DIP_MERGE_GAP_DAYS are merged (fragmentation).
 * 3. Dips shorter than MIN_DIP_DURATION_DAYS are dropped (sample-scale
 *    blips). Both time-based guards are structural no-ops at Kepler's
 *    30-min cadence.
 * This is a detection-sensitivity calibration, not a claim about what is
 * "real": it makes "dip" mean the same statistical thing (≥3σ, sustained)
 * across missions with different noise levels.
 * @param flux Sampled flux values. NaN/null entries are skipped silently.
 * @param times Timestamps matched 1:1 with `flux` (typically BKJD).
 * @param threshold Normalized-flux cutoff that defines "in a dip" (default 0.990 = 1.0% below mean). On high-noise curves the effective cutoff is the noise-relative floor described above, whichever is lower.
 * @returns Detected dips sorted by descending score.
 */
export function detectDips(flux: number[], times: number[], threshold = 0.990): Dip[] {
  if (!flux || flux.length === 0) return []

  const validFlux = flux.filter(f => !isNaN(f) && f !== null)
  const avgFlux = validFlux.reduce((a, b) => a + b, 0) / validFlux.length
  const variance = validFlux.reduce((a, b) => a + (b - avgFlux) ** 2, 0) / validFlux.length
  const stdFlux = Math.sqrt(variance)

  // Noise-relative threshold floor — active only beyond the gate, so the
  // fixed threshold's calibrated Kepler-domain behavior is untouched.
  const sigmaRob = robustFluxSigma(flux)
  const effThreshold =
    sigmaRob > DIP_NOISE_GATE_SIGMA
      ? Math.min(threshold, 1 - DIP_NOISE_SIGMA_K * sigmaRob)
      : threshold

  // Pass 1 — scan contiguous below-threshold runs (same traversal
  // semantics as the original detector: non-finite samples are skipped
  // and do NOT end a run; endIdx is the recovery sample).
  const runs: Array<{ startIdx: number; endIdx: number }> = []
  let inDip = false
  let dipStart = 0
  for (let i = 0; i < flux.length; i++) {
    if (flux[i] === null || isNaN(flux[i])) continue
    const norm = flux[i] / avgFlux
    if (norm < effThreshold && !inDip) {
      inDip = true
      dipStart = i
    } else if (inDip && (norm >= effThreshold || i === flux.length - 1)) {
      runs.push({ startIdx: dipStart, endIdx: i })
      inDip = false
    }
  }

  // Pass 2 — merge runs separated by a short above-threshold gap.
  const merged: Array<{ startIdx: number; endIdx: number }> = []
  for (const run of runs) {
    const prev = merged[merged.length - 1]
    if (prev && times[run.startIdx] - times[prev.endIdx] < DIP_MERGE_GAP_DAYS) {
      prev.endIdx = run.endIdx
    } else {
      merged.push({ ...run })
    }
  }

  // Pass 3 — score each surviving run (min-duration filter inline).
  const dips: Dip[] = []
  for (const run of merged) {
    const duration = times[run.endIdx] - times[run.startIdx]
    if (duration < MIN_DIP_DURATION_DAYS) continue

    let dipMin = Infinity
    let dipMinIdx = run.startIdx
    for (let i = run.startIdx; i <= run.endIdx; i++) {
      const f = flux[i]
      if (f === null || isNaN(f)) continue
      if (f < dipMin) { dipMin = f; dipMinIdx = i }
    }
    if (!Number.isFinite(dipMin)) continue

    const fluxBefore = flux
      .slice(Math.max(0, run.startIdx - 5), run.startIdx)
      .filter(f => f !== null && !isNaN(f))
    const fluxAfter = flux
      .slice(run.endIdx, Math.min(flux.length, run.endIdx + 5))
      .filter(f => f !== null && !isNaN(f))
    const avgBefore = fluxBefore.length
      ? fluxBefore.reduce((a, b) => a + b, 0) / fluxBefore.length
      : avgFlux
    const avgAfter = fluxAfter.length
      ? fluxAfter.reduce((a, b) => a + b, 0) / fluxAfter.length
      : avgFlux
    const asymmetry = Math.abs(avgBefore - avgAfter) / avgFlux
    const depth = (avgFlux - dipMin) / avgFlux
    const sigma = (avgFlux - dipMin) / (stdFlux || 1)
    // Depth is no longer pre-weighted to <1; a 20% dip alone (depth=0.20)
    // contributes 0.60 to the raw score, which on its own is enough to
    // land at WOW. Sigma and asymmetry add headroom for cases where the
    // dip is also statistically clean / unusually asymmetric. Final
    // score is clamped to 1 by `Math.min` below.
    const rawScore =
      depth * 3 +
      Math.min(sigma / 8, 0.3) +
      asymmetry * 0.1
    const score = Math.min(rawScore, 1)
    const label =
      score >= 0.60 ? 'WOW'
      : score >= 0.40 ? 'INTERESTING'
      : score >= 0.20 ? 'NOTABLE'
      : 'NORMAL'

    dips.push({
      startIdx: run.startIdx,
      endIdx: run.endIdx,
      minIdx: dipMinIdx,
      startTime: times[run.startIdx],
      endTime: times[run.endIdx],
      peakTime: times[dipMinIdx],
      minFlux: dipMin,
      depth,
      duration,
      asymmetry,
      score,
      label,
    })
  }
  return dips.sort((a, b) => b.score - a.score)
}

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
