/**
 * @description Difference-image centroid vetting — the pixel-level
 * companion to the odd/even and phase-0.5 checks. Given a confident
 * periodic box signal (period / epoch / duration) and a set of parsed
 * Kepler TPF quarters, it measures WHERE on the sky the transit signal
 * originates: the difference between the mean out-of-transit pixel stamp
 * and the mean in-transit stamp is the transit signal localized on the
 * detector, and the offset between that difference image's centroid and
 * the star's photocenter is the measured quantity. All numbers are
 * reported as measurements (offset ± error, significance); consumers must
 * present them descriptively and never translate them into a physical
 * cause (see the describe-don't-diagnose rule in `curveClassifier.ts`).
 *
 * Method (difference imaging — what the Kepler DV pipeline computes; its
 * `koi_dicco_msky` outputs are this feature's calibration ground truth):
 * 1. Per quarter: classify clean cadences (QUALITY == 0) into in-transit
 *    (|dt| < IN_TRANSIT_CORE_FRAC × duration/2 from the nearest transit
 *    center) and local out-of-transit flanks.
 * 2. Per quarter: mean in-transit stamp, mean out-of-transit stamp
 *    (per-pixel, NaN-aware), difference = out − in.
 * 3. Per quarter: flux-weighted moment centroid of the (positive part of
 *    the) difference image vs the same centroid of the out-of-transit
 *    stamp → an offset vector in pixels → arcsec (3.98″/px).
 * 4. VECTOR-average the per-quarter offsets (mean of dx, dy; error from
 *    scatter/√N). Quarter noise directions are random, so vector
 *    averaging cancels the noise-magnitude bias that averaging |offset|
 *    would keep (empirically: a clean planet's per-quarter magnitudes ran
 *    0.5–2.8″ while the vector mean was ~0.9″ ± 0.6″).
 *
 * Calibration + design decisions (measured 2026-07-10, see
 * docs/DESIGN_tpf-centroid-analysis.md §3):
 * - K02606.01 (DR25 centroid-offset FALSE POSITIVE, NASA 7.069″ ± 0.091″):
 *   this engine measures 7.20″ ± 0.70″ from 6 quarters — 0.2σ agreement.
 * - K01800.01 (clean CONFIRMED planet, NASA 0.008″ ± 0.07″): measures
 *   ~0.9″ ± 0.6″ — consistent with zero at our noise floor.
 * - Noise-clipping the difference image was measured and REJECTED: a 2σ
 *   clip zeroes shallow-transit difference images entirely and biases
 *   surviving centroids toward the brightest residual pixel.
 * - Honest sensitivity floor: a moment centroid with quarter-scatter
 *   errors resolves offsets ≳ 2″ (half a Kepler pixel). NASA's PRF-fitted
 *   pipeline reaches 0.07″. Sub-pixel blends are BELOW this check's
 *   floor, and the verdict gate encodes that (offset ≥ 2″ AND ≥ 3σ).
 * - Saturated targets (Kp ≲ 11.5) produce meaningless moment centroids
 *   (bleed columns): NASA's own table shows a confirmed planet on a
 *   mag-9.2 star reading a 6.6″ "offset". The gate REFUSES those stars
 *   instead of echoing a bogus number.
 *
 * Known approximation (documented, accepted): per-quarter offsets are
 * averaged in STAMP-frame pixel coordinates. Kepler's quarterly roll
 * changes the stamp's sky orientation, which mixes frames across
 * quarters; empirically the FP ground truth still reproduces to 0.2σ and
 * the clean planet stays consistent with zero, and the 2″ verdict floor
 * absorbs the residual. A physical-CCD/WCS-frame average is the known
 * refinement if the floor ever needs to drop.
 *
 * Dependency-free and side-effect-free: runs in the API route and in the
 * offline regression tests against frozen fixtures.
 */

