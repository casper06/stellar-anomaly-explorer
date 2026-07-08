import type { Dip } from './anomalyDetector'
import { runBls, BLS_SDE_THRESHOLD, type BlsResult } from './bls'
import { measureOddEvenDepths, type OddEvenResult } from './oddEven'
import { measureSecondaryEclipse, type SecondaryEclipseResult } from './secondaryEclipse'

/**
 * @description Version of the classification algorithm. BUMP THIS on any
 * change that can alter a star's PATTERN LABEL — pattern-cache entries
 * store only the label (plus this version), and the batch classifier
 * treats entries from older versions as missing (re-classifies them)
 * instead of serving mixed-provenance labels. Same lesson as the
 * lightcurve cache's CACHE_SCHEMA_VERSION. Purely additive profile
 * fields that never feed `pickPattern` (e.g. the odd/even depth check)
 * do NOT require a bump: they aren't cached, so they can't go stale.
 * v2: BLS period search added; PERIODIC_UNIFORM now requires a confident
 * BLS detection (gated on ≥3 visible dips); bestFitPeriodDays sourced
 * from BLS.
 * v3: dip-detector high-noise calibration (the TOI 5523.02 fix in
 * `anomalyDetector.ts`): sigma-relative threshold floor beyond the noise
 * gate + fragmentation merge + min-duration guard. Dip count feeds the
 * SPARSE gate and every dip-derived scalar, so labels of high-noise
 * stars can change (e.g. noise-dip IRREGULAR → SPARSE/HIGH_VARIABILITY);
 * verified bit-identical on all frozen Kepler fixtures.
 */
export const CLASSIFIER_VERSION = 3

/**
 * @description Pattern label assigned by the classifier. Purely
 * descriptive — describes the SHAPE of the light curve data, never
 * its physical cause. Consumers must not translate these into
 * astronomical interpretations (no "planet", "binary", "Dyson
 * sphere") — the user does that part. Definitions:
 * - `PERIODIC_UNIFORM`: dips repeat at evenly-spaced intervals AND
 *   the depths are consistent. The data forms a regular pattern.
 * - `IRREGULAR`: dips exist but don't repeat cleanly OR their depths
 *   vary significantly. The interesting bucket.
 * - `HIGH_VARIABILITY`: baseline noise is large relative to dip
 *   depths. Any dips reported are hard to trust against the noise
 *   floor.
 * - `SPARSE`: fewer than three dips, not enough to characterize a
 *   pattern.
 * - `UNCERTAIN`: the raw periodicity/consistency numbers looked good
 *   but the BLS phase-folding search found no confident periodic box
 *   signal — the signature of the dip detector locking onto sampling
 *   noise or baseline flicker rather than a real repeating event.
 */
export type CurvePattern =
  | 'PERIODIC_UNIFORM'
  | 'IRREGULAR'
  | 'HIGH_VARIABILITY'
  | 'SPARSE'
  | 'UNCERTAIN'

/**
 * @description Descriptive shape of the dominant dips in a light curve.
 * U-shaped dips have a flat bottom (flux stays near minimum across
 * several samples around the deepest point); V-shaped dips have a
 * sharp point (flux rises immediately on either side of the
 * minimum). 'MIXED' when the deepest dips disagree, 'UNKNOWN' when
 * there isn't enough signal to tell. Strictly descriptive — no
 * physical interpretation is implied.
 */
export type DipShape = 'U' | 'V' | 'MIXED' | 'UNKNOWN'

/**
 * @description Measured features of a light curve. Every field is a
 * value computed from the data; nothing in this struct asserts what
 * caused the data to look this way. UI consumers MUST present these
 * descriptively and let the user form their own hypothesis.
 */
