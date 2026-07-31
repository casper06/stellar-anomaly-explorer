/**
 * @description Angular "nearest anomaly" search on the celestial sphere,
 * with the currently-selected star excluded.
 *
 * Lives in lib/ (not HUD.tsx) for the same reason as {@link ./flyToZoom}:
 * the component is a `'use client'` module whose graph the plain-Node unit
 * suite can't import, and this is decision logic worth pinning with tests.
 *
 * ## Why the exclusion exists (issue #22, bug 1)
 *
 * "Nearest" is measured against the store's `cameraTarget`, which
 * `CameraSync` rewrites EVERY FRAME from the camera's actual pointing
 * direction. So the reference point is "where I am already looking" — and
 * in the dense Kepler field whatever the user is looking at is very often
 * the star already selected. GO TO NEAREST ANOMALY then computes that same
 * star as the nearest and flies to where the camera already is, reading as
 * a dead button.
 *
 * Excluding the selected star is the whole fix. Deliberately NOT excluded:
 * visited stars (no history tracking — the button is named "nearest", not
 * "nearest unvisited") and in-viewport stars (a viewport filter belongs to
 * NEXT ANOMALY, which is the tour button). One exclusion, matching the
 * button's literal name.
 */

/** @description Minimal shape this search needs from a star. */
export interface NearestCandidate {
  id: string
  ra: number
  dec: number
}

/**
 * @description Converts a celestial position to a unit vector, so angular
 * proximity can be compared with a dot product (correct across the RA=0/360
 * seam and at the poles, unlike naive coordinate differences).
 * @param ra Right ascension in degrees.
 * @param dec Declination in degrees.
 * @returns Unit vector components.
 */
export function toUnitVector(ra: number, dec: number): { x: number; y: number; z: number } {
  const r = (ra * Math.PI) / 180
  const d = (dec * Math.PI) / 180
  return {
    x: Math.cos(d) * Math.cos(r),
    y: Math.sin(d),
    z: Math.cos(d) * Math.sin(r),
  }
}

/**
 * @description Finds the index of the anomaly angularly nearest to a
 * pointing direction, skipping `excludeId`.
 *
 * Scans the WHOLE list rather than filtering to the viewport: this backs a
 * button meaning "take me to the nearest anomaly even if I can't see one
 * from here".
 *
 * No distance special-casing. If the excluded star was genuinely the
 * closest and the runner-up is far away, the runner-up still wins — "the
 * nearest one that isn't the one I'm on" is the honest answer, and a
 * distance cutoff would reintroduce a dead button in sparse regions.
 *
 * @param candidates Anomaly stars to search.
 * @param ra Right ascension of the current pointing direction, in degrees.
 * @param dec Declination of the current pointing direction, in degrees.
 * @param excludeId Star id to skip, or null/undefined for no exclusion
 * (the first-click case, where nothing is selected yet).
 * @returns Index into `candidates` of the nearest eligible anomaly, or -1
 * when none is eligible (empty list, or the only entry was excluded).
 */
export function findNearestAnomalyIndex(
  candidates: readonly NearestCandidate[],
  ra: number,
  dec: number,
  excludeId?: string | null,
): number {
  const cam = toUnitVector(ra, dec)
  let bestIdx = -1
  let bestDot = -Infinity

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i]
    if (excludeId != null && s.id === excludeId) continue
    const v = toUnitVector(s.ra, s.dec)
    // Higher dot product = smaller angle between the two directions.
    const dot = v.x * cam.x + v.y * cam.y + v.z * cam.z
    if (dot > bestDot) {
      bestDot = dot
      bestIdx = i
    }
  }

  return bestIdx
}