/** @description Kepler plate scale: arcsec of sky per detector pixel. */
export const KEPLER_ARCSEC_PER_PX = 3.98

/**
 * @description Kepler magnitude above which (numerically below which) the
 * target is bright enough to saturate the detector and bleed charge along
 * columns, making a moment centroid meaningless. Kepler's nominal
 * saturation limit is Kp ≈ 11.3–11.5; 11.5 is the conservative edge.
 * Ground truth for the refusal: K00003.01 (Kepler-3b, Kp 9.17, a
 * CONFIRMED planet) carries a bogus 6.6″ centroid offset in the DR25
 * table purely from saturation bleed.
 */
export const KEPLER_SATURATION_KEPMAG = 11.5

/**
 * @description Significance bar (in vector-scatter standard-error units)
 * for reporting a measured offset as significant. 3σ matches the odd/even
 * and phase-0.5 checks. Measured z on the calibration pair: FP ≈ 10σ,
 * clean planet ≈ 1.5σ.
 */
export const CENTROID_SIGMA_THRESHOLD = 3

/**
 * @description Minimum offset magnitude (arcsec) for OFFSET_DETECTED —
 * the calibrated sensitivity floor (≈ half a Kepler pixel). Below it a
 * statistically-significant vector mean is still within the stamp-frame
 * averaging approximation's residual, so the verdict stays
 * NO_SIGNIFICANT_OFFSET and the UI copy quotes the floor. Calibrated
 * against K01075.01 (a 1.02″ sub-pixel offset FP that this method cannot
 * resolve — frozen as a "must NOT fire" fixture) and K01800.01 (clean,
 * ~0.9″ vector-mean noise).
 */
export const CENTROID_MIN_OFFSET_ARCSEC = 2

/**
 * @description Fraction of the half-duration that counts as in-transit.
 * 0.7 keeps the in-transit stack in the flat bottom of the box and out of
 * ingress/egress, which would dilute the difference image.
 */
const IN_TRANSIT_CORE_FRAC = 0.7

/** @description Inner edge of the out-of-transit flank, in half-durations from mid-transit. */
const OUT_WINDOW_INNER_HALFDUR = 1.5

/** @description Outer edge of the out-of-transit flank, in half-durations from mid-transit. */
const OUT_WINDOW_OUTER_HALFDUR = 5

/** @description Minimum clean in-transit cadences for a quarter to contribute. */
const MIN_IN_CADENCES_PER_QUARTER = 5

/** @description Minimum clean out-of-transit cadences for a quarter to contribute. */
const MIN_OUT_CADENCES_PER_QUARTER = 10

/**
 * @description Minimum contributing quarters for a measurement. The error
 * bar comes from the scatter of per-quarter offset vectors, and a scatter
 * of fewer than 3 points is not a usable error estimate (same reasoning
 * as odd/even's MIN_CYCLES_PER_PARITY).
 */
export const MIN_QUARTERS_FOR_MEASUREMENT = 3

/** @description Cap for the significance so zero-noise synthetics stay finite. */
const SIGMA_CAP = 99

/**
 * @description One parsed TPF quarter as the engine consumes it — the
 * subset of `TpfQuarter` (tpfReader.ts) the math needs, kept structural
 * so frozen JSON fixtures can feed the engine without the FITS parser.
 */
export interface CentroidQuarterInput {
  /** Label for logs / per-quarter reporting (archive filename or quarter id). */
  label: string
  /** Stamp width (pixels; x varies fastest in `flux`). */
  nx: number
  /** Stamp height (pixels). */
  ny: number
  /** Per-cadence timestamps (BKJD); NaN for gap cadences. */
  times: number[]
  /** Per-cadence quality flags (0 = clean). */
  quality: number[]
  /** Flux cube, `times.length × nx*ny`, pixel (x,y) at `x + y*nx`; NaN allowed. */
  flux: ArrayLike<number>
  /**
   * Aperture bitmask (bit 2 = optimal aperture), for the UI overlay only —
   * the centroid math uses the full stamp. Null when unavailable.
   */
  apertureMask?: ArrayLike<number> | null
}