export interface CurveProfile {
  /** Pattern label — see CurvePattern. */
  pattern: CurvePattern
  /**
   * Periodicity score in [0, 1]. 1 = dips arrive at perfectly
   * evenly-spaced intervals; 0 = intervals are random with respect
   * to any single period. Derived from the residuals of dip
   * timestamps modulo the best-fit candidate period.
   */
  periodicity: number
  /**
   * Depth consistency in [0, 1]. 1 = all dips are the same depth;
   * 0 = depths vary wildly relative to their mean. Computed as
   * `1 - std(depths)/mean(depths)`, clamped to [0, 1].
   */
  depthConsistency: number
  /** Dominant dip shape among the deepest few dips. */
  dipShape: DipShape
  /**
   * Standard deviation of flux OUTSIDE detected dips, normalized to
   * baseline flux (so a value of 0.002 means 0.2% RMS noise around
   * the baseline). Indicates intrinsic stellar variability /
   * instrument noise floor.
   */
  baselineRMS: number
  /**
   * Best-fit period in days, sourced from the BLS search, surfaced
   * ONLY when the pattern label is PERIODIC_UNIFORM (anywhere else a
   * period would contradict the label). Null otherwise.
   */
  bestFitPeriodDays: number | null
  /** Number of dips that contributed to the analysis. */
  dipCount: number
  /**
   * Raw BLS search result — an INDEPENDENT statistical detection,
   * reported regardless of the pattern label (a SPARSE star can carry
   * a confident sub-threshold-depth BLS signal; that is exactly the
   * NASA-score-vs-local-detector desync case). Null when the curve was
   * too small/short to search. Consumers show it as its own line
   * ("statistical periodic signal"), never as a property of the
   * visible dip pattern.
   */
  bls: BlsResult | null
  /**
   * Odd/even transit depth comparison, computed whenever the BLS
   * detection is confident (like the `bls` field, independent of the
   * pattern label — a SPARSE star with a confident signal still gets
   * measured). Null when BLS isn't confident or the fold geometry
   * doesn't support the measurement (too few cycles per parity). Never
   * feeds the pattern label — purely an additional reported measurement,
   * which is why adding it did not bump CLASSIFIER_VERSION.
   */
  oddEven: OddEvenResult | null
  /**
   * Phase-0.5 dimming (secondary eclipse position) measurement — the
   * companion vetting check to `oddEven`, on the same confident-BLS
   * gate and with the same non-label-affecting status (no
   * CLASSIFIER_VERSION bump). Null when BLS isn't confident or too few
   * cycles have usable phase-0.5 coverage.
   */
  secondary: SecondaryEclipseResult | null
}

/**
 * @description Threshold above which `periodicity` is considered
 * meaningful enough to report a best-fit period and to qualify (with
 * `depthConsistency`) for the `PERIODIC_UNIFORM` label.
 */
const PERIODIC_THRESHOLD = 0.5

/**
 * @description Threshold above which `depthConsistency` is required
 * for the `PERIODIC_UNIFORM` label. Same value as periodicity by
 * design — both must be confidently high before the label fires.
 */
const DEPTH_CONSISTENCY_THRESHOLD = 0.5

/**
 * @description Baseline-RMS threshold (fraction of mean baseline
 * flux) above which the `HIGH_VARIABILITY` label takes precedence
 * over any other pattern call. 1% noise overwhelms most planetary
 * transits, so dips against that backdrop are hard to trust.
 */
const HIGH_VARIABILITY_RMS = 0.01

/**
 * @description Minimum dip count for any pattern call other than
 * `SPARSE`. Two dips give one interval, which is not enough to call
 * "periodic" — a single measurement of a period is the period of a
 * one-cycle artifact too.
 */
const MIN_DIPS_FOR_PATTERN = 3

/**
 * @description Threshold on the `(flux[min±k] - flux[min]) / depth`
 * ratio for classifying a single dip's shape. Smaller ratios mean
 * the bottom is flat (U-shape); larger ratios mean the bottom is a
 * sharp point (V-shape). 0.3 splits the typical observed range
 * cleanly — values below mean "stayed near minimum for several
 * samples", values above mean "rose ~30%+ within a couple samples".
 */
const SHAPE_SPLIT_RATIO = 0.3

/**
 * @description How many flanking samples to inspect on each side of
 * a dip minimum when classifying its shape. Three samples covers
 * ~90 minutes of Kepler 30-min cadence, enough to span the bottom
 * of a typical few-hour transit without bleeding into ingress/egress.
 */
const SHAPE_FLANK_SAMPLES = 3

/**
 * @description How many of the deepest dips to use for the
 * dominant-shape vote. We don't want a single shallow noisy dip to
 * swing the classification, but we also don't want to average over
 * dozens of marginal dips. Top 5 keeps the signal where it's
 * strongest.
 */
const SHAPE_VOTE_TOP_N = 5

/**
 * @description Shortest period we're willing to call a real signal, in
 * days. The record-holding confirmed transiting exoplanet (K2-137 b) sits
 * near 0.18 d; 0.2 d gives a small margin below that. A "best-fit
 * period" below this floor is far more likely to be the classifier
 * locking onto Kepler's ~0.0204 d cadence (or a low multiple of it)
 * because a noisy star triggered many near-consecutive dips.
 */
