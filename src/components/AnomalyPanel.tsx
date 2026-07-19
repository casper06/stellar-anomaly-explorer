'use client'
import { useEffect, useRef, useState } from 'react'
import { useStore, type Anomaly, type LightcurveProvenance } from '@/lib/store'
import type { CurveProfile, CurvePattern, DipShape } from '@/lib/curveClassifier'
import { BLS_SDE_THRESHOLD, type BlsResult } from '@/lib/bls'
import type { CentroidStamp, CentroidVetResult } from '@/lib/centroidVet'
import { fetchCentroidVet, type CentroidVetPayload, type CentroidVetFailure } from '@/lib/centroidClient'
import { constellationAt, describeVisibilityStory } from '@/lib/constellations'
import { selectDisplayNames, type SimbadIdentity } from '@/lib/simbadIds'
import LightCurve from './LightCurve'

/**
 * @description Glossary of plain-English explanations for technical astronomy
 * terms shown in the panel. Hovering the (?) badge next to a term reveals the
 * matching entry. Kept in one map so it stays trivial to add/edit terms.
 */
const GLOSSARY: Record<string, string> = {
  MAG: 'Magnitude: how bright the star appears from Earth. Lower number = brighter.',
  RA: 'Right Ascension: the celestial equivalent of longitude, measured in degrees.',
  DEC: 'Declination: the celestial equivalent of latitude, measured in degrees.',
  COLOR: 'Spectral type: derived from the B-V color index. Blue = hot and young, red = cool or giant.',
  DIP: 'Brightness dip: a moment when the star dimmed unexpectedly.',
  SCORE: 'How rare the event is. WOW = extremely anomalous, with no known explanation.',
  DEPTH: 'Dip depth: percentage of light lost relative to normal brightness.',
  DURATION: 'Dip duration in days.',
  BKJD: 'Barycentric Kepler Julian Date: time system used by the Kepler telescope.',
  TJD: 'TESS Julian Date: time system used by the TESS telescope (BJD − 2457000).',
  SKY: 'The IAU constellation this position falls in — where the star sits in the real night sky. Below it: which Earth latitudes can ever see it, and the month it is highest around midnight.',
  NASA_SCORE: "NASA's own catalog vetting score for this candidate, independent from the local detector and BLS results shown below. A low score here alongside high local activity (many dips, high variability, or a confident BLS signal) is expected, not contradictory — they are two separate instruments looking at the same star.",
  TOI_SCALE: "This is a TESS (TOI) candidate, and the TOI score scale tops out around 50 rather than 100 — it lacks the extra NASA-vetting term that Kepler (KOI) scores carry. So a value like 41 sits near the top of TOI's range, not artificially low next to a KOI score.",
}

/**
 * @description Color used to fill the central glow of the SVG star visualization, based on
 * the B-V color index. Mirrors the palette used in StarField but tuned for the
 * larger sphere where saturation reads stronger.
 * @param bv B-V color index (negative = hot, positive = cool).
 * @returns Core (inner) and halo (outer) hex colors for the radial gradient.
 */
function bvToVisualColor(bv: number): { core: string; halo: string } {
  if (bv < 0) return { core: '#cfe2ff', halo: '#5b8def' }
  if (bv < 0.3) return { core: '#f0f6ff', halo: '#9ab8e8' }
  if (bv < 0.6) return { core: '#fffaf0', halo: '#f5d97c' }
  if (bv < 1.0) return { core: '#ffe5a8', halo: '#f4a261' }
  return { core: '#ffd0c2', halo: '#e76f51' }
}

const LABEL_COLOR: Record<string, string> = {
  WOW: '#ff4d6d',
  INTERESTING: '#f4a261',
  NOTABLE: '#4cc9f0',
  NORMAL: 'rgba(255,255,255,0.3)',
}

/**
 * @description Donut-style SVG ring that fills clockwise in proportion to an anomaly
 * score (0–1). Stroke color shifts at WOW/INTERESTING/NOTABLE thresholds
 * to give the user an at-a-glance read on severity.
 * @param score Anomaly score in [0, 1].
 * @returns SVG element ~70×70 px.
 */
function ScoreRing({ score }: { score: number }) {
  const r = 28
  const circ = 2 * Math.PI * r
  const dash = circ * score
  const color =
    score >= 0.60 ? '#ff4d6d'
    : score >= 0.40 ? '#f4a261'
    : score >= 0.20 ? '#4cc9f0'
    : 'rgba(255,255,255,0.3)'

  return (
    <svg width={70} height={70} viewBox="0 0 70 70">
      <circle cx={35} cy={35} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={4} />
      <circle
        cx={35}
        cy={35}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={4}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 35 35)"
        style={{ transition: 'stroke-dasharray 0.8s ease' }}
      />
      <text x={35} y={35} textAnchor="middle" dominantBaseline="central" fill={color} fontSize={12} fontWeight={700} fontFamily="JetBrains Mono, monospace">
        {Math.round(score * 100)}
      </text>
      <text x={35} y={47} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize={7} fontFamily="JetBrains Mono, monospace">
        SCORE
      </text>
    </svg>
  )
}

/**
 * @description SVG representation of how the selected star would look up close: a radial
 * gradient sphere colored by B-V, an outer corona, and (for known anomalies)
 * a pulsing red ring drawn via a CSS @keyframes animation injected once below.
 * @param colorIndex B-V color index; selects the gradient palette.
 * @param isAnomaly If true, adds the pulsing dashed red ring.
 * @returns 140×140 SVG suitable for the panel header.
 */
function StarVisualization({
  colorIndex,
  isAnomaly,
}: {
  colorIndex: number
  isAnomaly: boolean
}) {
  const { core, halo } = bvToVisualColor(colorIndex)
  const gid = `star-grad-${Math.round(colorIndex * 1000)}`
  const cid = `star-corona-${Math.round(colorIndex * 1000)}`

  return (
    <div style={{ position: 'relative', width: 140, height: 140, margin: '0 auto' }}>
      <svg width={140} height={140} viewBox="0 0 140 140">
        <defs>
          <radialGradient id={gid} cx="40%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.95} />
            <stop offset="35%" stopColor={core} stopOpacity={1} />
            <stop offset="100%" stopColor={halo} stopOpacity={1} />
          </radialGradient>
          <radialGradient id={cid} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={halo} stopOpacity={0.45} />
            <stop offset="60%" stopColor={halo} stopOpacity={0.12} />
            <stop offset="100%" stopColor={halo} stopOpacity={0} />
          </radialGradient>
        </defs>

        {/* Corona */}
        <circle cx={70} cy={70} r={66} fill={`url(#${cid})`} />
        {/* Star body */}
        <circle cx={70} cy={70} r={36} fill={`url(#${gid})`} />

        {/* Anomaly ring */}
        {isAnomaly && (
          <circle
            cx={70}
            cy={70}
            r={52}
            fill="none"
            stroke="#ff4d6d"
            strokeWidth={1.5}
            strokeDasharray="3 5"
            style={{
              transformOrigin: 'center',
              animation: 'anomaly-ring-pulse 2.4s ease-in-out infinite',
            }}
          />
        )}
      </svg>
      <style jsx>{`
        @keyframes anomaly-ring-pulse {
          0%, 100% { opacity: 0.35; transform: scale(1); }
          50%      { opacity: 0.9;  transform: scale(1.08); }
        }
      `}</style>
    </div>
  )
}

/**
 * @description Small "?" badge next to a label. On hover/focus, shows a tooltip with the
 * matching glossary entry. Falls back silently if the term isn't in GLOSSARY.
 * @param term Key into GLOSSARY (e.g. "MAG", "RA").
 * @returns Inline badge, or null if the term has no glossary entry.
 */
