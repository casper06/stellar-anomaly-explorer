'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * @description In-app interactive tutorial: a slide-based walkthrough of
 * how to read and use the explorer, launched from a HUD header button.
 * Deeper than the first-run <Onboarding /> overlay (which only covers
 * basic controls): this explains what the DATASETS are, what the
 * numbers and badges mean, and how the analysis tools work. Never
 * auto-opens — it is skippable at any point (Esc, backdrop, SKIP) and
 * re-openable forever from the same button.
 */

/** @description One tutorial slide: heading plus rendered body. */
interface Slide {
  title: string
  body: React.ReactNode
}

/** @description Small inline color swatch used in legends. */
function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 4,
        background: color,
        marginRight: 8,
        verticalAlign: 'middle',
      }}
    />
  )
}

/**
 * @description Inline mock of a data-source badge, reusing the real
 * badges' visual language so the slide teaches the exact chips the user
 * will see in the AnomalyPanel.
 * @param label Badge text.
 * @param color Text/border color.
 * @returns Small inline chip.
 */
function BadgeMock({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 8,
        letterSpacing: 1.5,
        padding: '2px 6px',
        borderRadius: 3,
        border: `1px solid ${color}99`,
        background: `${color}22`,
        color,
        fontWeight: 700,
        whiteSpace: 'nowrap',
        marginRight: 6,
      }}
    >
      {label}
    </span>
  )
}

/** @description Shared paragraph style for slide bodies. */
const P: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.7,
  color: 'rgba(255,255,255,0.75)',
  margin: '0 0 12px',
}

/** @description Emphasis span used for key terms inside slide copy. */
function Em({ children, color = '#4cc9f0' }: { children: React.ReactNode; color?: string }) {
  return <span style={{ color, fontWeight: 700 }}>{children}</span>
}

/**
 * @description The tutorial deck. Order goes from "what am I looking
 * at" (the datasets, the numbers) to "how do I use it" (navigation,
 * radar, light curves) to "what do I do with a find" (reporting).
 */
