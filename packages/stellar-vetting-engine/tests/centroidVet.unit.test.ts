// SPDX-License-Identifier: MIT
/**
 * @description Unit tests for `runCentroidVet` driven by small SYNTHETIC
 * TPF quarter inputs (no FITS, no network) so the engine's decision paths
 * are pinned independently of the frozen real-data centroid fixtures:
 *   - saturation refusal (bright magnitude → status 'saturated', no numbers);
 *   - insufficient-segments path (< MIN_QUARTERS_FOR_MEASUREMENT usable);
 *   - a clean measured case with a KNOWN injected sky offset (verdict +
 *     magnitude recovered through the WCS);
 *   - the on-target (zero-offset) measured case → NO_SIGNIFICANT_OFFSET;
 *   - WCS vs photocenter reference-frame branching (all-or-nothing).
 *
 * Synthetic-stamp construction: a flat baseline stamp where exactly ONE
 * pixel dims during transit. The difference image (out − in) is then a
 * single positive pixel, so its flux-weighted centroid sits exactly on
 * that pixel — a controllable ground-truth source position. Placing it on
 * the WCS reference pixel yields a ~0 offset; placing it one pixel away
 * yields an offset of one pixel scale.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runCentroidVet,
  isSaturatedMag,
  KEPLER_ARCSEC_PER_PX,
  KEPLER_SATURATION_KEPMAG,
  CENTROID_MIN_FLOOR_ARCSEC,
  MIN_QUARTERS_FOR_MEASUREMENT,
  type CentroidQuarterInput,
  type CentroidWcs,
} from '../src/centroidVet.ts'

const NX = 5
const NY = 5
const BASELINE = 1000 // e-/s per pixel, flat
const DIP_FRACTION = 0.2 // the marked pixel loses 20% of its flux in transit

/**
 * @description An axis-aligned Kepler-scale WCS whose reference pixel
 * (catalog position) is at stamp pixel (refX, refY) 0-based. CRPX is
 * 1-based (FITS convention), so crpx = ref + 1. CDELT is degrees/pixel;
 * negative CDELT1 mirrors real sky (RA increases leftward) but for a
 * pure-magnitude test the sign only flips dx's sign, not |offset|.
 * @param refX Reference pixel x (0-based).
 * @param refY Reference pixel y (0-based).
 * @returns A CentroidWcs with no rotation and Kepler pixel scale.
 */
function keplerWcs(refX: number, refY: number): CentroidWcs {
  const degPerPx = KEPLER_ARCSEC_PER_PX / 3600
  return {
    crpx1: refX + 1,
    crpx2: refY + 1,
    cdelt1: -degPerPx,
    cdelt2: degPerPx,
    pc11: 1,
    pc12: 0,
    pc21: 0,
    pc22: 1,
  }
}

/**
 * @description Builds a synthetic TPF quarter: a flat BASELINE stamp at
 * every clean cadence, with the pixel (dimX, dimY) reduced by DIP_FRACTION
 * during in-transit cadences. Generates enough evenly-spaced cadences over
 * several periods that each transit contributes ≥ the required in/out
 * cadence minimums.
 * @param label Segment label.
 * @param period Signal period in days.
 * @param epoch Mid-transit epoch (day 0 phase).
 * @param durationHours Transit duration in hours.
 * @param dimX Dimming pixel x (the injected source position).
 * @param dimY Dimming pixel y.
 * @param wcs FLUX-column WCS, or null for the photocenter fallback path.
 * @returns A CentroidQuarterInput.
 */
function syntheticQuarter(
  label: string,
  period: number,
  epoch: number,
  durationHours: number,
  dimX: number,
  dimY: number,
  wcs: CentroidWcs | null,
): CentroidQuarterInput {
  const nPx = NX * NY
  const halfDur = durationHours / 24 / 2
  const times: number[] = []
  const quality: number[] = []
  const fluxRows: number[] = []
  const cadence = 0.02 // ~30 min

  // Cover 8 periods; at each cadence decide in/out and paint the stamp.
  const tStart = epoch - period
  const tEnd = epoch + 7 * period
  for (let t = tStart; t <= tEnd; t += cadence) {
    const n = Math.round((t - epoch) / period)
    const dt = Math.abs(t - (epoch + n * period))
    const inTransit = dt < halfDur * 0.7
    // Only keep clean cadences that are clearly in-transit or in the
    // out-of-transit flank window — skip ingress/egress ambiguity.
    const inFlank = dt > halfDur * 1.5 && dt < halfDur * 5
    if (!inTransit && !inFlank) continue
    times.push(t)
    quality.push(0)
    for (let p = 0; p < nPx; p++) {
      const x = p % NX
      const y = Math.floor(p / NX)
      let v = BASELINE
      if (inTransit && x === dimX && y === dimY) v = BASELINE * (1 - DIP_FRACTION)
      fluxRows.push(v)
    }
  }
  return { label, nx: NX, ny: NY, times, quality, flux: fluxRows, wcs }
}

