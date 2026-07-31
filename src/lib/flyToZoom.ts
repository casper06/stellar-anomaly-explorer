/**
 * @description Zoom policy for camera fly-tos: the FOV constants a fly-to
 * settles at, and the pure decision of whether a given fly-to should ease
 * the zoom at all.
 *
 * Lives in lib/ (not StarField.tsx) for the same reason as
 * {@link ./radarPalette}: StarField is a `'use client'` module that imports
 * Three.js and @react-three/fiber, so nothing in it can be exercised by the
 * plain-Node unit suite. The decision below is the load-bearing half of the
 * fly-to zoom behavior — "does this fly-to touch the zoom, and where does it
 * land" — so it is kept pure and dependency-free, and StarField imports it.
 * The interpolation itself stays in the component, where the frame loop is.
 */

/** @description Widest field — "naked eye". Mirrors StarField's FOV_MAX. */
export const FOV_MAX = 75

/** @description Narrowest field — "binoculars". Mirrors StarField's FOV_MIN. */
export const FOV_MIN = 20

/**
 * @description FOV at or below which a centered anomaly is auto-selected.
 * The fly-to arrival FOV is chosen relative to this.
 */
export const AUTO_SELECT_FOV = 28

/**
 * @description FOV a `zoomMode: 'target'` fly-to settles at on arrival.
 *
 * Sits just inside {@link AUTO_SELECT_FOV} so arriving at a star also puts
 * the camera in the auto-select regime the user would otherwise have to
 * wheel into by hand, and below StarField's ANOMALY_TIER_LOW_FOV (40) so the
 * anomaly markers arrive already in full detail-pulse mode rather than as
 * static overview dots.
 *
 * Deliberately a FIXED arrival FOV rather than one scaled by how far the
 * camera travelled: the wheel zoom is multiplicative (`fov * exp(...)`), so
 * it always lands on an absolute FOV and never varies its result by where
 * the user started. Distance-scaling would make the same destination settle
 * at different magnifications depending on the approach, which is precisely
 * the inconsistency the wheel avoids.
 */
export const FLY_TO_ARRIVAL_FOV = 26

/**
 * @description How much wider than {@link FLY_TO_ARRIVAL_FOV} the current
 * zoom must be before a fly-to will touch it.
 *
 * A fly-to only ever tightens the view. Without this margin, a fly-to
 * started while the user is already zoomed in past the arrival FOV would
 * yank the view back OUT to it — destroying zoom the user deliberately
 * chose, which is a worse bug than the one the zoom easing fixes.
 */
export const FLY_TO_ZOOM_MARGIN_FOV = 2

/**
 * @description Whether a fly-to should ease the zoom, given its mode and the
 * zoom target in effect when it starts.
 *
 * Takes the current zoom TARGET (where the zoom is heading) rather than the
 * live `camera.fov` (where it happens to be this frame): if a wheel gesture
 * is still settling when the fly-to begins, the target is the honest start
 * point, and using the instantaneous value would produce a visible hitch.
 *
 * @param currentFovTarget The zoom target in effect as the fly-to starts.
 * @param zoomMode `'target'` flies to a specific star and closes in;
 * `'region'` flies to an area (quadrant cell, minimap position) and holds
 * the current zoom, since tightening past the region's own extent would
 * overshoot what the user asked to look at. Defaults to `'target'`.
 * @returns True when the fly-to should ease the zoom toward
 * {@link FLY_TO_ARRIVAL_FOV}; false when it should leave zoom untouched.
 */
export function shouldFlyToZoom(
  currentFovTarget: number,
  zoomMode: 'target' | 'region' = 'target',
): boolean {
  if (zoomMode !== 'target') return false
  return currentFovTarget > FLY_TO_ARRIVAL_FOV + FLY_TO_ZOOM_MARGIN_FOV
}