function InfoBadge({ term }: { term: string }) {
  const [open, setOpen] = useState(false)
  const text = GLOSSARY[term]
  if (!text) return null

  return (
    <span
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 12,
        height: 12,
        marginLeft: 4,
        borderRadius: '50%',
        border: '1px solid rgba(255,255,255,0.25)',
        color: 'rgba(255,255,255,0.5)',
        fontSize: 8,
        cursor: 'help',
        userSelect: 'none',
        outline: 'none',
      }}
    >
      ?
      {open && (
        <span
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.95)',
            border: '1px solid rgba(76,201,240,0.4)',
            borderRadius: 4,
            padding: '6px 10px',
            fontSize: 9,
            lineHeight: 1.5,
            color: 'rgba(255,255,255,0.85)',
            width: 200,
            textAlign: 'left',
            letterSpacing: 0.3,
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          {text}
        </span>
      )}
    </span>
  )
}

/**
 * @description Pill-shaped provenance badge that tells the user where the
 * light curve came from. Four states:
 * - `'real'`     → green "REAL DATA" (Kepler PDC from MAST)
 * - `'unavailable'` → grey "DATA UNAVAILABLE" (real fetch failed, no fake substitute)
 * - `'synthetic'` → orange "DEV/SYNTHETIC" (dev-only stand-in, never in prod)
 * - undefined    → faint "LOADING" while the fetch is in flight
 * @param source Provenance string from the lightcurve API, or undefined while loading.
 * @returns Small inline badge styled to match the panel chrome.
 */
function DataSourceBadge({ source }: { source?: 'real' | 'unavailable' | 'synthetic' }) {
  const config =
    source === 'real'
      ? { label: 'REAL DATA', color: '#4ade80', bg: 'rgba(74,222,128,0.12)', border: 'rgba(74,222,128,0.5)' }
      : source === 'unavailable'
        ? { label: 'DATA UNAVAILABLE', color: 'rgba(255,255,255,0.55)', bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.25)' }
        : source === 'synthetic'
          ? { label: 'DEV/SYNTHETIC', color: '#f4a261', bg: 'rgba(244,162,97,0.12)', border: 'rgba(244,162,97,0.5)' }
          : { label: 'LOADING', color: 'rgba(255,255,255,0.4)', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.12)' }

  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 8,
        letterSpacing: 1.5,
        padding: '2px 6px',
        borderRadius: 3,
        background: config.bg,
        border: `1px solid ${config.border}`,
        color: config.color,
        fontWeight: 700,
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
      }}
    >
      {config.label}
    </span>
  )
}

/**
 * @description Amber "PARTIAL N/M QUARTERS" badge shown next to the
 * REAL DATA badge when MAST served fewer segments than its listing said
 * exist. This is the loud partial-data signal — a truncated curve can
 * make the classifier report SPARSE/UNCERTAIN where the full curve would
 * be periodic (the K00931.01 case), so the user must see that data is
 * missing rather than trust an incomplete verdict. Renders nothing when
 * the curve is complete.
 * @param partial Whether the served curve is incomplete.
 * @param segments `{ recovered, expected }` segment coverage, when known.
 * @param mission Serving mission (labels the segment unit — quarters vs sectors).
 * @returns Inline amber badge, or null when not partial.
 */
function PartialDataBadge({
  partial,
  segments,
  mission,
}: {
  partial?: boolean
  segments?: { recovered: number; expected: number }
  mission?: 'Kepler' | 'TESS' | null
}) {
  if (!partial || !segments) return null
  const unit = mission === 'TESS' ? 'SECTORS' : 'QUARTERS'
  return (
    <span
      title={`MAST served ${segments.recovered} of ${segments.expected} available ${unit.toLowerCase()}; the curve and any classification below may be incomplete.`}
      style={{
        display: 'inline-block',
        fontSize: 8,
        letterSpacing: 1.5,
        padding: '2px 6px',
        borderRadius: 3,
        background: 'rgba(244,162,97,0.14)',
        border: '1px solid rgba(244,162,97,0.6)',
        color: '#f4a261',
        fontWeight: 700,
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
      }}
    >
      {`PARTIAL ${segments.recovered}/${segments.expected} ${unit}`}
    </span>
  )
}

/**
 * @description Human-readable spectral classification label for a B-V color index, shown
 * in the panel's COLOR row.
 * @param bv B-V color index.
 * @returns English descriptor with spectral class hint.
 */
function bvToColorName(bv: number): string {
  if (bv < 0) return 'Bright blue (O/B)'
  if (bv < 0.3) return 'Blue-white (A/F)'
  if (bv < 0.6) return 'Yellow-white (F/G)'
  if (bv < 1.0) return 'Yellow/Orange (G/K)'
  return 'Red (M / Giant)'
}

/**
 * @description Maps a 0–1 anomaly score to one of the four LABEL_COLOR keys,
 * matching the same WOW / INTERESTING / NOTABLE / NORMAL thresholds the dip
 * detector uses. Lets us render the catalog-recorded score in the panel
 * with the same color language as live-detected dips.
 * @param score Anomaly score in [0, 1].
 * @returns Severity label string suitable for indexing LABEL_COLOR.
 */
function catalogLabelFor(score: number): 'WOW' | 'INTERESTING' | 'NOTABLE' | 'NORMAL' {
  if (score >= 0.60) return 'WOW'
  if (score >= 0.40) return 'INTERESTING'
  if (score >= 0.20) return 'NOTABLE'
  return 'NORMAL'
}

/**
 * @description Returns the best Zooniverse destination for a given star id.
 * Tabby's Star (KIC8462852) gets a dedicated variable-star project; everything
 * else falls back to the generic "stars" tag listing.
 * @param starId Catalog id, e.g. "KIC8462852".
 * @returns Absolute Zooniverse URL.
 */
function zooniverseLinkFor(starId: string): string {
  if (starId === 'KIC8462852') {
    return 'https://www.zooniverse.org/projects/zookeeper/variable-star-zoo'
  }
  return 'https://www.zooniverse.org/projects?tag=stars'
}

/**
 * @description Full-viewport modal that displays the selected star's light
 * curve at a much larger size than the side panel allows. Fades in over
 * 0.2s, closes on Escape or by clicking the dark backdrop outside the
 * content card. The chart canvas is sized to ~70% of viewport height.
 *
 * `LABEL_COLOR` (declared above) is reused for the legend swatches so the
 * fullscreen chart matches the side panel's color language.
 * @param starName Star to show in the top bar.
 * @param source Provenance state — drives the badge next to the name.
 * @param times BKJD timestamps from the lightcurve payload.
 * @param flux Normalized flux values, paired 1:1 with `times`.
 * @param dips Detected dips with labels/scores used to render markers and the legend.
 * @param onClose Called when the user dismisses the overlay.
 * @returns A fixed-position fullscreen overlay.
 */
