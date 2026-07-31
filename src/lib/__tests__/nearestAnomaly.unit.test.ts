/**
 * @description Unit tests for the nearest-anomaly search (issue #22, bug 1).
 *
 * The bug: "nearest" is measured against `cameraTarget`, which CameraSync
 * rewrites every frame from the camera's live pointing direction. In the
 * dense Kepler field the nearest anomaly to where you are already looking is
 * usually the star already selected, so GO TO NEAREST ANOMALY flew to where
 * the camera already was — a button that appeared to do nothing.
 *
 * The fix excludes ONLY the selected star. These tests pin that exclusion,
 * the no-selection path (first click), and the deliberate ABSENCE of
 * distance special-casing.
 *
 * Run via `npm run test:unit` (plain Node ≥ 22.15, node:test + native
 * type stripping — no framework).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findNearestAnomalyIndex,
  toUnitVector,
  type NearestCandidate,
} from '../nearestAnomaly.ts'

/** @description Three anomalies in increasing angular distance from RA 300 / Dec 44. */
const STARS: NearestCandidate[] = [
  { id: 'KIC_NEAR', ra: 300.0, dec: 44.0 },   // exactly at the camera
  { id: 'KIC_MID', ra: 302.0, dec: 44.5 },    // a couple of degrees away
  { id: 'KIC_FAR', ra: 120.0, dec: -30.0 },   // most of the sky away
]

describe('findNearestAnomalyIndex — the exclusion (issue #22 bug 1)', () => {
  it('returns the genuinely nearest star when nothing is selected', () => {
    // First-click case: no prior selection, so no exclusion applies.
    assert.equal(findNearestAnomalyIndex(STARS, 300, 44, null), 0)
    assert.equal(findNearestAnomalyIndex(STARS, 300, 44, undefined), 0)
    assert.equal(findNearestAnomalyIndex(STARS, 300, 44), 0)
  })

  it('skips the selected star and returns the NEXT nearest', () => {
    // The core regression: pointing straight at KIC_NEAR while it is
    // selected must move the user onward, not re-target the same star.
    assert.equal(findNearestAnomalyIndex(STARS, 300, 44, 'KIC_NEAR'), 1)
  })

  it('excludes only the selected star, never the rest', () => {
    // Excluding the middle one leaves the nearest still winning — the
    // exclusion must not be an accidental "skip everything closer".
    assert.equal(findNearestAnomalyIndex(STARS, 300, 44, 'KIC_MID'), 0)
    assert.equal(findNearestAnomalyIndex(STARS, 300, 44, 'KIC_FAR'), 0)
  })

  it('an id that is not in the list changes nothing', () => {
    assert.equal(findNearestAnomalyIndex(STARS, 300, 44, 'KIC_NOT_PRESENT'), 0)
  })
})

describe('findNearestAnomalyIndex — edge cases', () => {
  it('picks the next-closest even when it is very far away (no distance cutoff)', () => {
    // Deliberate: with only the on-camera star and one across the sky,
    // excluding the former must still fly to the latter. A distance cutoff
    // would silently reintroduce a dead button in sparse regions.
    const sparse: NearestCandidate[] = [STARS[0], STARS[2]]
    assert.equal(findNearestAnomalyIndex(sparse, 300, 44, 'KIC_NEAR'), 1)
  })

  it('returns -1 when the selected star is the only candidate', () => {
    // Nowhere else to go. The caller must treat -1 as "do nothing" rather
    // than flying to index 0, which was the old default-to-zero behavior.
    assert.equal(findNearestAnomalyIndex([STARS[0]], 300, 44, 'KIC_NEAR'), -1)
  })

  it('returns -1 for an empty candidate list', () => {
    assert.equal(findNearestAnomalyIndex([], 300, 44, null), -1)
    assert.equal(findNearestAnomalyIndex([], 300, 44, 'KIC_NEAR'), -1)
  })

  it('never returns the excluded index, swept over every star as the selection', () => {
    // Property form: whichever star is selected, the result is never it.
    for (const sel of STARS) {
      const idx = findNearestAnomalyIndex(STARS, 300, 44, sel.id)
      assert.notEqual(STARS[idx]?.id, sel.id, `returned the excluded star ${sel.id}`)
    }
  })
})

describe('findNearestAnomalyIndex — angular correctness', () => {
  it('works across the RA 0/360 seam', () => {
    // RA 359 and RA 1 are 2° apart, not 358°. A naive coordinate difference
    // would pick the wrong star here; the dot product gets it right.
    const seam: NearestCandidate[] = [
      { id: 'FAR_BY_RA_NUMBER', ra: 180, dec: 0 },
      { id: 'NEAR_ACROSS_SEAM', ra: 1, dec: 0 },
    ]
    assert.equal(findNearestAnomalyIndex(seam, 359, 0, null), 1)
  })

  it('works near the celestial pole', () => {
    // Near the pole, large RA differences are small angular distances.
    const polar: NearestCandidate[] = [
      { id: 'EQUATOR', ra: 0, dec: 0 },
      { id: 'NEAR_POLE', ra: 180, dec: 89 },
    ]
    assert.equal(findNearestAnomalyIndex(polar, 0, 89.5, null), 1)
  })
})

describe('toUnitVector', () => {
  it('produces unit-length vectors', () => {
    for (const [ra, dec] of [[0, 0], [300, 44], [359.9, -89], [180, 90]]) {
      const v = toUnitVector(ra, dec)
      const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
      assert.ok(Math.abs(len - 1) < 1e-12, `|v| = ${len} at ra=${ra} dec=${dec}`)
    }
  })

  it('maps declination to the y axis', () => {
    assert.ok(Math.abs(toUnitVector(0, 90).y - 1) < 1e-12, 'north pole → +y')
    assert.ok(Math.abs(toUnitVector(0, -90).y + 1) < 1e-12, 'south pole → −y')
  })
})
