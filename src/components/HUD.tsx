'use client'
import { useEffect, useMemo, useState } from 'react'
import { useStore, type Star } from '@/lib/store'
import { KNOWN_ANOMALIES } from '@/lib/starCatalog'
import { ALL_QUADRANT_IDS, quadrantCenter } from '@/lib/quadrants'

/**
 * @description Threshold (degrees, camera FOV) below which the quadrant
 * HUD panel becomes visible. Matches the user spec — quadrants only
 * make sense once the user has zoomed in enough that one quadrant
 * actually fills a meaningful portion of the screen.
 */
const QUADRANT_PANEL_FOV_THRESHOLD = 45

const ONBOARDING_KEY = 'sae:onboarded:v1'

const ONBOARDING_STEPS = [
  { icon: '✥', title: 'DRAG', desc: 'to explore the sky' },
  { icon: '◎', title: 'CLICK', desc: 'a star to analyze it' },
  { icon: '●', title: 'RED DOTS', desc: 'are unexplained anomalies' },
  { icon: '➤', title: 'GO TO ANOMALY', desc: 'takes you straight there' },
]

/**
 * @description Full-screen onboarding overlay shown only the first time the user opens the
 * app. Persists dismissal in localStorage under ONBOARDING_KEY. Renders four
 * animated step cards that fade in sequentially.
 */
