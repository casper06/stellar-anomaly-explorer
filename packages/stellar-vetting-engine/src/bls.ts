/**
 * @description Box Least Squares (BLS) period search, plain TypeScript,
 * no dependencies. Detects periodic box-shaped dimmings (transits,
 * eclipses) in a light curve and reports period, epoch, depth, duration,
 * and an SDE (signal detection efficiency) confidence statistic.
 *
 * This is a BUDGETED approximation of full-rigor BLS (Kovács et al.
 * 2002), tuned to run per-star in ~1–2 s inside a browser worker or the
 * Node batch process:
 * - The curve is time-binned to `SEARCH_BIN_DAYS` (3 h) before the
 *   search, capping the fold cost regardless of cadence (Kepler 30-min
 *   full mission ~65k samples → ~11k bins; TESS 2-min sectors shrink
 *   even more).
 * - The frequency grid is log-spaced and capped by an operations budget
 *   rather than the rigorous Δf = q/(OS·T) spacing, then a refinement
 *   stage re-searches around the best coarse peaks with a 15× finer
 *   grid and more phase bins.
 *
 * Consequences (documented, accepted): sensitivity degrades for transit
 * durations ≲ 3 h and periods ≲ 1 d unless the signal is deep (≥ ~1%,
 * e.g. eclipsing binaries, which punch through the smearing); red-noise
 * (stellar variability) inflates the SR spectrum and can suppress SDE —
 * callers should treat sub-threshold results as "no confident
 * detection", never "no signal".
 *
 * Strictly descriptive: reports that a periodic box-shaped dimming is
 * present in the data. It never asserts a physical cause.
 */

/** @description One confident-or-not BLS search result. */
export interface BlsResult {
  /** Best-fit period in days. */
  periodDays: number
  /** Mid-transit epoch in the curve's native time system (BKJD/TJD). */
  epochDays: number
  /** Mean box depth in parts-per-million of the median flux level. */
  depthPpm: number
  /** Box duration in hours. */
  durationHours: number
  /**
   * Signal detection efficiency: (peak − mean)/std of the per-frequency
   * SR spectrum. ≥ BLS_SDE_THRESHOLD is a confident detection.
   */
  sde: number
}

/**
 * @description SDE above which a BLS peak counts as a confident
 * detection. 7–9 is the standard range in the transit literature;
 * 7.5 balances the synthetic-injection recovery tests against the
 * pure-noise null test (noise spectra peak around SDE 4–6).
 */
export const BLS_SDE_THRESHOLD = 7.5

/** @description Time-bin width (days) for the search decimation. 3 h. */
const SEARCH_BIN_DAYS = 0.125

/** @description Shortest period searched (days). */
const MIN_PERIOD_DAYS = 0.5

/** @description Longest period searched (days), further capped by baseline/3. */
const MAX_PERIOD_DAYS = 120

/** @description Phase bins for the coarse stage. */
const COARSE_PHASE_BINS = 200

/** @description Phase bins for the refinement stage. */
const FINE_PHASE_BINS = 400

/** @description Box durations scanned, in coarse phase bins. */
const DURATION_BINS = [1, 2, 3, 4, 6, 8]

/** @description Total fold-operation budget for the coarse stage. */
const OPS_BUDGET = 4.5e8

/** @description Upper-only MAD clip factor (cosmic-ray spikes). */
const MAD_CLIP_K = 5

/**
 * @description Cleans and time-bins a light curve for the search:
 * drops non-finite samples, clips upward outliers at median + 5·MAD
 * (upward only — downward excursions are the signal we're looking
 * for), converts to zero-mean relative flux, and averages into
 * `SEARCH_BIN_DAYS` bins.
 * @param times Raw time samples.
 * @param flux Raw flux samples (any normalization).
 * @returns Parallel typed arrays of bin times and zero-mean relative
 * flux, or null when too little usable data remains.
 */