function LightCurveFullscreen({
  starId,
  starName,
  source,
  times,
  flux,
  dips,
  provenance,
  profile,
  gapDays,
  timeUnit,
  partial,
  segments,
  mission,
  onClose,
}: {
  starId: string
  starName: string
  source: 'real' | 'unavailable' | 'synthetic'
  times: number[]
  flux: number[]
  dips: Anomaly[]
  provenance?: LightcurveProvenance
  profile: CurveProfile | null
  gapDays?: number
  timeUnit?: string
  partial?: boolean
  segments?: { recovered: number; expected: number }
  mission?: 'Kepler' | 'TESS' | null
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Lock body scroll while the overlay is open so wheel-zoom on the chart
  // doesn't accidentally scroll the page underneath. The chart's own
  // non-passive wheel listener calls preventDefault, but a stray scroll
  // outside the canvas (e.g. on the legend) would still bubble up; this
  // is the belt-and-suspenders fix. We preserve and restore whatever
  // `body.style.overflow` was before mount so nested overlays compose.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Chart pixel buffer for rasterization. CSS sizing fills the flex
  // container; this number only controls how crisp the line looks when
  // stretched. 1600 is a reasonable middle ground for 1080p–4k.
  const canvasW = 1600
  const canvasH = 720

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.92)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
        animation: 'lc-fs-fade 0.2s ease',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      {/* Inner content card — fills the viewport as a flex column. Click
          here is stopped so chart interactions don't dismiss the overlay;
          backdrop clicks (outside this card) still close. */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(1600px, 96vw)',
          height: '100%',
          margin: '0 auto',
          padding: '20px 0 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: 0,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Classifier readout — floats top-left over the chart corner as a
            column: the readout card, then (when eligible) the opt-in
            pixel-level vetting panel below it. The column ignores pointer
            events so chart interactions pass through; the vetting panel
            re-enables them on itself (it has a button). Contains only
            measured features; no causal interpretation. */}
        {profile && (
          <div
            style={{
              position: 'absolute',
              top: 72,
              left: 16,
              zIndex: 5,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              pointerEvents: 'none',
            }}
          >
            <ClassifierReadout profile={profile} partial={partial} segments={segments} mission={mission} />
            {/* Pixel-level vetting needs real data from a mission whose
                TPFs we can fetch (Kepler KIC / TESS TIC — the id must
                match the mission that served the curve) and a confident
                BLS ephemeris to define the in/out-of-transit windows —
                same gate as the odd/even and phase-0.5 lines. Keyed by
                star so state never leaks across selections. */}
            {source === 'real' &&
              ((mission === 'Kepler' && /^KIC\d+$/.test(starId)) ||
                (mission === 'TESS' && /^TIC\d+$/.test(starId))) &&
              profile.bls &&
              profile.bls.sde >= BLS_SDE_THRESHOLD && (
                <PixelVettingPanel key={starId} starId={starId} mission={mission} bls={profile.bls} />
              )}
          </div>
        )}
        {/* Top bar — fixed-height header */}
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingBottom: 12,
            borderBottom: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'white', letterSpacing: 1 }}>
              {starName}
            </div>
            <DataSourceBadge source={source} />
            <PartialDataBadge partial={partial} segments={segments} mission={mission} />
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: 2 }}>
              LIGHT CURVE
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close light curve"
            style={{
              background: 'none',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 4,
              width: 32,
              height: 32,
              color: 'rgba(255,255,255,0.7)',
              fontSize: 16,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Chart — flexes to fill remaining vertical space. The chart
            component itself uses `fillContainer` so its main canvas is
            flex:1 and the minimap+hint stay anchored to the bottom. */}
        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: 8,
            padding: 12,
            overflow: 'hidden',
          }}
        >
          <LightCurve
            times={times}
            flux={flux}
            dips={dips}
            width={canvasW}
            height={canvasH}
            interactive
            fillContainer
            provenance={provenance}
            gapDays={gapDays}
            timeUnit={timeUnit}
          />
        </div>

        {/* Legend — fixed-height footer, never clipped */}
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            gap: 24,
            justifyContent: 'center',
          }}
        >
          {(['WOW', 'INTERESTING', 'NOTABLE', 'NORMAL'] as const).map(label => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: LABEL_COLOR[label],
                  boxShadow: label === 'WOW' ? `0 0 8px ${LABEL_COLOR[label]}` : undefined,
                }}
              />
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', letterSpacing: 2 }}>
                {label}
              </span>
            </div>
          ))}
        </div>
        <div
          style={{
            flex: '0 0 auto',
            fontSize: 9,
            color: 'rgba(255,255,255,0.35)',
            textAlign: 'center',
            letterSpacing: 1,
          }}
        >
          Click outside or press Esc to close
        </div>
      </div>

      <style jsx>{`
        @keyframes lc-fs-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
    </div>
  )
}

/**
 * @description Human-readable copy for each `CurvePattern`. STRICTLY
 * DESCRIPTIVE — does not assert a physical cause. The IRREGULAR
 * note is framed as a prompt for the user ("worth a closer look"),
 * not a conclusion. Editing any of these strings: keep the same
 * tone — measure, don't interpret.
 */
const PATTERN_COPY: Record<CurvePattern, { label: string; note: string; color: string }> = {
  PERIODIC_UNIFORM: {
    label: 'PERIODIC · UNIFORM',
    note: 'Dips repeat at a steady interval with consistent depth.',
    color: '#4cc9f0',
  },
  IRREGULAR: {
    label: 'IRREGULAR',
    note: 'Does not match a simple repeating pattern — worth a closer look.',
    color: '#ff4d6d',
  },
  HIGH_VARIABILITY: {
    label: 'HIGH VARIABILITY',
    note: 'Baseline noise is large; any dips here are hard to trust.',
    color: '#f4a261',
  },
  SPARSE: {
    label: 'SPARSE',
    note: 'Too few dips detected to characterize a pattern.',
    color: 'rgba(255,255,255,0.4)',
  },
  UNCERTAIN: {
    label: 'UNCERTAIN',
    note: 'Pattern detected may be sampling noise rather than a real signal — period is below plausible transit timescales.',
    color: '#f4a261',
  },
}

/** @description Display text for each `DipShape` value. */
const SHAPE_COPY: Record<DipShape, string> = {
  U: 'U-shaped (flat bottom)',
  V: 'V-shaped (sharp point)',
  MIXED: 'mixed',
  UNKNOWN: '—',
}

/**
 * @description Floating top-left readout inside the fullscreen overlay
 * that surfaces the descriptive `CurveProfile` measurements. Every
 * field is a measurement the user can verify against the chart —
 * the panel never says what the data MEANS, only what it IS. The
 * pattern note is intentionally framed as a prompt ("worth a closer
 * look") for the IRREGULAR case so the user owns the interpretation.
 * @param profile Measurements from `classifyCurve`.
 * @returns Absolutely-positioned panel; renders nothing if profile is null.
 */
function ClassifierReadout({
  profile,
  partial,
  segments,
  mission,
}: {
  profile: CurveProfile
  partial?: boolean
  segments?: { recovered: number; expected: number }
  mission?: 'Kepler' | 'TESS' | null
}) {
  const copy = PATTERN_COPY[profile.pattern]
  const unit = mission === 'TESS' ? 'sectors' : 'quarters'
  // Positioning lives on the wrapper column in LightCurveFullscreen (the
  // readout stacks above the opt-in pixel-vetting panel); this card only
  // styles itself.
  return (
    <div
      style={{
        background: 'rgba(0,0,0,0.78)',
        border: `1px solid ${copy.color}55`,
        borderRadius: 6,
        padding: '10px 14px',
        minWidth: 220,
        maxWidth: 320,
        pointerEvents: 'none',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', letterSpacing: 2, marginBottom: 4 }}>
        MEASURED PROFILE
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: copy.color, letterSpacing: 1, marginBottom: 8 }}>
        {copy.label}
      </div>
      {/* Partial-data caveat — makes a label like SPARSE/UNCERTAIN read as
          provisional when the curve is missing quarters. Directly addresses
          the K00931.01 case: a truncated fetch produced a misleading label
          with no signal that data was incomplete. */}
      {partial && segments && (
        <div
          style={{
            marginBottom: 8,
            padding: '5px 7px',
            borderRadius: 4,
            background: 'rgba(244,162,97,0.12)',
            border: '1px solid rgba(244,162,97,0.5)',
            fontSize: 9,
            color: '#f4a261',
            letterSpacing: 0.3,
            lineHeight: 1.4,
          }}
        >
          ⚠ PARTIAL DATA — {segments.recovered}/{segments.expected} {unit}. This
          profile is measured from an incomplete curve and may change once all
          {` ${unit}`} are available.
        </div>
      )}
      <ReadoutRow label="Periodicity" value={`${Math.round(profile.periodicity * 100)}%`} />
      <ReadoutRow label="Depth consistency" value={`${Math.round(profile.depthConsistency * 100)}%`} />
      <ReadoutRow label="Dominant shape" value={SHAPE_COPY[profile.dipShape]} />
      <ReadoutRow label="Baseline RMS" value={`${(profile.baselineRMS * 100).toFixed(2)}%`} />
      {profile.bestFitPeriodDays !== null && (
        <ReadoutRow
          label="Best-fit period"
          value={`${profile.bestFitPeriodDays.toFixed(profile.bestFitPeriodDays >= 10 ? 1 : 3)} d`}
        />
      )}
      <ReadoutRow label="Dips counted" value={profile.dipCount.toLocaleString()} />
      {/* Independent statistical detection line — shown whenever the BLS
          search found a confident periodic box signal, REGARDLESS of the
          pattern label. A SPARSE star with a confident BLS line is the
          NASA-score-vs-local-detector desync case made self-explanatory:
          the signal is real but far shallower than the 1% visible-dip
          threshold. Descriptive only — reports the detection, never a
          cause. */}
      {profile.bls && profile.bls.sde >= BLS_SDE_THRESHOLD && (
        <div
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            fontSize: 9,
            color: '#9d8cff',
            letterSpacing: 0.5,
            lineHeight: 1.4,
          }}
        >
          Statistical periodic signal detected (BLS): P=
          {profile.bls.periodDays.toFixed(profile.bls.periodDays >= 10 ? 2 : 3)}d,
          depth≈{Math.round(profile.bls.depthPpm).toLocaleString()}ppm,
          SDE {profile.bls.sde.toFixed(1)}
        </div>
      )}
      {/* Odd/even transit depth comparison — the standard first-order
          vetting measurement on a confident periodic signal. Reported as
          measured numbers only (describe-don't-diagnose: no "binary", no
          "planet" — the user interprets what a depth mismatch means). */}
      {profile.oddEven && (
        <div
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            fontSize: 9,
            color: profile.oddEven.verdict === 'MISMATCH' ? '#f4a261' : 'rgba(255,255,255,0.6)',
            letterSpacing: 0.5,
            lineHeight: 1.4,
          }}
        >
          {profile.oddEven.verdict === 'MISMATCH'
            ? `Odd/even transit depths differ: odd ≈ ${Math.round(profile.oddEven.oddDepthPpm).toLocaleString()}ppm vs even ≈ ${Math.round(profile.oddEven.evenDepthPpm).toLocaleString()}ppm (Δ ${profile.oddEven.relDiffPct.toFixed(1)}%, ${profile.oddEven.diffSigma.toFixed(1)}σ, ${profile.oddEven.oddCycles} odd / ${profile.oddEven.evenCycles} even)`
            : `Odd/even transit depths consistent: Δ ${profile.oddEven.relDiffPct.toFixed(1)}% (${profile.oddEven.diffSigma.toFixed(1)}σ, ${profile.oddEven.oddCycles} odd / ${profile.oddEven.evenCycles} even)`}
        </div>
      )}
      {/* Phase-0.5 dimming (secondary eclipse position) — companion vetting
          measurement to odd/even. Descriptive only: reports the measured
          depth, significance, and ratio to the primary; never says what a
          detection (or its absence) means. A shallow detection with a tiny
          ratio is a real phenomenon on some confirmed planets (occultation),
          which is exactly why no cause is asserted. */}
      {profile.secondary && (
        <div
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            fontSize: 9,
            color: profile.secondary.verdict === 'DETECTED' ? '#f4a261' : 'rgba(255,255,255,0.6)',
            letterSpacing: 0.5,
            lineHeight: 1.4,
          }}
        >
          {profile.secondary.verdict === 'DETECTED'
            ? `Secondary dimming detected at phase 0.5: ≈ ${Math.round(profile.secondary.depthPpm).toLocaleString()}ppm (${profile.secondary.sigma.toFixed(1)}σ${profile.secondary.ratioToPrimaryPct !== null ? `, ~${profile.secondary.ratioToPrimaryPct.toFixed(1)}% of primary depth` : ''}, ${profile.secondary.cycles} cycles)`
            : `No significant dimming at phase 0.5 (${Math.round(profile.secondary.depthPpm).toLocaleString()}ppm, ${profile.secondary.sigma.toFixed(1)}σ, ${profile.secondary.cycles} cycles)`}
        </div>
      )}
      <div
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid rgba(255,255,255,0.08)',
          fontSize: 9,
          color: 'rgba(255,255,255,0.6)',
          letterSpacing: 0.5,
          lineHeight: 1.4,
        }}
      >
        {copy.note}
      </div>
    </div>
  )
}

/**
 * @description One label/value row inside `ClassifierReadout`. Label
 * uses the dim secondary color; value is white. Pulled out so the
 * row spacing stays consistent across the variable-length list
 * (period row only renders when present).
 * @param label Field label (left side).
 * @param value Measured value (right side).
 */
function ReadoutRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 12,
        fontSize: 10,
        letterSpacing: 0.5,
        padding: '2px 0',
      }}
    >
      <span style={{ color: 'rgba(255,255,255,0.5)' }}>{label}</span>
      <span style={{ color: 'white', fontFamily: 'inherit' }}>{value}</span>
    </div>
  )
}

/**
 * @description Narration steps for the pixel-vetting fetch (time-driven —
 * the route has no SSE; mirrors what it actually does: TAP discovery,
 * bounded TPF downloads, stacking, centroid). Cold path runs ~10–30 s.
 */
const VETTING_STEPS = [
  'Querying MAST for Target Pixel Files…',
  'Downloading pixel stamps (~15 MB across 6 quarters)…',
  'Stacking in-transit vs out-of-transit images…',
  'Measuring difference-image centroid…',
]
const VETTING_STEP_MS = 4000

/**
 * @description Renders one nx×ny pixel stamp on a canvas: a log-stretched
 * grayscale for the mean out-of-transit image, or a red-scaled positive
 * map for the difference image. Overlays: the optimal-aperture outline
 * (out image only), an × at the star's photocenter, and — on the
 * difference image — a ○ at the difference centroid plus a connecting
 * line so the measured offset is visible as geometry, not just a number.
 * Displayed with y flipped (stamp row 0 at the bottom) to match sky/CCD
 * orientation conventions.
 * @param stamp Stamp payload from the vetting result (JSON round-trip
 * turns non-finite pixels into null).
 * @param kind Which image to draw ('out' | 'diff').
 * @param title Small caption under the canvas.
 * @returns Canvas + caption column.
 */
function StampCanvas({
  stamp,
  kind,
  title,
}: {
  stamp: CentroidStamp
  kind: 'out' | 'diff'
  title: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cell = 18
  const w = stamp.nx * cell
  const h = stamp.ny * cell

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = kind === 'out' ? stamp.meanOut : stamp.diff
    // JSON serialization maps NaN → null; normalize to finite-or-null.
    const finite = img.map(v => (v !== null && Number.isFinite(v) ? v : null))
    const positives = finite.filter((v): v is number => v !== null && v > 0)
    const maxV = positives.length > 0 ? Math.max(...positives) : 1

    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    for (let p = 0; p < finite.length; p++) {
      const x = p % stamp.nx
      const y = Math.floor(p / stamp.nx)
      const cx = x * cell
      const cy = (stamp.ny - 1 - y) * cell // flip: stamp row 0 at bottom
      const v = finite[p]
      if (v === null) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)' // uncollected pixel
      } else if (v <= 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)'
      } else {
        const t = Math.log1p(v) / Math.log1p(maxV) // log stretch
        ctx.fillStyle =
          kind === 'out'
            ? `rgba(${Math.round(120 + 135 * t)}, ${Math.round(130 + 125 * t)}, ${Math.round(150 + 105 * t)}, ${0.15 + 0.85 * t})`
            : `rgba(${Math.round(180 + 75 * t)}, ${Math.round(60 + 60 * t)}, ${Math.round(60 + 30 * t)}, ${0.15 + 0.85 * t})`
      }
      ctx.fillRect(cx, cy, cell - 1, cell - 1)
    }

    // Optimal-aperture outline (out image only) — the photometer's pixels.
    if (kind === 'out' && stamp.apertureMask) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth = 1
      for (let p = 0; p < stamp.apertureMask.length; p++) {
        if (!(stamp.apertureMask[p] & 2)) continue
        const x = p % stamp.nx
        const y = Math.floor(p / stamp.nx)
        ctx.strokeRect(x * cell + 0.5, (stamp.ny - 1 - y) * cell + 0.5, cell - 2, cell - 2)
      }
    }

    /**
     * Converts stamp pixel coordinates (pixel centers) to canvas position
     * under the vertical flip used above.
     */
    const toCanvas = ([px, py]: [number, number]): [number, number] => [
      (px + 0.5) * cell,
      (stamp.ny - 1 - py + 0.5) * cell,
    ]
    // The offset's reference point: the target's catalog position (WCS)
    // when available, else the photocenter (legacy fallback path).
    const reference = stamp.catalogPosition ?? stamp.photocenter
    const [phx, phy] = toCanvas(reference)

    if (kind === 'diff') {
      const [dx, dy] = toCanvas(stamp.diffCentroid)
      // Offset line: catalog position → difference centroid.
      ctx.strokeStyle = 'rgba(76,201,240,0.9)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(phx, phy)
      ctx.lineTo(dx, dy)
      ctx.stroke()
      // ○ = where the transit signal comes from.
      ctx.beginPath()
      ctx.arc(dx, dy, 5, 0, Math.PI * 2)
      ctx.stroke()
    }

    // × = the reference point (both stamps).
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(phx - 4, phy - 4)
    ctx.lineTo(phx + 4, phy + 4)
    ctx.moveTo(phx + 4, phy - 4)
    ctx.lineTo(phx - 4, phy + 4)
    ctx.stroke()
  }, [stamp, kind, w, h, cell])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
      <canvas ref={canvasRef} width={w} height={h} style={{ borderRadius: 3 }} />
      <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.45)', letterSpacing: 1, textAlign: 'center' }}>
        {title}
      </div>
    </div>
  )
}

/**
 * @description Opt-in pixel-level vetting panel shown below the classifier
 * readout in the fullscreen overlay (Kepler targets with a confident BLS
 * signal only). Nothing is fetched until the user clicks the button —
 * TPF quarters are ~15 MB per run, so this is strictly on-demand, never
 * automatic (and never part of the batch).
 *
 * Result copy follows the describe-don't-diagnose rule: the panel reports
 * the measured offset, its significance, and the documented sensitivity
 * floor; it never asserts "blend"/"false positive"/"planet". The
 * saturation refusal is likewise phrased as a property of the data.
 * @param starId Selected star's catalog id (KIC…).
 * @param bls Confident BLS detection supplying the ephemeris.
 * @returns Bordered card with the button / progress / measurement.
 */
function PixelVettingPanel({
  starId,
  mission,
  bls,
}: {
  starId: string
  mission: 'Kepler' | 'TESS'
  bls: BlsResult
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [payload, setPayload] = useState<CentroidVetPayload | CentroidVetFailure | null>(null)
  const [stepIdx, setStepIdx] = useState(0)

  useEffect(() => {
    if (state !== 'loading') return
    const id = setInterval(() => {
      setStepIdx(i => Math.min(i + 1, VETTING_STEPS.length - 1))
    }, VETTING_STEP_MS)
    return () => clearInterval(id)
  }, [state])

  /** Kicks off the on-demand measurement (single flight per mount). */
  const run = async () => {
    setState('loading')
    setStepIdx(0)
    const res = await fetchCentroidVet(starId, bls)
    setPayload(res)
    setState('done')
  }

  const result: CentroidVetResult | null =
    payload && payload.status === 'ok' ? payload.result : null

  return (
    <div
      style={{
        background: 'rgba(0,0,0,0.78)',
        border: '1px solid rgba(76,201,240,0.35)',
        borderRadius: 6,
        padding: '10px 14px',
        maxWidth: 320,
        pointerEvents: 'auto',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', letterSpacing: 2, marginBottom: 6 }}>
        PIXEL-LEVEL VETTING · {mission.toUpperCase()} TPF
      </div>

      {state === 'idle' && (
        <>
          <button
            onClick={run}
            style={{
              width: '100%',
              background: 'rgba(76,201,240,0.12)',
              border: '1px solid rgba(76,201,240,0.5)',
              borderRadius: 4,
              padding: '7px 10px',
              color: '#4cc9f0',
              fontSize: 10,
              letterSpacing: 1.5,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            RUN PIXEL-LEVEL VETTING
          </button>
          <div style={{ marginTop: 6, fontSize: 8.5, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>
            {mission === 'Kepler'
              ? 'On-demand only: downloads ~15 MB of this star’s Kepler pixel data (6 quarters) from NASA/MAST and measures where the periodic dimming signal originates on the sky, relative to the target’s catalog position. Takes ~10–30 s.'
              : 'On-demand only: downloads this star’s TESS pixel data (up to 4 sectors, ~50 MB EACH) from NASA/MAST and measures where the periodic dimming signal originates on the sky. Can take a minute or more.'}
          </div>
          {mission === 'TESS' && (
            <div
              style={{
                marginTop: 6,
                padding: '5px 7px',
                borderRadius: 4,
                background: 'rgba(244,162,97,0.1)',
                border: '1px solid rgba(244,162,97,0.4)',
                fontSize: 8.5,
                color: '#f4a261',
                lineHeight: 1.5,
              }}
            >
              ⚠ QUALITATIVE FOR TESS — this check is calibrated against Kepler
              DR25 ground truth only; no equivalent public per-target centroid
              values exist for TESS, and TESS&apos;s ~21″ pixels make the
              measurement far coarser. Treat the result as indicative, not
              validated.
            </div>
          )}
        </>
      )}

      {state === 'loading' && (
        <div style={{ fontSize: 9.5, color: '#4cc9f0', lineHeight: 1.6 }}>
          {VETTING_STEPS[stepIdx]}
          <div
            style={{
              marginTop: 6,
              height: 2,
              background: 'rgba(76,201,240,0.15)',
              borderRadius: 1,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: '40%',
                background: '#4cc9f0',
                animation: 'vetting-sweep 1.2s ease-in-out infinite alternate',
              }}
            />
          </div>
          <style jsx>{`
            @keyframes vetting-sweep {
              from { margin-left: 0; }
              to   { margin-left: 60%; }
            }
          `}</style>
        </div>
      )}

      {state === 'done' && payload && payload.status !== 'ok' && (
        <div style={{ fontSize: 9.5, color: '#f4a261', lineHeight: 1.5 }}>{payload.message}</div>
      )}

      {state === 'done' && result && result.status === 'saturated' && (
        <div style={{ fontSize: 9.5, color: '#f4a261', lineHeight: 1.5 }}>
          Target too bright for a reliable centroid ({mission === 'Kepler' ? 'Kp' : 'Tmag'}{' '}
          {result.kepmag !== null ? result.kepmag.toFixed(1) : '?'} — saturated pixels bleed
          along CCD columns). Measurement refused rather than reporting a
          meaningless offset.
        </div>
      )}

      {state === 'done' && result && result.status === 'insufficient' && (
        <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
          Not enough usable in/out-of-transit pixel data at this ephemeris
          ({result.quartersUsed} usable {mission === 'Kepler' ? 'quarters' : 'sectors'}; 3
          needed for an error bar).
        </div>
      )}

      {state === 'done' && result && result.status === 'measured' && (
        <div>
          {result.stamp && (
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 8 }}>
              <StampCanvas
                stamp={result.stamp}
                kind="out"
                title={`MEAN OUT-OF-TRANSIT (aperture outlined, × ${result.stamp.catalogPosition ? 'catalog position' : 'photocenter'})`}
              />
              <StampCanvas
                stamp={result.stamp}
                kind="diff"
                title="DIFFERENCE IMAGE (○ transit-signal centroid)"
              />
            </div>
          )}
          <div
            style={{
              fontSize: 9.5,
              lineHeight: 1.6,
              color: result.verdict === 'OFFSET_DETECTED' ? '#f4a261' : 'rgba(255,255,255,0.7)',
            }}
          >
            {result.verdict === 'OFFSET_DETECTED'
              ? `Transit-signal centroid offset: ${result.offsetArcsec!.toFixed(2)}″ ± ${result.offsetErrArcsec!.toFixed(2)}″ (${result.sigma!.toFixed(1)}σ) from the target's catalog position — the dimming originates away from the target.`
              : `No significant centroid offset: ${result.offsetArcsec!.toFixed(2)}″ ± ${result.offsetErrArcsec!.toFixed(2)}″ (${result.sigma!.toFixed(1)}σ; this check resolves offsets ≳ ${Math.round(result.floorArcsec)}″).`}
          </div>
          {mission === 'TESS' && (
            <div style={{ marginTop: 5, fontSize: 8.5, color: '#f4a261', lineHeight: 1.5 }}>
              ⚠ Qualitative — unvalidated for TESS (no public per-target
              centroid ground truth; ~21″ pixels).
            </div>
          )}
          <div style={{ marginTop: 5, fontSize: 8, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}>
            {result.quartersUsed} {mission === 'Kepler' ? 'quarters' : 'sectors'} vector-averaged ·
            stamp from {result.stamp ? result.stamp.label.replace(/(_lpd-targ\.fits\.gz|_tp\.fits)$/, '') : '—'} ·
            NASA/MAST {mission} Target Pixel Files
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * @description Ordered pipeline steps shown to the user while the real MAST
 * fetch is in flight. We don't have per-step events from the server, so
 * this is a believable narration of what the route is actually doing
 * (see `/api/lightcurve/[id]/route.ts`). Each step holds for at least
 * `LOADING_STEP_MS` so the user can read it; the cycle loops if the
 * fetch is still in flight when we hit the last step.
 */
const LOADING_STEPS = [
  'Querying NASA/MAST catalog…',
  'Found Kepler quarters for this target',
  'Downloading photometry files…',
  'Parsing FITS data…',
  'Running anomaly detection…',
]
const LOADING_STEP_MS = 900

/**
 * @description Cycling progress indicator shown while the lightcurve fetch is
 * in flight. The MAST cold-cache path can take 30–60s (parallel download of
 * ~17 Kepler quarters); without this the panel looks frozen. Cycles through
 * `LOADING_STEPS` so the user knows real work is happening. The bar uses a
 * CSS keyframes sweep so it stays cheap (no JS per frame).
 * @returns A bordered card with cycling copy + animated bar.
 */
function LoadingProgress() {
  const [stepIdx, setStepIdx] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setStepIdx(i => (i + 1) % LOADING_STEPS.length)
    }, LOADING_STEP_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      style={{
        background: 'rgba(76,201,240,0.06)',
        border: '1px solid rgba(76,201,240,0.3)',
        borderRadius: 6,
        padding: '12px 14px',
        marginBottom: 16,
      }}
    >
      <div
        key={stepIdx}
        style={{
          fontSize: 10,
          color: '#4cc9f0',
          letterSpacing: 1,
          lineHeight: 1.6,
          animation: 'lc-step-fade 0.4s ease',
        }}
      >
        {LOADING_STEPS[stepIdx]}
      </div>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', marginTop: 4, lineHeight: 1.5 }}>
        First load can take up to 60s. Subsequent loads are instant.
      </div>
      <div
        style={{
          position: 'relative',
          height: 3,
          marginTop: 10,
          background: 'rgba(255,255,255,0.06)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            height: '100%',
            width: '35%',
            background: 'linear-gradient(90deg, transparent, #4cc9f0, transparent)',
            animation: 'lc-loading-sweep 1.4s ease-in-out infinite',
          }}
        />
      </div>
      <style jsx>{`
        @keyframes lc-step-fade {
          from { opacity: 0.3; transform: translateY(-2px); }
          to   { opacity: 1;   transform: translateY(0); }
        }
        @keyframes lc-loading-sweep {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(370%); }
        }
      `}</style>
    </div>
  )
}