function Onboarding() {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARDING_KEY)) setVisible(true)
    } catch {
      // localStorage may throw in private mode — fall through and skip the overlay
    }
  }, [])

  function dismiss() {
    setClosing(true)
    try { localStorage.setItem(ONBOARDING_KEY, '1') } catch {}
    setTimeout(() => setVisible(false), 350)
  }

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.78)',
        backdropFilter: 'blur(6px)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 32,
        opacity: closing ? 0 : 1,
        transition: 'opacity 0.35s ease',
        pointerEvents: 'auto',
        padding: 24,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', letterSpacing: 3 }}>WELCOME TO</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'white', letterSpacing: 4, marginTop: 6 }}>
          STELLAR ANOMALY EXPLORER
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 16,
          maxWidth: 820,
          width: '100%',
        }}
      >
        {ONBOARDING_STEPS.map((step, i) => (
          <div
            key={step.title}
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(76,201,240,0.25)',
              borderRadius: 8,
              padding: '18px 16px',
              textAlign: 'center',
              opacity: 0,
              animation: `onb-fade-in 0.5s ease forwards`,
              animationDelay: `${i * 0.15}s`,
            }}
          >
            <div style={{ fontSize: 26, color: '#4cc9f0', marginBottom: 8 }}>{step.icon}</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'white', letterSpacing: 2, marginBottom: 4 }}>
              {step.title}
            </div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1, lineHeight: 1.5 }}>
              {step.desc}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={dismiss}
        style={{
          background: '#4cc9f0',
          border: 'none',
          borderRadius: 6,
          padding: '12px 28px',
          color: '#000',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 3,
          cursor: 'pointer',
          fontFamily: 'inherit',
          opacity: 0,
          animation: `onb-fade-in 0.5s ease forwards`,
          animationDelay: `${ONBOARDING_STEPS.length * 0.15 + 0.1}s`,
        }}
      >
        GOT IT, EXPLORE
      </button>

      <style jsx>{`
        @keyframes onb-fade-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

export default function HUD() {
  const {
    mode,
    selectedStar,
    cameraTarget,
    anomalies,
    koiCount,
    koiError,
    toiCount,
    toiError,
    anomalyStars,
    zoom,
    nextAnomalyCursor,
    setNextAnomalyCursor,
    requestFlyTo,
    visitedIds,
    flaggedIds,
    setSelectedStar,
    setMode,
  } = useStore()

  // Transient toast for "NO ANOMALIES IN VIEW" feedback. Local state with
  // a setTimeout so it self-dismisses after ~1.5s without needing a
  // separate animation library.
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 1500)
    return () => clearTimeout(id)
  }, [toast])

  // Use the full KOI catalog when it's loaded; fall back to the 11
  // hardcoded seeds while it's still pending or if the fetch failed.
  // This way nav works on first paint AND scales to thousands once
  // the merge lands.
  const navTargets = anomalyStars.length > 0 ? anomalyStars : KNOWN_ANOMALIES

  /**
   * @description Computes the unit-vector for a celestial position.
   * Pulled out so both nav handlers and the in-view filter share one
   * implementation. Standard RA/Dec → (x, y, z) on the unit sphere.
   */
  function toUnit(ra: number, dec: number) {
    const r = (ra * Math.PI) / 180
    const d = (dec * Math.PI) / 180
    return {
      x: Math.cos(d) * Math.cos(r),
      y: Math.sin(d),
      z: Math.cos(d) * Math.sin(r),
    }
  }

  /**
   * @description Returns indices into `anomalyStars` for entries whose
   * direction is inside the camera's current view cone. The cone is
   * approximate — we use half-FOV × 1.3 to roughly cover the horizontal
   * extent of the canvas (vertical FOV times the typical 16:9 aspect
   * widens the horizontal field by ~30%). Good enough for "is this
   * star on screen" filtering without round-tripping through Three.js
   * projection math. Returns indices in score-desc order since
   * `anomalyStars` is already sorted that way.
   */
  function visibleAnomalyIndices(): number[] {
    if (anomalyStars.length === 0) return []
    const cam = toUnit(cameraTarget.ra, cameraTarget.dec)
    // `zoom` holds the camera FOV in degrees (set by CameraSync each frame).
    const halfFovRad = ((zoom / 2) * Math.PI) / 180
    // Generous cone: 1.3× covers horizontal extent for typical aspect ratios.
    const cosThreshold = Math.cos(halfFovRad * 1.3)
    const out: number[] = []
    for (let i = 0; i < anomalyStars.length; i++) {
      const s = anomalyStars[i]
      const v = toUnit(s.ra, s.dec)
      const dot = v.x * cam.x + v.y * cam.y + v.z * cam.z
      if (dot >= cosThreshold) out.push(i)
    }
    return out
  }

  function goToNearestAnomaly() {
    // Angular nearest on the celestial sphere: pick the anomaly whose
    // direction has the highest dot product with the camera's current
    // pointing vector. Scans the full catalog (NOT view-filtered) —
    // this button is for "take me to the nearest anomaly even if I
    // can't see one from here".
    if (navTargets.length === 0) return
    const cam = toUnit(cameraTarget.ra, cameraTarget.dec)
    let bestIdx = 0
    let bestDot = -Infinity
    for (let i = 0; i < navTargets.length; i++) {
      const s = navTargets[i]
      const v = toUnit(s.ra, s.dec)
      const dot = v.x * cam.x + v.y * cam.y + v.z * cam.z
      if (dot > bestDot) { bestDot = dot; bestIdx = i }
    }
    const best = navTargets[bestIdx]
    requestFlyTo(best.ra, best.dec)
    // Sync cursor to this position so a subsequent NEXT click advances
    // from the visible target rather than jumping somewhere arbitrary.
    if (navTargets === anomalyStars) setNextAnomalyCursor(bestIdx)
  }

  /**
   * @description Cycles through anomalies visible in the current viewport
   * by score desc. The previous version cycled globally through all
   * ~6,000 KOIs which made the button useless once the Kepler field
   * was off-screen — it'd just keep flying back there. View-filtered
   * cycling lets the user pan to any region of sky and tour the
   * anomalies in THAT region.
   *
   * Logic:
   *   1. Find anomalies inside the current view cone.
   *   2. If empty → flash "NO ANOMALIES IN VIEW" toast and stop.
   *   3. Otherwise find the first visible anomaly with `globalRank >
   *      nextAnomalyCursor`. If none, wrap to the first visible.
   *   4. Fly there, update cursor.
   *
   * The cursor stores the global rank (index into `anomalyStars`),
   * NOT the in-view rank, because the visible set changes every time
   * the user pans/zooms. Using global rank lets the cycle resume
   * sensibly when the user pans somewhere new — we pick up where we
   * left off in score order rather than restarting from the highest
   * score visible (which would lock the user on the same top anomaly
   * after every pan).
   */
  function goToNextAnomaly() {
    if (anomalyStars.length === 0) return
    const visible = visibleAnomalyIndices()
    if (visible.length === 0) {
      setToast('NO ANOMALIES IN VIEW')
      return
    }
    // Find first visible index strictly greater than the cursor; wrap
    // to the first visible if we ran past the end of the visible list.
    let pick = visible.find(i => i > nextAnomalyCursor)
    if (pick === undefined) pick = visible[0]
    const target = anomalyStars[pick]
    setNextAnomalyCursor(pick)
    requestFlyTo(target.ra, target.dec)
  }

  const statusColor =
    mode === 'analyze' ? '#f4a261'
    : anomalies.length > 0 ? '#ff4d6d'
    : '#4cc9f0'

  const statusLabel =
    mode === 'analyze' ? 'ANALYZING'
    : mode === 'report' ? 'REPORTING'
    : anomalies.length > 0 ? 'ANOMALY DETECTED'
    : 'EXPLORING'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 10,
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <Onboarding />
      {/* Header */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '16px 24px 10px',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.8) 0%, transparent 100%)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 3, color: 'white' }}>
              STELLAR ANOMALY EXPLORER
            </div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: 2, marginTop: 2 }}>
              KEPLER · TESS · GAIA · HIPPARCOS
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: 1 }}>
              RA {cameraTarget.ra.toFixed(4)}° · DEC {cameraTarget.dec.toFixed(4)}°
            </div>
            <div style={{ fontSize: 9, color: statusColor, letterSpacing: 2, marginTop: 2 }}>
              {statusLabel}
            </div>
          </div>
        </div>
        {/* Global progress bar — fraction of anomaly catalog the user
            has opened a light curve for. Hidden until the catalog
            loads (anomalyStars empty = pending) since "0 / 0" is
            meaningless. */}
        {anomalyStars.length > 0 && (
          <ProgressBar visited={countVisitedAnomalies(anomalyStars, visitedIds)} total={anomalyStars.length} />
        )}
      </div>

      {/* Crosshair */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 24,
          height: 24,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: 1,
            background: 'rgba(255,255,255,0.25)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: 1,
            background: 'rgba(255,255,255,0.25)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.4)',
          }}
        />
      </div>

      {/* Bottom-left: anomaly counter + nav button */}
      <div
        style={{
          position: 'absolute',
          bottom: 24,
          left: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          pointerEvents: 'auto',
        }}
      >
        {/* Global mission counters (catalog scale, not per-selected-star).
            One row per mission, stacked in a single card so both counts
            are visible together. Each row shows a "CATALOG UNAVAILABLE"
            badge instead of a number when its fetch failed. The
            per-star detected-dip count (`anomalies.length`) still
            drives the status color/label in the header — different
            semantic. */}
        <div
          style={{
            background: 'rgba(0,0,0,0.7)',
            border:
              koiError && toiError
                ? '1px solid rgba(244,162,97,0.4)'
                : '1px solid rgba(255,77,109,0.4)',
            borderRadius: 8,
            padding: '10px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <MissionCount label="KEPLER" count={koiCount} error={koiError} accent="#ff4d6d" />
          <MissionCount label="TESS" count={toiCount} error={toiError} accent="#00e5ff" />
        </div>

        <button
          onClick={goToNearestAnomaly}
          style={{
            background: 'rgba(0,0,0,0.7)',
            border: '1px solid rgba(76,201,240,0.4)',
            borderRadius: 8,
            padding: '10px 16px',
            color: '#4cc9f0',
            fontSize: 9,
            letterSpacing: 2,
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
          }}
        >
          GO TO NEAREST ANOMALY
        </button>

        {/* NEXT ANOMALY — cycles through anomalies visible in the current
            viewport, by score desc. Disabled while the catalog hasn't
            loaded yet. Shows "N IN VIEW" — count of anomalies inside
            the camera's view cone — instead of the global total. */}
        <button
          onClick={goToNextAnomaly}
          disabled={anomalyStars.length === 0}
          style={{
            background: 'rgba(0,0,0,0.7)',
            border: `1px solid ${anomalyStars.length === 0 ? 'rgba(76,201,240,0.15)' : 'rgba(76,201,240,0.4)'}`,
            borderRadius: 8,
            padding: '10px 16px',
            color: anomalyStars.length === 0 ? 'rgba(76,201,240,0.3)' : '#4cc9f0',
            fontSize: 9,
            letterSpacing: 2,
            cursor: anomalyStars.length === 0 ? 'default' : 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>NEXT ANOMALY ▸</span>
          {anomalyStars.length > 0 && (
            <span style={{ opacity: 0.55, fontSize: 8 }}>
              {visibleAnomalyIndices().length.toLocaleString()} IN VIEW
            </span>
          )}
        </button>

        {/* Transient toast: shows when NEXT is pressed with no visible
            anomalies. Self-dismisses after ~1.5s (handled by the
            useEffect above). Kept small/subtle — same monospace style
            as the rest of the HUD, not modal. */}
        {toast && (
          <div
            style={{
              fontSize: 9,
              color: '#f4a261',
              letterSpacing: 2,
              padding: '6px 10px',
              background: 'rgba(0,0,0,0.7)',
              border: '1px solid rgba(244,162,97,0.4)',
              borderRadius: 6,
            }}
          >
            {toast}
          </div>
        )}
      </div>

      {/* Bottom-right column above the minimap: flagged list (top)
          then quadrant panel (bottom). One absolutely-positioned
          column container so the two child panels stack via flex,
          never overlap, and the FLAGGED list always sits above the
          QUADRANTS panel regardless of which is expanded. The
          column anchors to bottom-right of the viewport at an
          offset that clears the minimap (~120px). */}
      <div
        style={{
          position: 'absolute',
          bottom: 130,
          right: 24,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
          maxHeight: 'calc(100vh - 200px)',
          pointerEvents: 'none', // children opt in individually
        }}
      >
        <FlaggedPanel
          flaggedIds={flaggedIds}
          anomalyStars={anomalyStars}
          onFlyTo={(star) => {
            requestFlyTo(star.ra, star.dec)
            setSelectedStar(star)
            setMode('analyze')
          }}
        />
        <QuadrantPanel
          fov={zoom}
          anomalyStars={anomalyStars}
          visitedIds={visitedIds}
          flaggedIds={flaggedIds}
          onPick={(ra, dec) => requestFlyTo(ra, dec)}
        />
      </div>

      {/* Bottom-right: minimap (click to fly the camera there) */}
      <Minimap
        ra={cameraTarget.ra}
        dec={cameraTarget.dec}
        onPick={(targetRa, targetDec) => requestFlyTo(targetRa, targetDec)}
      />

      {/* Selected star label */}
      {selectedStar && (
        <div
          style={{
            position: 'absolute',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.75)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 8,
            padding: '8px 18px',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontSize: 11, color: 'white', letterSpacing: 1 }}>{selectedStar.name}</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
            MAG {selectedStar.magnitude.toFixed(1)} · RA {selectedStar.ra.toFixed(2)}° · DEC {selectedStar.dec.toFixed(2)}°
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * @description Bottom-right minimap showing the full celestial sphere as a
 * 2:1 equirectangular projection. Renders known anomalies as red dots and
 * the camera's current pointing direction as a glowing cyan marker. Clicking
 * inside the map dispatches `onPick(ra, dec)` so the camera can fly to that
 * point on the sky.
 * @param ra Current camera RA in degrees [0, 360).
 * @param dec Current camera Dec in degrees [-90, 90].
 * @param onPick Called with the RA/Dec corresponding to the clicked pixel.
 * @returns Absolutely-positioned 160×80 minimap with a title row above.
 */
function Minimap({
  ra,
  dec,
  onPick,
}: {
  ra: number
  dec: number
  onPick: (ra: number, dec: number) => void
}) {
  const W = 160
  const H = 80
  const DOT = 5
  const VIEW = 7

  /**
   * @description Projects RA/Dec to {left, top} CSS pixels inside the map,
   * clamped so the marker never overflows the box.
   * @param r RA in degrees.
   * @param d Dec in degrees.
   * @param size Marker size in pixels (used to compute the offset).
   */
  const project = (r: number, d: number, size: number) => {
    const x = (r / 360) * W
    // Dec runs +90 (top) to -90 (bottom) → invert so north is up.
    const y = ((90 - d) / 180) * H
    return {
      left: Math.max(0, Math.min(W - size, x - size / 2)),
      top: Math.max(0, Math.min(H - size, y - size / 2)),
    }
  }

  /**
   * @description Inverse of `project`: given a click in CSS pixels relative
   * to the map's top-left, returns the corresponding RA/Dec on the celestial
   * sphere. Mirrors the projection's dec-inversion (north up).
   * @param px Pixel offset from the left edge of the map.
   * @param py Pixel offset from the top edge of the map.
   */
  const unproject = (px: number, py: number) => {
    const cx = Math.max(0, Math.min(W, px))
    const cy = Math.max(0, Math.min(H, py))
    const newRa = (cx / W) * 360
    const newDec = 90 - (cy / H) * 180
    return { ra: newRa, dec: newDec }
  }

  const view = project(ra, dec, VIEW)

  /**
   * @description Click handler on the map box. Translates the event position
   * (which uses page coords) into map-local pixels, then unprojects.
   */
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const { ra: r, dec: d } = unproject(e.clientX - rect.left, e.clientY - rect.top)
    onPick(r, d)
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 24,
        right: 24,
      }}
    >
      <div
        style={{
          fontSize: 8,
          color: 'rgba(255,255,255,0.35)',
          letterSpacing: 2,
          marginBottom: 4,
          textAlign: 'right',
        }}
      >
        SKY MAP
      </div>
      <div
        onClick={handleClick}
        style={{
          position: 'relative',
          width: W,
          height: H,
          background: 'rgba(0,0,0,0.65)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6,
          overflow: 'hidden',
          // HUD wrapper sets pointer-events: none for click-through; opt in here.
          pointerEvents: 'auto',
          cursor: 'crosshair',
        }}
      >
        {/* Celestial equator */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: 1,
            background: 'rgba(255,255,255,0.08)',
          }}
        />
        {/* Vertical grid (RA = 90°, 180°, 270°) */}
        {[0.25, 0.5, 0.75].map(f => (
          <div
            key={f}
            style={{
              position: 'absolute',
              left: `${f * 100}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: 'rgba(255,255,255,0.05)',
            }}
          />
        ))}
        {/* Known anomaly dots */}
        {KNOWN_ANOMALIES.map(s => {
          const p = project(s.ra, s.dec, DOT)
          return (
            <div
              key={s.id}
              style={{
                position: 'absolute',
                left: p.left,
                top: p.top,
                width: DOT,
                height: DOT,
                borderRadius: '50%',
                background: '#ff4d6d',
                boxShadow: '0 0 4px rgba(255,77,109,0.6)',
              }}
            />
          )
        })}
        {/* Current view indicator */}
        <div
          style={{
            position: 'absolute',
            left: view.left,
            top: view.top,
            width: VIEW,
            height: VIEW,
            borderRadius: '50%',
            background: '#4cc9f0',
            boxShadow: '0 0 8px #4cc9f0',
          }}
        />
      </div>
    </div>
  )
}