const MIN_PLAUSIBLE_PERIOD_DAYS = 0.2

/**
 * @description Computes a `CurveProfile` from a light curve and its
 * detected dips. All four measurements (periodicity, depth
 * consistency, dip shape, baseline RMS) are derived from the input
 * data; nothing here uses external catalog values or asserts a
 * physical cause. Returns `SPARSE` when fewer than `MIN_DIPS_FOR_
 * PATTERN` dips are present, since a pattern call below that point
 * would be statistical noise.
 * @param times Time samples (BKJD), parallel to `flux`.
 * @param flux Normalized flux values, parallel to `times`. Nulls and
 * non-finite values are tolerated (filtered out where appropriate).
 * @param dips Detected dips from `detectDips`.
 * @returns Measured profile of the curve.
 */
export function classifyCurve(times: number[], flux: number[], dips: Dip[]): CurveProfile {
  const dipCount = dips.length
  const baselineRMS = computeBaselineRMS(flux, dips)

  // BLS runs unconditionally — its result is an independent statistical
  // detection surfaced even for SPARSE curves (that's the honest answer
  // to "NASA scores this high but I see no dips": the transit is often
  // detectable statistically while being far below the 1% visible-dip
  // threshold).
  const bls = runBls(times, flux)
  const blsConfident =
    bls !== null &&
    bls.sde >= BLS_SDE_THRESHOLD &&
    bls.periodDays >= MIN_PLAUSIBLE_PERIOD_DAYS

  // Odd/even and the phase-0.5 check run on the same gate as the BLS
  // readout line: any confident detection, regardless of what pattern
  // label the curve ends up with.
  const oddEven = blsConfident && bls ? measureOddEvenDepths(times, flux, bls) : null
  const secondary = blsConfident && bls ? measureSecondaryEclipse(times, flux, bls) : null

  if (dipCount < MIN_DIPS_FOR_PATTERN) {
    return {
      pattern: 'SPARSE',
      periodicity: 0,
      depthConsistency: 0,
      dipShape: 'UNKNOWN',
      baselineRMS,
      bestFitPeriodDays: null,
      dipCount,
      bls,
      oddEven,
      secondary,
    }
  }

  // Sort dips by peak time so interval analysis is meaningful
  // regardless of the input order (detectDips returns by score desc).
  const dipsByTime = [...dips].sort((a, b) => a.peakTime - b.peakTime)

  const { periodicity } = computePeriodicity(dipsByTime)
  const depthConsistency = computeDepthConsistency(dipsByTime)
  const dipShape = computeDipShape(times, flux, dipsByTime)

  const pattern = pickPattern({
    periodicity,
    depthConsistency,
    baselineRMS,
    blsConfident,
  })

  // The surfaced period comes from BLS (a real phase-folding search),
  // ONLY when the pattern label is PERIODIC_UNIFORM — anywhere else a
  // period would contradict the label. (The old interval-heuristic
  // period is gone; `periodicity` remains as a descriptive scalar.)
  const reportedPeriod = pattern === 'PERIODIC_UNIFORM' && bls ? bls.periodDays : null

  return {
    pattern,
    periodicity,
    depthConsistency,
    dipShape,
    baselineRMS,
    bestFitPeriodDays: reportedPeriod,
    dipCount,
    bls,
    oddEven,
    secondary,
  }
}

/**
 * @description Picks the descriptive pattern label. Priority:
 * 1. `HIGH_VARIABILITY` whenever the baseline is noisier than
 *    `HIGH_VARIABILITY_RMS` — a noisy backdrop makes any pattern call
 *    unreliable, so we surface the noise first (even over a confident
 *    BLS detection; the BLS line is still shown separately).
 * 2. `PERIODIC_UNIFORM` when the BLS search found a CONFIDENT periodic
 *    box signal (SDE ≥ threshold, plausible period). This replaced the
 *    old interval-folding heuristic + implausible-period/dip-density
 *    guards: a real phase-folding search either finds the period or it
 *    doesn't, so the guards' job (rejecting cadence lock-on and
 *    flicker) is inherent. Note the caller only reaches this function
 *    with ≥ MIN_DIPS_FOR_PATTERN visible dips — a confident BLS signal
 *    with 0–2 visible dips stays SPARSE by design (the label describes
 *    the VISIBLE dip pattern; the BLS detection is surfaced as its own
 *    independent line).
 * 3. `UNCERTAIN` when the raw interval scalars LOOK periodic but BLS
 *    found nothing confident — the signature of the dip detector
 *    locking onto sampling noise or baseline flicker.
 * 4. `IRREGULAR` otherwise.
 * @param scores Measured scalars plus the BLS confidence flag.
 * @returns The CurvePattern label.
 */