function prepare(
  times: (number | null)[],
  flux: (number | null)[],
): { t: Float64Array; x: Float64Array } | null {
  const ct: number[] = []
  const cf: number[] = []
  for (let i = 0; i < times.length; i++) {
    const ti = times[i]
    const fi = flux[i]
    if (ti !== null && fi !== null && Number.isFinite(ti) && Number.isFinite(fi)) {
      ct.push(ti)
      cf.push(fi)
    }
  }
  if (ct.length < 100) return null

  // Median + upper MAD clip.
  const sorted = [...cf].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (!(median > 0)) return null
  const absDev = cf.map(v => Math.abs(v - median)).sort((a, b) => a - b)
  const mad = absDev[Math.floor(absDev.length / 2)]
  const upper = median + MAD_CLIP_K * Math.max(mad, 1e-12)

  // Time-bin to SEARCH_BIN_DAYS, relative flux around the median.
  const t0 = ct[0]
  const binSum = new Map<number, { st: number; sx: number; n: number }>()
  for (let i = 0; i < ct.length; i++) {
    if (cf[i] > upper) continue
    const key = Math.floor((ct[i] - t0) / SEARCH_BIN_DAYS)
    let b = binSum.get(key)
    if (!b) { b = { st: 0, sx: 0, n: 0 }; binSum.set(key, b) }
    b.st += ct[i]
    b.sx += cf[i] / median - 1
    b.n++
  }
  const keys = [...binSum.keys()].sort((a, b) => a - b)
  if (keys.length < 50) return null
  const t = new Float64Array(keys.length)
  const x = new Float64Array(keys.length)
  let mean = 0
  for (let k = 0; k < keys.length; k++) {
    const b = binSum.get(keys[k])!
    t[k] = b.st / b.n
    x[k] = b.sx / b.n
    mean += x[k]
  }
  mean /= keys.length
  for (let k = 0; k < keys.length; k++) x[k] -= mean
  return { t, x }
}

/**
 * @description Scans one frequency: folds the binned curve at `f`,
 * accumulates per-phase-bin sums/counts, then slides each candidate box
 * duration circularly over the phase bins keeping the best NEGATIVE
 * (dimming) box by the SR merit `s²/(n·(1−n/N))`.
 * @param t Bin times (relative to their first element is fine).
 * @param x Zero-mean relative flux per bin.
 * @param f Trial frequency (1/days).
 * @param nPhase Number of phase bins.
 * @param sums Scratch Float64Array(nPhase).
 * @param counts Scratch Float64Array(nPhase).
 * @param durations Box widths to scan, in phase bins.
 * @returns Best merit for this frequency plus the winning box geometry.
 */
function scanFrequency(
  t: Float64Array,
  x: Float64Array,
  f: number,
  nPhase: number,
  sums: Float64Array,
  counts: Float64Array,
  durations: number[],
): { merit: number; s: number; n: number; startBin: number; durBins: number } {
  sums.fill(0)
  counts.fill(0)
  const N = t.length
  for (let i = 0; i < N; i++) {
    const ph = t[i] * f
    const bin = ((ph - Math.floor(ph)) * nPhase) | 0
    sums[bin] += x[i]
    counts[bin]++
  }
  let best = { merit: 0, s: 0, n: 0, startBin: 0, durBins: 1 }
  for (const d of durations) {
    if (d >= nPhase) continue
    // Initialize circular window [0, d)
    let s = 0
    let n = 0
    for (let b = 0; b < d; b++) { s += sums[b]; n += counts[b] }
    for (let start = 0; start < nPhase; start++) {
      if (s < 0 && n > 2 && n < N) {
        const merit = (s * s) / (n * (1 - n / N))
        if (merit > best.merit) best = { merit, s, n, startBin: start, durBins: d }
      }
      // Slide: drop `start`, add `(start + d) % nPhase`
      s += sums[(start + d) % nPhase] - sums[start]
      n += counts[(start + d) % nPhase] - counts[start]
    }
  }
  return best
}

/**
 * @description Runs the budgeted two-stage BLS search.
 * @param times Time samples (native days: BKJD/TJD), nulls tolerated.
 * @param flux Flux samples parallel to `times`, nulls tolerated.
 * @returns Best detection with its SDE (caller compares against
 * `BLS_SDE_THRESHOLD`), or null when the curve has too little data or
 * too short a baseline to search.
 */
