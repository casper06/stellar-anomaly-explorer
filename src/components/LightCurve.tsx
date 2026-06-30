'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Anomaly, type LightcurveProvenance } from '@/lib/store'

const LABEL_COLOR: Record<string, string> = {
  WOW: '#ff4d6d',
  INTERESTING: '#f4a261',
  NOTABLE: '#4cc9f0',
  NORMAL: 'rgba(255,255,255,0.3)',
}

/**
 * @description Time gap (in days) above which two consecutive samples are
 * treated as belonging to different observation runs — the line lifts
 * the pen rather than drawing a diagonal stroke across the gap. Kepler
 * intra-quarter cadence is ~30 minutes; inter-quarter gaps are 1–4
 * days; longer gaps (data outages, safe-mode events) also qualify. 5
 * days cleanly separates real observation windows from cadence noise.
 */
const GAP_DAYS = 5

/**
 * @description Target output point count when LTTB-downsampling the visible
 * window. Standard recommendation is ~2× the canvas width in pixels;
 * 2000 reads well on both the inline 460-px chart and the fullscreen
 * ~1400-px one.
 */
const LTTB_TARGET_POINTS = 2000

/**
 * @description Largest-Triangle-Three-Buckets downsampling (Steinarsson 2013).
 * Reduces a series of (x, y) points to roughly `threshold` points while
 * preserving the visual shape — picks the point in each bucket that
 * forms the largest triangle with the previous selected point and the
 * average of the next bucket. Standard algorithm for time-series viz
 * (used by Grafana, Plotly, etc); doesn't produce the per-column fill
 * artifact that min/max envelope rendering does.
 *
 * **Min/max guarantee**: standard LTTB can miss the global extremes
 * of a segment if they fall in a bucket whose largest triangle is
 * formed by a different point. For light curves this can hide deep
 * narrow dips (Tabby's −22% events span <50 samples out of ~60k). We
 * post-process the picked indices to splice in the global y-min and
 * y-max indices if they're not already present, preserving their
 * chronological position. Cost: O(N) one extra pass.
 *
 * Expects a single contiguous segment — callers handle splitting around
 * nulls and quarter gaps so each segment renders as its own sub-path.
 * @param xs x coordinates of the source samples (must be monotonic).
 * @param ys y coordinates of the source samples (same length as xs).
 * @param threshold Target output count (returns input unchanged if <= 2 or >= xs.length).
 * @returns Indices into the source arrays of the selected samples,
 * monotonically increasing, including the segment's global y-min and
 * y-max indices.
 */
function lttbIndices(xs: number[], ys: number[], threshold: number): number[] {
  const n = xs.length
  if (threshold >= n || threshold <= 2) {
    const all = new Array<number>(n)
    for (let i = 0; i < n; i++) all[i] = i
    return all
  }
  const out: number[] = new Array(threshold)
  let outIdx = 0
  const bucketSize = (n - 2) / (threshold - 2)
  let aIdx = 0
  out[outIdx++] = 0

  // Track the segment's global y-min and y-max indices in the SAME pass
  // so we don't need a second loop later.
  let yMinIdx = 0
  let yMaxIdx = 0
  for (let i = 1; i < n; i++) {
    if (ys[i] < ys[yMinIdx]) yMinIdx = i
    if (ys[i] > ys[yMaxIdx]) yMaxIdx = i
  }

  for (let i = 0; i < threshold - 2; i++) {
    // Average x/y of the NEXT bucket — used as the third triangle vertex.
    const nbStart = Math.floor((i + 1) * bucketSize) + 1
    const nbEnd = Math.min(n, Math.floor((i + 2) * bucketSize) + 1)
    let avgX = 0
    let avgY = 0
    const nbLen = nbEnd - nbStart
    if (nbLen > 0) {
      for (let j = nbStart; j < nbEnd; j++) {
        avgX += xs[j]
        avgY += ys[j]
      }
      avgX /= nbLen
      avgY /= nbLen
    } else {
      avgX = xs[n - 1]
      avgY = ys[n - 1]
    }

    // Pick the point in the CURRENT bucket that forms the largest triangle
    // with (aIdx, avg).
    const bStart = Math.floor(i * bucketSize) + 1
    const bEnd = Math.min(n, Math.floor((i + 1) * bucketSize) + 1)
    const ax = xs[aIdx]
    const ay = ys[aIdx]
    let maxArea = -1
    let pickedIdx = bStart
    for (let j = bStart; j < bEnd; j++) {
      // Triangle area = 0.5 * | (ax - avgX)(ys[j] - ay) - (ax - xs[j])(avgY - ay) |
      const area = Math.abs((ax - avgX) * (ys[j] - ay) - (ax - xs[j]) * (avgY - ay))
      if (area > maxArea) { maxArea = area; pickedIdx = j }
    }
    out[outIdx++] = pickedIdx
    aIdx = pickedIdx
  }
  out[outIdx++] = n - 1

  // Min/max preservation. Endpoints (0, n-1) are already in `out` so we
  // only need to splice when the extreme is interior. Use a Set for O(1)
  // membership; insert with binary search to keep `out` monotonic.
  const present = new Set<number>(out)
  const insertInOrder = (idx: number) => {
    if (idx === 0 || idx === n - 1 || present.has(idx)) return
    let lo = 0
    let hi = out.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (out[mid] < idx) lo = mid + 1
      else hi = mid
    }
    out.splice(lo, 0, idx)
    present.add(idx)
  }
  insertInOrder(yMinIdx)
  insertInOrder(yMaxIdx)
  return out
}

interface Props {
  times: number[]
  flux: number[]
  dips: Anomaly[]
  /**
   * Canvas pixel width. Defaults to 460 (panel inline use). Pass a larger
   * value for fullscreen overlays so the chart isn't blurry when stretched.
   */
  width?: number
  /**
   * Canvas pixel height. Defaults to 200 (panel inline use).
   */
  height?: number
  /**
   * When true, enables wheel-to-zoom, drag-to-pan, double-click-to-reset
   * on the time axis, and renders a minimap strip below the main chart.
   * Off by default so the inline panel chart stays passive (user scrolling
   * the side panel shouldn't accidentally zoom the chart).
   */
  interactive?: boolean
  /**
   * When true, the root element and main canvas stretch to fill their
   * flex parent (CSS `height: 100%`); the `height` prop only controls the
   * pixel buffer used for rasterization. Use this inside a flex column so
   * the chart grabs all available vertical space without overflowing.
   * Minimap + hint remain at their fixed sizes anchored to the bottom.
   */
  fillContainer?: boolean
  /**
   * Provenance shown in the pinned tooltip when a dip marker is clicked
   * (interactive mode only). Optional because the inline panel chart
   * doesn't surface a pinned tooltip — the panel already lists dips
   * with their own provenance line beside the chart.
   */
  provenance?: LightcurveProvenance
}

interface Tooltip {
  x: number
  y: number
  dip: Anomaly
}

/**
 * @description Canvas 2D plot of a star's normalized flux over time, with detected dips
 * shaded and labeled. The line draws left-to-right via an ease-out reveal on
 * mount; dip markers fade in once the reveal has passed the halfway mark.
 * Hovering near a dip's peak shows a tooltip with its statistics.
 * @param times Time axis (BKJD).
 * @param flux Normalized flux values, paired 1:1 with `times`.
 * @param dips Detected dips to shade and mark.
 * @returns Canvas + tooltip overlay + color legend.
 */
