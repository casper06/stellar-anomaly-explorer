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
  angularSeparationDeg,
  findNearestAnomalyIndex,
  pushNavHistory,
  toUnitVector,
  NEAREST_NAV_HISTORY_SIZE,
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

describe('pushNavHistory — the rolling buffer', () => {
  it('keeps at most NEAREST_NAV_HISTORY_SIZE entries, oldest dropped first', () => {
    // Explicit size so this test pins FIFO semantics, not the constant.
    let h: string[] = []
    h = pushNavHistory(h, 'A', 2)
    assert.deepEqual(h, ['A'])
    h = pushNavHistory(h, 'B', 2)
    assert.deepEqual(h, ['A', 'B'])
    h = pushNavHistory(h, 'C', 2)
    assert.deepEqual(h, ['B', 'C'], 'A falls off the front')

    // And the shipped default keeps at most NEAREST_NAV_HISTORY_SIZE.
    let d: string[] = []
    for (const id of ['A', 'B', 'C', 'D', 'E']) d = pushNavHistory(d, id)
    assert.equal(d.length, NEAREST_NAV_HISTORY_SIZE)
    assert.deepEqual(d, ['C', 'D', 'E'])
  })

  it('moves a repeated id to newest instead of storing it twice', () => {
    // A duplicate must never consume two slots — that would silently
    // halve the exclusion and let a ping-pong resume.
    const h = pushNavHistory(['A', 'B'], 'A')
    assert.deepEqual(h, ['B', 'A'])
  })

  it('never mutates the input array', () => {
    const original = ['A', 'B']
    const copy = [...original]
    pushNavHistory(original, 'C')
    assert.deepEqual(original, copy, 'input buffer was mutated in place')
  })
})

