'use client'
import { useEffect, useState } from 'react'
import { useStore, type Anomaly, type LightcurveProvenance } from '@/lib/store'
import type { CurveProfile, CurvePattern, DipShape } from '@/lib/curveClassifier'
import { BLS_SDE_THRESHOLD } from '@/lib/bls'
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
        {/* Classifier readout — floats top-left over the chart corner.
            Rendered AFTER the chart panel in source order so the
            absolute positioning keeps it on top without z-index
            gymnastics. Contains only measured features; no causal
            interpretation. */}
        {profile && (
          <ClassifierReadout profile={profile} partial={partial} segments={segments} mission={mission} />
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
  return (
    <div
      style={{
        position: 'absolute',
        top: 72,
        left: 16,
        zIndex: 5,
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
  const { selectedStar, lightcurve, lightcurveLoading, setSelectedStar, setMode, flaggedIds, toggleFlagged } = useStore()
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

        {/* Score ring + star info */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16 }}>
          <ScoreRing score={selectedStar.anomalyScore} />
          <div style={{ flex: 1 }}>
            <InfoRow label="RA" value={`${selectedStar.ra.toFixed(4)}°`} term="RA" />
            <InfoRow label="DEC" value={`${selectedStar.dec.toFixed(4)}°`} term="DEC" />
            <InfoRow label="MAG" value={selectedStar.magnitude.toFixed(2)} term="MAG" />
            <InfoRow label="COLOR" value={bvToColorName(selectedStar.colorIndex)} small term="COLOR" />
          </div>
        </div>

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
