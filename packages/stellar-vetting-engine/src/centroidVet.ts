// SPDX-License-Identifier: MIT
/**
 * @description Difference-image centroid vetting — the pixel-level
 * companion to the odd/even and phase-0.5 checks. Given a confident
 * periodic box signal (period / epoch / duration) and a set of parsed
 * TPF segments (Kepler quarters / TESS sectors), it measures WHERE on
 * the sky the transit signal originates: the difference between the mean
 * out-of-transit pixel stamp and the mean in-transit stamp is the
 * transit signal localized on the detector, and the offset between that
 * difference image's centroid and the TARGET'S CATALOG POSITION is the
 * measured quantity. All numbers are reported as measurements (offset ±
 * error, significance); consumers must present them descriptively and
 * never translate them into a physical cause (see the
 * describe-don't-diagnose rule in `curveClassifier.ts`).
 *
 * Method (difference imaging — what the Kepler DV pipeline computes; its
 * `koi_dikco_msky` outputs are this feature's calibration ground truth):
 * 1. Per segment: classify clean cadences (QUALITY == 0) into in-transit
 *    (|dt| < IN_TRANSIT_CORE_FRAC × duration/2 from the nearest transit
 *    center) and local out-of-transit flanks.
 * 2. Per segment: mean in-transit stamp, mean out-of-transit stamp
 *    (per-pixel, NaN-aware), difference = out − in.
 * 3. Per segment: flux-weighted moment centroid of the (positive part of
 *    the) difference image, measured against the FLUX column's WCS
 *    reference pixel — which the pipeline sets to the target's catalog
 *    position — and converted to a tangent-plane sky offset
 *    (ΔRA·cosδ, ΔDec, arcsec) through the WCS rotation matrix and pixel
 *    scale. When a segment carries no WCS the engine falls back to the
 *    out-of-transit moment photocenter reference at a fixed Kepler pixel
 *    scale (the phase-1 behavior; `referenceFrame` reports which ran).
 * 4. VECTOR-average the per-segment offsets (mean of dx, dy; error from
 *    scatter/√N). Segment noise directions are random, so vector
 *    averaging cancels the noise-magnitude bias that averaging |offset|
 *    would keep.
 *
 * Calibration (measured 2026-07-10 against NASA DR25 `koi_dikco_msky`,
 * the difference-image offset from the KIC catalog position — see
 * docs/DESIGN_tpf-centroid-analysis.md and the phase-2 investigation):
 * - K02606.01 (centroid-offset FALSE POSITIVE, NASA dikco 6.889″ ±
 *   0.091″): this engine measures ~7.3″ ± 0.9 — fires OFFSET_DETECTED.
 * - K01317.01 (on-target eclipsing binary, NASA dikco 0.040″): reads
 *   ~0.12″ ± 0.12. Under the phase-1 photocenter reference this star
 *   read 1.81″ — the reference point, NOT frame rotation, was the
 *   ~1.8″ systematic: a moment photocenter of the out-of-transit stamp
 *   is biased by neighbor-star crowding and stamp truncation, while the
 *   WCS reference pixel is bias-free. (The frame-rotation hypothesis was
 *   tested and refuted: Kepler's focal-plane symmetry keeps each star's
 *   stamp orientation constant across quarters — all six quarters of
 *   every calibration star share one PC rotation angle — so stamp-frame
 *   and sky-frame vector means have identical magnitude.)
 * - K00931.01 (clean confirmed, NASA dikco 0.095″): 1.92″ → ~0.34″.
 * - K01800.01 (clean confirmed, NASA dikco 0.443″): reads ~1.16″ ±
 *   0.37 — which is why the 2″ verdict floor STAYS despite the smaller
 *   per-star errors: a 1″ floor would false-alarm on this clean planet.
 * - Noise-clipping the difference image was measured and REJECTED in
 *   phase 1 (biases the centroid toward the brightest residual pixel).
 *
 * Mission scope: calibrated for KEPLER against DR25 ground truth. TESS
 * segments run through the identical math (their TPFs carry the same
 * WCS keywords), but there is NO public per-TOI centroid ground truth to
 * validate against, and TESS's 21″ pixels put the half-pixel floor near
 * 10″ — consumers MUST label TESS results qualitative/unvalidated.
 *
 * Saturated targets (Kepler Kp < 11.5; TESS Tmag < 6.8) produce
 * meaningless moment centroids (bleed columns): NASA's own table shows a
 * confirmed planet on a mag-9.2 star reading a 6.6″ "offset". The gate
 * REFUSES those stars instead of echoing a bogus number.
 *
 * Dependency-free and side-effect-free: runs in the API route and in the
 * offline regression tests against frozen fixtures.
 */