const SLIDES: Slide[] = [
  {
    title: 'TWO VERY DIFFERENT DATASETS',
    body: (
      <>
        <p style={P}>
          The dense red <Em color="#ff4d6d">blob</Em>{' '}is the{' '}
          <Em>Kepler mission&apos;s field of view</Em>{' '}— a fixed patch of
          ~115 square degrees near Cygnus/Lyra that NASA&apos;s Kepler
          space telescope stared at continuously. It never moved: every
          Kepler discovery lives inside that one patch, which is why the
          anomaly markers cluster there so densely.
        </p>
        <p style={P}>
          The scattered background stars are a different dataset
          entirely: the <Em>Hipparcos catalog</Em>{' '}— ESA&apos;s (not
          NASA&apos;s) whole-sky survey of ~118,000 stars. They give you
          the real sky to navigate, but they are not anomaly candidates.
        </p>
        <p style={P}>
          Scattered <Em color="#00e5ff">cyan markers</Em>{' '}across the whole
          sky are TESS targets — NASA&apos;s successor mission, which
          scans the entire sky instead of one patch.
        </p>
      </>
    ),
  },
  {
    title: 'WHAT THE COUNTERS COUNT',
    body: (
      <>
        <p style={P}>
          The bottom-left card — <Em color="#ff4d6d">KEPLER 3,611</Em>{' '}/{' '}
          <Em color="#00e5ff">TESS 5,918</Em>{' '}— counts{' '}
          <Em>unique anomaly-candidate stars</Em>{' '}from NASA&apos;s KOI and
          TOI catalogs (Kepler/TESS Objects of Interest, one count per
          star even when a star hosts several candidates).
        </p>
        <p style={P}>
          It is <Em color="#f4a261">not</Em>{' '}the number of stars on
          screen — the rendered sky holds ~118,000 Hipparcos stars. The
          counters answer &quot;how many stars have a documented candidate
          worth investigating?&quot;, not &quot;how many stars exist here?&quot;.
        </p>
      </>
    ),
  },
  {
    title: 'DATA SOURCE BADGES',
    body: (
      <>
        <p style={P}>
          Every light curve declares where it came from, next to the star
          name:
        </p>
        <p style={{ ...P, lineHeight: 2.2 }}>
          <BadgeMock label="REAL DATA" color="#4ade80" />{' '}actual
          Kepler/TESS photometry fetched live from NASA&apos;s MAST
          archive.
          <br />
          <BadgeMock label="DATA UNAVAILABLE" color="#9ca3af" />{' '}the fetch
          failed or the star was never observed — nothing fake is shown
          in its place.
          <br />
          <BadgeMock label="DEV/SYNTHETIC" color="#f4a261" />{' '}a
          development-only stand-in curve. Loud on purpose so it can
          never be mistaken for real data.
          <br />
          <BadgeMock label="PARTIAL 11/17 QUARTERS" color="#f4a261" />{' '}the
          archive served fewer observation segments than exist.
        </p>
        <p style={P}>
          Partial data gets <Em>flagged rather than hidden</Em>{' '}because an
          incomplete curve can genuinely mislead the analysis — a
          truncated curve can look sparse or irregular when the full one
          is periodic. You should see that data is missing instead of
          trusting an incomplete verdict.
        </p>
      </>
    ),
  },
  {
    title: 'FINDING YOUR WAY',
    body: (
      <>
        <p style={P}>
          <Em>Search</Em>{' '}(header field) finds any catalog star by id or
          name — KIC 8462852, K00931.01, TOI 5523.02, Tabby&apos;s Star.
        </p>
        <p style={P}>
          <Em>Click a star</Em>{' '}to open its analysis panel. In dense
          fields a small popover lists every star under your cursor so
          you can pick the one you meant. Drag rotates the view; scroll
          zooms (it narrows the field of view, telescope-style).
        </p>
        <p style={P}>
          <Em>Quadrants</Em>{' '}(bottom-right, zoomed in): the Kepler field
          is gridded A1–F6 with per-quadrant counts — click to fly there.{' '}
          <Em>Flag</Em>{' '}interesting stars with the ★ in the panel; they
          get a white ring in the sky and live in the FLAGGED list.
          Visited anomalies dim so unexplored ones stand out.
        </p>
      </>
    ),
  },
  {
    title: 'THE SKY RADAR',
    body: (
      <>
        <p style={P}>
          As light curves get analyzed, anomaly markers gain a tint
          showing the measured pattern of their data — a map of what has
          been looked at and what it looked like:
        </p>
        <p style={{ ...P, lineHeight: 2.1 }}>
          <Dot color="#ff2ea6" />
          <Em color="#ff2ea6">IRREGULAR</Em>{' '}— dips that don&apos;t repeat
          cleanly. Worth a closer look.
          <br />
          <Dot color="#4ade80" />
          <Em color="#4ade80">PERIODIC · UNIFORM</Em>{' '}— dips repeat at a
          steady interval with consistent depth.
          <br />
          <Dot color="#facc15" />
          <Em color="#facc15">HIGH VARIABILITY</Em>{' '}— the baseline itself
          is noisy; dips there are hard to trust.
          <br />
          <Dot color="rgba(255,255,255,0.35)" />
          <Em color="rgba(255,255,255,0.7)">no tint</Em>{' '}— not yet
          analyzed, or too little signal to characterize.
        </p>
        <p style={P}>
          These labels describe the <Em>shape of the data</Em>, never its
          cause — the app measures, you interpret.
        </p>
      </>
    ),
  },
  {
    title: 'READING A LIGHT CURVE',
    body: (
      <>
        <p style={P}>
          VIEW LIGHT CURVE opens the fullscreen viewer: the star&apos;s
          brightness over years of observation. Dips are marked and
          scored; the top-left readout lists the measured profile.
        </p>
        <p style={{ ...P, lineHeight: 2 }}>
          <Em>Scroll</Em>{' '}— zoom time around the cursor ·{' '}
          <Em>Shift+scroll</Em>{' '}— zoom flux
          <br />
          <Em>Drag</Em>{' '}— pan · <Em>Click a dip marker</Em>{' '}— pin it and
          zoom to it
          <br />
          <Em>Double-click</Em>{' '}— reset to the full view
        </p>
        <p style={P}>
          Black bands are <Em>observation gaps</Em>{' '}(telescope
          reorientation), not missing files — hover one for details. The
          minimap strip below shows where you are in the full recording.
        </p>
      </>
    ),
  },
  {
    title: 'REPORT WHAT YOU FIND',
    body: (
      <>
        <p style={P}>
          Found something odd? The panel&apos;s report buttons link to
          real <Em>citizen-science platforms</Em>{' '}— Zooniverse, the NASA
          Exoplanet Archive, and the SETI Institute. They open externally;
          reporting is manual for now (the app doesn&apos;t submit
          anything on your behalf).
        </p>
        <p style={P}>
          That&apos;s the whole loop: navigate the real sky, let the
          radar route your attention, inspect real photometry, and hand
          your find to the people who verify these things. The app never
          says &quot;planet&quot; or &quot;false positive&quot; — the
          measurements are yours to interpret and report.
        </p>
      </>
    ),
  },
]