function pickPattern({
  periodicity,
  depthConsistency,
  baselineRMS,
  blsConfident,
}: {
  periodicity: number
  depthConsistency: number
  baselineRMS: number
  blsConfident: boolean
}): CurvePattern {
  if (baselineRMS >= HIGH_VARIABILITY_RMS) return 'HIGH_VARIABILITY'
  if (blsConfident) return 'PERIODIC_UNIFORM'
  const rawLooksPeriodic =
    periodicity >= PERIODIC_THRESHOLD &&
    depthConsistency >= DEPTH_CONSISTENCY_THRESHOLD
  if (rawLooksPeriodic) return 'UNCERTAIN'
  return 'IRREGULAR'
}

/**
 * @description Measures how regularly-spaced the dip peaks are. The
 * candidate period is the smallest consecutive interval — if any pair
 * of dips is one cycle apart, that's our best guess at P. Then for
 * every consecutive interval Δt, we look at how close `Δt mod P` is
 * to 0 or P (either is fine — a "skipped" cycle that lands exactly
 * 2P later is still periodic). Score is `1 - 2 * median(|phase|)`
 * where phase is the modulo distance to the nearest multiple of P,
 * normalized to [0, 0.5]; clamped to [0, 1].
 *
 * Edge cases:
 * - Fewer than 2 dips: returns 0 / null (no interval to measure).
 * - All intervals collapse to ~0: returns 0 (degenerate).
 * @param dipsByTime Dips already sorted by peak time ascending.
 * @returns Score and the best-fit period in days (null when no
 * interval was usable).
 */
function computePeriodicity(dipsByTime: Dip[]): {
  periodicity: number
  bestFitPeriodDays: number | null
} {
  if (dipsByTime.length < 2) return { periodicity: 0, bestFitPeriodDays: null }

  const intervals: number[] = []
  for (let i = 1; i < dipsByTime.length; i++) {
    const d = dipsByTime[i].peakTime - dipsByTime[i - 1].peakTime
    if (d > 0 && Number.isFinite(d)) intervals.push(d)
  }
  if (intervals.length === 0) return { periodicity: 0, bestFitPeriodDays: null }

  // Candidate period = smallest non-trivial interval. Trivial = below
  // ~30 minutes (Kepler cadence) which would mean two dips on the
  // same transit and isn't meaningful for periodicity.
  const usable = intervals.filter(d => d > 0.04)
  if (usable.length === 0) return { periodicity: 0, bestFitPeriodDays: null }
  const period = Math.min(...usable)
  if (!(period > 0)) return { periodicity: 0, bestFitPeriodDays: null }

  // For each interval, fold to [-period/2, period/2] and report the
  // absolute distance as a fraction of half-period.
  const residuals: number[] = []
  for (const d of intervals) {
    const folded = d - Math.round(d / period) * period
    const phase = Math.abs(folded) / (period / 2)
    residuals.push(Math.min(phase, 1))
  }
  residuals.sort((a, b) => a - b)
  const median = residuals[Math.floor(residuals.length / 2)]
  const periodicity = Math.max(0, Math.min(1, 1 - median))

  return { periodicity, bestFitPeriodDays: period }
}

/**
 * @description 1 minus the coefficient of variation of dip depths.
 * High score means all dips were similar depth; low means depths
 * varied a lot relative to their mean. Clamped to [0, 1] — extremely
 * variable depths (e.g. a 20% dip mixed with 0.5% dips) can drive
 * the raw value negative.
 * @param dipsByTime Dips already sorted by peak time (order doesn't
 * actually matter for this stat, but we accept the same shape for
 * symmetry with the other helpers).
 * @returns Depth consistency in [0, 1].
 */