/**
 * @description Returns true when a star id is NOT a KIC/TIC/EPIC catalog
 * id — i.e. the user clicked a Hipparcos background star or a synthetic
 * filler and we need to cone-search MAST. Used by the panel to pick
 * between the pipeline narration (`LoadingProgress`) and the lighter
 * spinner (`SearchingMAST`), and to swap the "unavailable" copy between
 * "transient MAST failure" and "not observed by Kepler or TESS".
 * @param id Catalog id.
 */
function isOnDemandId(id: string): boolean {
  return !/^(KIC|TIC|EPIC)\d+$/.test(id)
}

/**
 * @description Lighter loading indicator used for on-demand clicks
 * (Hipparcos background stars, etc). The MAST cone search is
 * typically 1–3s, so the multi-step pipeline narration is
 * misleading — this variant just spins with a single line of copy
 * that matches what's actually happening.
 * @returns A bordered card with animated bar.
 */
function SearchingMAST() {
  return (
    <div
      style={{
        background: 'rgba(76,201,240,0.06)',
        border: '1px solid rgba(76,201,240,0.3)',
        borderRadius: 6,
        padding: '12px 14px',
        marginBottom: 16,
      }}
    >
      <div style={{ fontSize: 10, color: '#4cc9f0', letterSpacing: 1, lineHeight: 1.6 }}>
        Searching MAST archive…
      </div>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', marginTop: 4, lineHeight: 1.5 }}>
        Checking whether Kepler or TESS observed this star.
      </div>
      <div
        style={{
          position: 'relative',
          height: 3,
          marginTop: 10,
          background: 'rgba(255,255,255,0.06)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            height: '100%',
            width: '35%',
            background: 'linear-gradient(90deg, transparent, #4cc9f0, transparent)',
            animation: 'sm-loading-sweep 1.4s ease-in-out infinite',
          }}
        />
      </div>
      <style jsx>{`
        @keyframes sm-loading-sweep {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(370%); }
        }
      `}</style>
    </div>
  )
}

