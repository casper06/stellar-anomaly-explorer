'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Anomaly } from '@/lib/store'

const LABEL_COLOR: Record<string, string> = {
  WOW: '#ff4d6d',
  INTERESTING: '#f4a261',
  NOTABLE: '#4cc9f0',
  NORMAL: 'rgba(255,255,255,0.3)',
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
export default function LightCurve({ times, flux, dips, width = 460, height = 200, interactive = false, fillContainer = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const minimapRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const progressRef = useRef(0)
  const [tooltip, setTooltip] = useState<Tooltip | null>(null)

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

  // Percentile-based Y range. Min/max is fragile on raw Kepler PDC data:
  // even after dropping >1.05 / <0.5 outliers, a handful of survivors at
  // ~1.04 or ~0.55 still squash the legitimate ±1% flux band into a
  // hairline. Take p5/p95 with 20% padding for breathing room, then HARD
  // CAP the half-window to ±0.15 around the median so the visible range
  // can never exceed 0.30 regardless of how weird the data is. A normal
  // star has p5/p95 much tighter than ±0.15, so the cap is dormant.
  const fluxRange = useMemo(() => {
    const finite = cleanedFlux.filter((f): f is number => f != null)
    if (finite.length === 0) return { minF: 0.95, maxF: 1.05, median: 1.0 }
    const sorted = [...finite].sort((a, b) => a - b)
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    const p5 = pick(0.05)
    const p95 = pick(0.95)
    const median = pick(0.5)
    const pad = (p95 - p5) * 0.20
    const lo = Math.max(p5 - pad, median - 0.15)
    const hi = Math.min(p95 + pad, median + 0.15)
    return { minF: lo, maxF: hi, median }
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

      // Adaptive downsampling: at full zoom-out, render at most ~2000
      // points (stroking 60k points into 1500 horizontal pixels makes the
      // line look like a solid filled band AND tanks the wheel-zoom frame
      // rate). When zoomed in below 10% of the total range we render at
      // full resolution since each sample then occupies more than one
      // pixel and detail matters. Between 10% and 100% the stride scales
      // linearly so the perceived density stays roughly constant.
      const viewSpan = maxT - minT
      const fullSpan = fullEnd - fullStart || 1
      const zoomFrac = viewSpan / fullSpan
      const MAX_RENDERED = 2000
      let stride: number
      if (zoomFrac <= 0.1) {
        stride = 1
      } else {
        // At zoomFrac=1 → stride ≈ N/MAX_RENDERED. At zoomFrac=0.1 → stride 1.
        const desired = (times.length * zoomFrac) / MAX_RENDERED
        stride = Math.max(1, Math.floor(desired))
      }

      let penDown = false
      for (let i = 0; i < revealIdx; i += stride) {
        const t = times[i]
        // Skip samples outside the visible time window with a small margin
        // so partial line segments at the edges still draw correctly.
        if (t < minT - viewSpan * 0.02 || t > maxT + viewSpan * 0.02) {
          penDown = false
          continue
        }
        const f = cleanedFlux[i]
        if (f == null) {
          // Outlier or gap → lift the pen; next valid point starts a new sub-path
          penDown = false
          continue
        }
        const x = toX(t)
        const y = toY(f)
        if (!penDown) { ctx.moveTo(x, y); penDown = true }
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.restore()

      // Dip markers (only after curve has passed them). Skip dips outside
      // the visible time window so the chart doesn't draw off-screen labels.
      if (progress > 0.5) {
        dips.forEach(dip => {
          if (dip.peakTime < minT || dip.peakTime > maxT) return
          const x = toX(dip.peakTime)
          const dipFluxIdx = times.findIndex(t => t >= dip.peakTime)
          const dipFlux = dipFluxIdx >= 0 ? flux[dipFluxIdx] : 0.98
          const y = toY(dipFlux)
          const color = LABEL_COLOR[dip.label]

          ctx.beginPath()
          ctx.arc(x, y, 4, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.shadowColor = color
          ctx.shadowBlur = 8
          ctx.fill()
          ctx.shadowBlur = 0

          // Label above
          ctx.fillStyle = color
          ctx.font = '8px JetBrains Mono, monospace'
          ctx.textAlign = 'center'
          ctx.fillText(dip.label, x, y - 10)
        })
      }
    },
    [times, flux, cleanedFlux, dips, getCanvasCoords, fullStart, fullEnd, PAD.top, PAD.right, PAD.bottom, PAD.left],
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
  const dragRef = useRef<{ startClientX: number; startViewT0: number; startViewT1: number } | null>(null)

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
        startViewT0: viewStartT,
        startViewT1: viewEndT,
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

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragRef.current) return
      const canvas = canvasRef.current
      canvas?.releasePointerCapture(e.pointerId)
      dragRef.current = null
    },
    [],
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

    // Line — sample every Nth point so we don't push 60K verts for a strip
    // that's only ~80 px tall.
    const stride = Math.max(1, Math.floor(times.length / W))
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(76,201,240,0.55)'
    ctx.lineWidth = 1
    let penDown = false
    for (let i = 0; i < times.length; i += stride) {
      const f = cleanedFlux[i]
      if (f == null) { penDown = false; continue }
      const x = toMx(times[i])
      const y = toMy(f)
      if (!penDown) { ctx.moveTo(x, y); penDown = true }
      else ctx.lineTo(x, y)
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
          SCROLL TO ZOOM · DRAG TO PAN · DOUBLE-CLICK TO RESET · CLICK MINIMAP TO JUMP
        </div>
      )}
      {tooltip && (
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
