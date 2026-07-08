/**
 * @description Odd/even transit depth comparison — the standard first-order
 * vetting measurement applied to a confident periodic box signal. Using the
 * BLS period and epoch, every observed transit is assigned a cycle index
 * relative to the epoch; depths of odd-indexed and even-indexed transits
 * are averaged separately and compared. The measurement is reported as
 * numbers (per-parity mean depths, their difference in sigma and percent) —
 * consumers must present it descriptively and never translate it into a
 * physical cause (see the describe-don't-diagnose rule in
 * `curveClassifier.ts`).
 *
 * Method (flux-fold, mirroring the Kepler pipeline's DV odd/even test —
 * NOT based on the 1%-threshold dip detector, whose cutoff would drop
 * shallow transits entirely):
 * 1. Each finite sample gets a cycle index `n = round((t − epoch) / P)`.
 * 2. In-transit = within the BLS box: `|t − epoch − nP| ≤ duration/2`.
 * 3. Per-cycle local baseline = median of samples in the flanking window
 *    `duration/2 < |dt| ≤ BASELINE_WINDOW_DUR_MULT × duration`, so slow
 *    stellar variability doesn't masquerade as a depth difference.
 * 4. Per-cycle depth = baseline − median(in-transit), for cycles with
 *    enough samples on both sides.
 * 5. Split cycles by parity of `n`; compare group means with a z-statistic
 *    built from the empirical per-group standard errors.
 *
 * Partial curves (the `partial` flag from the MAST segment pool) are NOT
 * treated specially: a missing quarter spans many periods, so it removes
 * odd and even cycles in near-equal numbers — no systematic parity bias,
 * only reduced N, which the standard errors already widen for. The one
 * geometry that could bias parity (P comparable to the ~90 d quarter
 * length) cannot yield MIN_CYCLES_PER_PARITY usable cycles and returns
 * null through the ordinary gate.
 */
import type { BlsResult } from './bls'

/**
 * @description Result of the odd/even depth comparison. All fields are
 * measurements; `verdict` is a threshold call on those measurements
 * (documented on ODD_EVEN_SIGMA_THRESHOLD / ODD_EVEN_MIN_REL_DIFF_PCT),
 * still phrased as a property of the data, never of its cause.
 */
export interface OddEvenResult {
  /** Mean depth of odd-indexed transits, ppm of the local baseline. */
  oddDepthPpm: number
  /** Mean depth of even-indexed transits, ppm of the local baseline. */
  evenDepthPpm: number
  /** Number of odd cycles with usable in-transit + baseline coverage. */
  oddCycles: number
  /** Number of even cycles with usable in-transit + baseline coverage. */
  evenCycles: number
  /**
   * |odd − even| in units of the combined standard error
   * (`sqrt(SE_odd² + SE_even²)`). Capped at DIFF_SIGMA_CAP so a
   * noiseless synthetic curve doesn't emit Infinity.
   */
  diffSigma: number
  /** |odd − even| as a percentage of the mean of the two depths. */
  relDiffPct: number
  /**
   * `MISMATCH` when the difference is both statistically significant
   * (≥ ODD_EVEN_SIGMA_THRESHOLD) and materially large
   * (≥ ODD_EVEN_MIN_REL_DIFF_PCT); `CONSISTENT` otherwise.
   */
  verdict: 'CONSISTENT' | 'MISMATCH'
}

/**
 * @description Significance bar (in combined-standard-error units) for
 * calling the odd/even depths mismatched. 3σ matches standard transit
 * vetting practice; below it the difference is compatible with noise.
 */
export const ODD_EVEN_SIGMA_THRESHOLD = 3

/**
 * @description Minimum relative depth difference (percent of the mean
 * depth) for a MISMATCH verdict. On very high-SNR curves a fraction-of-a-
 * percent depth difference can clear 3σ while being physically
 * unremarkable; the relative floor keeps the verdict aligned with the
 * magnitude of effect the check exists to surface. Calibrated against
 * ground truth: KIC4275739 (K01317.01), a FALSE POSITIVE KOI carrying the
 * DR25 Robovetter's DEPTH_ODDEVEN flag, measures Δ9.3% at 11.3σ on our
 * pipeline — an earlier 10% floor wrongly read it as CONSISTENT; 5%
 * catches it with margin while still ignoring the sub-1% regime.
 */
export const ODD_EVEN_MIN_REL_DIFF_PCT = 5

/**
 * @description Minimum usable cycles PER PARITY before the comparison is
 * attempted. Fewer than 3 depths per group makes the empirical standard
 * error itself unreliable, so the check returns null instead of a verdict.
 */
export const MIN_CYCLES_PER_PARITY = 3

/** @description Minimum finite in-transit samples for a cycle to count. */
const MIN_IN_TRANSIT_SAMPLES = 3

/** @description Minimum finite baseline samples for a cycle to count. */
const MIN_BASELINE_SAMPLES = 5