describe('runCentroidVet — synthetic decision paths', () => {
  it('refuses a saturated (too-bright) target without producing numbers', () => {
    const period = 3
    const epoch = 100
    const q = () => syntheticQuarter('q', period, epoch, 4, 2, 2, keplerWcs(2, 2))
    const brightMag = KEPLER_SATURATION_KEPMAG - 1 // brighter than the limit
    const res = runCentroidVet([q(), q(), q()], period, epoch, 4, brightMag, 'Kepler')
    assert.equal(res.status, 'saturated')
    assert.equal(res.offsetArcsec, null)
    assert.equal(res.verdict, null)
    assert.equal(res.kepmag, brightMag)
    // Sanity: the shared predicate agrees.
    assert.equal(isSaturatedMag('Kepler', brightMag), true)
  })

  it('reports insufficient when fewer than the minimum segments are usable', () => {
    const period = 3
    const epoch = 100
    // Only two usable quarters → below MIN_QUARTERS_FOR_MEASUREMENT (3).
    const q = () => syntheticQuarter('q', period, epoch, 4, 2, 2, keplerWcs(2, 2))
    const res = runCentroidVet([q(), q()], period, epoch, 4, 13, 'Kepler')
    assert.equal(res.status, 'insufficient')
    assert.ok(res.quartersUsed < MIN_QUARTERS_FOR_MEASUREMENT)
    assert.equal(res.offsetArcsec, null)
  })

  it('measures ~0 offset (on-target) and returns NO_SIGNIFICANT_OFFSET', () => {
    const period = 3
    const epoch = 100
    // Dimming pixel sits ON the WCS reference pixel (2,2) → offset ≈ 0.
    const q = (lbl: string) => syntheticQuarter(lbl, period, epoch, 4, 2, 2, keplerWcs(2, 2))
    const res = runCentroidVet([q('a'), q('b'), q('c')], period, epoch, 4, 13, 'Kepler')
    assert.equal(res.status, 'measured')
    assert.equal(res.referenceFrame, 'catalog-wcs')
    assert.ok(res.offsetArcsec !== null && res.offsetArcsec < 0.5, `on-target offset ${res.offsetArcsec}″ ≈ 0`)
    assert.equal(res.verdict, 'NO_SIGNIFICANT_OFFSET')
    assert.equal(res.quartersUsed, 3)
  })

  it('recovers a KNOWN injected offset through the WCS and fires OFFSET_DETECTED', () => {
    const period = 3
    const epoch = 100
    // Reference pixel at (2,2); dimming pixel two pixels away in x →
    // expected offset ≈ 2 × KEPLER_ARCSEC_PER_PX (≈ 7.96″), well over the 2″ floor.
    const ref: [number, number] = [2, 2]
    const dim: [number, number] = [4, 2]
    const expectedArcsec = Math.hypot(dim[0] - ref[0], dim[1] - ref[1]) * KEPLER_ARCSEC_PER_PX
    const q = (lbl: string) => syntheticQuarter(lbl, period, epoch, 4, dim[0], dim[1], keplerWcs(ref[0], ref[1]))
    const res = runCentroidVet([q('a'), q('b'), q('c'), q('d')], period, epoch, 4, 13, 'Kepler')
    assert.equal(res.status, 'measured')
    assert.equal(res.referenceFrame, 'catalog-wcs')
    assert.ok(res.offsetArcsec !== null, 'offset measured')
    assert.ok(
      Math.abs(res.offsetArcsec! - expectedArcsec) < 0.5,
      `recovered offset ${res.offsetArcsec!.toFixed(2)}″ ≈ expected ${expectedArcsec.toFixed(2)}″`,
    )
    assert.ok(res.offsetArcsec! >= res.floorArcsec, 'offset clears the verdict floor')
    assert.equal(res.verdict, 'OFFSET_DETECTED')
    // Every synthetic quarter is identical, so segment scatter → 0 and the
    // capped sigma is large (well past the 3σ bar).
    assert.ok(res.sigma !== null && res.sigma >= 3, `sigma ${res.sigma} clears 3σ`)
  })

  it('falls back to the photocenter reference frame when any usable segment lacks WCS', () => {
    const period = 3
    const epoch = 100
    // Mix a WCS-less quarter in → the whole run uses the photocenter path.
    // The photocenter of the flat out-of-transit stamp is the grid center
    // (2,2); the diff centroid is the dimming pixel, so the stamp-frame
    // offset is still recovered, just referenced to the photocenter.
    const withWcs = (lbl: string) => syntheticQuarter(lbl, period, epoch, 4, 4, 2, keplerWcs(2, 2))
    const noWcs = (lbl: string) => syntheticQuarter(lbl, period, epoch, 4, 4, 2, null)
    const res = runCentroidVet([withWcs('a'), noWcs('b'), noWcs('c')], period, epoch, 4, 13, 'Kepler')
    assert.equal(res.status, 'measured')
    assert.equal(res.referenceFrame, 'photocenter', 'a single WCS-less segment forces the fallback for the whole run')
    // The floor stays at the Kepler-calibrated minimum on the fallback path.
    assert.equal(res.floorArcsec, CENTROID_MIN_FLOOR_ARCSEC)
    assert.ok(res.offsetArcsec !== null)
  })

  it('uses the WCS reference frame only when every segment carries WCS', () => {
    const period = 3
    const epoch = 100
    const q = (lbl: string) => syntheticQuarter(lbl, period, epoch, 4, 2, 2, keplerWcs(2, 2))
    const res = runCentroidVet([q('a'), q('b'), q('c')], period, epoch, 4, 13, 'Kepler')
    assert.equal(res.referenceFrame, 'catalog-wcs')
  })
})
