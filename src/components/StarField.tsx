'use client'
import React, { useRef, useMemo, useEffect, useState, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { CatalogStar } from '@/lib/starCatalog'
import { useStore } from '@/lib/store'
import { fetchLightcurve, detectDips } from '@/lib/anomalyDetector'
import { classifyCurve } from '@/lib/curveClassifier'

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
 * @description Selects a star: switches the UI to analyze mode, fetches its light curve,
 * detects dips, and pushes everything into the store so the side panel can
 * render. Setters are passed in (instead of pulled from `useStore()`) so this
 * helper stays callable from both React handlers and `useFrame` loops.
 * @param star The star the user (or auto-select) just picked.
 * @param setSelectedStar Store action — selected star.
 * @param setMode Store action — UI mode.
 * @param setLightcurve Store action — light curve + dips.
 * @param setAnomalies Store action — list of notable+ dips for the HUD counter.
 */
async function selectStar(
  star: CatalogStar,
  setSelectedStar: (s: CatalogStar) => void,
  setMode: (m: 'explore' | 'analyze' | 'report') => void,
  setLightcurve: (d: ReturnType<typeof useStore.getState>['lightcurve']) => void,
  setAnomalies: (a: ReturnType<typeof useStore.getState>['anomalies']) => void,
) {
  setSelectedStar(star)
  setMode('analyze')
  // Mark visited as soon as the user opens the curve — the persisted
  // record is "I tried to look at this star", not "I successfully
  // fetched data". A failed MAST fetch still counts as visited so the
  // user isn't pestered to revisit dead targets.
  useStore.getState().markVisited(star.id)
  // Clear stale data from the previously selected star and flip the loading
  // flag so the panel can render its progress indicator instead.
  const { setLightcurveLoading } = useStore.getState()
  setLightcurve(null)
  setLightcurveLoading(true)
  try {
    const { times, flux, source, provenance } = await fetchLightcurve(star.id)
    const dips = detectDips(flux, times)
    const anomalyDips = dips.map(d => ({
      starId: star.id,
      score: d.score,
      depth: d.depth,
      duration: d.duration,
      asymmetry: d.asymmetry,
      peakTime: d.peakTime,
      label: d.label,
    }))
    // Profile the curve only when we actually have data; the
    // 'unavailable' path returns empty arrays and `classifyCurve`
    // would just report SPARSE / zeros — clearer to surface null.
    const profile =
      source === 'unavailable' || times.length === 0
        ? null
        : classifyCurve(times, flux, dips)
    setLightcurve({ times, flux, dips: anomalyDips, source, provenance, profile })
    setAnomalies(anomalyDips.filter(d => d.label !== 'NORMAL'))
  } finally {
    setLightcurveLoading(false)
  }
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
 * @description Bridge component that lives inside the Canvas so it has access to camera,
 * raycaster, and gl, then publishes a `pick(clientX, clientY)` function back
 * to the outer DOM tree via the `onPick` callback. The container uses that
 * function from its native `pointerup` listener to do raycasting and select
 * the star nearest the click.
 *
 * Renders nothing.
 * @param pointsRef Ref to the `THREE.Points` mesh of the catalog.
 * @param stars Catalog backing the points, indexed by `intersect.index`.
 * @param onPick Receives the picker function once the scene is mounted.
 */
function ClickRaycastBridge({
  pointsRef,
  stars,
  onPick,
}: {
  pointsRef: React.RefObject<THREE.Points | null>
  stars: CatalogStar[]
  onPick: (picker: (clientX: number, clientY: number) => void) => void
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
      // Bigger threshold = easier to hit a star
      raycaster.params.Points = { threshold: 4 }
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObject(mesh)
      if (hits.length === 0) return
      // Prefer the hit closest to the click in screen space (smallest distanceToRay)
      let best = hits[0]
      for (const h of hits) {
        if ((h.distanceToRay ?? Infinity) < (best.distanceToRay ?? Infinity)) best = h
      }
      const idx = best.index ?? 0
      const star = stars[idx]
      if (star) {
        const { setSelectedStar, setMode, setLightcurve, setAnomalies } = useStore.getState()
        selectStar(star, setSelectedStar, setMode, setLightcurve, setAnomalies)
      }
    })
  }, [pointsRef, stars, camera, raycaster, gl, onPick])

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
  const { setSelectedStar, setMode, setLightcurve, setAnomalies, selectedStar, setCameraTarget, setZoom } = useStore()
  const autoSelectedRef = useRef<string | null>(null)

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

  useFrame(() => {
    const dir = new THREE.Vector3()
    camera.getWorldDirection(dir)
    const { ra, dec } = xyzToRaDec(dir.x, dir.y, dir.z)
    setCameraTarget({ ra, dec })

    const fov = (camera as THREE.PerspectiveCamera).fov ?? FOV_MAX
    setZoom(fov)

    // Auto-select when zoomed in (narrow FOV) and an anomaly is near center
    if (fov <= AUTO_SELECT_FOV) {
      let closest: (typeof anomalyDirs)[0] | null = null
      let closestAngle = Infinity
      for (const ap of anomalyDirs) {
        const angle = ap.dir.angleTo(dir)
        if (angle < closestAngle) { closestAngle = angle; closest = ap }
      }
      // Within ~½ of the current half-FOV → centered enough to lock on
      const halfFovRad = (fov / 2) * (Math.PI / 180)
      if (closest && closestAngle < halfFovRad * 0.5 && autoSelectedRef.current !== closest.star.id) {
        autoSelectedRef.current = closest.star.id
        selectStar(closest.star, setSelectedStar, setMode, setLightcurve, setAnomalies)
      }
    } else {
      if (!selectedStar) autoSelectedRef.current = null
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
    const onPointerDown = (e: PointerEvent) => {
      downPosRef.current = { x: e.clientX, y: e.clientY, t: performance.now() }
    }
    const onPointerUp = (e: PointerEvent) => {
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
        <CameraSync stars={stars} />
        <FlyToController controlsRef={controlsRef} onArrive={handleFlyArrive} />
        <FovZoomController containerRef={containerRef} />
        <ClickRaycastBridge
          pointsRef={pointsRef}
          stars={stars}
          onPick={(fn) => { pickerRef.current = fn }}
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