/**
 * @description One-line citation under each dip card showing where the
 * underlying time-series came from. Pulls labels straight from the
 * lightcurve's `provenance` so adding a new mission (TESS, K2) doesn't
 * require touching this component.
 * @param provenance The provenance bundle from the API response.
 * @returns Inline text node, or null if provenance is missing.
 */
function DipProvenanceLine({ provenance }: { provenance?: LightcurveProvenance }) {
  if (!provenance) return null
  return (
    <div
      style={{
        fontSize: 7,
        color: 'rgba(255,255,255,0.3)',
        letterSpacing: 0.5,
        marginTop: 6,
        lineHeight: 1.5,
      }}
    >
      Source: {provenance.sourceName} · {provenance.mission} · {provenance.dataType}
    </div>
  )
}

/**
 * @description Right-side slide-in panel that appears whenever a star is selected. Shows
 * the star visualization, coordinate/magnitude metadata, the score ring, a
 * list of detected dips, an expandable light curve, and (for known anomalies)
 * external citizen-science report links.
 * @returns The panel, or null when no star is selected.
 */
export default function AnomalyPanel() {
  const { selectedStar, lightcurve, lightcurveLoading, identity, identityLoading, setSelectedStar, setMode, flaggedIds, toggleFlagged } = useStore()
  const [showLightcurve, setShowLightcurve] = useState(false)

  if (!selectedStar) return null

  /**


   * @description Closes the panel and returns the app to explore mode.


   */
  function close() {
    setSelectedStar(null)
    setMode('explore')
    setShowLightcurve(false)
  }

  return (
    <>
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 300,
        background: 'rgba(0,0,0,0.88)',
        backdropFilter: 'blur(12px)',
        borderLeft: '1px solid rgba(255,255,255,0.08)',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'JetBrains Mono, monospace',
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '20px 20px 0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: 2 }}>
            {selectedStar.hasAnomaly ? '⚠ KNOWN ANOMALY' : 'STAR'}
          </div>
          {/* flexWrap: the PARTIAL badge can't fit next to name + ★ +
              REAL DATA inside the 300px panel; it wraps to its own line
              instead of clipping at the panel edge. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'white', lineHeight: 1.3 }}>
              {selectedStar.name}
            </div>
            {/* Bookmark toggle. Filled white star = flagged (saved to
                localStorage `sae_flagged`); outline = unflagged. Click
                cycles the state. Title hint is a small accessibility
                affordance — most users will recognize the icon. */}
            <button
              onClick={() => toggleFlagged(selectedStar.id)}
              title={flaggedIds.has(selectedStar.id) ? 'Remove bookmark' : 'Bookmark this star'}
              aria-pressed={flaggedIds.has(selectedStar.id)}
              style={{
                background: 'none',
                border: 'none',
                color: flaggedIds.has(selectedStar.id) ? '#ffffff' : 'rgba(255,255,255,0.4)',
                fontSize: 16,
                lineHeight: 1,
                cursor: 'pointer',
                padding: '0 2px',
                fontFamily: 'inherit',
              }}
            >
              {flaggedIds.has(selectedStar.id) ? '★' : '☆'}
            </button>
            <DataSourceBadge source={lightcurve?.source} />
            <PartialDataBadge
              partial={lightcurve?.partial}
              segments={lightcurve?.segments}
              mission={lightcurve?.mission}
            />
          </div>
        </div>
        <button
          onClick={close}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 18,
            cursor: 'pointer',
            lineHeight: 1,
            padding: 4,
          }}
        >
          ×
        </button>
      </div>

      <div style={{ padding: '16px 20px', flexShrink: 0 }}>
        {/* Star visualization */}
        <div style={{ marginBottom: 12 }}>
          <StarVisualization
            colorIndex={selectedStar.colorIndex}
            isAnomaly={selectedStar.hasAnomaly}
          />
        </div>

        {/* Score ring + star info. The ring shows NASA's catalog vetting
            score (0–100), which is independent from the local detector /
            BLS findings surfaced further down — hence the NASA_SCORE
            tooltip. For TESS (TOI) stars the TOI scale tops out near 50,
            so an inline note + tooltip keeps a ~41 from reading as
            artificially low against a KOI 0–100 score. Purely explanatory;
            no scoring math is touched. */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 7, letterSpacing: 1, color: 'rgba(255,255,255,0.4)' }}>NASA SCORE</span>
              <InfoBadge term="NASA_SCORE" />
            </div>
            <ScoreRing score={selectedStar.anomalyScore} />
            {selectedStar.source === 'TESS' && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 7, letterSpacing: 0.5, color: 'rgba(0,229,255,0.75)', whiteSpace: 'nowrap' }}>
                  TOI scale · max ~50
                </span>
                <InfoBadge term="TOI_SCALE" />
              </div>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <InfoRow label="RA" value={`${selectedStar.ra.toFixed(4)}°`} term="RA" />
            <InfoRow label="DEC" value={`${selectedStar.dec.toFixed(4)}°`} term="DEC" />
            <InfoRow label="MAG" value={selectedStar.magnitude.toFixed(2)} term="MAG" />
            <InfoRow label="COLOR" value={bvToColorName(selectedStar.colorIndex)} small term="COLOR" />
            <InfoRow
              label="SKY"
              value={constellationAt(selectedStar.ra, selectedStar.dec).name}
              small
              term="SKY"
            />
          </div>
        </div>

        {/* Celestial-orientation copy, storytelling frame: separates the
            two facts a technical one-liner conflates — (a) WHEN it is up
            all night worldwide, from RA (culmination month → season), and
            (b) WHO can see it and how high, from Dec geometry alone.
            Orientation aid, not an ephemeris; the declination math is
            untouched (describeVisibilityStory reuses visibilityFor). */}
        <div
          style={{
            fontSize: 9,
            color: 'rgba(255,255,255,0.5)',
            letterSpacing: 0.3,
            lineHeight: 1.7,
            marginBottom: 14,
          }}
        >
          {describeVisibilityStory(selectedStar.ra, selectedStar.dec)}
        </div>

        {/* Alternate designations from SIMBAD. Renders nothing at all on
            a miss, a failure, or when every name is already on screen —
            see AlsoKnownAs. */}
        <AlsoKnownAs
          identity={identity}
          loading={identityLoading}
          displayed={[selectedStar.name, selectedStar.id]}
        />

        <Divider />

        {/* Loading state takes priority over dips/chart/explanation so a slow
            MAST fetch doesn't make the panel look frozen. Catalog stars
            (KIC/TIC/EPIC) get the multi-step MAST pipeline narration
            (cold path can take 30–90s); on-demand clicks on background
            stars get a lighter "Searching MAST archive…" spinner
            (typical 1–3s cone-search) since the pipeline narration
            would misrepresent what's actually happening. */}
        {lightcurveLoading ? (
          isOnDemandId(selectedStar.id) ? <SearchingMAST /> : <LoadingProgress />
        ) : lightcurve?.source === 'unavailable' && selectedStar.hasAnomaly ? (
          <>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: 2, marginBottom: 8, display: 'flex', alignItems: 'center' }}>
              DOCUMENTED ANOMALY
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <InfoBadge term="SCORE" />
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              <div
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  borderLeft: `3px solid ${LABEL_COLOR[catalogLabelFor(selectedStar.anomalyScore)]}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 9, color: LABEL_COLOR[catalogLabelFor(selectedStar.anomalyScore)], letterSpacing: 1 }}>
                    {catalogLabelFor(selectedStar.anomalyScore)}
                  </span>
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>
                    {Math.round(selectedStar.anomalyScore * 100)}%
                  </span>
                </div>
                <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
                  Catalog-recorded anomaly score
                </div>
                <div style={{ height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 1, marginTop: 6 }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${selectedStar.anomalyScore * 100}%`,
                      background: LABEL_COLOR[catalogLabelFor(selectedStar.anomalyScore)],
                      borderRadius: 1,
                    }}
                  />
                </div>
                <DipProvenanceLine
                  provenance={{
                    sourceName: 'Curated catalog',
                    mission: 'Literature',
                    dataType: 'Published anomaly score',
                  }}
                />
              </div>
            </div>
            <Divider />
          </>
        ) : lightcurve && lightcurve.dips.length > 0 && (
          <>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: 2, marginBottom: 8, display: 'flex', alignItems: 'center' }}>
              DIPS
              <InfoBadge term="DIP" />
              <span style={{ marginLeft: 6 }}>DETECTED ({lightcurve.dips.length})</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <InfoBadge term="SCORE" />
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {lightcurve.dips.slice(0, 6).map((dip, i) => (
                <div
                  key={i}
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    borderRadius: 6,
                    padding: '8px 12px',
                    borderLeft: `3px solid ${LABEL_COLOR[dip.label]}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 9, color: LABEL_COLOR[dip.label], letterSpacing: 1 }}>
                      {dip.label}
                    </span>
                    <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>
                      {Math.round(dip.score * 100)}%
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                    <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.35)' }}>
                      −{(dip.depth * 100).toFixed(2)}%
                    </span>
                    <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.35)' }}>
                      {dip.duration.toFixed(1)}d
                    </span>
                    <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.35)' }}>
                      t={dip.peakTime.toFixed(1)} {lightcurve.mission === 'TESS' ? 'TJD' : 'BKJD'}
                    </span>
                  </div>
                  {/* Score bar */}
                  <div style={{ height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 1, marginTop: 6 }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${dip.score * 100}%`,
                        background: LABEL_COLOR[dip.label],
                        borderRadius: 1,
                        transition: 'width 0.5s ease',
                      }}
                    />
                  </div>
                  <DipProvenanceLine provenance={lightcurve.provenance} />
                </div>
              ))}
            </div>

            <Divider />
          </>
        )}

        {/* Light curve toggle + button. Always visible so any clicked star
            can be inspected — Hipparcos background clicks trigger an
            on-demand MAST cone search via `selectStar`. Three states:
            - Data available (real or synthetic): button opens the fullscreen chart.
            - `unavailable` for a catalog star: MAST fetch failed for a
              documented target; probably transient, tell the user that.
            - `unavailable` for an on-demand star: MAST cone search found
              no observation at that position; the star hasn't been
              looked at by either mission. Different copy — this isn't
              a temporary failure, it's a real coverage gap. */}
        {lightcurveLoading ? null : lightcurve?.source === 'unavailable' ? (
          <div
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              padding: '12px 14px',
              fontSize: 10,
              lineHeight: 1.6,
              color: 'rgba(255,255,255,0.6)',
            }}
          >
            {isOnDemandId(selectedStar.id) ? (
              <>
                <strong style={{ color: 'rgba(255,255,255,0.85)', letterSpacing: 1 }}>
                  DATA UNAVAILABLE
                </strong>
                {' — '}
                This star has not been observed by Kepler or TESS.
              </>
            ) : (
              <>
                Real light curve data could not be fetched from NASA/MAST.
                This star exists and has documented anomalies, but the raw
                data is temporarily unavailable.
              </>
            )}
          </div>
        ) : (
          <ActionButton
            label="VIEW LIGHT CURVE"
            color="#4cc9f0"
            onClick={() => setShowLightcurve(true)}
          />
        )}

        {/* Report buttons */}
        {selectedStar.hasAnomaly && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            <Divider />
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: 2, marginBottom: 4 }}>
              REPORT TO CITIZEN SCIENCE
            </div>
            <ActionButton
              label="ZOONIVERSE"
              color="#f4a261"
              onClick={() => window.open(zooniverseLinkFor(selectedStar.id), '_blank')}
              external
            />
            <ActionButton
              label="NASA EXOPLANET ARCHIVE"
              color="#f4a261"
              onClick={() => window.open('https://exoplanetarchive.ipac.caltech.edu/', '_blank')}
              external
            />
            <ActionButton
              label="SETI INSTITUTE"
              color="#f4a261"
              onClick={() => window.open('https://www.seti.org', '_blank')}
              external
            />
          </div>
        )}
      </div>
    </div>
    {showLightcurve && lightcurve && lightcurve.flux.length > 0 && (
      <LightCurveFullscreen
        starId={selectedStar.id}
        starName={selectedStar.name}
        source={lightcurve.source}
        times={lightcurve.times}
        flux={lightcurve.flux}
        dips={lightcurve.dips}
        provenance={lightcurve.provenance}
        profile={lightcurve.profile ?? null}
        gapDays={lightcurve.gapDays}
        timeUnit={lightcurve.mission === 'TESS' ? 'TJD' : 'BKJD'}
        partial={lightcurve.partial}
        segments={lightcurve.segments}
        mission={lightcurve.mission}
        onClose={() => setShowLightcurve(false)}
      />
    )}
    </>
  )
}

