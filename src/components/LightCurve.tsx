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
 * Expects a single contiguous segment — callers handle splitting around
 * nulls and quarter gaps so each segment renders as its own sub-path.
 * @param xs x coordinates of the source samples (must be monotonic).
 * @param ys y coordinates of the source samples (same length as xs).
 * @param threshold Target output count (returns input unchanged if <= 2 or >= xs.length).
 * @returns Indices into the source arrays of the selected samples.
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
  // Reset pinned tooltip whenever the dataset changes (new star selected).
  useEffect(() => { setPinnedDip(null) }, [times, flux])

  // Time window currently visible on the X axis. Defaults to the full data
  // range. Wheel/drag mutate this; double-click resets to full.
  const fullStart = times[0]
  const fullEnd = times[times.length - 1]
  const [viewStartT, setViewStartT] = useState(fullStart)
  const [viewEndT, setViewEndT] = useState(fullEnd)
  // Reset window when the underlying data changes (selecting a different star)
  useEffect(() => {
    setViewStartT(times[0])
    setViewEndT(times[times.length - 1])
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
  // occasional cosmic-ray hits and spacecraft artifacts that read as flux
  // values 50× the median or near-zero — keeping them collapses the entire
  // legitimate flux range to a hairline at the bottom of the chart (which
  // is what made KIC 6543674 look like a solid filled blob). Replacing
  // them with null lets the draw loop skip those samples and start a new
  // sub-path so the line itself stays gap-aware.
  const cleanedFlux = useMemo(
    () => flux.map(f => (f > 1.05 || f < 0.5 ? null : f)),
    [flux],
  )

  // Percentile-based Y range using p2/p98. The previous version capped
  // the range to median ± 0.15 to defend against cosmic-ray survivors,
  // but that also clipped legitimate stellar variability on intrinsic
  // variables. With p2/p98 we exclude the top/bottom 2% — out of ~60k
  // samples that's >1200 samples on each side, more than enough cushion
  // for the few cosmic rays that pass the outlier filter. Real
  // variations are never clipped.
  const fluxRange = useMemo(() => {
    const finite = cleanedFlux.filter((f): f is number => f != null)
    if (finite.length === 0) return { minF: 0.95, maxF: 1.05, median: 1.0 }
    const sorted = [...finite].sort((a, b) => a - b)
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    const p2 = pick(0.02)
    const p98 = pick(0.98)
    const median = pick(0.5)
    const pad = (p98 - p2) * 0.10
    return { minF: p2 - pad, maxF: p98 + pad, median }
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
      const { minF, maxF } = fluxRange

      const toX = (t: number) => PAD.left + ((t - minT) / (maxT - minT)) * plotW
      const toY = (f: number) => PAD.top + (1 - (f - minF) / (maxF - minF)) * plotH

      return { W, H, plotW, plotH, minT, maxT, minF, maxF, toX, toY }
    },
    [viewStartT, viewEndT, fluxRange, PAD.top, PAD.right, PAD.bottom, PAD.left],
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

      // Allocate the LTTB point budget proportionally to segment size.
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
          const picked = segBudget >= segLen
            ? null // sentinel: draw all
            : lttbIndices(seg.xs, seg.ys, segBudget)
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
      }
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.restore()

      // Dip markers (only after curve has passed them). Skip dips outside
      // the visible time window so the chart doesn't draw off-screen labels.
      //
      // Label collision: when many dips cluster within a short time span
      // (e.g. periodic dips in KIC 11610797), their text labels overlap
      // into an unreadable pile. We always draw the dot, but suppress the
      // text label if another HIGHER-scoring dip already has a label
      // within LABEL_COLLISION_PX of this dip's x position. Sort by
      // descending score so winners get processed first.
      if (progress > 0.5) {
        const LABEL_COLLISION_PX = 40
        const visible: { dip: Anomaly; x: number; y: number }[] = []
        for (const dip of dips) {
          if (dip.peakTime < minT || dip.peakTime > maxT) continue
          const x = toX(dip.peakTime)
          const dipFluxIdx = times.findIndex(t => t >= dip.peakTime)
          const dipFlux = dipFluxIdx >= 0 ? flux[dipFluxIdx] : 0.98
          const y = toY(dipFlux)
          visible.push({ dip, x, y })
        }
        // Sort copy by score desc so the highest-scoring dip in any cluster
        // wins the label; we keep `visible` for the dot pass so original
        // chronological order is irrelevant.
        const ranked = [...visible].sort((a, b) => b.dip.score - a.dip.score)
        const labeledXs: number[] = []
        const dipsWithLabel = new Set<Anomaly>()
        for (const { dip, x } of ranked) {
          let blocked = false
          for (const lx of labeledXs) {
            if (Math.abs(lx - x) < LABEL_COLLISION_PX) { blocked = true; break }
          }
          if (!blocked) {
            labeledXs.push(x)
            dipsWithLabel.add(dip)
          }
        }
        for (const { dip, x, y } of visible) {
          const color = LABEL_COLOR[dip.label]
          ctx.beginPath()
          ctx.arc(x, y, 4, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.shadowColor = color
          ctx.shadowBlur = 8
          ctx.fill()
          ctx.shadowBlur = 0
          if (dipsWithLabel.has(dip)) {
            ctx.fillStyle = color
            ctx.font = '8px JetBrains Mono, monospace'
            ctx.textAlign = 'center'
            ctx.fillText(dip.label, x, y - 10)
          }
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
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width)
      const plotW = canvas.width - PAD.left - PAD.right
      const cursorFrac = Math.max(0, Math.min(1, (mx - PAD.left) / plotW))
      const cursorT = viewStartT + cursorFrac * (viewEndT - viewStartT)

      const factor = e.deltaY < 0 ? 1 / 1.25 : 1.25
      const newSpan = (viewEndT - viewStartT) * factor
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
    canvas.addEventListener('wheel', onNativeWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onNativeWheel)
  }, [interactive, viewStartT, viewEndT, fullStart, fullEnd, PAD.left, PAD.right])

  // Drag state lives in a ref so the rAF-driven redraw doesn't re-render
  // the component on every pointermove (we just mutate viewStartT/viewEndT).
  // `moved` and `startedAt` let pointer-up distinguish a click (no
  // movement, short) from a real drag — clicks trigger dip hit-testing.
  const dragRef = useRef<{
    startClientX: number
    startClientY: number
    startViewT0: number
    startViewT1: number
    moved: boolean
    startedAt: number
  } | null>(null)

  /**
   * @description Finds the dip nearest the cursor's X position (within ~20 px) and sets it
   * as the active tooltip, or clears the tooltip if no dip is close enough.
   * Suppressed while a drag-to-pan is in flight.
   * @param e React mouse event from the canvas.
   */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (dragRef.current) return // mid-drag, skip tooltip work
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width)

      const { toX } = getCanvasCoords(canvas)

      let nearest: Tooltip | null = null
      let minDist = 20

      dips.forEach(dip => {
        const dx = Math.abs(toX(dip.peakTime) - mx)
        if (dx < minDist) {
          minDist = dx
          nearest = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            dip,
          }
        }
      })
      setTooltip(nearest)
    },
    [dips, getCanvasCoords],
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
        moved: false,
        startedAt: performance.now(),
      }
      setTooltip(null)
    },
    [interactive, viewStartT, viewEndT],
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
      const cssPerPx = canvas.width / rect.width
      const dxCss = e.clientX - dragRef.current.startClientX
      const dxCanvas = dxCss * cssPerPx
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
    },
    [fullStart, fullEnd, PAD.left, PAD.right],
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
   * @description Double-click anywhere on the chart resets the view to the
   * full data range.
   */
  const handleDoubleClick = useCallback(() => {
    if (!interactive) return
    setViewStartT(fullStart)
    setViewEndT(fullEnd)
  }, [interactive, fullStart, fullEnd])

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
        onMouseLeave={() => setTooltip(null)}
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
            fontSize: 8,
            color: 'rgba(255,255,255,0.4)',
            letterSpacing: 1.5,
            marginTop: 4,
            textAlign: 'center',
          }}
        >
          SCROLL TO ZOOM · DRAG TO PAN · CLICK DIP TO INSPECT · DOUBLE-CLICK TO RESET · CLICK MINIMAP TO JUMP
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
