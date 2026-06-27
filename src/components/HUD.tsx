'use client'
import { useEffect, useState } from 'react'
import { useStore } from '@/lib/store'
import { KNOWN_ANOMALIES } from '@/lib/starCatalog'

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
  const { mode, selectedStar, cameraTarget, anomalies, requestFlyTo } = useStore()

  function goToNearestAnomaly() {
    // Angular nearest on the celestial sphere: convert each RA/Dec to a unit
    // direction vector, then pick the anomaly whose direction has the highest
    // dot product with the camera's current pointing vector. Euclidean RA/Dec
    // distance is wrong near the poles and across the RA=0/360 seam.
    const toUnit = (ra: number, dec: number) => {
      const r = (ra * Math.PI) / 180
      const d = (dec * Math.PI) / 180
      return {
        x: Math.cos(d) * Math.cos(r),
        y: Math.sin(d),
        z: Math.cos(d) * Math.sin(r),
      }
    }
    const cam = toUnit(cameraTarget.ra, cameraTarget.dec)
    let best = KNOWN_ANOMALIES[0]
    let bestDot = -Infinity
    for (const s of KNOWN_ANOMALIES) {
      const v = toUnit(s.ra, s.dec)
      const dot = v.x * cam.x + v.y * cam.y + v.z * cam.z
      if (dot > bestDot) { bestDot = dot; best = s }
    }
    if (best) requestFlyTo(best.ra, best.dec)
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
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.8) 0%, transparent 100%)',
        }}
      >
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
        {anomalies.length > 0 && (
          <div
            style={{
              background: 'rgba(0,0,0,0.7)',
              border: '1px solid rgba(255,77,109,0.4)',
              borderRadius: 8,
              padding: '10px 16px',
            }}
          >
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: 2 }}>
              ANOMALIES DETECTED
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#ff4d6d', marginTop: 2 }}>
              {anomalies.length}
            </div>
          </div>
        )}

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
