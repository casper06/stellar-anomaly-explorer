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
 * The search is anchored to the SELECTED STAR's catalog position, and the
 * selected star is excluded from its own result — otherwise the nearest
 * anomaly to a star is always that star, and the button appears dead.
 *
 * The anchor is deliberately NOT the store's `cameraTarget`. That value is
 * a pointing DIRECTION which `CameraSync` rewrites every frame; it lines up
 * with a real star only when something explicitly flew the camera there
 * (search pick, flagged list). A direct sky click never moves the camera,
 * so anchoring to it measured from wherever the camera happened to point —
 * observed live as an origin of "RA 290.287° / Dec 46.432° (empty sky)"
 * immediately after clicking TOI 5281.01. Anchoring to the selection also
 * keeps the reference and the exclusion on one source, so they cannot
 * drift apart.
 *
 * Deliberately NOT excluded: visited stars (no history tracking — the
 * button is named "nearest", not "nearest unvisited") and in-viewport
 * stars (a viewport filter belongs to NEXT ANOMALY, the tour button).
 */

/**
 * @description A point on the celestial sphere. Deliberately just the two
 * coordinates: the camera's pointing direction (`store.cameraTarget`) has
 * no id, so anything measuring angles must not demand one.
 */
export interface SkyPosition {
  ra: number
  dec: number
}

/**
 * @description Minimal shape this search needs from a star. Extends
 * {@link SkyPosition}, so any candidate is also a valid angle argument.
 */
export interface NearestCandidate extends SkyPosition {
  id: string
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
 * @description Great-circle (angular) separation between two points on the
 * celestial sphere, in degrees.
 *
 * Same dot-product method `findNearestAnomalyIndex` ranks by, surfaced as a
 * human-readable number. That ranking compares dot products directly and
 * never needs the angle, so this is a separate helper rather than a change
 * to that function's return type — it exists for diagnostics (the dev-only
 * nav log) and for tests.
 *
 * The dot product is clamped to [-1, 1] before `Math.acos`: for nearly
 * identical or nearly antipodal inputs, floating-point error can push it a
 * few ULP outside that range, and `Math.acos` returns NaN there.
 *
 * @param a First position (a star, or the camera's pointing direction).
 * @param b Second position.
 * @returns Separation in degrees, in [0, 180].
 */
export function angularSeparationDeg(a: SkyPosition, b: SkyPosition): number {
  const va = toUnitVector(a.ra, a.dec)
  const vb = toUnitVector(b.ra, b.dec)
  const dot = va.x * vb.x + va.y * vb.y + va.z * vb.z
  const clamped = Math.max(-1, Math.min(1, dot))
  return (Math.acos(clamped) * 180) / Math.PI
}

/**
 * @description How many previously-flown-to targets the nav button
 * remembers and skips, on top of the star the camera currently sits on.
 *
 * **Three, not two — and the reason is subtle.** The newest buffer entry
 * is ALWAYS the current selection: the handler flies to a star, records
 * it, and that same star immediately becomes the selection. So the
 * combined exclusion set (selection ∪ buffer) holds only `size` DISTINCT
 * stars, not `size + 1`. A buffer of 2 therefore excludes 2 stars, which
 * breaks a 2-star ping-pong but leaves a 3-star cycle intact (measured:
 * A→B→A→C→B→A…). Three distinct exclusions is the smallest value that
 * breaks both:
 * - A 2-star ping-pong, where each star is the other's true nearest
 *   neighbor. Confirmed live on TOI 3518.01 ↔ TOI 3516.01.
 * - A 3-star cycle (A→B→C→A) among mutually-close isolated stars.
 *
 * Deliberately NOT a general visited-history: #22 descoped that on
 * purpose, and it would change the button's meaning from "nearest" to
 * "nearest unvisited". This is a small rolling buffer, in memory only,
 * fed exclusively by this one nav action.
 */
export const NEAREST_NAV_HISTORY_SIZE = 3

/**
 * @description Pushes a star id onto a fixed-size FIFO of recent nav
 * targets, newest last, de-duplicated.
 *
 * Returns a NEW array; never mutates the input (the caller keeps this in
 * a React ref / module state, and in-place mutation would make staleness
 * bugs invisible). Re-visiting an id already in the buffer moves it to
 * the newest slot rather than storing it twice, so a duplicate can never
 * consume two of the {@link NEAREST_NAV_HISTORY_SIZE} slots and silently
 * weaken the exclusion.
 *
 * @param history Current buffer, oldest first.
 * @param id Star id just navigated to.
 * @param size Maximum entries to keep. Defaults to {@link NEAREST_NAV_HISTORY_SIZE}.
 * @returns The updated buffer, oldest first, at most `size` entries.
 */
export function pushNavHistory(
  history: readonly string[],
  id: string,
  size: number = NEAREST_NAV_HISTORY_SIZE,
): string[] {
  const withoutDupe = history.filter(h => h !== id)
  withoutDupe.push(id)
  return withoutDupe.slice(-size)
}

/**
 * @description Finds the index of the anomaly angularly nearest to a
 * pointing direction, skipping every excluded id.
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
 * @param exclude Star id(s) to skip: a single id, an array of ids, or
 * null/undefined for no exclusion (the first-click case, where nothing is
 * selected and nothing has been navigated to yet). Nullish entries inside
 * an array are ignored, and repeats are harmless — matching is by value,
 * so a star that is both the current selection and in the nav history is
 * simply skipped once.
 * @returns Index into `candidates` of the nearest eligible anomaly, or -1
 * when none is eligible (empty list, or every candidate was excluded).
 */
export function findNearestAnomalyIndex(
  candidates: readonly NearestCandidate[],
  ra: number,
  dec: number,
  exclude?: string | readonly (string | null | undefined)[] | null,
): number {
  // Normalize to a Set so callers can pass one id or many, and so a star
  // appearing twice (selection AND nav history) costs nothing.
  const excluded = new Set<string>()
  if (typeof exclude === 'string') {
    excluded.add(exclude)
  } else if (Array.isArray(exclude)) {
    for (const id of exclude) {
      if (id != null) excluded.add(id)
    }
  }

  const cam = toUnitVector(ra, dec)
  let bestIdx = -1
  let bestDot = -Infinity

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i]
    if (excluded.has(s.id)) continue
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