/** @description Kepler plate scale (arcsec/px) for the no-WCS fallback path. */
export const KEPLER_ARCSEC_PER_PX = 3.98

/**
 * @description Kepler magnitude below which (brighter than) the target
 * saturates and bleeds charge along columns, making a moment centroid
 * meaningless. Kepler's nominal saturation limit is Kp ≈ 11.3–11.5;
 * 11.5 is the conservative edge. Ground truth for the refusal:
 * K00003.01 (Kepler-3b, Kp 9.17, a CONFIRMED planet) carries a bogus
 * 6.6″ centroid offset in the DR25 table purely from saturation bleed.
 */
export const KEPLER_SATURATION_KEPMAG = 11.5

/**
 * @description TESS magnitude below which the target saturates (TESS
 * cameras saturate near Tmag ≈ 6.8 for 2-min stamps).
 */
export const TESS_SATURATION_TMAG = 6.8

/**
 * @description Significance bar (in vector-scatter standard-error units)
 * for reporting a measured offset as significant. 3σ matches the odd/even
 * and phase-0.5 checks.
 */
export const CENTROID_SIGMA_THRESHOLD = 3

/**
 * @description Minimum offset magnitude for OFFSET_DETECTED, expressed as
 * a fraction of the pixel scale (half a pixel). At Kepler's 3.98″/px
 * this is ~2″ — the calibrated floor: K01800.01, a CLEAN confirmed
 * planet, measures 1.16″ ± 0.37 against its catalog position (NASA
 * dikco 0.443″), so any floor much below 2″ would false-alarm on it.
 * At TESS's ~21″/px the same half-pixel logic puts the floor near 10″.
 */
export const CENTROID_FLOOR_PX = 0.5

/** @description Lower bound on the verdict floor in arcsec (the Kepler-calibrated value). */
export const CENTROID_MIN_FLOOR_ARCSEC = 2

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

/** @description Minimum clean in-transit cadences for a segment to contribute. */
const MIN_IN_CADENCES_PER_QUARTER = 5

/** @description Minimum clean out-of-transit cadences for a segment to contribute. */
const MIN_OUT_CADENCES_PER_QUARTER = 10

/**
 * @description Minimum contributing segments for a measurement. The error
 * bar comes from the scatter of per-segment offset vectors, and a scatter
 * of fewer than 3 points is not a usable error estimate (same reasoning
 * as odd/even's MIN_CYCLES_PER_PARITY).
 */
export const MIN_QUARTERS_FOR_MEASUREMENT = 3

/** @description Cap for the significance so zero-noise synthetics stay finite. */
const SIGMA_CAP = 99

/**
 * @description Linear WCS of one segment's FLUX column (see
 * `TpfWcs` in tpfReader.ts — duplicated structurally here so the engine
 * stays free of reader imports and fixtures can feed plain JSON).
 */
export interface CentroidWcs {
  crpx1: number
  crpx2: number
  cdelt1: number
  cdelt2: number
  pc11: number
  pc12: number
  pc21: number
  pc22: number
}

/**
 * @description One parsed TPF segment as the engine consumes it — the
 * subset of `TpfQuarter` (tpfReader.ts) the math needs, kept structural
 * so frozen JSON fixtures can feed the engine without the FITS parser.
 */
export interface CentroidQuarterInput {
  /** Label for logs / per-segment reporting (archive filename or segment id). */
  label: string
  /** Stamp width (pixels; x varies fastest in `flux`). */
  nx: number
  /** Stamp height (pixels). */
  ny: number
  /** Per-cadence timestamps (BKJD/TJD); NaN for gap cadences. */
  times: number[]
  /** Per-cadence quality flags (0 = clean). */
  quality: number[]
  /** Flux cube, `times.length × nx*ny`, pixel (x,y) at `x + y*nx`; NaN allowed. */
  flux: ArrayLike<number>
  /** FLUX-column WCS; null/undefined → the fallback photocenter path runs. */
  wcs?: CentroidWcs | null
  /**
   * Aperture bitmask (bit 2 = optimal aperture), for the UI overlay only —
   * the centroid math uses the full stamp. Null when unavailable.
   */
  apertureMask?: ArrayLike<number> | null
}

