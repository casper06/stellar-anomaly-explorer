// SPDX-License-Identifier: MIT
/**
 * @description Dip detector — scans a normalized flux time series for
 * sustained drops below a threshold and scores each event. Extracted from
 * the app's `anomalyDetector.ts` (which retains the app-side lightcurve
 * client) so the detector, like the rest of the engine, is portable and
 * dependency-free.
 */

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
  let lastValidIdx = -1
  for (let i = 0; i < flux.length; i++) {
    if (flux[i] === null || isNaN(flux[i])) continue
    lastValidIdx = i
    const norm = flux[i] / avgFlux
    if (norm < effThreshold && !inDip) {
      inDip = true
      dipStart = i
    } else if (inDip && (norm >= effThreshold || i === flux.length - 1)) {
      runs.push({ startIdx: dipStart, endIdx: i })
      inDip = false
    }
  }
  // Force-close a run still open when the loop ends. The in-loop
  // `i === flux.length - 1` closure only fires when the LAST sample is
  // finite — a null/NaN at the final index is skipped by the `continue`
  // above, so a dip still in progress when the curve ends in invalid data
  // would otherwise be silently dropped. Close it at the last valid index.
  if (inDip && lastValidIdx >= dipStart) {
    runs.push({ startIdx: dipStart, endIdx: lastValidIdx })
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