export default function LightCurve({ times, flux, dips, width = 460, height = 200, interactive = false, fillContainer = false, provenance }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const minimapRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const progressRef = useRef(0)
  const [tooltip, setTooltip] = useState<Tooltip | null>(null)
  // Sticky tooltip pinned by clicking a dip marker. Independent of the
  // hover tooltip so panning/moving doesn't blow it away.
  const [pinnedDip, setPinnedDip] = useState<Anomaly | null>(null)
  // Tooltip shown when the cursor is over an inter-quarter gap region —
  // the empty black bands between Kepler observation runs confuse users
  // ("is my data corrupted?"), so a short explanation helps.
  const [gapHover, setGapHover] = useState<{ x: number; y: number; days: number } | null>(null)
  // Reset pinned tooltip whenever the dataset changes (new star selected).
  useEffect(() => { setPinnedDip(null) }, [times, flux])

  // Time window currently visible on the X axis. Defaults to the full data
  // range. Wheel/drag mutate this; double-click resets to full.
  const fullStart = times[0]
  const fullEnd = times[times.length - 1]
  const [viewStartT, setViewStartT] = useState(fullStart)
  const [viewEndT, setViewEndT] = useState(fullEnd)
  // Flux window currently visible on the Y axis. Defaults to the data's
  // p2/p98 percentile range (computed in `fluxRange` below). Shift+wheel
  // zooms this; double-click resets BOTH X and Y to their auto-fit
  // defaults. Kept as nullable: null means "use the auto fluxRange".
  // Once the user interacts with Y zoom, this becomes concrete numbers.
  const [viewYMin, setViewYMin] = useState<number | null>(null)
  const [viewYMax, setViewYMax] = useState<number | null>(null)
  // Reset all view state when the underlying data changes (new star)
  useEffect(() => {
    setViewStartT(times[0])
    setViewEndT(times[times.length - 1])
    setViewYMin(null)
    setViewYMax(null)
  }, [times])

  const PAD = { top: 20, right: 16, bottom: 36, left: 48 }
  const MINIMAP_H = 36 // px, only rendered when interactive

  /**
   * @description Computes plot dimensions and value↔pixel mappers for the current canvas.
   * Memoized so it only recomputes when the underlying data or padding change.
   * @param canvas Live canvas element used to read width/height.
   * @returns Plot box, data ranges, and `toX`/`toY` conversion helpers.
   */
  // Outlier-filtered view of the flux array. Raw Kepler PDC data contains
  // single-point cosmic-ray hits and spacecraft artifacts; they're
  // visually distracting (upward spikes on the chart) but also poison
  // any min/max-based statistics. We replace outliers with `null` so the
  // draw loop skips them, lifts the pen, and starts a new sub-path —
  // no NaN spikes, no fake "data gaps".
  //
  // **Asymmetric MAD filter** (this was a real bug for months):
  // cosmic-ray hits in Kepler PDC photometry are UPWARD spikes
  // (photon pile-up adds counts; it never subtracts them). Real
  // astrophysical events — planetary transits, KIC 8462852's deep
  // mystery dips, KIC 12557548's dust-tail occultations — are
  // DOWNWARD excursions. A symmetric MAD filter using the global
  // noise scale (~0.0003 for a quiet star) treats a 22% downward
  // transit identically to a 22% upward spike: both get rejected. We
  // therefore only apply the MAD bound on the UPPER side; downward
  // excursions are bounded only by the absolute floor (0.5, defends
  // against truly broken negative-flux values from instrument errors).
  //
  // **Single-point spike detector** (pass 3, both directions): the
  // asymmetric MAD passes anything moving DOWN, but real transits are
  // multi-sample events (Kepler 30-min cadence × few-hour transit = at
  // least 4-8 consecutive samples). A single sample that differs
  // sharply from BOTH neighbors while the neighbors themselves agree
  // is an instrument artifact, not astrophysics. This catches downward
  // single-sample spikes (hot pixel masking errors, calibration
  // glitches) that survive the asymmetric MAD and produce visible
  // V-shaped notches like the K00526.01 BKJD~763 case.
  //
  // Cascade:
  //   1. Absolute hard bounds: `f > 1.05 || f < 0.5`. Defends against
  //      truly broken values that would otherwise inflate the MAD
  //      estimate below.
  //   2. Asymmetric MAD: `f > median + MAD_K * MAD` rejects upward
  //      spikes (cosmic rays). NO lower MAD bound.
  //   3. Neighbor-based single-point spike: `|f[i] - f[i±1]| > SPIKE_K
  //      * MAD` AND `|f[i-1] - f[i+1]| < NEIGHBOR_AGREE_K * MAD`,
  //      symmetric (both upward AND downward). Time-gap aware — won't
  //      compare across observation gaps > GAP_DAYS.
  //
  // K=5 catches single-point cosmic rays without touching real stellar
  // variations on the upper side (continuous variability rarely spikes
  // a single sample >5×MAD above the median).
  const cleanedFlux = useMemo(() => {
    const MAD_K = 5
    // Spike detector thresholds. SPIKE_K=5 mirrors MAD_K so the same
    // noise scale governs both passes. NEIGHBOR_AGREE_K=3 requires
    // prev/next to be reasonably close (within 3×MAD of each other),
    // which is true everywhere outside of real dip slopes — at the
    // edge of a real dip prev and next would also differ by the dip
    // depth (way more than 3×MAD for a meaningful dip).
    const SPIKE_K = 5
    const NEIGHBOR_AGREE_K = 3
    // Pass 1: absolute bounds. Skip null/non-finite entries.
    const survivors: number[] = []
    for (const f of flux) {
      if (f != null && Number.isFinite(f) && f <= 1.05 && f >= 0.5) survivors.push(f)
    }
    if (survivors.length === 0) return flux.map(() => null as number | null)
    // Median of survivors
    const sortedSurv = [...survivors].sort((a, b) => a - b)
    const median = sortedSurv[Math.floor(sortedSurv.length / 2)]
    // MAD = median(|x - median|)
    const absDevs = survivors.map(f => Math.abs(f - median))
    absDevs.sort((a, b) => a - b)
    const mad = absDevs[Math.floor(absDevs.length / 2)]
    // Guard against pathological MAD=0 (constant flux). Fall back to a
    // tiny floor so the filter doesn't reject every sample.
    const madFloored = Math.max(mad, 1e-5)
    const upperThreshold = median + MAD_K * madFloored

    // Pass 2 result: absolute + asymmetric MAD.
    const afterMad: (number | null)[] = flux.map(f => {
      if (f == null || !Number.isFinite(f)) return null
      if (f > 1.05 || f < 0.5) return null
      if (f > upperThreshold) return null
      return f
    })

    // Pass 3: single-point neighbor-based spike removal. Walk the
    // array; for each interior surviving sample, compare it to its
    // immediate previous and next surviving samples — but only when
    // those neighbors are also within GAP_DAYS in time (don't bridge
    // across observation gaps). If the candidate differs from BOTH
    // neighbors by more than SPIKE_K*MAD AND the neighbors agree with
    // each other within NEIGHBOR_AGREE_K*MAD, null the candidate.
    const result: (number | null)[] = afterMad.slice()
    const spikeThreshold = SPIKE_K * madFloored
    const neighborAgreeThreshold = NEIGHBOR_AGREE_K * madFloored
    let spikesRemoved = 0
    for (let i = 1; i < result.length - 1; i++) {
      const f = result[i]
      const fp = result[i - 1]
      const fn = result[i + 1]
      if (f == null || fp == null || fn == null) continue
      // Don't compare across observation gaps; those samples aren't
      // really "neighbors" in the continuous-time sense.
      if (times[i] - times[i - 1] > GAP_DAYS) continue
      if (times[i + 1] - times[i] > GAP_DAYS) continue
      const dPrev = Math.abs(f - fp)
      const dNext = Math.abs(f - fn)
      const dNeighbors = Math.abs(fp - fn)
      if (
        dPrev > spikeThreshold &&
        dNext > spikeThreshold &&
        dNeighbors < neighborAgreeThreshold
      ) {
        result[i] = null
        spikesRemoved++
      }
    }

    // Diagnostic logging — gated on a URL query param so it doesn't
    // spam the console for every star. Use `?debugStar=K00526` (or any
    // substring of the star id) to enable for one specific case.
    if (typeof window !== 'undefined') {
      const debugStar = new URLSearchParams(window.location.search).get('debugStar')
      if (debugStar) {
        console.log(
          `[LightCurve MAD diagnostic · debugStar=${debugStar}]`,
          {
            samples: flux.length,
            survivors: survivors.length,
            median,
            mad,
            madFloored,
            upperThresholdAsymmetric: upperThreshold,
            spikeThreshold,
            neighborAgreeThreshold,
            droppedByAbsoluteBounds: flux.filter(f => f != null && Number.isFinite(f) && (f > 1.05 || f < 0.5)).length,
            droppedByAsymmetricMAD: flux.filter(f => f != null && Number.isFinite(f) && f <= 1.05 && f >= 0.5 && f > upperThreshold).length,
            droppedBySpikeDetector: spikesRemoved,
          },
        )
      }
    }

    return result
  }, [flux, times])

  // Percentile-based Y range using p2/p98. The previous version capped
  // the range to median ± 0.15 to defend against cosmic-ray survivors,
  // but that also clipped legitimate stellar variability on intrinsic
  // variables. With p2/p98 we exclude the top/bottom 2% — out of ~60k
  // samples that's >1200 samples on each side, more than enough cushion
  // for the few cosmic rays that pass the outlier filter. Real
  // variations are never clipped.
  // Time-domain gap regions (where consecutive samples are > GAP_DAYS
  // apart). Memoized once per dataset; independent of view zoom so the
  // hit-test below is just two number comparisons per gap. The draw
  // loop already breaks the line at these boundaries; this is purely
  // for the hover tooltip.
  const gapRegions = useMemo(() => {
    const out: { start: number; end: number; days: number }[] = []
    for (let i = 1; i < times.length; i++) {
      const dt = times[i] - times[i - 1]
      if (dt > GAP_DAYS) {
        out.push({ start: times[i - 1], end: times[i], days: dt })
      }
    }
    return out
  }, [times])

  const fluxRange = useMemo(() => {
    const finite = cleanedFlux.filter((f): f is number => f != null)
    if (finite.length === 0) return { minF: 0.95, maxF: 1.05, median: 1.0 }
    const sorted = [...finite].sort((a, b) => a - b)
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    // p1/p99 (was p2/p98) — wider tails so genuine variability is less
    // likely to be clipped. The bottom 1% of ~60k samples is still ~600
    // points of cushion against surviving cosmic-ray hits.
    const p1 = pick(0.01)
    const p99 = pick(0.99)
    const median = pick(0.5)
    const pad = (p99 - p1) * 0.10
    return { minF: p1 - pad, maxF: p99 + pad, median }
  }, [cleanedFlux])

  const getCanvasCoords = useCallback(
    (canvas: HTMLCanvasElement) => {
      const W = canvas.width
      const H = canvas.height
      const plotW = W - PAD.left - PAD.right
      const plotH = H - PAD.top - PAD.bottom

      // X axis uses the current zoom/pan window, not the full data range.
      const minT = viewStartT
      const maxT = viewEndT

      // Y axis: when the user has explicitly set viewYMin/Max we honor
      // them verbatim. Otherwise auto-fit starts from the global
      // p1/p99 `fluxRange` and is extended DOWNWARD to include any
      // sample in the current X window that falls below it. Reason:
      // deep narrow dips (Tabby's −22%, KIC 12557548) are sub-1% of
      // total samples, so even p1 misses them — the bottom of the
      // chart would just show the noise band. We extend with 5%
      // padding so the dip lands clearly above the axis line.
      let minF: number
      let maxF: number
      if (viewYMin !== null && viewYMax !== null) {
        minF = viewYMin
        maxF = viewYMax
      } else {
        minF = fluxRange.minF
        maxF = fluxRange.maxF
        // Find the first/last in-window indices via binary search
        // (times array is monotonic post-concatenation by the route).
        const t0 = viewStartT
        const t1 = viewEndT
        let lo = 0
        let hi = times.length
        while (lo < hi) {
          const mid = (lo + hi) >>> 1
          if (times[mid] < t0) lo = mid + 1
          else hi = mid
        }
        const firstIdx = lo
        lo = firstIdx
        hi = times.length
        while (lo < hi) {
          const mid = (lo + hi) >>> 1
          if (times[mid] <= t1) lo = mid + 1
          else hi = mid
        }
        const lastIdx = lo // exclusive
        // Scan the window for any flux below the auto-fit minF.
        let windowMin = Infinity
        for (let i = firstIdx; i < lastIdx; i++) {
          const f = cleanedFlux[i]
          if (f == null) continue
          if (f < windowMin) windowMin = f
        }
        if (windowMin < minF) {
          const range = maxF - windowMin
          minF = windowMin - range * 0.05
        }
      }

      const toX = (t: number) => PAD.left + ((t - minT) / (maxT - minT)) * plotW
      const toY = (f: number) => PAD.top + (1 - (f - minF) / (maxF - minF)) * plotH

      return { W, H, plotW, plotH, minT, maxT, minF, maxF, toX, toY }
    },
    [viewStartT, viewEndT, viewYMin, viewYMax, fluxRange, times, cleanedFlux, PAD.top, PAD.right, PAD.bottom, PAD.left],
  )

  /**
   * @description Renders one frame of the chart: grid, axes, baseline, shaded dip regions,
   * the partially-revealed curve, and (after halfway) labeled dip markers.
   * @param progress Reveal progress in [0, 1]; the curve is drawn up to this fraction of `times`.
   */
  const draw = useCallback(
    (progress: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const { W, H, plotW, plotH, minT, maxT, minF, maxF, toX, toY } = getCanvasCoords(canvas)

      ctx.clearRect(0, 0, W, H)

      // Grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      for (let i = 0; i <= 4; i++) {
        const y = PAD.top + (plotH / 4) * i
        ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke()
      }
      for (let i = 0; i <= 5; i++) {
        const x = PAD.left + (plotW / 5) * i
        ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, H - PAD.bottom); ctx.stroke()
      }

      // Axes labels
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '9px JetBrains Mono, monospace'
      ctx.textAlign = 'right'
      for (let i = 0; i <= 4; i++) {
        const f = minF + ((maxF - minF) / 4) * (4 - i)
        const y = PAD.top + (plotH / 4) * i
        ctx.fillText(f.toFixed(3), PAD.left - 4, y + 3)
      }
      ctx.textAlign = 'center'
      for (let i = 0; i <= 5; i++) {
        const t = minT + ((maxT - minT) / 5) * i
        const x = PAD.left + (plotW / 5) * i
        ctx.fillText(t.toFixed(0), x, H - PAD.bottom + 14)
      }

      // Axis labels
      ctx.save()
      ctx.translate(12, H / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(255,255,255,0.2)'
      ctx.font = '8px JetBrains Mono, monospace'
      ctx.fillText('FLUX NORM.', 0, 0)
      ctx.restore()
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(255,255,255,0.2)'
      ctx.font = '8px JetBrains Mono, monospace'
      ctx.fillText('TIME (BKJD)', PAD.left + plotW / 2, H - 4)

      // Baseline
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 6])
      const baseY = toY(1.0)
      ctx.beginPath(); ctx.moveTo(PAD.left, baseY); ctx.lineTo(W - PAD.right, baseY); ctx.stroke()
      ctx.setLineDash([])

      // Dip regions (shaded). Clip to the plot rect so wide shaded bands
      // don't leak into the axis area when the user zooms in on a dip.
      ctx.save()
      ctx.beginPath()
      ctx.rect(PAD.left, PAD.top, plotW, plotH)
      ctx.clip()
      dips.forEach(dip => {
        const dipEnd = dip.peakTime + dip.duration / 2
        const dipStart = dip.peakTime - dip.duration / 2
        if (dipEnd < minT || dipStart > maxT) return
        const x1 = toX(dipStart)
        const x2 = toX(dipEnd)
        const color = LABEL_COLOR[dip.label]
        ctx.fillStyle = color.startsWith('#') ? color + '18' : 'rgba(255,255,255,0.04)'
        ctx.fillRect(x1, PAD.top, x2 - x1, plotH)
      })
      ctx.restore()

      // Light curve line (animated reveal left to right). Stroke-only —
      // no fill under the line, no fill on the line itself. Null entries
      // in `cleanedFlux` (outliers) break the path so the line skips them
      // instead of drawing a spike to NaN. We also clip the canvas to the
      // plot rect so when zoomed in, partially-visible segments at the
      // edges don't bleed into the axis padding.
      const revealIdx = Math.floor(progress * times.length)
      if (revealIdx < 2) return

      ctx.save()
      ctx.beginPath()
      ctx.rect(PAD.left, PAD.top, plotW, plotH)
      ctx.clip()

      ctx.beginPath()
      ctx.strokeStyle = '#4cc9f0'
      ctx.lineWidth = 1.5
      ctx.shadowColor = '#4cc9f0'
      ctx.shadowBlur = 4

      // LTTB downsampling per contiguous segment.
      //
      // Splitting strategy: walk the visible window once, collecting
      // contiguous segments — break wherever a sample is null (outlier)
      // OR where two consecutive non-null samples are > GAP_DAYS apart
      // (Kepler inter-quarter gap). Each segment is then LTTB-reduced
      // to its proportional share of LTTB_TARGET_POINTS and stroked as
      // its own sub-path. No connection across breaks → gaps render as
      // empty canvas, which is astronomically correct.
      //
      // When a segment has few enough points (< ~plotW/2 samples) we
      // skip LTTB and just stroke every sample directly.
      const viewSpan = maxT - minT
      const xMargin = viewSpan * 0.02
      const winLo = minT - xMargin
      const winHi = maxT + xMargin

      // Locate the first/last in-window indices to bound the loop.
      let firstIdx = 0
      while (firstIdx < revealIdx && times[firstIdx] < winLo) firstIdx++
      let lastIdx = revealIdx - 1
      while (lastIdx > firstIdx && times[lastIdx] > winHi) lastIdx--

      // Build segments: each segment is a (xs, ys) pair of arrays for
      // LTTB. We push xs in pixel-x space so the LTTB area calculation
      // uses the same units the user perceives.
      const segments: { xs: number[]; ys: number[] }[] = []
      let curXs: number[] = []
      let curYs: number[] = []
      let prevT: number | null = null
      const startNewSegment = () => {
        if (curXs.length > 0) segments.push({ xs: curXs, ys: curYs })
        curXs = []
        curYs = []
      }
      for (let i = firstIdx; i <= lastIdx; i++) {
        const f = cleanedFlux[i]
        if (f == null) {
          startNewSegment()
          prevT = null
          continue
        }
        const t = times[i]
        if (prevT !== null && t - prevT > GAP_DAYS) startNewSegment()
        curXs.push(toX(t))
        curYs.push(toY(f))
        prevT = t
      }
      startNewSegment()

      // Allocate the LTTB point budget proportionally to segment size,
      // then apply a per-pixel-column dedupe pass before emitting any
      // strokes.
      //
      // The fill-artifact problem: at low zoom many post-LTTB points
      // still map to the same integer pixel column. Each adjacent pair
      // in the same column produces a vertical lineTo that visually
      // bridges the gap between up/down strokes via antialiasing,
      // accumulating into a solid block on high-frequency oscillators.
      //
      // Fix: walk the picked indices pairwise. When `floor(x[k]) ===
      // floor(x[k+1])`, drop the one whose y is closer to the median
      // line — keep the one whose flux deviates more. After this pass
      // each pixel column contributes at most 2 points to the stroke
      // (the entry point inherited from the previous column + at most
      // one survivor inside this column), which eliminates the fill.
      //
      // We compare against `toY(median)` because `ys` are already in
      // pixel space; |y - medianY| has the same ordering as |flux -
      // median| since `toY` is monotonic — no need to thread the raw
      // flux values back through here.
      const medianY = toY(fluxRange.median)
      const totalPoints = segments.reduce((s, seg) => s + seg.xs.length, 0)
      if (totalPoints > 0) {
        for (const seg of segments) {
          const segLen = seg.xs.length
          if (segLen < 2) continue
          let segBudget: number
          if (segLen <= plotW / 2 || totalPoints <= LTTB_TARGET_POINTS) {
            // Few enough samples that LTTB has nothing to gain — stroke
            // every point directly.
            segBudget = segLen
          } else {
            segBudget = Math.max(2, Math.round((segLen / totalPoints) * LTTB_TARGET_POINTS))
          }
          // Normalize both code paths to an index list `picked` so the
          // dedupe + emit loop has a single shape.
          let picked: number[]
          if (segBudget >= segLen) {
            picked = new Array(segLen)
            for (let k = 0; k < segLen; k++) picked[k] = k
          } else {
            picked = lttbIndices(seg.xs, seg.ys, segBudget)
          }

          // Per-pixel-column dedupe. We keep the first picked point
          // unconditionally (it's the segment's `moveTo` anchor), then
          // walk pairs and skip a candidate when its predecessor in the
          // accumulator shares the same column AND is further from
          // medianY. If the candidate is further, replace the
          // predecessor. Single pass, O(picked.length).
          const out: number[] = [picked[0]]
          for (let k = 1; k < picked.length; k++) {
            const idx = picked[k]
            const prevIdx = out[out.length - 1]
            const colCur = Math.floor(seg.xs[idx])
            const colPrev = Math.floor(seg.xs[prevIdx])
            if (colCur !== colPrev) {
              out.push(idx)
              continue
            }
            // Same column → keep the one further from medianY.
            const devCur = Math.abs(seg.ys[idx] - medianY)
            const devPrev = Math.abs(seg.ys[prevIdx] - medianY)
            if (devCur > devPrev) out[out.length - 1] = idx
            // else: keep prevIdx (drop current)
          }

          ctx.moveTo(seg.xs[out[0]], seg.ys[out[0]])
          for (let k = 1; k < out.length; k++) {
            const idx = out[k]
            ctx.lineTo(seg.xs[idx], seg.ys[idx])
          }
        }
      }
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.restore()

      // Dip markers (only after curve has passed them). Skip dips outside
      // the visible time window so the chart doesn't draw off-screen labels.
      //
      // Label collision (vertical stacking):
      // When many dips cluster within a short time span (e.g. periodic
      // transits on KIC 11610797), their text labels overlap into an
      // unreadable pile. Successive attempts:
      //   1. Suppress all but the highest-scoring in a 60-px x-window
      //      — hid too much; users couldn't tell which transit a label
      //      belonged to.
      //   2. Cascade y against immediately-previous label — still
      //      produced overlapping walls on dip-dense stars (KIC
      //      11610797) since later cascaded labels collided with
      //      labels two-or-more positions back, not just the prior.
      //   3. Bounding-box retry+suppress (4 attempts) — over-corrected
      //      and dropped almost all labels at wide zoom-out because
      //      every retry slot was also taken in dense regions.
      //
      // **Current behavior — bucket selection.** Partition the canvas
      // x-axis into fixed `LABEL_BUCKET_CSS_PX = 80` wide buckets.
      // For each bucket, pick the single highest-scoring visible dip
      // and render only that label. Dots still render for every
      // visible dip (so all transits remain hover/click targets).
      // Guarantees max one label per 80 CSS px of horizontal space →
      // evenly-spaced, never-overlapping labels at any zoom level.
      //
      // The bucket size is in CSS px, converted to canvas px per
      // render so spacing stays consistent across the 460-px inline
      // chart and the 1600-px fullscreen chart.
      if (progress > 0.5) {
        const LABEL_BUCKET_CSS_PX = 80
        const rect = canvas.getBoundingClientRect()
        const cssPxToCanvasPx = rect.width > 0 ? canvas.width / rect.width : 1
        const bucketWidth = LABEL_BUCKET_CSS_PX * cssPxToCanvasPx

        // Build the visible-dip render list and pick label winners by
        // bucket in a single pass.
        type DipRender = { dip: Anomaly; x: number; y: number }
        const renderList: DipRender[] = []
        // bucket index → winning dip's renderList index
        const bucketWinner = new Map<number, number>()
        for (const dip of dips) {
          if (dip.peakTime < minT || dip.peakTime > maxT) continue
          const x = toX(dip.peakTime)
          const dipFluxIdx = times.findIndex(t => t >= dip.peakTime)
          const dipFlux = dipFluxIdx >= 0 ? flux[dipFluxIdx] : 0.98
          const y = toY(dipFlux)
          const idx = renderList.length
          renderList.push({ dip, x, y })
          const bucket = Math.floor(x / bucketWidth)
          const existingIdx = bucketWinner.get(bucket)
          if (existingIdx === undefined || dip.score > renderList[existingIdx].dip.score) {
            bucketWinner.set(bucket, idx)
          }
        }

        // Single draw pass — dot for every visible dip; label only
        // for the bucket winners.
        const labelWinners = new Set(bucketWinner.values())
        for (let i = 0; i < renderList.length; i++) {
          const { dip, x, y } = renderList[i]
          const color = LABEL_COLOR[dip.label]
          ctx.beginPath()
          ctx.arc(x, y, 4, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.shadowColor = color
          ctx.shadowBlur = 8
          ctx.fill()
          ctx.shadowBlur = 0
          if (!labelWinners.has(i)) continue
          ctx.fillStyle = color
          ctx.font = '8px JetBrains Mono, monospace'
          ctx.textAlign = 'center'
          ctx.fillText(dip.label, x, y - 10)
        }
      }
    },
    [times, flux, cleanedFlux, dips, getCanvasCoords, PAD.top, PAD.right, PAD.bottom, PAD.left],
  )

  // Reveal animation: drive `progressRef` 0→1 over 1.8s when the underlying
  // data changes (i.e. user selected a different star). Deliberately
  // depends only on `times`/`flux` — NOT on `draw` — so zoom/pan doesn't
  // restart the animation every wheel tick.
  useEffect(() => {
    progressRef.current = 0
    const start = performance.now()
    const duration = 1800

    /** @description rAF callback that drives the ease-out reveal animation. */
    function animate(now: number) {
      const t = Math.min((now - start) / duration, 1)
      progressRef.current = 1 - Math.pow(1 - t, 3) // ease-out cubic
      draw(progressRef.current)
      if (t < 1) animRef.current = requestAnimationFrame(animate)
    }

    animRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times, flux])

  // Redraw on zoom/pan or other view changes without restarting the reveal.
  // Uses the current `progressRef` value so a partial reveal stays partial.
  // The redraw is debounced through rAF so a burst of wheel events collapses
  // into a single paint per frame instead of one per event.
  const pendingRedrawRef = useRef(0)
  useEffect(() => {
    if (pendingRedrawRef.current) cancelAnimationFrame(pendingRedrawRef.current)
    pendingRedrawRef.current = requestAnimationFrame(() => {
      pendingRedrawRef.current = 0
      draw(progressRef.current)
    })
    return () => {
      if (pendingRedrawRef.current) {
        cancelAnimationFrame(pendingRedrawRef.current)
        pendingRedrawRef.current = 0
      }
    }
  }, [draw])

  // Attach a native (non-passive) wheel listener so we can call
  // preventDefault and stop the page from scrolling when zooming the chart.
  // React's synthetic onWheel handlers are passive in modern browsers and
  // preventDefault becomes a no-op there.
  useEffect(() => {
    if (!interactive) return
    const canvas = canvasRef.current
    if (!canvas) return
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const cssPerPxX = canvas.width / rect.width
      const cssPerPxY = canvas.height / rect.height
      const mx = (e.clientX - rect.left) * cssPerPxX
      const my = (e.clientY - rect.top) * cssPerPxY
      const plotW = canvas.width - PAD.left - PAD.right
      const plotH = canvas.height - PAD.top - PAD.bottom

      if (e.shiftKey) {
        // Y zoom uses a much gentler 1.05/tick factor — at the typical
        // flux scale (range ~0.01) a 1.25/tick step felt like jumping
        // an entire pane per scroll click. 1.05 gives ~14 ticks to
        // halve the visible range, which is comfortable.
        const yFactor = e.deltaY < 0 ? 1 / 1.05 : 1.05
        const curMin = viewYMin ?? fluxRange.minF
        const curMax = viewYMax ?? fluxRange.maxF
        const cursorFracY = Math.max(0, Math.min(1, (my - PAD.top) / plotH))
        // Higher pixel y = lower flux (chart is y-flipped)
        const cursorF = curMax - cursorFracY * (curMax - curMin)
        const span = curMax - curMin
        // Y zoom range is generous on both ends — let the user inspect
        // 0.0001-scale wiggles AND zoom out to see the full data.
        const dataSpan = Math.max(fluxRange.maxF - fluxRange.minF, 1e-6)
        const minYSpan = dataSpan * 0.001
        const maxYSpan = dataSpan * 10
        const newSpan = Math.max(minYSpan, Math.min(maxYSpan, span * yFactor))
        const newMax = cursorF + cursorFracY * newSpan
        const newMin = newMax - newSpan
        setViewYMin(newMin)
        setViewYMax(newMax)
      } else {
        // X zoom around the cursor (existing behavior).
        const xFactor = e.deltaY < 0 ? 1 / 1.25 : 1.25
        const cursorFrac = Math.max(0, Math.min(1, (mx - PAD.left) / plotW))
        const cursorT = viewStartT + cursorFrac * (viewEndT - viewStartT)
        const newSpan = (viewEndT - viewStartT) * xFactor
        const minSpan = (fullEnd - fullStart) * 0.001
        const maxSpan = fullEnd - fullStart
        const clampedSpan = Math.max(minSpan, Math.min(maxSpan, newSpan))
        let newStart = cursorT - cursorFrac * clampedSpan
        let newEnd = newStart + clampedSpan
        if (newStart < fullStart) { newStart = fullStart; newEnd = newStart + clampedSpan }
        if (newEnd > fullEnd) { newEnd = fullEnd; newStart = newEnd - clampedSpan }
        setViewStartT(newStart)
        setViewEndT(newEnd)
      }
    }
    canvas.addEventListener('wheel', onNativeWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onNativeWheel)
  }, [interactive, viewStartT, viewEndT, viewYMin, viewYMax, fluxRange, fullStart, fullEnd, PAD.left, PAD.right, PAD.top, PAD.bottom])

  // Drag state lives in a ref so the rAF-driven redraw doesn't re-render
  // the component on every pointermove (we just mutate viewStartT/viewEndT).
  // `moved` and `startedAt` let pointer-up distinguish a click (no
  // movement, short) from a real drag — clicks trigger dip hit-testing.
  const dragRef = useRef<{
    startClientX: number
    startClientY: number
    startViewT0: number
    startViewT1: number
    // Y baseline captured at down-time; only consulted when the drag is a
    // Y-pan (shiftKey held at pointerdown). Stored as concrete numbers
    // even when the user is in auto-fit mode so the pan is grounded.
    startViewY0: number
    startViewY1: number
    // True if the user held shift when pressing down. We lock the mode at
    // press time so releasing shift mid-drag doesn't flip-flop the axis.
    panY: boolean
    moved: boolean
    startedAt: number
  } | null>(null)

  /**
   * @description Hover handler: hit-tests against (a) dip markers for the
   * standard dip tooltip and (b) inter-quarter gap regions for the gap
   * explanation tooltip. Suppressed while a drag-to-pan is in flight.
   * @param e React mouse event from the canvas.
   */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (dragRef.current) return // mid-drag, skip tooltip work
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const cssPerPxX = canvas.width / rect.width
      const cssPerPxY = canvas.height / rect.height
      const mx = (e.clientX - rect.left) * cssPerPxX
      const my = (e.clientY - rect.top) * cssPerPxY

      const { toX } = getCanvasCoords(canvas)
      const cssX = e.clientX - rect.left
      const cssY = e.clientY - rect.top

      // Dip hit-test (existing behavior)
      let nearest: Tooltip | null = null
      let minDist = 20
      dips.forEach(dip => {
        const dx = Math.abs(toX(dip.peakTime) - mx)
        if (dx < minDist) {
          minDist = dx
          nearest = { x: cssX, y: cssY, dip }
        }
      })
      setTooltip(nearest)

      // Gap hit-test: cursor inside the plot rect AND between the start/
      // end pixel-x of an inter-quarter gap. A dip tooltip takes priority
      // (already shown above) so we don't double up.
      const plotH = canvas.height - PAD.top - PAD.bottom
      const insidePlotY = my >= PAD.top && my <= PAD.top + plotH
      const insidePlotX = mx >= PAD.left && mx <= canvas.width - PAD.right
      let gap: { x: number; y: number; days: number } | null = null
      if (insidePlotX && insidePlotY && !nearest) {
        for (const g of gapRegions) {
          const gx0 = toX(g.start)
          const gx1 = toX(g.end)
          if (mx >= gx0 && mx <= gx1) {
            gap = { x: cssX, y: cssY, days: g.days }
            break
          }
        }
      }
      setGapHover(gap)
    },
    [dips, gapRegions, getCanvasCoords, PAD.top, PAD.bottom, PAD.left, PAD.right],
  )

  /**
   * @description Begin a drag-to-pan gesture. Stores the starting cursor X and
   * current window so `handlePointerMove` can compute the pan delta in
   * time-space without accumulating float error.
   */
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return
      // Only left-click drags
      if (e.button !== 0) return
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.setPointerCapture(e.pointerId)
      dragRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startViewT0: viewStartT,
        startViewT1: viewEndT,
        // Snapshot the current EFFECTIVE Y range (auto-fit or user-set).
        // If the user is in auto-fit and shift-drags, we capture the
        // p2/p98 numbers so the pan starts smoothly from what's on screen.
        startViewY0: viewYMin ?? fluxRange.minF,
        startViewY1: viewYMax ?? fluxRange.maxF,
        panY: e.shiftKey,
        moved: false,
        startedAt: performance.now(),
      }
      setTooltip(null)
    },
    [interactive, viewStartT, viewEndT, viewYMin, viewYMax, fluxRange],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragRef.current) return
      const canvas = canvasRef.current
      if (!canvas) return
      // Threshold: any movement >5 CSS px from the down position counts as
      // a drag (so we DON'T treat the pointer-up as a click).
      const dxAbs = Math.abs(e.clientX - dragRef.current.startClientX)
      const dyAbs = Math.abs(e.clientY - dragRef.current.startClientY)
      if (!dragRef.current.moved && (dxAbs > 5 || dyAbs > 5)) {
        dragRef.current.moved = true
      }
      if (!dragRef.current.moved) return // sub-threshold wiggle — don't pan yet
      const rect = canvas.getBoundingClientRect()
      const cssPerPxX = canvas.width / rect.width
      const cssPerPxY = canvas.height / rect.height

      if (dragRef.current.panY) {
        // Y pan: drag down → window moves DOWN in flux (so the content
        // visually scrolls up under the cursor). No clamping to data
        // bounds — the user is free to pan into empty space, same as
        // most chart tools. RESET Y / double-click brings them back.
        const dyCss = e.clientY - dragRef.current.startClientY
        const dyCanvas = dyCss * cssPerPxY
        const plotH = canvas.height - PAD.top - PAD.bottom
        const yspan = dragRef.current.startViewY1 - dragRef.current.startViewY0
        // Pixel y grows downward; flux grows upward → drag-down = flux-down
        const df = (dyCanvas / plotH) * yspan
        setViewYMin(dragRef.current.startViewY0 + df)
        setViewYMax(dragRef.current.startViewY1 + df)
      } else {
        // X pan (default).
        const dxCss = e.clientX - dragRef.current.startClientX
        const dxCanvas = dxCss * cssPerPxX
        const plotW = canvas.width - PAD.left - PAD.right
        const span = dragRef.current.startViewT1 - dragRef.current.startViewT0
        // Drag right = move window LEFT in time (panning the content)
        const dt = -(dxCanvas / plotW) * span

        let newStart = dragRef.current.startViewT0 + dt
        let newEnd = dragRef.current.startViewT1 + dt
        if (newStart < fullStart) { const adj = fullStart - newStart; newStart += adj; newEnd += adj }
        if (newEnd > fullEnd) { const adj = newEnd - fullEnd; newStart -= adj; newEnd -= adj }
        setViewStartT(newStart)
        setViewEndT(newEnd)
      }
    },
    [fullStart, fullEnd, PAD.left, PAD.right, PAD.top, PAD.bottom],
  )

  /**
   * @description Pointer-up handler. If the gesture was a click (no movement
   * past threshold, short duration), runs dip-marker hit-testing: a hit
   * pins the dip + zooms to it; a miss dismisses any currently-pinned dip.
   * If it was a real drag, just releases pointer capture.
   */
  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragRef.current) return
      const canvas = canvasRef.current
      canvas?.releasePointerCapture(e.pointerId)
      const wasClick =
        !dragRef.current.moved &&
        performance.now() - dragRef.current.startedAt < 300
      dragRef.current = null
      if (!wasClick || !canvas) return

      // Hit-test against visible dip markers. The draw loop places a marker
      // at (toX(dip.peakTime), toY(fluxAtPeak)) with radius 4 px; we accept
      // clicks within HIT_RADIUS_PX of that center.
      const rect = canvas.getBoundingClientRect()
      const cssPerPx = canvas.width / rect.width
      const cx = (e.clientX - rect.left) * cssPerPx
      const cy = (e.clientY - rect.top) * cssPerPx
      const { toX, toY } = getCanvasCoords(canvas)
      const HIT_RADIUS_PX = 12 * cssPerPx
      let best: Anomaly | null = null
      let bestD2 = HIT_RADIUS_PX * HIT_RADIUS_PX
      for (const dip of dips) {
        if (dip.peakTime < viewStartT || dip.peakTime > viewEndT) continue
        const idx = times.findIndex(t => t >= dip.peakTime)
        const fluxAtPeak = idx >= 0 ? flux[idx] : 0.98
        const dx = toX(dip.peakTime) - cx
        const dy = toY(fluxAtPeak) - cy
        const d2 = dx * dx + dy * dy
        if (d2 < bestD2) { bestD2 = d2; best = dip }
      }
      if (best) {
        setPinnedDip(best)
        // Zoom to center the dip with context. Window width is at least
        // 8× the dip duration, never tighter than 2% of the full range.
        const fullSpan = fullEnd - fullStart
        const desired = Math.max(best.duration * 8, fullSpan * 0.02)
        const span = Math.min(desired, fullSpan)
        let s = best.peakTime - span / 2
        let en = best.peakTime + span / 2
        if (s < fullStart) { en += fullStart - s; s = fullStart }
        if (en > fullEnd) { s -= en - fullEnd; en = fullEnd }
        setViewStartT(s)
        setViewEndT(en)
      } else {
        // Click on empty chart space dismisses any pinned dip
        setPinnedDip(null)
      }
    },
    [dips, times, flux, viewStartT, viewEndT, fullStart, fullEnd, getCanvasCoords],
  )

  /**
   * @description Double-click anywhere on the chart resets the view —
   * both the X (time) window and the Y (flux) zoom — to their auto-fit
   * defaults. Setting Y back to null makes `getCanvasCoords` fall back
   * to the p2/p98 `fluxRange`.
   */
  const handleDoubleClick = useCallback(() => {
    if (!interactive) return
    setViewStartT(fullStart)
    setViewEndT(fullEnd)
    setViewYMin(null)
    setViewYMax(null)
  }, [interactive, fullStart, fullEnd])

  /**
   * @description Resets just the Y zoom back to auto-fit (p2/p98). Used
   * by the explicit "RESET Y" button so the user can rescale flux
   * without losing their current X zoom.
   */
  const handleResetY = useCallback(() => {
    setViewYMin(null)
    setViewYMax(null)
  }, [])

  // Convenience: is Y currently auto-fit? Drives whether to show the
  // RESET Y affordance as enabled/highlighted.
  const isYAutoFit = viewYMin === null && viewYMax === null

  /**
   * @description Renders the minimap strip below the main chart: a tiny
   * version of the full light curve with a translucent cyan rectangle
   * highlighting the currently-visible window. Uses simple Math.min/max for
   * the y-range since we're showing the whole thing, including outliers
   * (they'll appear as small spikes, which is fine at this scale).
   */
  const drawMinimap = useCallback(() => {
    const canvas = minimapRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height

    ctx.clearRect(0, 0, W, H)

    // Background
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, W, H)

    // Use the same percentile-padded range as the main chart so spikes
    // don't squash the mini-line either.
    const { minF, maxF } = fluxRange
    const toMx = (t: number) => ((t - fullStart) / (fullEnd - fullStart)) * W
    const toMy = (f: number) => (1 - (f - minF) / (maxF - minF)) * H

    // LTTB downsampling per segment, same algorithm as the main chart.
    // Quarter-scale gaps (>GAP_DAYS) split segments so the minimap
    // shows empty space between Kepler observation runs instead of a
    // diagonal bridge.
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(76,201,240,0.55)'
    ctx.lineWidth = 1

    const segments: { xs: number[]; ys: number[] }[] = []
    let curXs: number[] = []
    let curYs: number[] = []
    let prevSampleT: number | null = null
    const startNewSegment = () => {
      if (curXs.length > 0) segments.push({ xs: curXs, ys: curYs })
      curXs = []
      curYs = []
    }
    for (let i = 0; i < times.length; i++) {
      const f = cleanedFlux[i]
      if (f == null) {
        startNewSegment()
        prevSampleT = null
        continue
      }
      const t = times[i]
      if (prevSampleT !== null && t - prevSampleT > GAP_DAYS) startNewSegment()
      curXs.push(toMx(t))
      curYs.push(toMy(f))
      prevSampleT = t
    }
    startNewSegment()

    // The minimap is small — target ~W output points total, so each
    // segment gets its proportional share. Below that, LTTB is overkill;
    // just stroke every point.
    const totalPoints = segments.reduce((s, seg) => s + seg.xs.length, 0)
    const target = Math.min(totalPoints, W * 2)
    for (const seg of segments) {
      const segLen = seg.xs.length
      if (segLen < 2) continue
      const segBudget = totalPoints <= target
        ? segLen
        : Math.max(2, Math.round((segLen / totalPoints) * target))
      const picked = segBudget >= segLen ? null : lttbIndices(seg.xs, seg.ys, segBudget)
      ctx.moveTo(seg.xs[0], seg.ys[0])
      if (picked === null) {
        for (let k = 1; k < segLen; k++) ctx.lineTo(seg.xs[k], seg.ys[k])
      } else {
        for (let k = 1; k < picked.length; k++) {
          const idx = picked[k]
          ctx.lineTo(seg.xs[idx], seg.ys[idx])
        }
      }
    }
    ctx.stroke()

    // Window indicator
    const wx1 = toMx(viewStartT)
    const wx2 = toMx(viewEndT)
    ctx.fillStyle = 'rgba(76,201,240,0.15)'
    ctx.fillRect(wx1, 0, wx2 - wx1, H)
    ctx.strokeStyle = 'rgba(76,201,240,0.7)'
    ctx.lineWidth = 1
    ctx.strokeRect(wx1 + 0.5, 0.5, Math.max(1, wx2 - wx1 - 1), H - 1)
  }, [times, cleanedFlux, fluxRange, viewStartT, viewEndT, fullStart, fullEnd])

  // Redraw minimap whenever data or window changes
  useEffect(() => {
    if (interactive) drawMinimap()
  }, [interactive, drawMinimap])

  /**
   * @description Click on the minimap to center the visible window on the
   * clicked time. Preserves current zoom level.
   */
  const handleMinimapClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = minimapRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const frac = (e.clientX - rect.left) / rect.width
      const targetT = fullStart + frac * (fullEnd - fullStart)
      const span = viewEndT - viewStartT
      let newStart = targetT - span / 2
      let newEnd = newStart + span
      if (newStart < fullStart) { newStart = fullStart; newEnd = newStart + span }
      if (newEnd > fullEnd) { newEnd = fullEnd; newStart = newEnd - span }
      setViewStartT(newStart)
      setViewEndT(newEnd)
    },
    [fullStart, fullEnd, viewStartT, viewEndT],
  )

  return (
    <div
      style={{
        position: 'relative',
        ...(fillContainer
          ? { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }
          : null),
      }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{
          width: '100%',
          // In fillContainer mode the canvas flexes; the `height` prop only
          // controls the pixel buffer used for rasterization, not layout.
          ...(fillContainer
            ? { flex: 1, minHeight: 0, height: 'auto' }
            : { height }),
          display: 'block',
          cursor: interactive ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
          touchAction: interactive ? 'none' : 'auto',
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { setTooltip(null); setGapHover(null) }}
        onPointerDown={interactive ? handlePointerDown : undefined}
        onPointerMove={interactive ? handlePointerMove : undefined}
        onPointerUp={interactive ? handlePointerUp : undefined}
        onPointerCancel={interactive ? handlePointerUp : undefined}
        onDoubleClick={interactive ? handleDoubleClick : undefined}
      />
      {interactive && (
        <canvas
          ref={minimapRef}
          width={width}
          height={MINIMAP_H * 2}
          onClick={handleMinimapClick}
          style={{
            width: '100%',
            height: MINIMAP_H,
            display: 'block',
            marginTop: 6,
            cursor: 'pointer',
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        />
      )}
      {interactive && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            marginTop: 4,
          }}
        >
          <div
            style={{
              fontSize: 8,
              color: 'rgba(255,255,255,0.4)',
              letterSpacing: 1.5,
              textAlign: 'center',
            }}
          >
            SCROLL = ZOOM X · SHIFT+SCROLL = ZOOM Y · DRAG = PAN X · SHIFT+DRAG = PAN Y · CLICK DIP TO INSPECT · DOUBLE-CLICK TO RESET
          </div>
          <button
            type="button"
            onClick={handleResetY}
            disabled={isYAutoFit}
            style={{
              fontSize: 8,
              letterSpacing: 1.5,
              padding: '2px 8px',
              borderRadius: 3,
              border: '1px solid rgba(76,201,240,0.4)',
              background: isYAutoFit ? 'rgba(76,201,240,0.06)' : 'rgba(76,201,240,0.18)',
              color: isYAutoFit ? 'rgba(255,255,255,0.3)' : '#4cc9f0',
              cursor: isYAutoFit ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            RESET Y
          </button>
        </div>
      )}
      {tooltip && !pinnedDip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x + 12,
            top: tooltip.y - 10,
            background: 'rgba(0,0,0,0.9)',
            border: `1px solid ${LABEL_COLOR[tooltip.dip.label]}55`,
            borderRadius: 6,
            padding: '8px 12px',
            fontSize: 9,
            fontFamily: 'JetBrains Mono, monospace',
            pointerEvents: 'none',
            zIndex: 99,
            minWidth: 140,
          }}
        >
          <div style={{ color: LABEL_COLOR[tooltip.dip.label], fontWeight: 700, marginBottom: 4 }}>
            {tooltip.dip.label}
          </div>
          <div style={{ color: 'rgba(255,255,255,0.6)', lineHeight: 1.7 }}>
            Score: {Math.round(tooltip.dip.score * 100)}%<br />
            Depth: -{(tooltip.dip.depth * 100).toFixed(2)}%<br />
            Duration: {tooltip.dip.duration.toFixed(2)}d<br />
            Peak: {tooltip.dip.peakTime.toFixed(2)} BKJD
          </div>
        </div>
      )}
      {gapHover && !tooltip && !pinnedDip && (
        <div
          style={{
            position: 'absolute',
            left: gapHover.x + 12,
            top: gapHover.y - 10,
            background: 'rgba(0,0,0,0.88)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4,
            padding: '6px 9px',
            fontSize: 9,
            fontFamily: 'JetBrains Mono, monospace',
            color: 'rgba(255,255,255,0.7)',
            letterSpacing: 0.5,
            pointerEvents: 'none',
            zIndex: 98,
            maxWidth: 220,
            lineHeight: 1.5,
          }}
        >
          Kepler observation gap<br />
          <span style={{ color: 'rgba(255,255,255,0.4)' }}>
            telescope reorientation · {gapHover.days.toFixed(1)} days
          </span>
        </div>
      )}
      {pinnedDip && (
        <PinnedDipTooltip
          dip={pinnedDip}
          provenance={provenance}
          onDismiss={() => setPinnedDip(null)}
        />
      )}
      {/* Legend — only shown for the inline (non-interactive) chart. The
          fullscreen overlay renders its own larger legend below the chart
          so we'd otherwise duplicate it. */}
      {!interactive && (
        <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
          {Object.entries(LABEL_COLOR).map(([label, color]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
              <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.35)', letterSpacing: 1 }}>{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * @description Sticky tooltip card pinned by clicking a dip marker in
 * the interactive chart. Anchored top-right of the chart so it stays
 * visible regardless of where the dip moves to after the zoom-to. Shows
 * the full dip summary (label, score, depth, duration, peak time) plus
 * the data provenance line when available. Click the ✕ to dismiss.
 * @param dip The pinned anomaly.
 * @param provenance Optional source/mission/dataType labels.
 * @param onDismiss Called when the user closes the tooltip.
 * @returns Absolutely-positioned card inside the chart container.
 */
function PinnedDipTooltip({
  dip,
  provenance,
  onDismiss,
}: {
  dip: Anomaly
  provenance?: LightcurveProvenance
  onDismiss: () => void
}) {
  const accent = LABEL_COLOR[dip.label]
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        background: 'rgba(0,0,0,0.92)',
        border: `1px solid ${accent}88`,
        borderRadius: 6,
        padding: '10px 12px 10px 14px',
        fontSize: 10,
        fontFamily: 'JetBrains Mono, monospace',
        zIndex: 99,
        minWidth: 200,
        boxShadow: `0 0 16px ${accent}33`,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: accent, fontWeight: 700, letterSpacing: 1 }}>
          {dip.label}
        </span>
        <button
          onClick={onDismiss}
          aria-label="Dismiss pinned dip"
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(255,255,255,0.5)',
            fontSize: 13,
            cursor: 'pointer',
            lineHeight: 1,
            padding: 0,
            marginLeft: 12,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ color: 'rgba(255,255,255,0.75)', lineHeight: 1.7 }}>
        Score: {Math.round(dip.score * 100)}%<br />
        Depth: −{(dip.depth * 100).toFixed(2)}%<br />
        Duration: {dip.duration.toFixed(2)} d<br />
        Peak: {dip.peakTime.toFixed(2)} BKJD
      </div>
      {provenance && (
        <div
          style={{
            marginTop: 8,
            paddingTop: 6,
            borderTop: '1px solid rgba(255,255,255,0.1)',
            fontSize: 8,
            color: 'rgba(255,255,255,0.45)',
            letterSpacing: 0.5,
            lineHeight: 1.5,
          }}
        >
          Source: {provenance.sourceName} · {provenance.mission} · {provenance.dataType}
        </div>
      )}
    </div>
  )
}