/** @description Per-quarter measured offset (reported for transparency/tests). */
export interface QuarterCentroidOffset {
  label: string
  /** Offset components in arcsec (difference-image centroid − photocenter), stamp frame. */
  dxArcsec: number
  dyArcsec: number
  /** Offset magnitude in arcsec. */
  rArcsec: number
  /** Clean in-transit / out-of-transit cadence counts that fed the stacks. */
  nIn: number
  nOut: number
}

/**
 * @description Pixel-stamp visuals for the UI, taken from the contributing
 * quarter with the most in-transit cadences. Arrays are `nx*ny` in the
 * cube's pixel order; non-finite entries mean "no data for this pixel"
 * (they JSON-serialize to null). Centroids are in stamp pixel coordinates.
 */
export interface CentroidStamp {
  label: string
  nx: number
  ny: number
  /** Mean out-of-transit image (e-/s). */
  meanOut: number[]
  /** Difference image, out − in (e-/s); positive where flux dropped in transit. */
  diff: number[]
  /** Flux-weighted centroid of `meanOut` (the star's photocenter), [x, y]. */
  photocenter: [number, number]
  /** Flux-weighted centroid of the positive part of `diff`, [x, y]. */
  diffCentroid: [number, number]
  /** Optimal-aperture bitmask for the outline overlay; null when unavailable. */
  apertureMask: number[] | null
}

/**
 * @description Result of the centroid vetting measurement. `status`
 * distinguishes the three honest outcomes: `measured` (numbers below are
 * real), `saturated` (target too bright — refused, no numbers), and
 * `insufficient` (not enough usable quarters/cadences for an error bar).
 * The verdict is a threshold call on the measurements (3σ AND ≥ 2″),
 * phrased as a property of the data, never of its cause.
 */
export interface CentroidVetResult {
  status: 'measured' | 'saturated' | 'insufficient'
  /** Kepler magnitude that drove a `saturated` refusal; null otherwise. */
  kepmag: number | null
  /** Vector-mean offset magnitude in arcsec; null unless `measured`. */
  offsetArcsec: number | null
  /** Standard error of the offset magnitude (from quarter scatter); null unless `measured`. */
  offsetErrArcsec: number | null
  /** offset / error, capped; null unless `measured`. */
  sigma: number | null
  /** Verdict on the measurement; null unless `measured`. */
  verdict: 'OFFSET_DETECTED' | 'NO_SIGNIFICANT_OFFSET' | null
  /** Quarters that contributed (passed the cadence minimums). */
  quartersUsed: number
  /** Per-quarter offsets, for transparency and the regression tests. */
  quarterOffsets: QuarterCentroidOffset[]
  /** Stamp visuals from the best contributing quarter; null unless `measured`. */
  stamp: CentroidStamp | null
  /** The sensitivity floor the verdict used, for UI copy. */
  floorArcsec: number
}

/**
 * @description Returns true when a Kepler magnitude is bright enough that
 * the saturation refusal applies. Null magnitudes do NOT gate (no
 * evidence of saturation) — the engine measures and the UI shows the
 * numbers with the standard caveats.
 * @param kepmag Kepler magnitude (Kp) from the TPF primary header.
 * @returns True when the target must be refused.
 */
export function isSaturatedKepmag(kepmag: number | null): boolean {
  return kepmag !== null && kepmag < KEPLER_SATURATION_KEPMAG
}

/**
 * @description Flux-weighted moment centroid over the positive, finite
 * pixels of an image.
 * @param img Image pixels (`nx*ny`, x fastest).
 * @param nx Stamp width.
 * @returns [x, y] centroid in pixel coordinates, or null when no pixel
 * contributed (all non-finite / non-positive).
 */