/**
 * @description One mission row inside the HUD's anomaly counter card.
 * Shows the mission label + the unique-target count (or "CATALOG
 * UNAVAILABLE" when its fetch failed, or "…" while still loading).
 * The accent color matches the mission's marker color in the 3D sky
 * (red for Kepler, cyan for TESS).
 * @param label All-caps mission tag, e.g. "KEPLER" or "TESS".
 * @param count Unique-target count; 0 means pending or unavailable.
 * @param error Non-null = fetch failed; the row renders the error
 * badge instead of the count.
 * @param accent Hex color used for the count number's text — same as
 * the mission's marker color in StarField for visual coherence.
 */
function MissionCount({
  label,
  count,
  error,
  accent,
}: {
  label: string
  count: number
  error: string | null
  accent: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: 2, minWidth: 56 }}>
        {label}
      </div>
      {error ? (
        <div style={{ fontSize: 10, color: '#f4a261', letterSpacing: 1 }}>
          CATALOG UNAVAILABLE
        </div>
      ) : (
        <div style={{ fontSize: 18, fontWeight: 700, color: accent }}>
          {count > 0 ? count.toLocaleString() : '…'}
        </div>
      )}
    </div>
  )
}

/**
 * @description Counts how many entries in the anomaly catalog the user
 * has opened a light curve for. Intersection of `anomalyStars` and
 * `visitedIds`. Used by the header progress bar — distinct from
 * `visitedIds.size` because the user may have visited stars that
 * aren't in the current anomaly subset (e.g. a Hipparcos star they
 * inspected before the KOI/TOI merge).
 * @param anomalyStars Current anomaly subset (post merge).
 * @param visitedIds Persisted visited set.
 * @returns Count of anomalies the user has visited.
 */