export function runBls(
  times: (number | null)[],
  flux: (number | null)[],
): BlsResult | null {
  const prep = prepare(times, flux)
  if (!prep) return null
  const { t, x } = prep

  const tFirst = t[0]
  const baseline = t[t.length - 1] - tFirst
  if (baseline < 2) return null
  // Shift times so phase math stays well-conditioned.
  const tr = new Float64Array(t.length)
  for (let i = 0; i < t.length; i++) tr[i] = t[i] - tFirst

  const pMax = Math.min(MAX_PERIOD_DAYS, baseline / 3)
  if (pMax <= MIN_PERIOD_DAYS) return null
  const fMin = 1 / pMax
  const fMax = 1 / MIN_PERIOD_DAYS

  // Log-spaced coarse grid, capped by the ops budget.
  const nFreq = Math.max(4000, Math.min(45000, Math.floor(OPS_BUDGET / t.length)))
  const logStep = Math.log(fMax / fMin) / (nFreq - 1)

  const sums = new Float64Array(COARSE_PHASE_BINS)
  const counts = new Float64Array(COARSE_PHASE_BINS)
  const spectrum = new Float64Array(nFreq)
  let bestIdx = 0
  let bestCoarse = { merit: 0, s: 0, n: 0, startBin: 0, durBins: 1 }
  for (let k = 0; k < nFreq; k++) {
    const f = fMin * Math.exp(k * logStep)
    const r = scanFrequency(tr, x, f, COARSE_PHASE_BINS, sums, counts, DURATION_BINS)
    spectrum[k] = Math.sqrt(r.merit)
    if (r.merit > bestCoarse.merit) { bestCoarse = r; bestIdx = k }
  }

  // SDE over the coarse SR spectrum.
  let mean = 0
  for (let k = 0; k < nFreq; k++) mean += spectrum[k]
  mean /= nFreq
  let variance = 0
  for (let k = 0; k < nFreq; k++) variance += (spectrum[k] - mean) ** 2
  const std = Math.sqrt(variance / nFreq) || 1e-12
  const sde = (spectrum[bestIdx] - mean) / std

  // Refinement: ±3 coarse steps around the peak, 15× finer, more
  // phase bins, duration set scaled to the finer binning.
  const fPeak = fMin * Math.exp(bestIdx * logStep)
  const fLo = fPeak * Math.exp(-3 * logStep)
  const fHi = fPeak * Math.exp(3 * logStep)
  const nRefine = 90
  const fineDurations = DURATION_BINS.map(d => Math.max(1, Math.round((d * FINE_PHASE_BINS) / COARSE_PHASE_BINS)))
  const fineSums = new Float64Array(FINE_PHASE_BINS)
  const fineCounts = new Float64Array(FINE_PHASE_BINS)
  let bestFine = { merit: 0, s: 0, n: 0, startBin: 0, durBins: 1 }
  let bestF = fPeak
  for (let k = 0; k <= nRefine; k++) {
    const f = fLo * Math.exp((Math.log(fHi / fLo) * k) / nRefine)
    const r = scanFrequency(tr, x, f, FINE_PHASE_BINS, fineSums, fineCounts, fineDurations)
    if (r.merit > bestFine.merit) { bestFine = r; bestF = f }
  }
  const winner = bestFine.merit > 0 ? bestFine : bestCoarse
  const winnerBins = bestFine.merit > 0 ? FINE_PHASE_BINS : COARSE_PHASE_BINS
  const period = 1 / bestF

  const depth = winner.n > 0 ? -(winner.s / winner.n) : 0
  const phaseCenter = ((winner.startBin + winner.durBins / 2) % winnerBins) / winnerBins
  return {
    periodDays: period,
    epochDays: tFirst + phaseCenter * period,
    depthPpm: depth * 1e6,
    durationHours: (winner.durBins / winnerBins) * period * 24,
    sde,
  }
}