function imageCentroid(img: ArrayLike<number>, nx: number): [number, number] | null {
  let sx = 0
  let sy = 0
  let s = 0
  for (let p = 0; p < img.length; p++) {
    const v = img[p]
    if (!Number.isFinite(v) || v <= 0) continue
    sx += v * (p % nx)
    sy += v * Math.floor(p / nx)
    s += v
  }
  return s > 0 ? [sx / s, sy / s] : null
}

/**
 * @description Measures one quarter's difference-image centroid offset.
 * Returns the offset plus the stamp images (so the caller can keep the
 * best quarter's visuals), or null when the quarter lacks the cadence
 * minimums or a usable centroid.
 * @param q Parsed quarter.
 * @param periodDays Signal period in days.
 * @param epochDays Mid-transit epoch (BKJD — the TPF TIME system).
 * @param durationHours Transit duration in hours.
 * @returns Per-quarter measurement, or null when unusable.
 */
function measureQuarter(
  q: CentroidQuarterInput,
  periodDays: number,
  epochDays: number,
  durationHours: number,
): { offset: QuarterCentroidOffset; stamp: CentroidStamp } | null {
  const nPx = q.nx * q.ny
  const halfDur = durationHours / 24 / 2
  if (!(halfDur > 0) || !(periodDays > 0)) return null

  const inIdx: number[] = []
  const outIdx: number[] = []
  for (let r = 0; r < q.times.length; r++) {
    const t = q.times[r]
    if (!Number.isFinite(t) || q.quality[r] !== 0) continue
    const n = Math.round((t - epochDays) / periodDays)
    const dt = Math.abs(t - (epochDays + n * periodDays))
    if (dt < halfDur * IN_TRANSIT_CORE_FRAC) inIdx.push(r)
    else if (dt > halfDur * OUT_WINDOW_INNER_HALFDUR && dt < halfDur * OUT_WINDOW_OUTER_HALFDUR) outIdx.push(r)
  }
  if (inIdx.length < MIN_IN_CADENCES_PER_QUARTER || outIdx.length < MIN_OUT_CADENCES_PER_QUARTER) {
    return null
  }

  // Per-pixel NaN-aware means for the two stacks.
  const sumIn = new Float64Array(nPx)
  const sumOut = new Float64Array(nPx)
  const cntIn = new Int32Array(nPx)
  const cntOut = new Int32Array(nPx)
  for (const r of inIdx) {
    for (let p = 0; p < nPx; p++) {
      const f = q.flux[r * nPx + p]
      if (Number.isFinite(f)) {
        sumIn[p] += f
        cntIn[p]++
      }
    }
  }
  for (const r of outIdx) {
    for (let p = 0; p < nPx; p++) {
      const f = q.flux[r * nPx + p]
      if (Number.isFinite(f)) {
        sumOut[p] += f
        cntOut[p]++
      }
    }
  }

  const meanOut = new Array<number>(nPx)
  const diff = new Array<number>(nPx)
  for (let p = 0; p < nPx; p++) {
    const mo = cntOut[p] > 0 ? sumOut[p] / cntOut[p] : NaN
    const mi = cntIn[p] > 0 ? sumIn[p] / cntIn[p] : NaN
    meanOut[p] = mo
    diff[p] = Number.isFinite(mo) && Number.isFinite(mi) ? mo - mi : NaN
  }

  const photocenter = imageCentroid(meanOut, q.nx)
  const diffCentroid = imageCentroid(diff, q.nx)
  if (!photocenter || !diffCentroid) return null

  const dxArcsec = (diffCentroid[0] - photocenter[0]) * KEPLER_ARCSEC_PER_PX
  const dyArcsec = (diffCentroid[1] - photocenter[1]) * KEPLER_ARCSEC_PER_PX
  return {
    offset: {
      label: q.label,
      dxArcsec,
      dyArcsec,
      rArcsec: Math.hypot(dxArcsec, dyArcsec),
      nIn: inIdx.length,
      nOut: outIdx.length,
    },
    stamp: {
      label: q.label,
      nx: q.nx,
      ny: q.ny,
      meanOut,
      diff,
      photocenter,
      diffCentroid,
      apertureMask: q.apertureMask ? Array.from(q.apertureMask) : null,
    },
  }
}

