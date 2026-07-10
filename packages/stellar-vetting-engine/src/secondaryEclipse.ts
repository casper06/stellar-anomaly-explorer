// SPDX-License-Identifier: MIT
/**
 * @description Secondary-eclipse check — the companion vetting measurement
 * to the odd/even depth comparison (`oddEven.ts`). Using the BLS period
 * and epoch, it measures whether the flux dims at phase 0.5 — the point
 * of the fold directly opposite the primary transit. The measurement is
 * reported as numbers (depth, significance, ratio to the primary depth);
 * consumers must present it descriptively and never translate it into a
 * physical cause (describe-don't-diagnose, per `curveClassifier.ts`).
 * A shallow phase-0.5 dimming is a real, physical phenomenon for some
 * genuine planets (reflected light / thermal emission of hot Jupiters,
 * typically tens-to-hundreds of ppm) — which is exactly why this check
 * reports the measured depth and ratio instead of a verdict about what
 * the object is.
 *
 * Geometry note (learned from the odd/even fixture work): this check and
 * odd/even are COMPLEMENTARY views of the same eclipsing-binary
 * signature, selected by which period BLS locks. Locked at the HALF
 * period, primary and secondary eclipses alternate at phase 0 → odd/even
 * fires and phase 0.5 is empty. Locked at the TRUE period, the secondary
 * sits at phase ~0.5 → this check fires and odd/even reads consistent.
 *
 * Method — same per-cycle machinery as odd/even, aimed at phase 0.5:
 * 1. Each finite sample gets a cycle index relative to the SECONDARY
 *    center `t₀ + P/2`: `n = round((t − t₀ − P/2) / P)`.
 * 2. In-window = within one primary-duration box of that center (for a
 *    near-circular orbit the secondary duration ≈ the primary duration).
 *    LIMITATION: an eccentric system's secondary is displaced from phase
 *    0.5 and is missed — the check answers "is there a dimming AT phase
 *    0.5", not "is there a secondary anywhere in the fold".
 * 3. Per-cycle local baseline = median of the flanking window
 *    `duration/2 < |dt| ≤ BASELINE_WINDOW_DUR_MULT × duration` (same
 *    slow-variability robustness as odd/even; the flank never reaches
 *    the primary for duty cycles below ~20%).
 * 4. Per-cycle depth = baseline − median(in-window); pooled across all
 *    cycles into mean ± standard error → z-statistic.
 *
 * Partial curves are handled the same way as odd/even, and for the same
 * reason: the phase-0.5 window recurs EVERY cycle, so a missing quarter
 * removes whole cycles (their phase-0 and phase-0.5 slices alike) rather
 * than the secondary window preferentially. Lost coverage only reduces
 * the cycle count, which widens the standard error — partial data makes
 * this check more conservative, never more alarmist. The one geometry
 * that could starve the window preferentially (P on the order of the
 * ~90 d quarter length) cannot reach MIN_CYCLES usable cycles and
 * returns null through the ordinary gate.
 */
import type { BlsResult } from './bls'

/**
 * @description Result of the phase-0.5 dimming measurement. All fields
 * are measurements; `verdict` is a threshold call on them (documented on
 * SECONDARY_SIGMA_THRESHOLD), still phrased as a property of the data.
 */
export interface SecondaryEclipseResult {
  /**
   * Mean dimming at phase 0.5 in ppm of the local baseline. Can be
   * negative (the fold is BRIGHTER there than its surroundings) — a
   * negative value always reads NOT_DETECTED.
   */
  depthPpm: number
  /**
   * Depth in units of its pooled standard error. Sign follows the
   * depth (negative = brightening). Capped at ±DIFF_SIGMA_CAP.
   */
  sigma: number
  /** Number of cycles with usable in-window + baseline coverage. */
  cycles: number
  /**
   * Measured phase-0.5 depth as a percentage of the BLS primary depth.
   * Null when the primary depth isn't positive (nothing meaningful to
   * ratio against). This is the number that lets a user compare the
   * two dips without the UI labeling the comparison.
   */
  ratioToPrimaryPct: number | null
  /**
   * `DETECTED` when the dimming is positive and clears
   * SECONDARY_SIGMA_THRESHOLD; `NOT_DETECTED` otherwise.
   */
  verdict: 'DETECTED' | 'NOT_DETECTED'
}

/**
 * @description Significance bar (in pooled-standard-error units) for
 * calling the phase-0.5 dimming detected. Same 3σ convention as the
 * odd/even check — below it the measurement is compatible with noise.
 */