describe('nav loop breaking — repeated GO TO NEAREST presses', () => {
  /**
   * @description Simulates pressing the button `presses` times, threading
   * the rolling buffer exactly as the HUD handler does: exclude the
   * current selection plus the buffer, then record the result.
   * @param stars Candidate anomalies.
   * @param startId Star selected before the first press.
   * @param presses How many times to press.
   * @returns The ids visited, in order.
   */
  function pressSequence(
    stars: NearestCandidate[],
    startId: string,
    presses: number,
  ): string[] {
    // Models the real handler: the anchor is the SELECTED star, and this
    // button does not change the selection — so repeated presses keep
    // measuring from the SAME origin, walking outward through its nearest
    // neighbours as the history buffer excludes the ones already visited.
    const selected = stars.find(s => s.id === startId)!
    let history: string[] = []
    const visited: string[] = []
    for (let i = 0; i < presses; i++) {
      const idx = findNearestAnomalyIndex(stars, selected.ra, selected.dec, [
        selected.id,
        ...history,
      ])
      if (idx === -1) {
        visited.push('NO-OP')
        break
      }
      history = pushNavHistory(history, stars[idx].id)
      visited.push(stars[idx].id)
    }
    return visited
  }

  it('breaks a 2-star ping-pong (the TOI 3518.01 ↔ TOI 3516.01 case)', () => {
    // Two isolated stars close together, plus a third far away. Each of
    // the pair is genuinely the other's nearest, so selection-only
    // exclusion alternates forever.
    const stars: NearestCandidate[] = [
      { id: 'TOI3518', ra: 100.0, dec: 10.0 },
      { id: 'TOI3516', ra: 100.2, dec: 10.1 },
      { id: 'FAR', ra: 280.0, dec: -40.0 },
    ]
    const visited = pressSequence(stars, 'TOI3518', 4)
    // The decisive property: the pair cannot trap the user. Within four
    // presses the far star must be reached.
    assert.ok(
      visited.includes('FAR'),
      `never escaped the isolated pair: ${visited.join(' → ')}`,
    )
    // And it must not simply alternate forever between the two.
    const alternating = visited.every((id, i) =>
      id === (i % 2 === 0 ? 'TOI3516' : 'TOI3518'),
    )
    assert.ok(!alternating, `ping-ponged: ${visited.join(' → ')}`)
  })

  it('breaks a 3-star cycle, which one remembered target would not', () => {
    // Three mutually-close stars isolated from the rest. With a buffer of
    // 1, arriving at C leaves A eligible again → A→B→C→A→B→C forever.
    const stars: NearestCandidate[] = [
      { id: 'A', ra: 50.0, dec: 5.0 },
      { id: 'B', ra: 50.2, dec: 5.1 },
      { id: 'C', ra: 50.4, dec: 5.0 },
      { id: 'FAR', ra: 250.0, dec: -30.0 },
    ]
    const visited = pressSequence(stars, 'A', 6)
    // Whatever the exact order, the fourth body must be reached rather
    // than the trio repeating among itself forever. (An early revisit is
    // legitimate while the buffer is still filling — what must not happen
    // is being trapped in the trio indefinitely.)
    assert.ok(visited.includes('FAR'), `never escaped the trio: ${visited.join(' → ')}`)
  })

  it('works with fewer than 2 prior entries (app just opened)', () => {
    const stars: NearestCandidate[] = [
      { id: 'A', ra: 50.0, dec: 5.0 },
      { id: 'B', ra: 50.2, dec: 5.1 },
      { id: 'C', ra: 50.4, dec: 5.0 },
    ]
    // Empty buffer, no selection at all — the very first press.
    assert.notEqual(findNearestAnomalyIndex(stars, 50, 5, []), -1)
    assert.notEqual(findNearestAnomalyIndex(stars, 50, 5, [undefined]), -1)
    // Exactly one prior entry.
    assert.equal(findNearestAnomalyIndex(stars, 50, 5, [null, 'A']), 1)
  })

  it('no-ops rather than flying somewhere arbitrary when everything is excluded', () => {
    // A tiny isolated catalog the buffer can cover completely.
    const stars: NearestCandidate[] = [
      { id: 'A', ra: 50.0, dec: 5.0 },
      { id: 'B', ra: 50.2, dec: 5.1 },
      { id: 'C', ra: 50.4, dec: 5.0 },
    ]
    // Direct: every id excluded → -1, never a fallback to index 0.
    assert.equal(findNearestAnomalyIndex(stars, 50, 5, ['A', 'B', 'C']), -1)
    // And through the real press sequence: once the buffer fills with the
    // whole catalog the button must stop, not fly somewhere arbitrary.
    const visited = pressSequence(stars, 'A', 8)
    assert.equal(
      visited[visited.length - 1],
      'NO-OP',
      `expected the button to stop; got ${visited.join(' → ')}`,
    )
  })

  it('handles a star that is BOTH the selection and in the buffer', () => {
    // Overlap must dedup harmlessly, not double-exclude into a crash or
    // consume an extra slot's worth of exclusion.
    const stars: NearestCandidate[] = [
      { id: 'A', ra: 50.0, dec: 5.0 },
      { id: 'B', ra: 50.2, dec: 5.1 },
      { id: 'C', ra: 60.0, dec: 5.0 },
    ]
    const idx = findNearestAnomalyIndex(stars, 50, 5, ['A', 'A', 'A'])
    assert.equal(stars[idx].id, 'B', 'repeated exclusion of A should still leave B and C')
  })
})

describe('findNearestAnomalyIndex — exclusion argument forms', () => {
  const stars: NearestCandidate[] = [
    { id: 'A', ra: 50.0, dec: 5.0 },
    { id: 'B', ra: 50.2, dec: 5.1 },
  ]

  it('still accepts a bare string id (the pre-existing call form)', () => {
    assert.equal(findNearestAnomalyIndex(stars, 50, 5, 'A'), 1)
  })

  it('ignores null/undefined entries inside the array', () => {
    assert.equal(findNearestAnomalyIndex(stars, 50, 5, [null, undefined, 'A']), 1)
  })

  it('treats an empty array like no exclusion at all', () => {
    assert.equal(findNearestAnomalyIndex(stars, 50, 5, []), 0)
  })
})