/** @description Per-segment measured offset (reported for transparency/tests). */
export interface QuarterCentroidOffset {
  label: string
  /**
   * Offset components in arcsec: with WCS, dx = ΔRA·cosδ (east-positive)
   * and dy = ΔDec, measured from the target's catalog position; on the
   * fallback path, stamp-frame components from the photocenter.
   */
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
 * segment with the most in-transit cadences. Arrays are `nx*ny` in the
 * cube's pixel order; non-finite entries mean "no data for this pixel"
 * (they JSON-serialize to null). Positions are in stamp pixel coordinates.
 */
export interface CentroidStamp {
  label: string
  nx: number
  ny: number
  /** Mean out-of-transit image (e-/s). */
  meanOut: number[]
  /** Difference image, out − in (e-/s); positive where flux dropped in transit. */
  diff: number[]
  /** Flux-weighted centroid of `meanOut` (the stamp's photocenter), [x, y]. */
  photocenter: [number, number]
  /** Flux-weighted centroid of the positive part of `diff`, [x, y]. */
  diffCentroid: [number, number]
  /**
   * The target's catalog position in stamp coordinates (WCS reference
   * pixel, 0-based) — the offset's reference point. Null on the fallback
   * path (no WCS), where `photocenter` is the reference instead.
   */
  catalogPosition: [number, number] | null
  /** Optimal-aperture bitmask for the outline overlay; null when unavailable. */
  apertureMask: number[] | null
}

/**
 * @description Result of the centroid vetting measurement. `status`
 * distinguishes the three honest outcomes: `measured` (numbers below are
 * real), `saturated` (target too bright — refused, no numbers), and
 * `insufficient` (not enough usable segments/cadences for an error bar).
 * The verdict is a threshold call on the measurements (3σ AND the
 * half-pixel floor), phrased as a property of the data, never of its
 * cause.
 */
export interface CentroidVetResult {
  status: 'measured' | 'saturated' | 'insufficient'
  /** Brightness magnitude (Kp/Tmag) that drove a `saturated` refusal; null otherwise. */
  kepmag: number | null
  /** Vector-mean offset magnitude in arcsec; null unless `measured`. */
  offsetArcsec: number | null
  /** Standard error of the offset magnitude (from segment scatter); null unless `measured`. */
  offsetErrArcsec: number | null
  /** offset / error, capped; null unless `measured`. */
  sigma: number | null
  /** Verdict on the measurement; null unless `measured`. */
  verdict: 'OFFSET_DETECTED' | 'NO_SIGNIFICANT_OFFSET' | null
  /**
   * Which reference the offsets were measured against: `catalog-wcs`
   * (target catalog position via per-segment WCS — the calibrated path)
   * or `photocenter` (fallback when any usable segment lacked WCS; the
   * phase-1 behavior, subject to the ~1–2″ crowding bias).
   */
  referenceFrame: 'catalog-wcs' | 'photocenter' | null
  /** Segments that contributed (passed the cadence minimums). */
  quartersUsed: number
  /** Per-segment offsets, for transparency and the regression tests. */
  quarterOffsets: QuarterCentroidOffset[]
  /** Stamp visuals from the best contributing segment; null unless `measured`. */
  stamp: CentroidStamp | null
  /** The sensitivity floor the verdict used (arcsec), for UI copy. */
  floorArcsec: number
}

/**
 * @description Returns true when a target's brightness magnitude is
 * bright enough that the saturation refusal applies for its mission.
 * Null magnitudes do NOT gate (no evidence of saturation).
 * @param mission Which mission's saturation limit applies.
 * @param mag Kp (Kepler) or Tmag (TESS) from the TPF primary header.
 * @returns True when the target must be refused.
 */
export function isSaturatedMag(mission: 'Kepler' | 'TESS', mag: number | null): boolean {
  if (mag === null) return false
  return mag < (mission === 'Kepler' ? KEPLER_SATURATION_KEPMAG : TESS_SATURATION_TMAG)
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
 * @description Measures one segment's difference-image centroid offset.
 * Returns the offset plus the stamp images (so the caller can keep the
 * best segment's visuals), or null when the segment lacks the cadence
 * minimums or a usable centroid.
 * @param q Parsed segment.
 * @param periodDays Signal period in days.
 * @param epochDays Mid-transit epoch (same time system as the TPF TIME column).
 * @param durationHours Transit duration in hours.
 * @param useWcs When true (all segments have WCS) offsets are measured
 * from the catalog position through the WCS; when false the photocenter
 * fallback runs.
 * @returns Per-segment measurement, or null when unusable.
 */
function measureQuarter(
  q: CentroidQuarterInput,
  periodDays: number,
  epochDays: number,
  durationHours: number,
  useWcs: boolean,
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

  let dxArcsec: number
  let dyArcsec: number
  let catalogPosition: [number, number] | null = null
  if (useWcs && q.wcs) {
    // Reference = the WCS reference pixel (the target's catalog position;
    // FITS CRPX is 1-based). Convert the pixel offset to a tangent-plane
    // sky offset through the linear WCS: world = CDELT · (PC · Δpix),
    // deg → arcsec. dx is ΔRA·cosδ (the tangent plane bakes in cosδ).
    const w = q.wcs
    const refX = w.crpx1 - 1
    const refY = w.crpx2 - 1
    catalogPosition = [refX, refY]
    const dxPx = diffCentroid[0] - refX
    const dyPx = diffCentroid[1] - refY
    dxArcsec = w.cdelt1 * (w.pc11 * dxPx + w.pc12 * dyPx) * 3600
    dyArcsec = w.cdelt2 * (w.pc21 * dxPx + w.pc22 * dyPx) * 3600
  } else {
    // Fallback (phase-1 behavior): photocenter reference, fixed Kepler
    // pixel scale, stamp-frame components. Subject to the documented
    // crowding bias — `referenceFrame` tells the consumer which ran.
    dxArcsec = (diffCentroid[0] - photocenter[0]) * KEPLER_ARCSEC_PER_PX
    dyArcsec = (diffCentroid[1] - photocenter[1]) * KEPLER_ARCSEC_PER_PX
  }

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
      catalogPosition,
      apertureMask: q.apertureMask ? Array.from(q.apertureMask) : null,
    },
  }
}

/**
 * @description Runs the full centroid vetting measurement over a set of
 * parsed TPF segments. Applies the saturation refusal first (the
 * magnitude from the TPF headers is authoritative), measures each
 * segment against the target's catalog position (WCS path; photocenter
 * fallback when any usable segment lacks WCS), then vector-averages the
 * per-segment offsets and applies the verdict gate (≥ 3σ AND the
 * half-pixel floor).
 * @param quarters Parsed segments (any that fail cadence minimums are skipped).
 * @param periodDays Signal period in days (from the confident BLS detection).
 * @param epochDays Mid-transit epoch in the curve's native day system
 * (BKJD/TJD — same as the TPF TIME column).
 * @param durationHours Transit duration in hours (BLS box duration).
 * @param mag Brightness magnitude from the TPF primary header (Kp or
 * Tmag; null = unknown, not gated).
 * @param mission Which mission's saturation limit and pixel scale apply.
 * @returns The measurement result (see `CentroidVetResult`).
 */
export function runCentroidVet(
  quarters: CentroidQuarterInput[],
  periodDays: number,
  epochDays: number,
  durationHours: number,
  mag: number | null,
  mission: 'Kepler' | 'TESS' = 'Kepler',
): CentroidVetResult {
  const base = {
    kepmag: mag,
    offsetArcsec: null,
    offsetErrArcsec: null,
    sigma: null,
    verdict: null,
    referenceFrame: null,
    quarterOffsets: [] as QuarterCentroidOffset[],
    stamp: null,
    floorArcsec: CENTROID_MIN_FLOOR_ARCSEC,
  }
  if (isSaturatedMag(mission, mag)) {
    return { ...base, status: 'saturated', quartersUsed: 0 }
  }

  // WCS is all-or-nothing across the run: mixing catalog-referenced and
  // photocenter-referenced segments would average two different
  // measurements. Every real MAST TPF observed carries the keywords, so
  // the fallback only realistically runs on legacy/partial inputs.
  const useWcs = quarters.length > 0 && quarters.every(q => q.wcs != null)

  // Verdict floor = half a pixel, in arcsec. With WCS the true per-file
  // pixel scale is used; the fallback assumes Kepler's. Never below the
  // Kepler-calibrated 2″ (see CENTROID_FLOOR_PX docs).
  const pxScaleArcsec = useWcs
    ? Math.abs(quarters[0].wcs!.cdelt2) * 3600
    : KEPLER_ARCSEC_PER_PX
  const floorArcsec = Math.max(CENTROID_MIN_FLOOR_ARCSEC, CENTROID_FLOOR_PX * pxScaleArcsec)

  const offsets: QuarterCentroidOffset[] = []
  let bestStamp: CentroidStamp | null = null
  let bestNIn = -1
  for (const q of quarters) {
    const m = measureQuarter(q, periodDays, epochDays, durationHours, useWcs)
    if (!m) continue
    offsets.push(m.offset)
    if (m.offset.nIn > bestNIn) {
      bestNIn = m.offset.nIn
      bestStamp = m.stamp
    }
  }

  if (offsets.length < MIN_QUARTERS_FOR_MEASUREMENT) {
    return {
      ...base,
      status: 'insufficient',
      quartersUsed: offsets.length,
      quarterOffsets: offsets,
      floorArcsec,
    }
  }

  // Vector mean + standard error of the mean from the segment scatter.
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
      sigma >= CENTROID_SIGMA_THRESHOLD && r >= floorArcsec
        ? 'OFFSET_DETECTED'
        : 'NO_SIGNIFICANT_OFFSET',
    referenceFrame: useWcs ? 'catalog-wcs' : 'photocenter',
    quartersUsed: offsets.length,
    quarterOffsets: offsets,
    stamp: bestStamp,
    floorArcsec,
  }
}