function computeDepthConsistency(dipsByTime: Dip[]): number {
  const depths = dipsByTime.map(d => d.depth).filter(d => Number.isFinite(d) && d > 0)
  if (depths.length < 2) return 0
  const mean = depths.reduce((a, b) => a + b, 0) / depths.length
  if (mean <= 0) return 0
  const variance =
    depths.reduce((a, b) => a + (b - mean) * (b - mean), 0) / depths.length
  const std = Math.sqrt(variance)
  return Math.max(0, Math.min(1, 1 - std / mean))
}

/**
 * @description Inspects the deepest few dips and votes between
 * U-shape and V-shape. For each dip we compute the average of
 * `(flux[min ± k] - flux[min]) / depth` for k=1..SHAPE_FLANK_SAMPLES;
 * the smaller this ratio, the flatter the bottom (U). A ratio below
 * SHAPE_SPLIT_RATIO scores as U, above scores as V. Dominant shape =
 * majority of the votes; ties or near-ties return 'MIXED'.
 *
 * Why "deepest few" rather than "all": shallow dips have low
 * signal-to-noise around the minimum, and noise dominates the
 * shape measurement. Restricting to the top SHAPE_VOTE_TOP_N
 * highest-depth dips keeps the signal where it matters.
 *
 * Returns 'UNKNOWN' when no dip has enough flanking valid samples
 * (e.g. dips at the very start or end of the data; dips immediately
 * adjacent to gaps).
 * @param times Time samples (BKJD).
 * @param flux Normalized flux values.
 * @param dipsByTime Dips already sorted by peak time ascending.
 * @returns The dominant dip shape.
 */
function computeDipShape(times: number[], flux: number[], dipsByTime: Dip[]): DipShape {
  const topByDepth = [...dipsByTime]
    .sort((a, b) => b.depth - a.depth)
    .slice(0, SHAPE_VOTE_TOP_N)

  let uVotes = 0
  let vVotes = 0
  let usable = 0

  for (const dip of topByDepth) {
    const min = dip.minIdx
    if (dip.depth <= 0) continue
    const minFlux = flux[min]
    if (!Number.isFinite(minFlux)) continue

    const ratios: number[] = []
    for (let k = 1; k <= SHAPE_FLANK_SAMPLES; k++) {
      for (const side of [min - k, min + k]) {
        if (side < 0 || side >= flux.length) continue
        const f = flux[side]
        if (!Number.isFinite(f)) continue
        ratios.push((f - minFlux) / dip.depth)
      }
    }
    if (ratios.length === 0) continue

    const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length
    usable++
    if (meanRatio < SHAPE_SPLIT_RATIO) uVotes++
    else vVotes++
  }

  if (usable === 0) return 'UNKNOWN'
  if (uVotes === vVotes) return 'MIXED'
  // Treat a near-tie as MIXED so a 3-vs-2 split doesn't masquerade
  // as a clear dominant shape.
  if (Math.abs(uVotes - vVotes) === 1 && usable >= 4) return 'MIXED'
  return uVotes > vVotes ? 'U' : 'V'
  // Note: `times` is unused for now — kept in the signature so a
  // future cadence-aware version (e.g. interpolating around a dip
  // minimum that doesn't fall on a sample) can use it without an
  // API change.
}

/**
 * @description Computes the standard deviation of flux samples OUTSIDE
 * any detected dip, normalized by the mean baseline flux. Returns 0
 * when no usable baseline samples remain (entire curve was dips or
 * nulls). A value of 0.002 means 0.2% RMS noise.
 * @param flux Normalized flux values.
 * @param dips Detected dips (we mask out their `[startIdx, endIdx]`
 * ranges).
 * @returns Baseline RMS as a fraction of the baseline mean.
 */
function computeBaselineRMS(flux: number[], dips: Dip[]): number {
  const masked = new Uint8Array(flux.length)
  for (const d of dips) {
    const start = Math.max(0, d.startIdx)
    const end = Math.min(flux.length - 1, d.endIdx)
    for (let i = start; i <= end; i++) masked[i] = 1
  }
  let sum = 0
  let count = 0
  for (let i = 0; i < flux.length; i++) {
    const f = flux[i]
    if (masked[i]) continue
    if (!Number.isFinite(f)) continue
    sum += f
    count++
  }
  if (count === 0) return 0
  const mean = sum / count
  if (mean <= 0) return 0
  let varSum = 0
  for (let i = 0; i < flux.length; i++) {
    const f = flux[i]
    if (masked[i]) continue
    if (!Number.isFinite(f)) continue
    const d = f - mean
    varSum += d * d
  }
  return Math.sqrt(varSum / count) / mean
}