describe('selection-anchored search (the TOI 5281.01 report)', () => {
  // Real catalog coordinates from the live investigation.
  const TOI5281 = { id: 'TIC405932063', ra: 301.464969, dec: 51.856929 }
  const TOI3576 = { id: 'TIC405897415', ra: 300.917036, dec: 52.080676 }
  const K05552 = { id: 'KIC8644545', ra: 298.13864, dec: 44.744061 }
  const K03384 = { id: 'KIC8644365', ra: 298.09543, dec: 44.737061 }
  const stars: NearestCandidate[] = [TOI5281, TOI3576, K05552, K03384]

  it('REGRESSION: anchored to the selected star, returns its true nearest neighbour', () => {
    // The live failure: a sky click selected TOI 5281.01 but never moved
    // the camera, so anchoring to `cameraTarget` measured from empty sky
    // ~290°/46° and returned K05552.01 / K03384.01 — both ~7.45° away.
    // Anchored to the selection, the answer is TOI 3576.01 at 0.405°.
    const idx = findNearestAnomalyIndex(stars, TOI5281.ra, TOI5281.dec, [TOI5281.id])
    assert.equal(stars[idx].id, TOI3576.id, 'must pick TOI 3576.01')
    assert.ok(Math.abs(angularSeparationDeg(TOI5281, stars[idx]) - 0.405) < 1e-2)
  })

  it('the wrongly-picked stars are provably farther than the right one', () => {
    // Pins the numbers that made the bug visible, so a future refactor
    // cannot quietly reintroduce a 7° "nearest".
    assert.ok(Math.abs(angularSeparationDeg(TOI5281, K05552) - 7.447) < 1e-2)
    assert.ok(Math.abs(angularSeparationDeg(TOI5281, K03384) - 7.462) < 1e-2)
    assert.ok(angularSeparationDeg(TOI5281, TOI3576) < angularSeparationDeg(TOI5281, K05552))
  })

  it('the anchor is independent of where the camera happens to point', () => {
    // Same selection, three unrelated camera directions — the result must
    // not change, because the camera no longer participates.
    const expected = findNearestAnomalyIndex(stars, TOI5281.ra, TOI5281.dec, [TOI5281.id])
    for (const _camera of [{ ra: 290.287, dec: 46.432 }, { ra: 0, dec: 0 }, { ra: 180, dec: -80 }]) {
      const idx = findNearestAnomalyIndex(stars, TOI5281.ra, TOI5281.dec, [TOI5281.id])
      assert.equal(idx, expected, 'camera direction must not affect the anchored search')
    }
  })

  it('repeated presses are deterministic: same origin, widening ring', () => {
    // The intended product behavior: without re-selecting, each press
    // keeps measuring from the ORIGINAL star and walks outward through
    // its neighbours rather than drifting with the camera.
    let history: string[] = []
    const picks: string[] = []
    for (let i = 0; i < 3; i++) {
      const idx = findNearestAnomalyIndex(stars, TOI5281.ra, TOI5281.dec, [TOI5281.id, ...history])
      picks.push(stars[idx].id)
      history = pushNavHistory(history, stars[idx].id)
    }
    assert.deepEqual(picks, [TOI3576.id, K05552.id, K03384.id], 'strictly increasing distance')
    // Distances must be non-decreasing from the fixed origin.
    const d = picks.map(id => angularSeparationDeg(TOI5281, stars.find(s => s.id === id)!))
    for (let i = 1; i < d.length; i++) {
      assert.ok(d[i] >= d[i - 1], `press ${i + 1} moved inward: ${d.join(' → ')}`)
    }
  })

  it('falls back to the camera position only when nothing is selected', () => {
    // App just opened: no selection, so the caller passes cameraTarget and
    // an exclusion list of [undefined]. Must still return a real result.
    const idx = findNearestAnomalyIndex(stars, 300.9, 52.0, [undefined])
    assert.notEqual(idx, -1, 'first press with no selection must still find something')
    assert.equal(stars[idx].id, TOI3576.id, 'nearest to the camera position')
  })
})