function countVisitedAnomalies(anomalyStars: Star[], visitedIds: Set<string>): number {
  let n = 0
  for (const s of anomalyStars) if (visitedIds.has(s.id)) n++
  return n
}

/**
 * @description Thin progress bar that lives below the header title row,
 * showing how much of the anomaly catalog the user has explored. Bar
 * is full width with a cyan fill segment representing the visited
 * fraction. The numeric label sits to the right of the bar so a
 * glance reads both the relative and absolute progress.
 * @param visited Number of anomalies the user has opened.
 * @param total Total anomaly count.
 * @returns Bar + label row.
 */
function ProgressBar({ visited, total }: { visited: number; total: number }) {
  const pct = total > 0 ? (visited / total) * 100 : 0
  return (
    <div
      style={{
        marginTop: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div
        style={{
          flex: 1,
          height: 3,
          background: 'rgba(255,255,255,0.08)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.min(100, pct)}%`,
            height: '100%',
            background: '#4cc9f0',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)', letterSpacing: 1, whiteSpace: 'nowrap' }}>
        EXPLORED: {visited.toLocaleString()} / {total.toLocaleString()} ({pct.toFixed(1)}%)
      </div>
    </div>
  )
}

/**
 * @description Bottom-right overlay listing every Kepler-field quadrant
 * intersecting the current view, with per-quadrant anomaly /
 * visited / flagged counts. Hidden when FOV is wide (the grid only
 * makes sense once a quadrant fills a meaningful portion of the
 * screen) and when no anomalies have a quadrant tag yet (catalog
 * still loading). Clicking a row flies the camera to that
 * quadrant's center.
 *
 * Visible-quadrant detection: we collect the set of quadrant ids
 * across all anomalies whose unit-vector falls inside the camera
 * cone (`half-FOV × 1.3`, same approximation as `visibleAnomaly
 * Indices` in the parent). Cheap O(N) per render; the per-quadrant
 * counts (`anomalies`, `visited`, `flagged`) are also computed in
 * the same pass.
 * @param fov Current camera FOV in degrees.
 * @param anomalyStars Anomaly subset from the store.
 * @param visitedIds Persisted visited set.
 * @param flaggedIds Persisted flagged set.
 * @param onPick Click-to-fly callback; receives the RA/Dec at the
 * picked quadrant's center.
 */
function QuadrantPanel({
  fov,
  anomalyStars,
  visitedIds,
  flaggedIds,
  onPick,
}: {
  fov: number
  anomalyStars: Star[]
  visitedIds: Set<string>
  flaggedIds: Set<string>
  onPick: (ra: number, dec: number) => void
}) {
  // Recompute per-quadrant counts whenever any input changes. Cheap
  // even at ~10k anomalies because it's one linear pass.
  const visibleQuadrants = useMemo(() => {
    if (fov >= QUADRANT_PANEL_FOV_THRESHOLD) return []
    const stats = new Map<string, { anomalies: number; visited: number; flagged: number }>()
    for (const s of anomalyStars) {
      if (!s.quadrant) continue
      let bucket = stats.get(s.quadrant)
      if (!bucket) {
        bucket = { anomalies: 0, visited: 0, flagged: 0 }
        stats.set(s.quadrant, bucket)
      }
      bucket.anomalies++
      if (visitedIds.has(s.id)) bucket.visited++
      if (flaggedIds.has(s.id)) bucket.flagged++
    }
    // Return in canonical order (A1..F6) — feels more like a grid
    // reading than score-sorted, which would shuffle every visit.
    return ALL_QUADRANT_IDS
      .filter(id => stats.has(id))
      .map(id => ({ id, ...stats.get(id)! }))
  }, [fov, anomalyStars, visitedIds, flaggedIds])

  if (visibleQuadrants.length === 0) return null

  // Sized to fit; parent column places us below the FlaggedPanel
  // and above the minimap. No absolute positioning of our own —
  // the parent owns the stack.
  return (
    <div
      style={{
        width: 220,
        maxHeight: '32vh',
        overflowY: 'auto',
        background: 'rgba(0,0,0,0.7)',
        border: '1px solid rgba(76,201,240,0.25)',
        borderRadius: 6,
        padding: 8,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', letterSpacing: 2, marginBottom: 6, paddingLeft: 4 }}>
        QUADRANTS IN VIEW
      </div>
      {visibleQuadrants.map(q => (
        <button
          key={q.id}
          onClick={() => {
            const c = quadrantCenter(q.id)
            if (c) onPick(c.ra, c.dec)
          }}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            width: '100%',
            background: 'none',
            border: 'none',
            color: 'white',
            fontSize: 9,
            letterSpacing: 1,
            padding: '4px 6px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            textAlign: 'left',
            borderRadius: 4,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(76,201,240,0.1)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
        >
          <span style={{ fontWeight: 700, color: '#4cc9f0', minWidth: 22 }}>{q.id}</span>
          <span style={{ color: 'rgba(255,255,255,0.7)' }}>· {q.anomalies}</span>
          <span style={{ color: 'rgba(255,255,255,0.45)' }}>· {q.visited} visited</span>
          {q.flagged > 0 && <span style={{ color: 'white' }}>· {q.flagged} ★</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * @description Collapsible bottom-right panel listing every flagged
 * star. Collapsed default = a single ★ FLAGGED (N) button; expanded
 * = a scrollable list with name, score, and quadrant. Click a row to
 * fly the camera to that star AND open the AnomalyPanel for it
 * (using the dispatch passed in by the parent).
 *
 * The list is sourced from `anomalyStars` filtered by
 * `flaggedIds.has(id)` so the entries carry full star metadata
 * (score, quadrant). Stars in the persisted flagged set that aren't
 * in the current anomaly catalog (e.g. flagged before a catalog
 * fetch failure) are silently omitted — we don't have the data to
 * render their row.
 * @param flaggedIds Persisted flagged set.
 * @param anomalyStars Anomaly subset from the store.
 * @param onFlyTo Click handler; receives the full star so the
 * parent can both fly the camera and select it.
 */
function FlaggedPanel({
  flaggedIds,
  anomalyStars,
  onFlyTo,
}: {
  flaggedIds: Set<string>
  anomalyStars: Star[]
  onFlyTo: (star: Star) => void
}) {
  const [open, setOpen] = useState(false)

  const flaggedStars = useMemo(() => {
    const out: Star[] = []
    for (const s of anomalyStars) {
      if (flaggedIds.has(s.id)) out.push(s)
    }
    out.sort((a, b) => b.anomalyScore - a.anomalyScore)
    return out
  }, [flaggedIds, anomalyStars])

  // Rendered first inside the parent column container so it sits
  // ABOVE the QuadrantPanel. No absolute positioning — the parent
  // handles bottom/right anchoring and the gap between siblings.
  return (
    <div
      style={{
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
      }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          background: 'rgba(0,0,0,0.7)',
          border: '1px solid rgba(255,255,255,0.25)',
          borderRadius: 6,
          padding: '6px 12px',
          color: 'white',
          fontSize: 9,
          letterSpacing: 2,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        ★ FLAGGED ({flaggedStars.length}){open ? ' ▾' : ' ▸'}
      </button>
      {open && (
        <div
          style={{
            background: 'rgba(0,0,0,0.78)',
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 6,
            padding: 8,
            width: 240,
            maxHeight: '40vh',
            overflowY: 'auto',
          }}
        >
          {flaggedStars.length === 0 ? (
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', letterSpacing: 1, padding: 6, textAlign: 'center' }}>
              NO FLAGGED STARS YET
            </div>
          ) : (
            flaggedStars.map(s => (
              <button
                key={s.id}
                onClick={() => onFlyTo(s)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  color: 'white',
                  fontSize: 9,
                  letterSpacing: 1,
                  padding: '5px 6px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  borderRadius: 4,
                  gap: 6,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {s.name}
                </span>
                <span style={{ color: 'rgba(255,77,109,0.85)', fontWeight: 700 }}>
                  {s.anomalyScore.toFixed(2)}
                </span>
                <span style={{ color: 'rgba(76,201,240,0.7)', minWidth: 22, textAlign: 'right' }}>
                  {s.quadrant ?? '—'}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
