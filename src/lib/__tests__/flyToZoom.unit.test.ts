/**
 * @description Unit tests for the fly-to zoom policy (issue #22, bug 2).
 *
 * Before the fix, `FlyToController` interpolated only theta/phi and
 * `camera.fov` was written exclusively by the wheel handler, so every fly-to
 * was a pan at constant magnification. The fix eases the zoom in alongside
 * the pan. Two behaviors carry real risk of silent regression and are pinned
 * here:
 *
 * 1. **Zoom only ever tightens.** A fly-to must never widen the view back
 *    out to the arrival FOV when the user is already zoomed in past it —
 *    that would destroy zoom the user chose deliberately, a worse bug than
 *    the one being fixed.
 * 2. **`zoomMode: 'region'` holds the zoom.** Quadrant-cell and minimap
 *    fly-tos navigate to an AREA; tightening to a star-level FOV would
 *    overshoot the region the user asked to see.
 *
 * The interpolation itself (easing curve, duration, per-frame writes) lives
 * in `StarField.tsx` and needs a real R3F frame loop, so it is out of scope
 * here and covered by the E2E suite instead.
 *
 * Run via `npm run test:unit` (plain Node ≥ 22.15, node:test + native
 * type stripping — no framework).
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  shouldFlyToZoom,
  FLY_TO_ARRIVAL_FOV,
  FLY_TO_ZOOM_MARGIN_FOV,
  AUTO_SELECT_FOV,
  FOV_MAX,
  FOV_MIN,
} from '../flyToZoom.ts'
import { useStore } from '../store.ts'

/** @description The widest FOV that must still leave the zoom untouched. */
const ZOOM_THRESHOLD = FLY_TO_ARRIVAL_FOV + FLY_TO_ZOOM_MARGIN_FOV

describe('shouldFlyToZoom — guarantee 1: zoom only ever tightens', () => {
  it('eases the zoom when the view is wider than the threshold', () => {
    assert.equal(shouldFlyToZoom(FOV_MAX), true, 'fully zoomed out must zoom in')
    assert.equal(shouldFlyToZoom(45), true)
    assert.equal(
      shouldFlyToZoom(ZOOM_THRESHOLD + 0.5),
      true,
      'just wider than the threshold still zooms',
    )
  })

  it('leaves the zoom alone when already tighter than the arrival FOV', () => {
    // The regression this guards: a search pick at FOV 22 must NOT yank the
    // view back out to 26.
    assert.equal(shouldFlyToZoom(FLY_TO_ARRIVAL_FOV - 4), false)
    assert.equal(shouldFlyToZoom(FOV_MIN), false, 'fully zoomed in must not widen')
    assert.equal(
      shouldFlyToZoom(FLY_TO_ARRIVAL_FOV),
      false,
      'sitting exactly at the arrival FOV is not a reason to move',
    )
  })

  it('holds the zoom inside the margin band, where easing would be a net widening or a no-op', () => {
    // Between the arrival FOV and the threshold the camera is already close
    // enough; firing here would be visible churn for no gain.
    assert.equal(shouldFlyToZoom(FLY_TO_ARRIVAL_FOV + 1), false)
    assert.equal(
      shouldFlyToZoom(ZOOM_THRESHOLD),
      false,
      'the threshold itself is exclusive — strictly wider is required',
    )
  })

  it('never targets a zoom wider than where it started (the invariant, swept)', () => {
    // Property form of guarantee 1: for every starting FOV across the legal
    // range, if the policy fires then the arrival FOV must be a tightening.
    for (let fov = FOV_MIN; fov <= FOV_MAX; fov += 0.5) {
      if (shouldFlyToZoom(fov)) {
        assert.ok(
          FLY_TO_ARRIVAL_FOV < fov,
          `firing at fov=${fov} would widen the view to ${FLY_TO_ARRIVAL_FOV}`,
        )
      }
    }
  })
})

describe("shouldFlyToZoom — guarantee 2: zoomMode 'region' holds FOV", () => {
  it('never eases the zoom for a region fly-to, at any starting FOV', () => {
    for (const fov of [FOV_MAX, 60, 45, ZOOM_THRESHOLD + 10, 30, FOV_MIN]) {
      assert.equal(
        shouldFlyToZoom(fov, 'region'),
        false,
        `region fly-to at fov=${fov} must hold the zoom`,
      )
    }
  })

  it("mode 'target' is the default when unspecified", () => {
    // The four star-targeting call sites (both nav buttons, flagged list,
    // search) rely on the default, so an accidental flip would silently
    // disable the whole feature for them.
    assert.equal(shouldFlyToZoom(FOV_MAX), shouldFlyToZoom(FOV_MAX, 'target'))
    assert.equal(shouldFlyToZoom(FOV_MAX), true)
  })

  it('the two modes genuinely differ at the same starting FOV', () => {
    assert.equal(shouldFlyToZoom(FOV_MAX, 'target'), true)
    assert.equal(shouldFlyToZoom(FOV_MAX, 'region'), false)
  })
})