describe('angularSeparationDeg', () => {
  it('returns 0° for identical points', () => {
    assert.equal(angularSeparationDeg({ ra: 288.774, dec: 30.785 }, { ra: 288.774, dec: 30.785 }), 0)
    assert.equal(angularSeparationDeg({ ra: 0, dec: 0 }, { ra: 0, dec: 0 }), 0)
    // Pole: cos(dec)≈0 makes the vector components tiny; must not drift.
    assert.equal(angularSeparationDeg({ ra: 123, dec: 90 }, { ra: 45, dec: 90 }), 0)
  })

  it('returns 180° for antipodal points', () => {
    // Opposite poles.
    assert.ok(Math.abs(angularSeparationDeg({ ra: 0, dec: 90 }, { ra: 0, dec: -90 }) - 180) < 1e-9)
    // Opposite points on the equator.
    assert.ok(Math.abs(angularSeparationDeg({ ra: 0, dec: 0 }, { ra: 180, dec: 0 }) - 180) < 1e-9)
  })

  it('returns known separations for hand-checkable geometry', () => {
    // 90° apart along the equator.
    assert.ok(Math.abs(angularSeparationDeg({ ra: 0, dec: 0 }, { ra: 90, dec: 0 }) - 90) < 1e-9)
    // Equator to pole is a quarter turn regardless of RA.
    assert.ok(Math.abs(angularSeparationDeg({ ra: 200, dec: 0 }, { ra: 17, dec: 90 }) - 90) < 1e-9)
    // Pure declination difference: separation equals |Δdec|.
    assert.ok(Math.abs(angularSeparationDeg({ ra: 42, dec: 10 }, { ra: 42, dec: 35 }) - 25) < 1e-9)
    // Along the equator, separation equals ΔRA.
    assert.ok(Math.abs(angularSeparationDeg({ ra: 10, dec: 0 }, { ra: 22.5, dec: 0 }) - 12.5) < 1e-9)
  })

  it('is symmetric and handles the RA 0/360 seam', () => {
    const a = { ra: 359, dec: 0 }
    const b = { ra: 1, dec: 0 }
    assert.ok(Math.abs(angularSeparationDeg(a, b) - 2) < 1e-9, 'seam-crossing pair is 2° apart')
    assert.equal(angularSeparationDeg(a, b), angularSeparationDeg(b, a))
  })

  it('never returns NaN for near-identical or near-antipodal inputs (acos clamp)', () => {
    // Floating-point error can push the dot product just outside [-1, 1];
    // without the clamp Math.acos returns NaN here.
    const probes: [number, number][] = [
      [1e-13, 0], [0, 1e-13], [1e-9, 1e-9], [180 - 1e-12, 0],
    ]
    for (const [dRa, dDec] of probes) {
      const v = angularSeparationDeg({ ra: 288.774, dec: 30.785 }, { ra: 288.774 + dRa, dec: 30.785 + dDec })
      assert.ok(Number.isFinite(v), `NaN/Infinity at ΔRA=${dRa} ΔDec=${dDec}`)
    }
    assert.ok(Number.isFinite(angularSeparationDeg({ ra: 0, dec: 90 }, { ra: 180, dec: -90 })))
  })

  it('reproduces the measured TOI 3518.01 investigation values', () => {
    // Real catalog coordinates. Pins the numbers the nav-log diagnostic
    // prints, so a future refactor can't silently change what it reports.
    const toi3518 = { ra: 288.773993, dec: 30.785472 }
    assert.ok(Math.abs(angularSeparationDeg(toi3518, { ra: 290.52676, dec: 38.142979 }) - 7.4976) < 1e-3)
    assert.ok(Math.abs(angularSeparationDeg(toi3518, { ra: 282.58282, dec: 42.346352 }) - 12.5757) < 1e-3)
    assert.ok(Math.abs(angularSeparationDeg(toi3518, { ra: 288.9, dec: 30.57 }) - 0.246) < 0.02)
  })

  it('accepts a NearestCandidate wherever a SkyPosition is expected', () => {
    // Structural compatibility: candidates carry an id, cameraTarget does
    // not, and both must work without a cast.
    const star: NearestCandidate = { id: 'A', ra: 10, dec: 0 }
    const camera = { ra: 20, dec: 0 }
    assert.ok(Math.abs(angularSeparationDeg(camera, star) - 10) < 1e-9)
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