/**
 * @description One label/value row in the panel's metadata block. If `term` is provided
 * and matches a GLOSSARY key, an `InfoBadge` is appended next to the label.
 * @param label Short uppercase label, e.g. "RA".
 * @param value Already-formatted value string.
 * @param small Use a smaller value font (useful for long descriptors).
 * @param term Optional glossary key for the help tooltip.
 * @returns Flex row with label + value.
 */
function InfoRow({
  label,
  value,
  small,
  term,
}: {
  label: string
  value: string
  small?: boolean
  term?: string
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.3)', letterSpacing: 1, display: 'inline-flex', alignItems: 'center' }}>
        {label}
        {term && <InfoBadge term={term} />}
      </span>
      <span style={{ fontSize: small ? 7 : 9, color: 'rgba(255,255,255,0.7)', textAlign: 'right', maxWidth: 150 }}>{value}</span>
    </div>
  )
}

/**
 * @description Thin horizontal rule used between panel sections.
 * @returns 1-px divider styled to match the panel chrome.
 */
function Divider() {
  return <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '12px 0' }} />
}

/**
 * @description How long the identity lookup must stay in flight before the
 * panel shows a placeholder. SIMBAD answers in ~0.3–2.4 s live, but a disk
 * cache hit returns in a few ms — without this delay every revisit would
 * flash a one-frame "RESOLVING…" line, which reads as a glitch. 400 ms is
 * above the cache-hit path and below the point where silence feels broken.
 */