/**
 * @description Header button + slide-deck overlay. The button lives in
 * the HUD header next to the search field; the overlay is a fixed
 * full-screen modal above the HUD. Esc / backdrop / SKIP dismiss it at
 * any slide; ←/→ navigate; state resets to slide 0 on every open so a
 * re-open always starts from the top.
 * @returns The launcher button and, while open, the tutorial overlay.
 */
export default function TutorialLauncher() {
  const [open, setOpen] = useState(false)
  const [slide, setSlide] = useState(0)

  const openTutorial = useCallback(() => {
    setSlide(0)
    setOpen(true)
  }, [])
  const close = useCallback(() => setOpen(false), [])

  // Keyboard: Esc closes, arrows navigate. Bound only while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowRight') setSlide(s => Math.min(SLIDES.length - 1, s + 1))
      else if (e.key === 'ArrowLeft') setSlide(s => Math.max(0, s - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const last = slide === SLIDES.length - 1

  return (
    <>
      <button
        onClick={openTutorial}
        title="How to use this app"
        style={{
          pointerEvents: 'auto',
          background: 'rgba(0,0,0,0.6)',
          border: '1px solid rgba(76,201,240,0.35)',
          borderRadius: 4,
          color: '#4cc9f0',
          fontFamily: 'inherit',
          fontSize: 10,
          letterSpacing: 1.5,
          padding: '7px 12px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        ? TUTORIAL
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Tutorial"
          onClick={close}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 560,
              maxWidth: 'calc(100vw - 48px)',
              maxHeight: 'calc(100vh - 96px)',
              overflowY: 'auto',
              background: 'rgba(5,8,14,0.97)',
              border: '1px solid rgba(76,201,240,0.3)',
              borderRadius: 8,
              padding: '22px 26px 18px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', letterSpacing: 2 }}>
                TUTORIAL · {slide + 1}/{SLIDES.length}
              </div>
              <button
                onClick={close}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255,255,255,0.4)',
                  fontSize: 9,
                  letterSpacing: 1.5,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                SKIP ✕
              </button>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'white', letterSpacing: 2, margin: '8px 0 14px' }}>
              {SLIDES[slide].title}
            </div>
            {SLIDES[slide].body}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
              {/* Progress dots — click to jump. */}
              <div style={{ display: 'flex', gap: 6 }}>
                {SLIDES.map((s, i) => (
                  <button
                    key={s.title}
                    onClick={() => setSlide(i)}
                    aria-label={`Slide ${i + 1}`}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 4,
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      background: i === slide ? '#4cc9f0' : 'rgba(255,255,255,0.18)',
                    }}
                  />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {slide > 0 && (
                  <button
                    onClick={() => setSlide(s => s - 1)}
                    style={{
                      background: 'none',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: 4,
                      color: 'rgba(255,255,255,0.6)',
                      fontFamily: 'inherit',
                      fontSize: 10,
                      letterSpacing: 1.5,
                      padding: '6px 12px',
                      cursor: 'pointer',
                    }}
                  >
                    ◂ BACK
                  </button>
                )}
                <button
                  onClick={() => (last ? close() : setSlide(s => s + 1))}
                  style={{
                    background: 'rgba(76,201,240,0.15)',
                    border: '1px solid rgba(76,201,240,0.5)',
                    borderRadius: 4,
                    color: '#4cc9f0',
                    fontFamily: 'inherit',
                    fontSize: 10,
                    letterSpacing: 1.5,
                    padding: '6px 14px',
                    cursor: 'pointer',
                    fontWeight: 700,
                  }}
                >
                  {last ? 'GOT IT ✓' : 'NEXT ▸'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
