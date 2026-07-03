'use client'
import React, { useRef, useMemo, useEffect, useState, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { CatalogStar } from '@/lib/starCatalog'
import { useStore } from '@/lib/store'
import { selectStarAndFetchCurve } from '@/lib/selectStar'
import type { CurvePattern } from '@/lib/curveClassifier'

const STAR_SPHERE_RADIUS = 500
// Camera orbits the origin at a fixed radius — "zoom" is done via FOV, not by
// moving the camera. This matches how telescopes/binoculars work: narrowing the
// field of view brings distant objects apparently closer without translation.
const CAMERA_RADIUS = 0.1
const FOV_MAX = 75   // widest field — "naked eye"
const FOV_MIN = 20   // narrowest field — "binoculars"
// FOV at or below this triggers auto-selection of a centered anomaly
const AUTO_SELECT_FOV = 28
// Pixel radius around cursor (in screen space) inside which a label appears
const LABEL_HOVER_RADIUS_PX = 80

/**
 * @description Maps a star's B-V color index to a representative RGB color. The bins are
 * coarse on purpose — they match the standard O/B/A/F/G/K/M spectral
 * classification so the sky reads astronomically correctly at a glance.
 * @param bv B-V color index (negative = hot/blue, positive = cool/red).
 * @returns Three.js Color suitable for the point material's per-vertex color.
 */
function bvToColor(bv: number): THREE.Color {
  if (bv < 0) return new THREE.Color('#a0c4ff')
  if (bv < 0.3) return new THREE.Color('#e8f0ff')
  if (bv < 0.6) return new THREE.Color('#fff8e7')
  if (bv < 1.0) return new THREE.Color('#ffd166')
  return new THREE.Color('#ff6b6b')
}

/**
 * @description Converts celestial spherical coordinates (RA/Dec in degrees) to Cartesian
 * (x/y/z) on a sphere of the given radius. Uses the convention y = up so the
 * scene stays right-handed with Three.js defaults.
 * @param ra Right Ascension in degrees [0, 360).
 * @param dec Declination in degrees [-90, 90].
 * @param radius Sphere radius in world units.
 * @returns 3-tuple of world-space coordinates.
 */
function raDecToXYZ(ra: number, dec: number, radius: number): [number, number, number] {
  const raRad = (ra * Math.PI) / 180
  const decRad = (dec * Math.PI) / 180
  return [
    radius * Math.cos(decRad) * Math.cos(raRad),
    radius * Math.sin(decRad),
    radius * Math.cos(decRad) * Math.sin(raRad),
  ]
}

/**
 * @description Inverse of `raDecToXYZ`: takes a world-space direction (need not be
 * normalized) and returns its RA/Dec in degrees. RA is wrapped into [0, 360).
 * @param x World-space X.
 * @param y World-space Y.
 * @param z World-space Z.
 * @returns Celestial coordinates in degrees.
 */
function xyzToRaDec(x: number, y: number, z: number): { ra: number; dec: number } {
  const r = Math.sqrt(x * x + y * y + z * z)
  const dec = (Math.asin(y / r) * 180) / Math.PI
  const ra = ((Math.atan2(z, x) * 180) / Math.PI + 360) % 360
  return { ra, dec }
}

// Generates a soft circular sprite (white center → transparent edge) used so
// that pointsMaterial renders round dots instead of hard squares.
/**
 * @description Builds a 64×64 radial-gradient sprite (white center, transparent edge) used
 * as the alpha mask for star points. Without this the default `PointsMaterial`
 * draws hard squares; the sprite turns each point into a soft circle.
 * @returns A CanvasTexture ready to assign to PointsMaterial.map.
 */
function makeCircleTexture(): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.95)')
  gradient.addColorStop(0.7, 'rgba(255,255,255,0.25)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

/**
 * @description Builds a 128×128 reticle sprite for the "you are here"
 * selection marker: a thin white ring with four short crosshair ticks
 * cutting inward through it. Sprite is drawn on transparent alpha so
 * only the ring + ticks show — the star itself remains visible in the
 * middle. Wider stroke than the flagged ring so the two read as
 * distinct at a glance (flagged is a status badge; selection is
 * navigational). Additive blending in the material makes it pop
 * against dense backgrounds without changing its underlying whites.
 * @returns A CanvasTexture ready to assign to PointsMaterial.map.
 */
function makeReticleTexture(): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  const radius = 48
  ctx.clearRect(0, 0, size, size)
  ctx.lineCap = 'round'
  // Main ring — solid, moderately thick so it reads as a UI element
  // rather than a natural glow.
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()
  // Four crosshair ticks — poking inward from the ring toward center,
  // stopping short so the star's own visual isn't obscured. Reads as
  // "target this point" in every game/UI reticle vocabulary.
  const tickInner = radius - 12
  const tickOuter = radius + 8
  ctx.lineWidth = 2.5
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  for (const angle of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    ctx.beginPath()
    ctx.moveTo(cx + dx * tickInner, cy + dy * tickInner)
    ctx.lineTo(cx + dx * tickOuter, cy + dy * tickOuter)
    ctx.stroke()
  }
  // Subtle inner halo so the reticle has a soft aura at wide FOV
  // where the ring itself is only a few pixels across.
  const halo = ctx.createRadialGradient(cx, cy, radius - 4, cx, cy, radius + 6)
  halo.addColorStop(0, 'rgba(76,201,240,0)')
  halo.addColorStop(0.5, 'rgba(76,201,240,0.15)')
  halo.addColorStop(1, 'rgba(76,201,240,0)')
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(cx, cy, radius + 6, 0, Math.PI * 2)
  ctx.fill()
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

// ─── Star points ────────────────────────────────────────────────────────────

/**
 * @description Renders the entire star catalog as a single `THREE.Points` for performance
 * (one draw call instead of thousands of meshes). Per-vertex color comes from
 * B-V; per-vertex size comes from magnitude, doubled for known anomalies.
 *
 * Forwards its underlying `THREE.Points` ref so the parent can run raycasting
 * against it from a native click listener — R3F's `onClick` on `<points>` is
 * unreliable when OrbitControls sits in front of the event chain.
 * @param stars Catalog to render.
 * @param sprite Circular alpha sprite for round-looking points.
 * @returns A `<points>` element with packed buffer attributes.
 */
/**
 * @description Base pixel size of catalog star points at FOV_MAX. Scaled up
 * by `depthScale(fov, STAR_DEPTH_MAX_SCALE)` each frame to give a sense
 * of getting closer when the user zooms in.
 */
const STAR_BASE_SIZE = 3
const STAR_DEPTH_MAX_SCALE = 2.5

const StarPoints = React.forwardRef<THREE.Points, { stars: CatalogStar[]; sprite: THREE.Texture }>(
  function StarPoints({ stars, sprite }, ref) {
    // Internal ref so this component can mutate its own material in useFrame
    // independently of the parent's ref (which is used for click raycasting).
    const internalRef = useRef<THREE.Points>(null)
    const { camera } = useThree()

    const { positions, colors, sizes } = useMemo(() => {
      const positions = new Float32Array(stars.length * 3)
      const colors = new Float32Array(stars.length * 3)
      const sizes = new Float32Array(stars.length)

      stars.forEach((star, i) => {
        const [x, y, z] = raDecToXYZ(star.ra, star.dec, STAR_SPHERE_RADIUS)
        positions[i * 3] = x
        positions[i * 3 + 1] = y
        positions[i * 3 + 2] = z

        // Anomaly stars override B-V color with a hot white-red core so they
        // pop against the catalog. Bias toward white at the center because
        // PointsMaterial paints a single color across the soft sprite — a
        // very red point disappears into the surrounding red halo.
        if (star.hasAnomaly) {
          colors[i * 3] = 1.0
          colors[i * 3 + 1] = 0.55
          colors[i * 3 + 2] = 0.55
        } else {
          const color = bvToColor(star.colorIndex)
          colors[i * 3] = color.r
          colors[i * 3 + 1] = color.g
          colors[i * 3 + 2] = color.b
        }

        sizes[i] = Math.max(1.5, 8 - star.magnitude * 0.5)
        if (star.hasAnomaly) sizes[i] *= 3
      })

      return { positions, colors, sizes }
    }, [stars])

    // Depth-feel: scale point size by FOV each frame. Default
    // `pointsMaterial` ignores the per-vertex `attributes-size` buffer
    // (no custom shader), so the single `material.size` scalar is what
    // actually controls rendered size; we modulate that here.
    useFrame(() => {
      const mesh = internalRef.current
      if (!mesh) return
      const fov = (camera as THREE.PerspectiveCamera).fov ?? FOV_MAX
      const mat = mesh.material as THREE.PointsMaterial
      mat.size = STAR_BASE_SIZE * depthScale(fov, STAR_DEPTH_MAX_SCALE)
    })

    // Compose the forwarded ref with our internal one so the parent's
    // raycaster still sees the mesh while we keep direct access here.
    const setRef = (node: THREE.Points | null) => {
      internalRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }

    return (
      <points ref={setRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
          <bufferAttribute attach="attributes-size" args={[sizes, 1]} />
        </bufferGeometry>
        <pointsMaterial
          vertexColors
          sizeAttenuation={false}
          transparent
          opacity={0.95}
          size={STAR_BASE_SIZE}
          map={sprite}
          alphaTest={0.01}
          depthWrite={false}
        />
      </points>
    )
  },
)

/**
 * @description Screen-space radius (CSS pixels) around the click point
 * used to collect multi-hit candidates in dense fields. Stars whose
 * projected screen position falls within this many pixels of the
 * click are all treated as "at" the click and shown in the
 * disambiguation popover. Small enough that widely-separated stars
 * don't trigger the popover; large enough to include truly
 * overlapping points in dense KOI clusters.
 */
const CLICK_DISAMBIG_RADIUS_PX = 6

/**
 * @description One candidate returned by the picker when a click hits
 * multiple stars within `CLICK_DISAMBIG_RADIUS_PX`. `screenDistPx`
 * is the star's projected distance from the click point in CSS
 * pixels — kept as the sort key (nearest first) but NOT displayed:
 * in dense KOI stacks every candidate reads 0.0px (and the KOI
 * default magnitude 13.5), which carries zero signal. The popover
 * instead shows `dRaArcmin` / `dDecArcmin` — the star's angular
 * offset from the clicked sky position in arcminutes (ΔRA is the
 * on-sky offset, already scaled by cos δ) — which varies row to
 * row even inside a dense stack.
 */
export interface ClickCandidate {
  star: CatalogStar
  screenDistPx: number
  /** On-sky RA offset from the click point, arcmin: (α★ − α_click) · cos δ. */
  dRaArcmin: number
  /** Dec offset from the click point, arcmin: δ★ − δ_click. */
  dDecArcmin: number
}

/**
 * @description Bridge component that lives inside the Canvas so it has access to camera,
 * raycaster, and gl, then publishes a `pick(clientX, clientY)` function back
 * to the outer DOM tree via the `onPick` callback. The container uses that
 * function from its native `pointerup` listener to do raycasting.
 *
 * Multi-hit disambiguation: `raycaster.intersectObject` returns every
 * star along the ray path (within the world-space Points threshold).
 * We project each hit star's OWN world position — taken from the
 * geometry position buffer, never `intersection.point`, which for
 * Points is the closest point on the ray and projects back onto the
 * click pixel for every hit — to screen space, and keep only stars
 * within `CLICK_DISAMBIG_RADIUS_PX` of the click point. That's the
 * direct interpretation of "the user clicked on this spot". Behavior:
 * - **1 candidate**: select immediately (identical to the pre-
 *   disambiguation behavior; the popover would just be noise).
 * - **2+ candidates**: publish them via `onDisambiguate` so the
 *   outer component can render a popover. No `selectStar` runs
 *   until the user picks one.
 * - **0 candidates** (nothing within the screen radius but the ray
 *   still intersected something further out): fall back to the
 *   closest-to-ray hit so a slightly-off click still selects
 *   something reasonable.
 *
 * Renders nothing.
 * @param pointsRef Ref to the `THREE.Points` mesh of the catalog.
 * @param stars Catalog backing the points, indexed by `intersect.index`.
 * @param onPick Receives the picker function once the scene is mounted.
 * @param onDisambiguate Called when a click lands on 2+ stars; the
 * outer component shows a popover at the click coordinates.
 */
function ClickRaycastBridge({
  pointsRef,
  stars,
  onPick,
  onDisambiguate,
}: {
  pointsRef: React.RefObject<THREE.Points | null>
  stars: CatalogStar[]
  onPick: (picker: (clientX: number, clientY: number) => void) => void
  onDisambiguate: (clientX: number, clientY: number, candidates: ClickCandidate[]) => void
}) {
  const { camera, raycaster, gl } = useThree()

  useEffect(() => {
    onPick((clientX, clientY) => {
      const mesh = pointsRef.current
      if (!mesh) return
      const rect = gl.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      )
      // World-space threshold — kept a bit wider than the visual dot
      // so a slightly-off click still gets its intended target. The
      // strict "am I actually at this spot?" filter is the screen-
      // space reprojection below.
      raycaster.params.Points = { threshold: 4 }
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObject(mesh)
      if (hits.length === 0) return

      // Project each hit STAR to screen space and keep only those
      // within CLICK_DISAMBIG_RADIUS_PX of the click. Crucially this
      // uses the star's own world position from the geometry buffer,
      // NOT `h.point`: THREE.Points raycasting sets intersection.point
      // to the closest point ON THE RAY (Ray.closestPointToPoint), so
      // projecting h.point lands back on the click pixel for EVERY hit
      // and the screen filter passes everything inside the world-space
      // threshold (~0.5° of sky) — that bug produced 20–30-candidate
      // popovers of stars that were visibly nowhere near the cursor.
      // Dedupe by index so a single star that somehow shows up twice
      // (shouldn't happen for a single Points mesh but cheap insurance)
      // doesn't fill the popover with duplicates.
      const clickScreenX = clientX - rect.left
      const clickScreenY = clientY - rect.top
      const posAttr = mesh.geometry.getAttribute('position')
      // Sky position under the cursor: the (normalized) pick-ray
      // direction converted back to RA/Dec. Basis for the per-row
      // ΔRA/ΔDec readout in the disambiguation popover.
      const clickSky = xyzToRaDec(
        raycaster.ray.direction.x,
        raycaster.ray.direction.y,
        raycaster.ray.direction.z,
      )
      const projected = new THREE.Vector3()
      const dedupe = new Set<number>()
      const candidates: ClickCandidate[] = []
      for (const h of hits) {
        const idx = h.index
        if (idx == null || dedupe.has(idx)) continue
        dedupe.add(idx)
        const star = stars[idx]
        if (!star) continue
        projected
          .fromBufferAttribute(posAttr, idx)
          .applyMatrix4(mesh.matrixWorld)
          .project(camera)
        // NDC → CSS pixels within the canvas element.
        const sx = (projected.x * 0.5 + 0.5) * rect.width
        const sy = (1 - (projected.y * 0.5 + 0.5)) * rect.height
        const dx = sx - clickScreenX
        const dy = sy - clickScreenY
        const screenDistPx = Math.sqrt(dx * dx + dy * dy)
        if (screenDistPx <= CLICK_DISAMBIG_RADIUS_PX) {
          // Wrap the RA difference to (-180°, 180°] so a click near
          // the RA 0/360 seam doesn't report a ~21600′ offset, then
          // scale by cos δ for the true on-sky angular offset.
          const dRaDeg = ((star.ra - clickSky.ra + 540) % 360) - 180
          const dRaArcmin = dRaDeg * 60 * Math.cos((star.dec * Math.PI) / 180)
          const dDecArcmin = (star.dec - clickSky.dec) * 60
          candidates.push({ star, screenDistPx, dRaArcmin, dDecArcmin })
        }
      }

      if (candidates.length === 0) {
        // Nothing within the disambiguation radius. Fall back to the
        // single closest-to-ray hit so a click that's off by a few
        // pixels still selects something — matches the old behavior
        // for edge-case clicks.
        let best = hits[0]
        for (const h of hits) {
          if ((h.distanceToRay ?? Infinity) < (best.distanceToRay ?? Infinity)) best = h
        }
        const star = stars[best.index ?? 0]
        if (star) {
          void selectStarAndFetchCurve(star)
        }
        return
      }

      if (candidates.length === 1) {
        void selectStarAndFetchCurve(candidates[0].star)
        return
      }

      // 2+ candidates → open the popover. Sort by screen distance so
      // the top row is the star nearest the click.
      candidates.sort((a, b) => a.screenDistPx - b.screenDistPx)
      onDisambiguate(clientX, clientY, candidates)
    })
  }, [pointsRef, stars, camera, raycaster, gl, onPick, onDisambiguate])

  return null
}

// ─── Anomaly markers: three concentric radar-ping rings + bright core ───────

/** @description Pulse frequency in rad/s. 2π / 1.5s ≈ 4.19 rad/s → one full pulse every 1.5s. */
const ANOMALY_PULSE_OMEGA = (2 * Math.PI) / 1.5

/**
 * @description "Depth feel" multiplier for point sizes as the user zooms in
 * (FOV shrinks). At FOV_MAX → 1.0 (current sizes). At FOV_MIN → `maxScale`.
 * Linear interpolation in FOV-space — narrower FOV = bigger points,
 * giving the impression of getting closer to the stars.
 * @param fov Current camera field of view (degrees).
 * @param maxScale Multiplier applied when fov reaches FOV_MIN.
 * @returns Size multiplier in [1, maxScale].
 */
function depthScale(fov: number, maxScale: number): number {
  const t = (FOV_MAX - fov) / (FOV_MAX - FOV_MIN) // 0 at max-FOV, 1 at min-FOV
  const clamped = Math.max(0, Math.min(1, t))
  return 1 + clamped * (maxScale - 1)
}

/**
 * @description Three-layer red halo overlay drawn on top of anomaly stars,
 * styled as a radar ping. Two outer rings pulse at offset phases so they
 * read as expanding/contracting waves, and a hot pure-red core marks the
 * exact location. All materials are mutated in `useFrame` so the animation
 * runs without re-rendering React.
 * @param stars Full catalog; only entries with `hasAnomaly: true` are drawn.
 * @param sprite Shared circular alpha sprite.
 * @returns Three stacked `<points>` elements, or null if there are no anomalies.
 */
/**
 * @description Two-tier rendering mode for anomaly markers, driven by FOV:
 *
 * - **FOV ≥ ANOMALY_HARD_CUTOFF_FOV (55°)** — hard cutoff. Outer + mid
 *   rings rendered with opacity 0; core is a 1px static dot. The
 *   per-frame `useFrame` body early-returns without doing any trig,
 *   lerp, or material mutation (after snapping materials to the
 *   overview state ONCE on the transition). This is the
 *   performance fix for the wide-FOV red blob: the issue at wide
 *   FOV is the animated rings overlapping and smearing, not the
 *   dot count itself.
 * - **ANOMALY_TIER_HIGH_FOV (50°) ≤ FOV < 55°** — useFrame is still
 *   gated off (no animation work). Materials hold their last-set
 *   values, which the 40°–50° fade math already drove to the
 *   overview state by the time we crossed 50°. Effectively
 *   identical to ≥55° in render output; the gap exists because the
 *   user spec explicitly named both thresholds and we honor both
 *   literally — useFrame off at ≥50, hard cutoff at ≥55.
 * - **ANOMALY_TIER_LOW_FOV (40°) ≤ FOV < 50°** — animation runs;
 *   linear cross-fade between overview and detail: pulse opacity
 *   ramps 0→full, core color slides overview→detail, ring sizes
 *   interpolate from 1px → full design size.
 * - **FOV ≤ 40°** — "detail" mode. Full three-layer pulse as designed.
 */
const ANOMALY_TIER_HIGH_FOV = 50  // ≥ this → useFrame body short-circuits
const ANOMALY_TIER_LOW_FOV = 40   // ≤ this → full detail animation
const ANOMALY_HARD_CUTOFF_FOV = 55 // ≥ this → strict static overview (no animation)
const ANOMALY_OVERVIEW_CORE_PX = 1
const ANOMALY_CORE_BASE_SIZE = 8

/**
 * @description Color theme for one mission's anomaly markers. Lets the
 * same pulse animation drive two visually-distinct layers (Kepler in
 * red/orange, TESS in cyan) without duplicating the marker code.
 * `overview` is the static-dot color shown at wide FOV; `core`,
 * `mid`, `outer` are the three ring colors at full detail FOV. The
 * core's color is lerped between `overview` and `core` across the
 * transition band.
 */
interface AnomalyTheme {
  overview: THREE.Color    // static-dot color (wide FOV)
  core: THREE.Color        // core color at full detail FOV
  midHex: string           // mid ring color (static; set in JSX)
  outerHex: string         // outer ring color (static; set in JSX)
}

const KEPLER_THEME: AnomalyTheme = {
  overview: new THREE.Color('#f4a261'),  // orange
  core: new THREE.Color('#ff0000'),      // red
  midHex: '#ff4d6d',                     // brand red
  outerHex: '#ff0000',
}

const TESS_THEME: AnomalyTheme = {
  // Cyan/teal palette so TESS markers visually distinguish from
  // Kepler's red/orange across the same sky.
  overview: new THREE.Color('#7df9ff'),  // pale cyan (overview dot)
  core: new THREE.Color('#00e5ff'),      // saturated cyan (detail core)
  midHex: '#00bcd4',                     // teal mid ring
  outerHex: '#00e5ff',                   // cyan outer ring
}

/**
 * @description Returns the "detail mode amount" — 0.0 at FOV ≥
 * ANOMALY_TIER_HIGH_FOV (full overview), 1.0 at FOV ≤
 * ANOMALY_TIER_LOW_FOV (full detail), linearly interpolated in
 * between. The pulse opacity, color shift, and ring sizes all key off
 * this single number so the transition stays in sync across layers.
 * @param fov Current camera field of view (degrees).
 * @returns Detail amount in [0, 1].
 */
function detailAmount(fov: number): number {
  if (fov >= ANOMALY_TIER_HIGH_FOV) return 0
  if (fov <= ANOMALY_TIER_LOW_FOV) return 1
  return (ANOMALY_TIER_HIGH_FOV - fov) / (ANOMALY_TIER_HIGH_FOV - ANOMALY_TIER_LOW_FOV)
}

/**
 * @description Renders the three-layer pulse markers for one subset of
 * anomalies sharing a color theme. Extracted from the per-mission
 * wrapper below so the pulse + tier-fade logic isn't duplicated.
 * @param anomalies Pre-filtered list of stars (already known to have
 * `hasAnomaly: true` and matching the intended source/theme).
 * @param theme Color palette for this mission's markers.
 * @param sprite Shared circular alpha sprite.
 * @returns Three stacked `<points>` elements, or null if empty.
 */
function ThemedAnomalyMarkers({
  anomalies,
  theme,
  sprite,
  dimFactor = 1,
}: {
  anomalies: CatalogStar[]
  theme: AnomalyTheme
  sprite: THREE.Texture
  /**
   * @description Multiplier applied to all per-frame opacity values
   * (outer/mid/core rings AND the static overview core). `1` = full
   * brightness; `0.5` = visited dim. The static-snap branch also
   * scales by this so the wide-FOV core dims as expected. Default 1
   * keeps backward-compatible behavior for callers that don't pass
   * the prop.
   */
  dimFactor?: number
}) {
  const outerRef = useRef<THREE.Points>(null)
  const midRef = useRef<THREE.Points>(null)
  const coreRef = useRef<THREE.Points>(null)
  const { camera } = useThree()
  // Scratch Color so we don't allocate one per frame.
  const coreColorScratch = useMemo(() => new THREE.Color(), [])
  // Tracks whether we're currently in the "static overview" snapshot
  // state so we only mutate materials ONCE on the transition into it,
  // not every frame. Without this guard the useFrame body still runs
  // per-frame at wide FOV (you can't conditionally call a hook); the
  // ref lets the body do nothing once the static state is established.
  const isStaticRef = useRef(false)
  // When the caller changes `dimFactor` (visited → unvisited toggle in
  // dev, or set-rehydration), clear the latch so the next wide-FOV
  // frame re-snaps the static state with the new dim value baked in.
  useEffect(() => {
    isStaticRef.current = false
  }, [dimFactor])

  useFrame(({ clock }) => {
    const fov = (camera as THREE.PerspectiveCamera).fov ?? FOV_MAX
    // Wide FOV: skip ALL animation work. On the transition into this
    // state, snap materials to the static overview values once; on
    // subsequent frames, do nothing. This is the perf fix for the
    // wide-FOV blob — the animated mutation of `size`/`opacity`/`color`
    // every frame across thousands of overlapping markers is what
    // produces the smear, not the marker count itself.
    if (fov >= ANOMALY_TIER_HIGH_FOV) {
      if (!isStaticRef.current) {
        if (outerRef.current) {
          const mat = outerRef.current.material as THREE.PointsMaterial
          mat.size = 0
          mat.opacity = 0
        }
        if (midRef.current) {
          const mat = midRef.current.material as THREE.PointsMaterial
          mat.size = 0
          mat.opacity = 0
        }
        if (coreRef.current) {
          const mat = coreRef.current.material as THREE.PointsMaterial
          mat.size = ANOMALY_OVERVIEW_CORE_PX
          mat.opacity = 0.7 * dimFactor
          mat.color.copy(theme.overview)
        }
        isStaticRef.current = true
      }
      return
    }
    // Re-entering the animated band — clear the latch so the next
    // wide-FOV transition snaps fresh.
    isStaticRef.current = false

    const t = clock.elapsedTime * ANOMALY_PULSE_OMEGA
    const detail = detailAmount(fov)
    const overview = 1 - detail
    if (outerRef.current) {
      const mat = outerRef.current.material as THREE.PointsMaterial
      const pulseSize = 36 + 14 * Math.sin(t)
      const pulseOpacity = 0.18 + 0.12 * Math.sin(t)
      mat.size = pulseSize * detail
      mat.opacity = pulseOpacity * detail * dimFactor
    }
    if (midRef.current) {
      const mat = midRef.current.material as THREE.PointsMaterial
      const pulseSize = 22 + 9 * Math.sin(t + Math.PI * 0.6)
      const pulseOpacity = 0.45 + 0.25 * Math.sin(t + Math.PI * 0.6)
      mat.size = pulseSize * detail
      mat.opacity = pulseOpacity * detail * dimFactor
    }
    if (coreRef.current) {
      const mat = coreRef.current.material as THREE.PointsMaterial
      mat.size = ANOMALY_OVERVIEW_CORE_PX * overview + ANOMALY_CORE_BASE_SIZE * detail
      coreColorScratch.lerpColors(theme.overview, theme.core, detail)
      mat.color.copy(coreColorScratch)
      const overviewOpacity = 0.7
      const detailOpacity = 0.85 + 0.15 * Math.sin(t * 1.5)
      mat.opacity = (overviewOpacity * overview + detailOpacity * detail) * dimFactor
    }
  })

  const positions = useMemo(() => {
    const pos = new Float32Array(anomalies.length * 3)
    anomalies.forEach((star, i) => {
      const [x, y, z] = raDecToXYZ(star.ra, star.dec, STAR_SPHERE_RADIUS - 1)
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
    })
    return pos
  }, [anomalies])

  if (anomalies.length === 0) return null

  // Initial material props match the static-overview state so the
  // first paint (before the first useFrame tick) is correct even
  // when the camera starts at wide FOV. The useFrame body takes
  // over from there, mutating sizes/opacities only when FOV < 50.
  return (
    <>
      <points ref={outerRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color={theme.outerHex}
          size={0}
          sizeAttenuation={false}
          transparent
          opacity={0}
          map={sprite}
          alphaTest={0.01}
          depthWrite={false}
        />
      </points>
      <points ref={midRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color={theme.midHex}
          size={0}
          sizeAttenuation={false}
          transparent
          opacity={0}
          map={sprite}
          alphaTest={0.01}
          depthWrite={false}
        />
      </points>
      <points ref={coreRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color={theme.overview.getStyle()}
          size={ANOMALY_OVERVIEW_CORE_PX}
          sizeAttenuation={false}
          transparent
          opacity={0.7}
          map={sprite}
          alphaTest={0.01}
          depthWrite={false}
        />
      </points>
    </>
  )
}

/**
 * @description Multiplier applied to opacity of markers for anomalies
 * the user has already opened a light curve for. Lower than 1 so
 * unvisited anomalies pop against a sea of visited ones — the whole
 * point of the visited tracking is to direct attention to what hasn't
 * been seen yet.
 */
const VISITED_DIM_FACTOR = 0.5

/**
 * @description Wrapper that splits the anomaly catalog by mission source
 * AND by visited state, then renders one `ThemedAnomalyMarkers` layer
 * per (mission, visited) bucket — four meshes total per mission color
 * group (unvisited + visited × outer/mid/core). Visited anomalies use
 * `dimFactor = VISITED_DIM_FACTOR` so unvisited ones stay visually
 * dominant.
 *
 * A separate `FlaggedRingMarkers` layer renders a white ring around
 * every flagged star regardless of mission or visited state — flagged
 * is purely additive overlay, doesn't replace the underlying marker.
 *
 * Kepler = red/orange theme; TESS = cyan theme. Stars with no explicit
 * source tag (legacy seeds, anomalies that pre-date mission tagging)
 * fall into the Kepler bucket — most of them ARE historically Kepler
 * targets (Tabby's etc), so this matches user expectation. Mission
 * overlap: when a star is in both KOI and TOI catalogs, the page-level
 * merge tags it as `'TESS'` (TOI merge runs last).
 * @param stars Full catalog; we filter to `hasAnomaly: true` here.
 * @param sprite Shared circular alpha sprite.
 * @returns Per-mission themed layers plus the flagged ring overlay.
 */
function AnomalyMarkers({ stars, sprite }: { stars: CatalogStar[]; sprite: THREE.Texture }) {
  // Subscribe to the persisted sets so the buckets recompute when the
  // user toggles a flag or opens a new star's curve. Both are Set
  // instances; Zustand sets a new reference on each setter call so
  // the dependency check fires correctly.
  const visitedIds = useStore(s => s.visitedIds)
  const flaggedIds = useStore(s => s.flaggedIds)

  const partitioned = useMemo(() => {
    const kepUnvisited: CatalogStar[] = []
    const kepVisited: CatalogStar[] = []
    const tesUnvisited: CatalogStar[] = []
    const tesVisited: CatalogStar[] = []
    const flaggedAll: CatalogStar[] = []
    for (const s of stars) {
      if (!s.hasAnomaly) continue
      const isTess = s.source === 'TESS'
      const isVisited = visitedIds.has(s.id)
      if (isTess) (isVisited ? tesVisited : tesUnvisited).push(s)
      else (isVisited ? kepVisited : kepUnvisited).push(s)
      if (flaggedIds.has(s.id)) flaggedAll.push(s)
    }
    return { kepUnvisited, kepVisited, tesUnvisited, tesVisited, flaggedAll }
  }, [stars, visitedIds, flaggedIds])

  return (
    <>
      <ThemedAnomalyMarkers anomalies={partitioned.kepUnvisited} theme={KEPLER_THEME} sprite={sprite} />
      <ThemedAnomalyMarkers anomalies={partitioned.kepVisited} theme={KEPLER_THEME} sprite={sprite} dimFactor={VISITED_DIM_FACTOR} />
      <ThemedAnomalyMarkers anomalies={partitioned.tesUnvisited} theme={TESS_THEME} sprite={sprite} />
      <ThemedAnomalyMarkers anomalies={partitioned.tesVisited} theme={TESS_THEME} sprite={sprite} dimFactor={VISITED_DIM_FACTOR} />
      <FlaggedRingMarkers anomalies={partitioned.flaggedAll} sprite={sprite} />
    </>
  )
}

/**
 * @description Additive white-ring overlay drawn around every flagged
 * anomaly star regardless of mission or visited status. Renders as a
 * single `<points>` layer with a slightly larger sprite size than the
 * mission cores so the ring sits around them. Hidden at wide FOV
 * (FOV ≥ ANOMALY_TIER_HIGH_FOV, same threshold as the rest of the
 * marker overlay) so the wide-FOV view doesn't gain visual noise just
 * because the user flagged things across the sky.
 * @param anomalies Flagged star subset; assumed to all have `hasAnomaly`.
 * @param sprite Shared circular alpha sprite.
 * @returns A single `<points>` layer, or null when empty.
 */
function FlaggedRingMarkers({
  anomalies,
  sprite,
}: {
  anomalies: CatalogStar[]
  sprite: THREE.Texture
}) {
  const ringRef = useRef<THREE.Points>(null)
  const { camera } = useThree()

  useFrame(() => {
    if (!ringRef.current) return
    const fov = (camera as THREE.PerspectiveCamera).fov ?? FOV_MAX
    const mat = ringRef.current.material as THREE.PointsMaterial
    if (fov >= ANOMALY_TIER_HIGH_FOV) {
      mat.opacity = 0
      mat.size = 0
      return
    }
    const detail = detailAmount(fov)
    // Hold the ring at a stable size (no pulse — the ring is a
    // status badge, not an animation), but follow the same FOV fade
    // as the other markers so it doesn't pop in/out abruptly.
    mat.size = 14 * detail
    mat.opacity = 0.85 * detail
  })

  const positions = useMemo(() => {
    const pos = new Float32Array(anomalies.length * 3)
    anomalies.forEach((star, i) => {
      const [x, y, z] = raDecToXYZ(star.ra, star.dec, STAR_SPHERE_RADIUS - 1)
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
    })
    return pos
  }, [anomalies])

  if (anomalies.length === 0) return null

  return (
    <points ref={ringRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color="#ffffff"
        size={0}
        sizeAttenuation={false}
        transparent
        opacity={0}
        map={sprite}
        alphaTest={0.01}
        depthWrite={false}
      />
    </points>
  )
}

/**
 * @description Color palette for the sky-radar overlay, keyed by
 * `CurvePattern`. IRREGULAR pops in bright magenta so it reads as
 * "interesting — worth a closer look"; PERIODIC_UNIFORM is a dim,
 * calm green so classified planetary-signal-looking stars fade into
 * the background. HIGH_VARIABILITY gets a dim yellow to flag "noisy,
 * take results with a grain of salt". SPARSE and UNCERTAIN
 * intentionally have no radar entry — the classifier is admitting
 * it can't tell, so we let those stars keep their default
 * mission-color anomaly marker with no radar tint.
 */
const RADAR_COLOR_HEX: Partial<Record<CurvePattern, string>> = {
  IRREGULAR: '#ff2ea6',        // bright magenta — pops as "interesting"
  PERIODIC_UNIFORM: '#4ade80', // dim green — "boring, known"
  HIGH_VARIABILITY: '#facc15', // dim yellow — "noisy backdrop"
}

/**
 * @description Extra overlay layer for the sky radar. Renders one dot
 * per classified star at the pattern color from `RADAR_COLOR_HEX`.
 * Drawn ABOVE the mission-themed `AnomalyMarkers` so the mission
 * color underneath still peeks through the pulse animation while the
 * radar dot sits crisply on top at the star's exact position.
 *
 * FOV tier behavior mirrors `AnomalyMarkers`: hidden above the
 * hard-cutoff (≥ ANOMALY_HARD_CUTOFF_FOV = 55°) so a wide-view sky
 * doesn't grow a rash of colored dots on top of the already-static
 * overview cores. Between 40° and 50° the layer fades linearly with
 * `detailAmount(fov)`. Below 40° it renders at full opacity.
 *
 * Uses ONE `<points>` mesh per pattern so we don't need a custom
 * shader to vary color per vertex — three cheap draws (magenta /
 * green / yellow) is well within our budget and keeps the layer
 * consistent with how the rest of the file draws grouped markers.
 * @param stars Full catalog (we filter by classifiedPatterns here).
 * @param sprite Shared circular alpha sprite.
 * @returns One `<points>` mesh per pattern with a cached entry.
 */
function PatternRadarMarkers({
  stars,
  sprite,
}: {
  stars: CatalogStar[]
  sprite: THREE.Texture
}) {
  const classifiedPatterns = useStore(s => s.classifiedPatterns)

  // Bucket stars by pattern once per (stars, classifiedPatterns)
  // change — expensive to recompute, cheap to iterate later.
  const buckets = useMemo(() => {
    const out: Record<string, CatalogStar[]> = {}
    for (const patternKey of Object.keys(RADAR_COLOR_HEX)) out[patternKey] = []
    for (const star of stars) {
      const pattern = classifiedPatterns.get(star.id)
      if (!pattern) continue
      if (!(pattern in RADAR_COLOR_HEX)) continue
      out[pattern].push(star)
    }
    return out
  }, [stars, classifiedPatterns])

  return (
    <>
      {Object.entries(buckets).map(([pattern, patternStars]) => (
        <PatternRadarBucket
          key={pattern}
          stars={patternStars}
          colorHex={RADAR_COLOR_HEX[pattern as CurvePattern]!}
          sprite={sprite}
        />
      ))}
    </>
  )
}

/**
 * @description Single `<points>` mesh for one pattern bucket. Pulled
 * out so each bucket owns its own refs, useFrame, and positions
 * memo — cleaner than one giant per-pattern for-loop inside a
 * useFrame that also has to track per-bucket refs.
 *
 * Sits at `STAR_SPHERE_RADIUS - 3` (in front of the mission anomaly
 * layer at −1 and the flagged ring at −1) so its dot is always the
 * visually-top-most classified badge. `depthWrite: false` +
 * `depthTest: false` avoids Z-fighting with the other overlays at
 * near-equal radii.
 * @param stars Pre-bucketed subset for this pattern.
 * @param colorHex Radar color for this pattern.
 * @param sprite Shared circular alpha sprite.
 * @returns One `<points>` mesh, or null when the bucket is empty.
 */
function PatternRadarBucket({
  stars,
  colorHex,
  sprite,
}: {
  stars: CatalogStar[]
  colorHex: string
  sprite: THREE.Texture
}) {
  const ref = useRef<THREE.Points>(null)
  const { camera } = useThree()
  const isStaticRef = useRef(false)

  useFrame(() => {
    if (!ref.current) return
    const fov = (camera as THREE.PerspectiveCamera).fov ?? FOV_MAX
    const mat = ref.current.material as THREE.PointsMaterial
    // Same hard cutoff as the mission-color anomaly layer. Above
    // this FOV the wide-view sky shows only the static overview
    // cores; adding radar dots on top would just add clutter and
    // undo the perf win of the AnomalyMarkers static-snap.
    if (fov >= ANOMALY_HARD_CUTOFF_FOV) {
      if (!isStaticRef.current) {
        mat.size = 0
        mat.opacity = 0
        isStaticRef.current = true
      }
      return
    }
    isStaticRef.current = false
    // Linear fade over the same 40°–50° band as `detailAmount`.
    // Below 40° the dot renders at full 8px / 0.9 opacity.
    const detail = detailAmount(fov)
    mat.size = 8 * detail
    mat.opacity = 0.9 * detail
  })

  const positions = useMemo(() => {
    const pos = new Float32Array(stars.length * 3)
    stars.forEach((star, i) => {
      const [x, y, z] = raDecToXYZ(star.ra, star.dec, STAR_SPHERE_RADIUS - 3)
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
    })
    return pos
  }, [stars])

  if (stars.length === 0) return null

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color={colorHex}
        size={0}
        sizeAttenuation={false}
        transparent
        opacity={0}
        map={sprite}
        alphaTest={0.01}
        depthWrite={false}
        depthTest={false}
      />
    </points>
  )
}

/**
 * @description Base sprite size (screen pixels) for the selection
 * reticle at wide FOV. The `useFrame` animation modulates around
 * this baseline; picked to be large enough to read at FOV_MAX
 * without swamping the star itself.
 */
const SELECTION_BASE_SIZE = 34

/**
 * @description Angular frequency of the selection reticle's breathing
 * pulse (radians per second). Slower than the anomaly pulse
 * (`ANOMALY_PULSE_OMEGA`) so the two are visually distinguishable
 * when a flagged/anomaly star is also the selection — the reticle
 * feels calm and deliberate, the anomaly feels alert.
 */
const SELECTION_PULSE_OMEGA = (2 * Math.PI) / 2.2

/**
 * @description "You are here" reticle rendered at the currently-
 * selected star's position. Distinct from every other overlay:
 * - Flagged white ring is thinner, static, and only at anomaly stars.
 * - Anomaly pulse is red/cyan (mission-tinted) and FOV-gated.
 * This reticle is bright cyan, always visible regardless of FOV,
 * carries a crosshair-inside-ring shape, and breathes in size + opacity
 * so it reads as "the current cursor / selection anchor" rather than
 * as a status badge.
 *
 * Renders nothing when `selectedStar` is null. When it is set, the
 * position attribute is re-populated whenever the id / RA / Dec
 * changes — the underlying `<points>` mesh persists so we don't
 * churn a full mount cycle on every selection.
 * @returns Reticle `<points>` layer, or null if nothing is selected.
 */
function SelectionMarker() {
  const selectedStar = useStore(s => s.selectedStar)
  const ref = useRef<THREE.Points>(null)
  const reticle = useMemo(() => makeReticleTexture(), [])
  const { camera } = useThree()

  // Single-vertex position buffer. Re-populated by an effect below
  // whenever the selected star changes; we allocate the buffer once
  // and mutate it in place to avoid re-uploading the entire mesh
  // through React on each selection.
  const positions = useMemo(() => new Float32Array(3), [])

  useEffect(() => {
    if (!selectedStar || !ref.current) return
    const [x, y, z] = raDecToXYZ(selectedStar.ra, selectedStar.dec, STAR_SPHERE_RADIUS - 2)
    positions[0] = x
    positions[1] = y
    positions[2] = z
    const geom = ref.current.geometry
    const attr = geom.getAttribute('position') as THREE.BufferAttribute | undefined
    if (attr) attr.needsUpdate = true
  }, [selectedStar, positions])

  useFrame(({ clock }) => {
    if (!ref.current) return
    const mat = ref.current.material as THREE.PointsMaterial
    if (!selectedStar) {
      // Fully hidden when nothing is selected. We don't unmount the
      // mesh — cheap enough to keep around, and this way the
      // position/material state stays warm for the next selection.
      mat.opacity = 0
      mat.size = 0
      return
    }
    // Breathing pulse: size ±15% around the base, opacity 0.55–0.9.
    // Sine on different phases so size peak and opacity peak don't
    // land on the same frame — feels more organic than a lockstep
    // pulse. Renders at ALL FOVs (unlike the anomaly pulse) so the
    // user can always locate their selection.
    const t = clock.elapsedTime * SELECTION_PULSE_OMEGA
    const fov = (camera as THREE.PerspectiveCamera).fov ?? FOV_MAX
    // Gentle FOV boost so the reticle doesn't shrink relative to the
    // star point when the user zooms in (star points already scale
    // via `depthScale`). Cap at 1.6× to avoid overwhelming the star
    // itself at maximum zoom.
    const fovBoost = 1 + Math.min(0.6, (FOV_MAX - fov) / FOV_MAX * 0.9)
    mat.size = SELECTION_BASE_SIZE * fovBoost * (1 + 0.15 * Math.sin(t))
    mat.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t + Math.PI / 3))
  })

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color="#4cc9f0"
        size={0}
        sizeAttenuation={false}
        transparent
        opacity={0}
        map={reticle}
        alphaTest={0.01}
        depthWrite={false}
        depthTest={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

// ─── Camera sync + auto-select on zoom (FOV-based, no keyboard) ─────────────

/**
 * @description Per-frame bridge between Three's camera and the Zustand store. Publishes
 * the current pointing RA/Dec and FOV, and auto-selects a centered anomaly
 * once the user has zoomed in enough (narrow FOV + within half-FOV of an
 * anomaly's angular direction).
 * @param stars Catalog; only entries with `hasAnomaly: true` are eligible.
 * @returns Null — this is a pure side-effect component.
 */
function CameraSync({ stars }: { stars: CatalogStar[] }) {
  const { camera } = useThree()
  const { selectedStar, setCameraTarget, setZoom } = useStore()
  const flyTo = useStore(s => s.flyTo)
  // Id of the anomaly inside the auto-select cone (within
  // `halfFov * 0.5` of center) as of the previous frame, or null when
  // none was. Auto-select fires only on a TRANSITION of this value to
  // a new star — i.e. camera movement bringing a different anomaly to
  // center. It must NEVER fire because `selectedStar` changed out from
  // under it: an explicit pick (popover row, direct click) of an
  // off-center star leaves the centered anomaly unchanged, so with
  // transition semantics the pick survives. The previous design
  // (guard ref synced to `selectedStar`) re-armed on every explicit
  // pick and stole the selection back within one frame.
  const centeredAnomalyRef = useRef<string | null>(null)
  // Timestamp of the most recent fly-to command. Auto-select is
  // suppressed until this many ms have passed, giving the tween time
  // to arrive without any intermediate frame's `closest` anomaly
  // latching onto and overwriting the user's explicit pick. The
  // fly-to tween itself runs ~1000 ms; we hold the suppression a bit
  // longer so a slow arrival frame doesn't slip through.
  const flyToSuppressUntilRef = useRef<number>(0)

  const anomalyDirs = useMemo(
    () =>
      stars
        .filter(s => s.hasAnomaly)
        .map(s => ({
          star: s,
          dir: new THREE.Vector3(...raDecToXYZ(s.ra, s.dec, 1)).normalize(),
        })),
    [stars],
  )

  // Suppression window: any fly-to command triggers a ~1.3s hold on
  // auto-select. Without this, the auto-select useFrame below scans
  // for the anomaly angularly closest to the camera on every frame
  // during the 1s tween and fires `selectStarAndFetchCurve` on it —
  // silently overwriting the user's explicit selection when the
  // fly-to path passes within `halfFov * 0.5` of a different
  // anomaly. Verified failure case: search picks K02357.02
  // (KIC7449554); K07016.01 (KIC8311864) sits 2.36° away; at FOV≤28°
  // (auto-select threshold) `halfFov*0.5 = 7°` easily catches it.
  // The transition guard alone wouldn't cover this: mid-tween the
  // centered anomaly genuinely changes frame to frame, so those ARE
  // transitions — the time window is still needed to mute them.
  useEffect(() => {
    if (!flyTo) return
    flyToSuppressUntilRef.current = performance.now() + 1300
  }, [flyTo])

  useFrame(() => {
    const dir = new THREE.Vector3()
    camera.getWorldDirection(dir)
    const { ra, dec } = xyzToRaDec(dir.x, dir.y, dir.z)
    setCameraTarget({ ra, dec })

    const fov = (camera as THREE.PerspectiveCamera).fov ?? FOV_MAX
    setZoom(fov)

    // Auto-select when zoomed in (narrow FOV) and an anomaly is near center.
    // Suppressed for a ~1.3s window after any fly-to command so an
    // in-flight tween can't be silently overridden by whatever anomaly
    // happens to sit along its path.
    if (fov <= AUTO_SELECT_FOV && performance.now() >= flyToSuppressUntilRef.current) {
      let closest: (typeof anomalyDirs)[0] | null = null
      let closestAngle = Infinity
      for (const ap of anomalyDirs) {
        const angle = ap.dir.angleTo(dir)
        if (angle < closestAngle) { closestAngle = angle; closest = ap }
      }
      // Within ~½ of the current half-FOV → centered enough to lock on
      const halfFovRad = (fov / 2) * (Math.PI / 180)
      const centeredId =
        closest && closestAngle < halfFovRad * 0.5 ? closest.star.id : null
      // Fire only when the centered anomaly TRANSITIONS to a new star.
      // A frame where the centered star is unchanged never fires — no
      // matter what `selectedStar` is — so an explicit pick of an
      // off-center star (popover row, direct click) is never stolen
      // back by whatever happens to sit at screen center.
      if (centeredId !== centeredAnomalyRef.current) {
        centeredAnomalyRef.current = centeredId
        if (centeredId && closest && centeredId !== selectedStar?.id) {
          void selectStarAndFetchCurve(closest.star)
        }
      }
    } else if (fov > AUTO_SELECT_FOV) {
      // Wide FOV = outside the auto-select regime. Reset so zooming
      // back in re-evaluates from scratch (a fresh transition onto
      // whatever is centered then).
      centeredAnomalyRef.current = null
    }
  })

  return null
}

// ─── FOV-based zoom: wheel changes camera.fov instead of moving the camera ──

/**
 * @description Implements telescope-style zoom: wheel events modify `camera.fov` between
 * FOV_MIN and FOV_MAX instead of translating the camera. Each frame the
 * actual FOV interpolates toward the target so the zoom feels smooth and
 * continuous instead of stepped.
 * @param containerRef Element to attach the `wheel` listener to.
 * @returns Null — pure side effects.
 */
function FovZoomController({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const { camera } = useThree()
  const targetFovRef = useRef<number>(FOV_MAX)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // Initialize target from current camera fov
    targetFovRef.current = (camera as THREE.PerspectiveCamera).fov ?? FOV_MAX

    const onWheel = (e: WheelEvent) => {
      // Prevent OrbitControls (or page) from also consuming this wheel event
      e.preventDefault()
      // Scroll down (positive deltaY) → wider FOV (zoom out)
      // Scroll up (negative deltaY) → narrower FOV (zoom in)
      const factor = Math.exp(e.deltaY * 0.0015)
      targetFovRef.current = Math.min(FOV_MAX, Math.max(FOV_MIN, targetFovRef.current * factor))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [camera, containerRef])

  useFrame(() => {
    const persp = camera as THREE.PerspectiveCamera
    const target = targetFovRef.current
    const delta = target - persp.fov
    if (Math.abs(delta) > 0.01) {
      // Smooth approach (~10% per frame at 60fps → ~100ms to settle)
      persp.fov += delta * 0.15
      persp.updateProjectionMatrix()
    } else if (persp.fov !== target) {
      persp.fov = target
      persp.updateProjectionMatrix()
    }
  })

  return null
}

// ─── Hover-aware anomaly label tracker ──────────────────────────────────────
//
// Lives inside the Canvas, projects each anomaly into screen space every frame,
// finds the one closest to the cursor (if within LABEL_HOVER_RADIUS_PX), and
// pushes {star, sx, sy} into a parent ref so the HTML overlay can render it.

interface HoveredLabel {
  star: CatalogStar
  sx: number
  sy: number
}

/**
 * @description Each frame, projects every anomaly to screen space, finds the one closest
 * to the cursor (within LABEL_HOVER_RADIUS_PX), and pushes it up via
 * `onChange` so the HTML label overlay can render it. Shows one label at
 * most, anchored to the actual on-screen anomaly position.
 * @param stars Catalog; only `hasAnomaly: true` entries are considered.
 * @param mouseRef Ref to {x, y} in CSS pixels relative to the container, or null when the cursor has left.
 * @param onChange Called with the hovered label (or null) whenever it changes.
 * @returns Null — pure side effects.
 */
function AnomalyHoverTracker({
  stars,
  mouseRef,
  onChange,
}: {
  stars: CatalogStar[]
  mouseRef: React.RefObject<{ x: number; y: number } | null>
  onChange: (h: HoveredLabel | null) => void
}) {
  const { camera, size } = useThree()
  const anomalies = useMemo(() => stars.filter(s => s.hasAnomaly), [stars])
  const anomalyVectors = useMemo(
    () =>
      anomalies.map(s => ({
        star: s,
        pos: new THREE.Vector3(...raDecToXYZ(s.ra, s.dec, STAR_SPHERE_RADIUS - 2)),
      })),
    [anomalies],
  )
  const lastIdRef = useRef<string | null>(null)

  useFrame(() => {
    const mouse = mouseRef.current
    if (!mouse) {
      if (lastIdRef.current !== null) {
        lastIdRef.current = null
        onChange(null)
      }
      return
    }

    let best: HoveredLabel | null = null
    let bestDist = LABEL_HOVER_RADIUS_PX

    for (const { star, pos } of anomalyVectors) {
      const projected = pos.clone().project(camera)
      if (projected.z > 1) continue // behind camera
      const sx = ((projected.x + 1) / 2) * size.width
      const sy = ((-projected.y + 1) / 2) * size.height
      const dx = sx - mouse.x
      const dy = sy - mouse.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < bestDist) {
        bestDist = dist
        best = { star, sx, sy }
      }
    }

    const newId = best?.star.id ?? null
    if (newId !== lastIdRef.current) {
      lastIdRef.current = newId
      onChange(best)
    } else if (best) {
      // Same star but position may have changed (camera moved) — still update
      onChange(best)
    }
  })

  return null
}

// ─── Fly-to controller: smoothly orbits the camera to a target RA/Dec ──────
//
// Listens for `flyTo` commands in the store. When a new one comes in, it
// captures the current spherical position and tweens it (radius held, theta/phi
// shortest-arc) toward the target over ~1s with easeInOut.

/**
 * @description Watches `store.flyTo` for new commands and tweens the camera's pointing
 * direction (spherical theta/phi, radius held constant) toward the target
 * RA/Dec over ~1 second with easeInOutCubic. Theta is wrapped into the
 * shortest arc so the camera never spins the long way around.
 * @param controlsRef Ref to the OrbitControls instance, updated each frame so it stays in sync with the tweened camera.
 * @returns Null — pure side effects.
 */
function FlyToController({
  controlsRef,
  onArrive,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>
  onArrive?: () => void
}) {
  const { camera } = useThree()
  const flyTo = useStore(s => s.flyTo)
  const tweenRef = useRef<{
    fromTheta: number
    fromPhi: number
    radius: number
    toTheta: number
    toPhi: number
    startTime: number
    duration: number
    id: number
  } | null>(null)

  // The camera orbits the origin at a tiny CAMERA_RADIUS and OrbitControls
  // keeps it looking at the origin. So the direction the user *sees* is
  // -position.normalized(). To look at a target direction D, the camera must
  // be placed at -D * CAMERA_RADIUS. Spherical-from-(-D) gives the right
  // theta/phi to interpolate to.
  const targetSphericalFromRaDec = (ra: number, dec: number) => {
    const [x, y, z] = raDecToXYZ(ra, dec, 1)
    // Negate: camera sits opposite to where it looks.
    const v = new THREE.Vector3(-x, -y, -z)
    const s = new THREE.Spherical().setFromVector3(v)
    return { theta: s.theta, phi: s.phi }
  }

  useEffect(() => {
    if (!flyTo) return
    const cur = new THREE.Spherical().setFromVector3(camera.position)
    const tgt = targetSphericalFromRaDec(flyTo.ra, flyTo.dec)
    // Shortest-arc theta: wrap delta into [-π, π]
    let dTheta = tgt.theta - cur.theta
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI
    tweenRef.current = {
      fromTheta: cur.theta,
      fromPhi: cur.phi,
      radius: cur.radius,
      toTheta: cur.theta + dTheta,
      toPhi: tgt.phi,
      startTime: performance.now(),
      duration: 1000,
      id: flyTo.id,
    }
  }, [flyTo, camera])

  useFrame(() => {
    const tween = tweenRef.current
    if (!tween) return
    const elapsed = performance.now() - tween.startTime
    const t = Math.min(1, elapsed / tween.duration)
    // easeInOutCubic
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

    const theta = tween.fromTheta + (tween.toTheta - tween.fromTheta) * eased
    const phi = tween.fromPhi + (tween.toPhi - tween.fromPhi) * eased

    const s = new THREE.Spherical(tween.radius, phi, theta)
    camera.position.setFromSpherical(s)
    camera.lookAt(0, 0, 0)
    controlsRef.current?.update()

    if (t >= 1) {
      tweenRef.current = null
      onArrive?.()
    }
  })

  return null
}

// ─── Main export ─────────────────────────────────────────────────────────────

interface StarFieldProps {
  stars: CatalogStar[]
}

/**
 * @description Top-level interactive sky component. Owns the Three.js Canvas, the
 * OrbitControls, the click/raycast plumbing, and the hovered-label overlay.
 * All scene-level controllers (camera sync, FOV zoom, fly-to, hover tracking)
 * live as children so they can use `useThree`.
 * @param stars Catalog to display.
 * @returns Fullscreen interactive sky.
 */
export default function StarField({ stars }: StarFieldProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mouseRef = useRef<{ x: number; y: number } | null>(null)
  const pointsRef = useRef<THREE.Points>(null)
  const pickerRef = useRef<((cx: number, cy: number) => void) | null>(null)
  const downPosRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const [hovered, setHovered] = useState<HoveredLabel | null>(null)
  const [arrivalFlash, setArrivalFlash] = useState(false)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sprite = useMemo(() => makeCircleTexture(), [])
  // Popover shown when a click hits multiple stars in the same
  // screen-space region. `x`/`y` are page-coordinate pixel offsets
  // (from the click event), used verbatim as the popover's absolute
  // position — anchored so the top-left of the card sits at the
  // click site. Null when no disambiguation is pending.
  const [disambig, setDisambig] = useState<{
    x: number
    y: number
    candidates: ClickCandidate[]
  } | null>(null)

  // Mirror ref for `disambig` so the native pointerdown/pointerup
  // listeners (registered ONCE at mount, they don't re-bind on
  // state change) can read the current open state cheaply. When
  // the popover is open the picker must NOT fire — otherwise the
  // container's native pointerup handler runs the raycaster on
  // whatever's underneath the popover in the 3D canvas AND the
  // row's React `onClick` runs `onPick`, so we'd `selectStar`
  // twice with different targets. Ref-based state lookup lets one
  // stable listener stay correct across popover open/close.
  const disambigOpenRef = useRef(false)
  useEffect(() => { disambigOpenRef.current = disambig !== null }, [disambig])

  const handleDisambiguate = useCallback(
    (x: number, y: number, candidates: ClickCandidate[]) => {
      setDisambig({ x, y, candidates })
    },
    [],
  )

  /**
   * @description Triggered by `FlyToController` when the camera finishes
   * tweening to a fly-to target. Briefly flashes the screen red (0.3s) so
   * the user gets a strong "you have arrived" signal — important since the
   * camera motion itself can be subtle.
   */
  const handleFlyArrive = useCallback(() => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setArrivalFlash(true)
    flashTimerRef.current = setTimeout(() => setArrivalFlash(false), 300)
  }, [])

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect()
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    const onLeave = () => { mouseRef.current = null }

    // Distinguish "click" from "drag": only fire raycast pick if pointer moved
    // less than ~4px between down and up, and within 400ms.
    //
    // While the disambiguation popover is open we DON'T update
    // `downPosRef` and we DON'T call the picker on release. React's
    // synthetic events on the popover (row `onClick`, backdrop
    // dismiss) handle the interaction. If we allowed the container
    // picker to fire, clicking a row would additionally raycast
    // against the star underneath the popover and either overwrite
    // the correct `selectStar` result or trigger a spurious MAST
    // fetch. State is read from `disambigOpenRef` so this stable
    // listener stays correct without re-binding on every popover
    // open/close.
    const onPointerDown = (e: PointerEvent) => {
      if (disambigOpenRef.current) return
      downPosRef.current = { x: e.clientX, y: e.clientY, t: performance.now() }
    }
    const onPointerUp = (e: PointerEvent) => {
      if (disambigOpenRef.current) return
      const down = downPosRef.current
      downPosRef.current = null
      if (!down) return
      const dx = e.clientX - down.x
      const dy = e.clientY - down.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const elapsed = performance.now() - down.t
      if (dist < 5 && elapsed < 400) {
        pickerRef.current?.(e.clientX, e.clientY)
      }
    }

    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointerup', onPointerUp)
    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerup', onPointerUp)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      style={{ width: '100vw', height: '100vh', background: '#000', position: 'relative' }}
    >
      <Canvas
        camera={{ position: [CAMERA_RADIUS, 0, 0], fov: FOV_MAX, near: 0.001, far: 2000 }}
        gl={{ antialias: true }}
      >
        <StarPoints ref={pointsRef} stars={stars} sprite={sprite} />
        <AnomalyMarkers stars={stars} sprite={sprite} />
        <PatternRadarMarkers stars={stars} sprite={sprite} />
        <SelectionMarker />
        <CameraSync stars={stars} />
        <FlyToController controlsRef={controlsRef} onArrive={handleFlyArrive} />
        <FovZoomController containerRef={containerRef} />
        <ClickRaycastBridge
          pointsRef={pointsRef}
          stars={stars}
          onPick={(fn) => { pickerRef.current = fn }}
          onDisambiguate={handleDisambiguate}
        />
        <AnomalyHoverTracker stars={stars} mouseRef={mouseRef} onChange={setHovered} />
        <OrbitControls
          ref={controlsRef}
          enableZoom={false}
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.4}
          makeDefault
        />
      </Canvas>
      {hovered && <HoveredAnomalyLabel hovered={hovered} />}
      {/* Arrival flash: 0.3s red wash that fades out via CSS transition.
          pointer-events: none so it never intercepts clicks. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(circle at center, rgba(255,0,0,0.35), rgba(255,0,0,0.05) 70%, transparent 100%)',
          opacity: arrivalFlash ? 1 : 0,
          transition: arrivalFlash ? 'opacity 0.05s ease-out' : 'opacity 0.25s ease-in',
          pointerEvents: 'none',
          zIndex: 6,
        }}
      />
      {disambig && (
        <ClickDisambiguationPopover
          x={disambig.x}
          y={disambig.y}
          candidates={disambig.candidates}
          onPick={(star) => {
            void selectStarAndFetchCurve(star)
            setDisambig(null)
          }}
          onDismiss={() => setDisambig(null)}
        />
      )}
    </div>
  )
}

/**
 * @description Formats an angular offset in arcminutes for the
 * disambiguation popover: explicit sign (so direction from the click
 * is readable), one decimal at arcminute scale, two decimals below
 * 0.1′ so ultra-tight stacks still show distinct values, and a prime
 * suffix. Examples: `+2.1′`, `−0.05′`.
 * @param arcmin Signed angular offset in arcminutes.
 * @returns Compact signed string with a ′ suffix.
 */
function formatArcmin(arcmin: number): string {
  const abs = Math.abs(arcmin)
  const digits = abs < 0.1 ? 2 : 1
  const sign = arcmin < 0 ? '−' : '+'
  return `${sign}${abs.toFixed(digits)}′`
}

/**
 * @description Popover shown when a click hits multiple stars within
 * `CLICK_DISAMBIG_RADIUS_PX` in the 3D sky. Lists each candidate
 * with its name and its ΔRA/ΔDec angular offset from the clicked
 * sky position (arcminutes, ΔRA cos δ-corrected); clicking an entry
 * selects that star, clicking the backdrop dismisses. Rows stay
 * sorted by projected screen distance (nearest first) — the offsets
 * replaced the old mag/px columns only as the DISPLAYED values,
 * because in dense KOI stacks those rendered identically for every
 * row (mag 13.5 · 0.0px) and gave the user nothing to tell
 * candidates apart by.
 *
 * A full-viewport transparent backdrop sits behind the card and
 * intercepts clicks so a stray click on the sky doesn't re-trigger
 * the picker AND simultaneously dismiss the popover. Per the UX
 * spec, an off-card click dismisses WITHOUT selecting anything new.
 * @param x Page X of the original click; card left-anchors here.
 * @param y Page Y of the original click; card top-anchors here.
 * @param candidates Stars that hit the click point, pre-sorted by
 * screen distance ascending.
 * @param onPick Called when the user chooses one entry.
 * @param onDismiss Called when the user clicks outside the card.
 * @returns Fixed-position backdrop + candidate card, or null when
 * empty (shouldn't happen — parent gates on `candidates.length >= 2`).
 */
function ClickDisambiguationPopover({
  x,
  y,
  candidates,
  onPick,
  onDismiss,
}: {
  x: number
  y: number
  candidates: ClickCandidate[]
  onPick: (star: CatalogStar) => void
  onDismiss: () => void
}) {
  // NOTE on event isolation: the container in the outer component
  // registers NATIVE `pointerdown`/`pointerup` listeners on its
  // root div via `addEventListener`. Those don't participate in
  // React's synthetic-event tree, so `e.stopPropagation()` from a
  // React `onClick` here would NOT prevent them from firing on
  // bubble. Attaching a native `stopPropagation` listener on the
  // backdrop would prevent them — but it would ALSO break React's
  // root-level synthetic-event delegation (React 17+ listens on
  // the react root, which sits above this popover; stopping
  // propagation at the backdrop stops the event reaching the
  // delegator too, so the row's `onClick` would never fire).
  //
  // The correct fix is state-aware in the OUTER component: the
  // container's native picker checks `disambigOpenRef.current` and
  // bails when the popover is open. That's implemented in the
  // pointerup handler at `StarField`'s mount effect.
  if (candidates.length === 0) return null
  // Clamp the card so it never overflows the viewport when the click
  // was near the bottom-right edge. 260 is the card width plus
  // margin; 220 covers ~5 rows plus the header.
  const CARD_W = 260
  const CARD_H_APPROX = 220
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920
  const vh = typeof window !== 'undefined' ? window.innerHeight : 1080
  const left = Math.min(x + 8, vw - CARD_W - 8)
  const top = Math.min(y + 8, vh - CARD_H_APPROX - 8)
  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 30,
        // Transparent — the click capture is the whole point; visuals
        // stay minimal so the sky beneath is still readable.
        background: 'transparent',
        pointerEvents: 'auto',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute',
          left,
          top,
          width: CARD_W,
          maxHeight: 'min(50vh, 320px)',
          overflowY: 'auto',
          background: 'rgba(0,0,0,0.86)',
          border: '1px solid rgba(76,201,240,0.35)',
          borderRadius: 6,
          padding: 8,
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          animation: 'sf-disambig-fade 0.12s ease',
        }}
      >
        <div
          style={{
            fontSize: 8,
            color: 'rgba(255,255,255,0.4)',
            letterSpacing: 2,
            padding: '2px 6px 0',
          }}
        >
          {candidates.length} STARS AT THIS POINT
        </div>
        <div
          style={{
            fontSize: 7,
            color: 'rgba(255,255,255,0.25)',
            letterSpacing: 1,
            padding: '2px 6px 6px',
          }}
        >
          ΔRA · ΔDEC FROM CLICK (ARCMIN)
        </div>
        {candidates.map(c => (
          <button
            key={c.star.id}
            onClick={() => onPick(c.star)}
            title={c.star.name}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              width: '100%',
              background: 'none',
              border: 'none',
              color: 'white',
              fontSize: 10,
              letterSpacing: 0.5,
              padding: '6px 8px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textAlign: 'left',
              borderRadius: 4,
              gap: 8,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(76,201,240,0.12)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                minWidth: 0,
              }}
            >
              {c.star.name}
            </span>
            <span style={{ color: 'rgba(76,201,240,0.75)', fontSize: 9, minWidth: 42, textAlign: 'right' }}>
              {formatArcmin(c.dRaArcmin)}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 9, minWidth: 42, textAlign: 'right' }}>
              {formatArcmin(c.dDecArcmin)}
            </span>
          </button>
        ))}
      </div>
      <style jsx>{`
        @keyframes sf-disambig-fade {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

/**
 * @description Floating label card anchored to a screen-space position. Rendered outside
 * the Canvas as an absolutely-positioned DOM node so it can use real fonts
 * and CSS animation. Pointer-events are off so it never steals clicks from
 * the underlying scene.
 * @param hovered The currently hovered anomaly + its screen position.
 * @returns Absolutely-positioned `<div>` with the star name.
 */
function HoveredAnomalyLabel({ hovered }: { hovered: HoveredLabel }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: hovered.sx,
        top: hovered.sy,
        transform: 'translate(-50%, calc(-100% - 18px))',
        pointerEvents: 'none',
        zIndex: 5,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
      }}
    >
      <div
        style={{
          background: 'rgba(0,0,0,0.8)',
          border: '1px solid rgba(255,77,109,0.6)',
          borderRadius: 4,
          padding: '4px 10px',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          color: '#ff8fa3',
          letterSpacing: 1,
          whiteSpace: 'nowrap',
        }}
      >
        {hovered.star.name}
      </div>
      <div style={{ width: 1, height: 12, background: 'rgba(255,77,109,0.5)' }} />
    </div>
  )
}
