'use client'
import React, { useRef, useMemo, useEffect, useState, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { CatalogStar } from '@/lib/starCatalog'
import { useStore } from '@/lib/store'
import { fetchLightcurve, detectDips } from '@/lib/anomalyDetector'

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
    setLightcurve({ times, flux, dips: anomalyDips, source, provenance })
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
const StarPoints = React.forwardRef<THREE.Points, { stars: CatalogStar[]; sprite: THREE.Texture }>(
  function StarPoints({ stars, sprite }, ref) {
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

    return (
      <points ref={ref}>
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
          size={3}
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
 * @description Three-layer red halo overlay drawn on top of anomaly stars,
 * styled as a radar ping. Two outer rings pulse at offset phases so they
 * read as expanding/contracting waves, and a hot pure-red core marks the
 * exact location. All materials are mutated in `useFrame` so the animation
 * runs without re-rendering React.
 * @param stars Full catalog; only entries with `hasAnomaly: true` are drawn.
 * @param sprite Shared circular alpha sprite.
 * @returns Three stacked `<points>` elements, or null if there are no anomalies.
 */
function AnomalyMarkers({ stars, sprite }: { stars: CatalogStar[]; sprite: THREE.Texture }) {
  const outerRef = useRef<THREE.Points>(null)
  const midRef = useRef<THREE.Points>(null)
  const coreRef = useRef<THREE.Points>(null)
  const anomalies = useMemo(() => stars.filter(s => s.hasAnomaly), [stars])

  useFrame(({ clock }) => {
    const t = clock.elapsedTime * ANOMALY_PULSE_OMEGA
    // Outer ring: largest, slowest visible swing, low opacity (~#ff000044)
    if (outerRef.current) {
      const mat = outerRef.current.material as THREE.PointsMaterial
      mat.size = 36 + 14 * Math.sin(t)
      mat.opacity = 0.18 + 0.12 * Math.sin(t)
    }
    // Mid ring: offset phase so it reads as a second ping chasing the first
    if (midRef.current) {
      const mat = midRef.current.material as THREE.PointsMaterial
      mat.size = 22 + 9 * Math.sin(t + Math.PI * 0.6)
      mat.opacity = 0.45 + 0.25 * Math.sin(t + Math.PI * 0.6)
    }
    // Core: faster brightness wobble, stays small and hot
    if (coreRef.current) {
      const mat = coreRef.current.material as THREE.PointsMaterial
      mat.opacity = 0.85 + 0.15 * Math.sin(t * 1.5)
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

  return (
    <>
      {/* Outer faint ring — #ff0000 at ~27% opacity (≈ #ff000044) */}
      <points ref={outerRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color="#ff0000"
          size={36}
          sizeAttenuation={false}
          transparent
          opacity={0.27}
          map={sprite}
          alphaTest={0.01}
          depthWrite={false}
        />
      </points>
      {/* Mid ring — brand red */}
      <points ref={midRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color="#ff4d6d"
          size={22}
          sizeAttenuation={false}
          transparent
          opacity={0.6}
          map={sprite}
          alphaTest={0.01}
          depthWrite={false}
        />
      </points>
      {/* Hot pure-red core dot */}
      <points ref={coreRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color="#ff0000"
          size={8}
          sizeAttenuation={false}
          transparent
          opacity={0.95}
          map={sprite}
          alphaTest={0.01}
          depthWrite={false}
        />
      </points>
    </>
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