/**
 * @description Outer edge of the per-cycle baseline window, as a multiple
 * of the transit duration on each side of mid-transit. 2.5× gives ~4
 * transit-durations of out-of-transit samples per cycle without reaching
 * into the neighboring transit for any duty cycle below ~20%.
 */
const BASELINE_WINDOW_DUR_MULT = 2.5

/** @description Cap for diffSigma so zero-noise synthetics stay finite. */
const DIFF_SIGMA_CAP = 99

/**
 * @description Splits a curve's transits into odd and even cycles (by
 * cycle index relative to the BLS epoch) and compares their mean depths.
 * Returns null when the geometry doesn't support a measurement: too few
 * usable cycles in either parity, a non-positive duration/period, or a
 * non-positive mean depth (the folded box isn't a dimming, so a depth
 * ratio is meaningless).
 * @param times Time samples in the curve's native day system (BKJD/TJD),
 * parallel to `flux`.
 * @param flux Normalized flux, parallel to `times`; non-finite entries
 * are skipped.
 * @param bls Confident BLS detection supplying period, epoch, duration.
 * @returns Odd/even comparison, or null when unmeasurable.
 */
export function measureOddEvenDepths(
  times: number[],
  flux: number[],
  bls: BlsResult,
): OddEvenResult | null {
  const period = bls.periodDays
  const durationDays = bls.durationHours / 24
  if (!(period > 0) || !(durationDays > 0)) return null

  // Bucket samples by cycle index. Sparse Map keyed by cycle — a curve
  // only ever populates cycles its baseline actually covers.
  const inTransit = new Map<number, number[]>()
  const baseline = new Map<number, number[]>()
  const halfDur = durationDays / 2
  const baselineEdge = durationDays * BASELINE_WINDOW_DUR_MULT

  for (let i = 0; i < times.length; i++) {
    const f = flux[i]
    if (!Number.isFinite(f)) continue
    const t = times[i]
    if (!Number.isFinite(t)) continue
    const n = Math.round((t - bls.epochDays) / period)
    const dt = Math.abs(t - bls.epochDays - n * period)
    if (dt <= halfDur) {
      let arr = inTransit.get(n)
      if (!arr) inTransit.set(n, (arr = []))
      arr.push(f)
    } else if (dt <= baselineEdge) {
      let arr = baseline.get(n)
      if (!arr) baseline.set(n, (arr = []))
      arr.push(f)
    }
  }

  const oddDepths: number[] = []
  const evenDepths: number[] = []
  for (const [n, inArr] of inTransit) {
    if (inArr.length < MIN_IN_TRANSIT_SAMPLES) continue
    const baseArr = baseline.get(n)
    if (!baseArr || baseArr.length < MIN_BASELINE_SAMPLES) continue
    const depth = median(baseArr) - median(inArr)
    // Parity of the cycle index; Math.round can produce negative cycles
    // for samples before the epoch, so normalize -1 % 2 === -1 to odd.
    if (Math.abs(n % 2) === 1) oddDepths.push(depth)
    else evenDepths.push(depth)
  }

  if (oddDepths.length < MIN_CYCLES_PER_PARITY || evenDepths.length < MIN_CYCLES_PER_PARITY) {
    return null
  }

  const odd = meanAndSe(oddDepths)
  const even = meanAndSe(evenDepths)
  const meanDepth = (odd.mean + even.mean) / 2
  // A non-positive mean "depth" means the folded box isn't a dimming at
  // this (P, t0) — nothing meaningful to compare.
  if (!(meanDepth > 0)) return null

  const diff = Math.abs(odd.mean - even.mean)
  const combinedSe = Math.sqrt(odd.se * odd.se + even.se * even.se)
  const diffSigma = combinedSe > 0 ? Math.min(diff / combinedSe, DIFF_SIGMA_CAP) : diff > 0 ? DIFF_SIGMA_CAP : 0
  const relDiffPct = (diff / meanDepth) * 100

  return {
    oddDepthPpm: odd.mean * 1e6,
    evenDepthPpm: even.mean * 1e6,
    oddCycles: oddDepths.length,
    evenCycles: evenDepths.length,
    diffSigma,
    relDiffPct,
    verdict:
      diffSigma >= ODD_EVEN_SIGMA_THRESHOLD && relDiffPct >= ODD_EVEN_MIN_REL_DIFF_PCT
        ? 'MISMATCH'
        : 'CONSISTENT',
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

/**
 * @description Mean and standard error of the mean (sample std / √n).
 * @param values Array with at least MIN_CYCLES_PER_PARITY entries.
 * @returns Mean and standard error.
 */
function meanAndSe(values: number[]): { mean: number; se: number } {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const varSum = values.reduce((a, b) => a + (b - mean) * (b - mean), 0)
  const std = Math.sqrt(varSum / (n - 1))
  return { mean, se: std / Math.sqrt(n) }
}