const IDENTITY_PLACEHOLDER_DELAY_MS = 400

/**
 * @description "ALSO KNOWN AS" block: the star's alternate designations
 * from SIMBAD (common names like "Boyajian's Star", plus SIMBAD's
 * canonical `main_id` when it adds information).
 *
 * Absence is not news. This is bonus cross-reference context, not a core
 * feature — most faint KOI hosts are simply not in SIMBAD, which is a
 * normal answer, not an error. So the block renders NOTHING when the
 * lookup missed, failed, or returned only names the panel already shows.
 * There is deliberately no error state and no "not found" message: they
 * would clutter the panel on the common case while telling the user
 * something they cannot act on.
 * @param identity Resolved identity, or null for miss/failure/pending.
 * @param loading True while the lookup is in flight.
 * @param displayed Strings already shown for this star (name, id), so
 * the block doesn't echo them back.
 * @returns The block, or null when there is nothing worth showing.
 */
function AlsoKnownAs({
  identity,
  loading,
  displayed,
}: {
  identity: SimbadIdentity | null
  loading: boolean
  displayed: string[]
}) {
  // Gate the placeholder behind a short delay so cache hits (a few ms)
  // resolve before it would ever paint.
  const [showPlaceholder, setShowPlaceholder] = useState(false)
  useEffect(() => {
    if (!loading) {
      setShowPlaceholder(false)
      return
    }
    const t = setTimeout(() => setShowPlaceholder(true), IDENTITY_PLACEHOLDER_DELAY_MS)
    return () => clearTimeout(t)
  }, [loading])

  if (loading) {
    if (!showPlaceholder) return null
    return (
      <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.25)', letterSpacing: 2, marginBottom: 12 }}>
        RESOLVING IDENTITY…
      </div>
    )
  }

  if (!identity) return null
  const { names, mainId } = selectDisplayNames(identity, displayed)
  if (names.length === 0 && !mainId) return null

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', letterSpacing: 2, marginBottom: 6 }}>
        ALSO KNOWN AS
      </div>
      {names.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: mainId ? 6 : 0 }}>
          {names.map(name => (
            <span
              key={name}
              style={{
                fontSize: 10,
                color: 'rgba(255,255,255,0.85)',
                letterSpacing: 0.5,
                padding: '2px 6px',
                border: '1px solid rgba(76,201,240,0.25)',
                borderRadius: 3,
                background: 'rgba(76,201,240,0.07)',
              }}
            >
              {name}
            </span>
          ))}
        </div>
      )}
      {mainId && (
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', letterSpacing: 0.3 }}>
          SIMBAD: {mainId}
        </div>
      )}
      <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.25)', letterSpacing: 0.3, marginTop: 4 }}>
        via SIMBAD (CDS)
      </div>
    </div>
  )
}

/**
 * @description Themed button used for panel actions (view light curve, open external
 * citizen-science links, etc). Hover lifts the background tint slightly.
 * @param label Button text.
 * @param color Accent color for border, text, and hover background.
 * @param onClick Click handler.
 * @param external If true, shows an "↗" indicator implying a new-tab link.
 * @returns Styled `<button>`.
 */
function ActionButton({
  label,
  color,
  onClick,
  external,
}: {
  label: string
  color: string
  onClick: () => void
  external?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${color}44`,
        borderRadius: 6,
        padding: '10px 14px',
        color,
        fontSize: 9,
        letterSpacing: 2,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        transition: 'background 0.2s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = `${color}11`)}
      onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
    >
      {label}
      {external && <span style={{ opacity: 0.5 }}>↗</span>}
    </button>
  )
}