export const SECONDARY_SIGMA_THRESHOLD = 3

/**
 * @description Minimum usable cycles before the measurement is
 * attempted. Mirrors odd/even's per-parity gate: below 3 depths the
 * empirical standard error itself is unreliable, so the check returns
 * null instead of a verdict.
 */
export const MIN_CYCLES = 3

/** @description Minimum finite in-window samples for a cycle to count. */
const MIN_IN_WINDOW_SAMPLES = 3

/** @description Minimum finite baseline samples for a cycle to count. */
const MIN_BASELINE_SAMPLES = 5

/**
 * @description Outer edge of the per-cycle baseline window, as a
 * multiple of the transit duration on each side of the phase-0.5
 * center. Same value as odd/even's for the same reason: ~4 durations of
 * local out-of-window samples without reaching the primary transit for
 * any duty cycle below ~20%.
 */
const BASELINE_WINDOW_DUR_MULT = 2.5

/** @description Cap for |sigma| so zero-noise synthetics stay finite. */
const DIFF_SIGMA_CAP = 99

/**
 * @description Measures the flux dimming at phase 0.5 of the BLS fold —
 * the classic secondary-eclipse position for a near-circular orbit.
 * Returns null when the geometry doesn't support a measurement: fewer
 * than MIN_CYCLES usable cycles, or a non-positive period/duration.
 * @param times Time samples in the curve's native day system (BKJD/TJD),
 * parallel to `flux`.
 * @param flux Normalized flux, parallel to `times`; non-finite entries
 * are skipped.
 * @param bls Confident BLS detection supplying period, epoch, duration,
 * and the primary depth the ratio is computed against.
 * @returns Phase-0.5 dimming measurement, or null when unmeasurable.
 */
export function measureSecondaryEclipse(
  times: number[],
  flux: number[],
  bls: BlsResult,
): SecondaryEclipseResult | null {
  const period = bls.periodDays
  const durationDays = bls.durationHours / 24
  if (!(period > 0) || !(durationDays > 0)) return null

  const secondaryEpoch = bls.epochDays + period / 2
  const halfDur = durationDays / 2
  const baselineEdge = durationDays * BASELINE_WINDOW_DUR_MULT

  const inWindow = new Map<number, number[]>()
  const baseline = new Map<number, number[]>()
  for (let i = 0; i < times.length; i++) {
    const f = flux[i]
    if (!Number.isFinite(f)) continue
    const t = times[i]
    if (!Number.isFinite(t)) continue
    const n = Math.round((t - secondaryEpoch) / period)
    const dt = Math.abs(t - secondaryEpoch - n * period)
    if (dt <= halfDur) {
      let arr = inWindow.get(n)
      if (!arr) inWindow.set(n, (arr = []))
      arr.push(f)
    } else if (dt <= baselineEdge) {
      let arr = baseline.get(n)
      if (!arr) baseline.set(n, (arr = []))
      arr.push(f)
    }
  }

  const depths: number[] = []
  for (const [n, inArr] of inWindow) {
    if (inArr.length < MIN_IN_WINDOW_SAMPLES) continue
    const baseArr = baseline.get(n)
    if (!baseArr || baseArr.length < MIN_BASELINE_SAMPLES) continue
    depths.push(median(baseArr) - median(inArr))
  }
  if (depths.length < MIN_CYCLES) return null

  const nCycles = depths.length
  const mean = depths.reduce((a, b) => a + b, 0) / nCycles
  const varSum = depths.reduce((a, b) => a + (b - mean) * (b - mean), 0)
  const se = Math.sqrt(varSum / (nCycles - 1)) / Math.sqrt(nCycles)
  const rawSigma = se > 0 ? mean / se : mean !== 0 ? Math.sign(mean) * DIFF_SIGMA_CAP : 0
  const sigma = Math.max(-DIFF_SIGMA_CAP, Math.min(DIFF_SIGMA_CAP, rawSigma))

  return {
    depthPpm: mean * 1e6,
    sigma,
    cycles: nCycles,
    ratioToPrimaryPct: bls.depthPpm > 0 ? (mean * 1e6 / bls.depthPpm) * 100 : null,
    verdict: mean > 0 && sigma >= SECONDARY_SIGMA_THRESHOLD ? 'DETECTED' : 'NOT_DETECTED',
  }
}

/**
 * @description Median of a numeric array (copies before sorting so the
 * caller's array order is preserved).
 * @param values Non-empty numeric array.
 * @returns The median value.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