/**
 * @description Runs the full centroid vetting measurement over a set of
 * parsed TPF quarters. Applies the saturation refusal first (kepmag from
 * the TPF headers is authoritative), measures each quarter, then
 * vector-averages the per-quarter offsets and applies the verdict gate
 * (≥ 3σ AND ≥ 2″).
 * @param quarters Parsed quarters (any that fail cadence minimums are skipped).
 * @param periodDays Signal period in days (from the confident BLS detection).
 * @param epochDays Mid-transit epoch in BKJD (BLS epoch — same time system as TPF TIME).
 * @param durationHours Transit duration in hours (BLS box duration).
 * @param kepmag Kepler magnitude from the TPF primary header (null = unknown, not gated).
 * @returns The measurement result (see `CentroidVetResult`).
 */
export function runCentroidVet(
  quarters: CentroidQuarterInput[],
  periodDays: number,
  epochDays: number,
  durationHours: number,
  kepmag: number | null,
): CentroidVetResult {
  const base = {
    kepmag,
    offsetArcsec: null,
    offsetErrArcsec: null,
    sigma: null,
    verdict: null,
    quarterOffsets: [] as QuarterCentroidOffset[],
    stamp: null,
    floorArcsec: CENTROID_MIN_OFFSET_ARCSEC,
  }
  if (isSaturatedKepmag(kepmag)) {
    return { ...base, status: 'saturated', quartersUsed: 0 }
  }

  const offsets: QuarterCentroidOffset[] = []
  let bestStamp: CentroidStamp | null = null
  let bestNIn = -1
  for (const q of quarters) {
    const m = measureQuarter(q, periodDays, epochDays, durationHours)
    if (!m) continue
    offsets.push(m.offset)
    if (m.offset.nIn > bestNIn) {
      bestNIn = m.offset.nIn
      bestStamp = m.stamp
    }
  }

  if (offsets.length < MIN_QUARTERS_FOR_MEASUREMENT) {
    return { ...base, status: 'insufficient', quartersUsed: offsets.length, quarterOffsets: offsets }
  }

  // Vector mean + standard error of the mean from the quarter scatter.
  const n = offsets.length
  const mx = offsets.reduce((a, o) => a + o.dxArcsec, 0) / n
  const my = offsets.reduce((a, o) => a + o.dyArcsec, 0) / n
  const varX = offsets.reduce((a, o) => a + (o.dxArcsec - mx) ** 2, 0) / (n - 1)
  const varY = offsets.reduce((a, o) => a + (o.dyArcsec - my) ** 2, 0) / (n - 1)
  const sx = Math.sqrt(varX / n)
  const sy = Math.sqrt(varY / n)
  const r = Math.hypot(mx, my)
  // Error of the magnitude: project the component errors along the mean
  // vector's direction (the direction a magnitude change moves in).
  const err = r > 0 ? Math.hypot(mx * sx, my * sy) / r : Math.max(sx, sy)
  const sigma = err > 0 ? Math.min(r / err, SIGMA_CAP) : r > 0 ? SIGMA_CAP : 0

  return {
    ...base,
    status: 'measured',
    offsetArcsec: r,
    offsetErrArcsec: err,
    sigma,
    verdict:
      sigma >= CENTROID_SIGMA_THRESHOLD && r >= CENTROID_MIN_OFFSET_ARCSEC
        ? 'OFFSET_DETECTED'
        : 'NO_SIGNIFICANT_OFFSET',
    quartersUsed: offsets.length,
    quarterOffsets: offsets,
    stamp: bestStamp,
  }
}