describe('fly-to zoom constants — relationships the behavior depends on', () => {
  it('arrival FOV sits inside the auto-select regime', () => {
    // Arriving at a star should hand the user the auto-select behavior they
    // would otherwise have to wheel into by hand.
    assert.ok(
      FLY_TO_ARRIVAL_FOV < AUTO_SELECT_FOV,
      'arrival FOV must be inside AUTO_SELECT_FOV for arrival to latch',
    )
  })

  it('arrival FOV is a legal camera FOV', () => {
    assert.ok(FLY_TO_ARRIVAL_FOV >= FOV_MIN && FLY_TO_ARRIVAL_FOV <= FOV_MAX)
  })

  it('the margin is positive, so the tighten-only guard has a real band', () => {
    assert.ok(FLY_TO_ZOOM_MARGIN_FOV > 0)
  })
})

describe('HUD nav call sites — which zoomMode each one uses', () => {
  /**
   * @description Reads HUD.tsx as text and asserts the zoomMode each nav
   * entry point passes.
   *
   * A source-level check, deliberately: HUD.tsx is a `.tsx` module the
   * plain-Node suite cannot import (the resolver hook handles `.ts` only,
   * and there is no React test renderer in this project), so the call
   * sites cannot be exercised. Re-declaring the expected values in the
   * test would assert nothing about the real code. Matching the actual
   * `requestFlyTo(...)` text at least fails loudly if a call site's mode
   * changes without the decision being revisited.
   *
   * What this canNOT catch: a behavioral regression inside
   * `requestFlyTo` or `FlyToController`. Those are covered by the
   * `shouldFlyToZoom` policy tests above and the store plumbing tests
   * below.
   */
  const HUD_SRC = readFileSync(
    path.join(import.meta.dirname, '..', '..', 'components', 'HUD.tsx'),
    'utf8',
  )

  it("NEXT ANOMALY passes 'region' — it must not re-zoom (tour button, FOV-dependent candidate set)", () => {
    // The constant carries the reasoning; the call site must use it.
    assert.match(
      HUD_SRC,
      /export const NEXT_ANOMALY_ZOOM_MODE = 'region'/,
      'NEXT_ANOMALY_ZOOM_MODE must be region',
    )
    assert.match(
      HUD_SRC,
      /requestFlyTo\(target\.ra,\s*target\.dec,\s*NEXT_ANOMALY_ZOOM_MODE\)/,
      'goToNextAnomaly must pass the zoom mode, not fall through to the target default',
    )
  })

  it("quadrant panel and minimap keep 'region'", () => {
    assert.match(HUD_SRC, /requestFlyTo\(ra,\s*dec,\s*'region'\)/, 'quadrant panel')
    assert.match(
      HUD_SRC,
      /requestFlyTo\(targetRa,\s*targetDec,\s*'region'\)/,
      'minimap',
    )
  })

  it("GO TO NEAREST and the flagged list keep the 'target' default (they close in on one star)", () => {
    assert.match(HUD_SRC, /requestFlyTo\(best\.ra,\s*best\.dec\)/, 'GO TO NEAREST')
    assert.match(HUD_SRC, /requestFlyTo\(star\.ra,\s*star\.dec\)/, 'flagged list')
  })

  it('GO TO NEAREST anchors to the SELECTED star, not the camera direction', () => {
    // Fixed after the TOI 5281.01 report: `cameraTarget` is a pointing
    // direction, not a star position, and a sky click never moves the
    // camera — so anchoring there measured from empty sky.
    assert.match(
      HUD_SRC,
      /const origin = selectedStar \?\? cameraTarget/,
      'anchor must be the selection, with the camera only as a fallback',
    )
    assert.match(
      HUD_SRC,
      /findNearestAnomalyIndex\(\s*navTargets,\s*origin\.ra,\s*origin\.dec,/,
      'the search must use the anchored origin',
    )
    assert.match(
      HUD_SRC,
      /\[selectedStar\?\.id, \.\.\.nearestNavHistoryRef\.current\]/,
      'reference and exclusion must key off the same source (selectedStar)',
    )
    // The replaced camera-positional approach must be fully gone.
    assert.doesNotMatch(HUD_SRC, /starAtCamera/, 'starAtCamera must no longer be used')
  })

  it('every requestFlyTo call site in HUD is accounted for by this test', () => {
    // Guards against a NEW nav entry point being added and silently
    // inheriting the zoom-easing default the way NEXT did.
    const calls = HUD_SRC.match(/requestFlyTo\((?!ra: number)/g) ?? []
    // 5 call sites + the destructure from the store (`requestFlyTo,`) is
    // not a call, so expect exactly the 5 known ones.
    assert.equal(
      calls.length,
      5,
      `HUD has ${calls.length} requestFlyTo calls; update this test and decide the new one's zoomMode`,
    )
  })
})

describe('store.requestFlyTo — zoomMode plumbing', () => {
  beforeEach(() => {
    useStore.setState({ flyTo: null })
  })

  it("defaults to 'target' so existing call sites zoom without changes", () => {
    useStore.getState().requestFlyTo(290, 44)
    assert.equal(useStore.getState().flyTo?.zoomMode, 'target')
  })

  it("carries 'region' through to the command when passed", () => {
    useStore.getState().requestFlyTo(290, 44, 'region')
    assert.equal(useStore.getState().flyTo?.zoomMode, 'region')
  })

  it('still mints a fresh id per request (zoomMode did not break repeat flights)', () => {
    useStore.getState().requestFlyTo(290, 44, 'region')
    const first = useStore.getState().flyTo
    useStore.getState().requestFlyTo(290, 44, 'region')
    const second = useStore.getState().flyTo
    assert.notEqual(first?.id, second?.id)
  })
})
