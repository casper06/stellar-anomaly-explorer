# Stellar Anomaly Explorer — Context for Claude Code

## What this is
Interactive sky explorer built with real astronomical data. The user navigates freely through the universe (like Google Earth for the sky), the system detects stellar anomalies and guides the user toward them. From there they can view each star's real light curve and report findings to Zooniverse, NASA, or SETI.

## Stack
- Next.js 16 + TypeScript + Tailwind CSS
- Three.js + @react-three/fiber + @react-three/drei (3D WebGL sky)
- Zustand (global state)
- Axios

## How to run
```bash
npm run dev    # localhost:3000
npm run build  # production build
```

## Branch workflow
- **`dev`** is the working branch — all day-to-day commits land here.
- **`main`** holds the latest stable snapshot only.
- Merge `dev` → `main` when the working state is verified stable
  (typecheck clean, app boots, the feature being shipped actually works
  in the browser). Don't fast-forward unverified work into `main`.
- Don't commit directly to `main`. If a fix is urgent enough to go
  straight there, branch off `main`, fix, merge back, then sync `dev`.

## File architecture
```
src/
  app/
    page.tsx              # Orchestrates everything: load catalog → loading → StarField + HUD + AnomalyPanel
    layout.tsx            # JetBrains Mono, metadata
    globals.css           # Reset, black background, scrollbar
    api/
      stars/route.ts            # Proxies VizieR Hipparcos catalog (avoids CORS)
      lightcurve/[id]/route.ts  # Fetches & parses Kepler PDC FITS from MAST
  components/
    StarField.tsx         # 3D sky with Three.js — THE MAIN COMPONENT
    HUD.tsx               # Overlay UI (header, crosshair, counter, minimap, onboarding)
    AnomalyPanel.tsx      # Side panel shown when a star is selected
    LightCurve.tsx        # Canvas 2D light curve chart
  lib/
    starCatalog.ts        # Catalog client (calls /api/stars; synthetic fallback)
    anomalyDetector.ts    # Dip detection + lightcurve client (calls /api/lightcurve)
    fitsReader.ts         # Minimal FITS BINTABLE reader (server-side, no deps)
    store.ts              # Global Zustand state
```

## UI language
**All user-facing strings must be in English.** Spanish from earlier prototypes has been removed; do not reintroduce it.

## Documentation style
**All functions, components, type aliases, and exported constants must carry a JSDoc block in English, using standard tags.**

Required tags:
- `@description` — what the function does (always first, even if short).
- `@param <name> <text>` — for every parameter.
- `@returns <text>` — for every return value other than `void`/JSX-only render.

Optional: `@example`, `@throws`, `@see`.

Skeleton:
```ts
/**
 * @description One-line summary, then optional follow-up sentences on the
 * same description block.
 * @param foo What `foo` is for.
 * @param bar What `bar` is for.
 * @returns What the function gives back.
 */
function example(foo: string, bar: number): boolean { ... }
```

For React components, document the props in `@param` form (one per prop) and use `@returns` to describe what's rendered:
```ts
/**
 * @description Score ring SVG that fills clockwise.
 * @param score Anomaly score in [0, 1].
 * @returns 70×70 SVG element.
 */
function ScoreRing({ score }: { score: number }) { ... }
```

For type aliases and interfaces, a single `@description` block is enough; document fields with inline comments only when their meaning isn't obvious from the name.

## Current project state

### What works ✅
- Navigable 3D sky with ~8000 stars rendered as `Points` (WebGL)
- Real star colors based on B-V index (blue=hot, red=cool)
- 11 hardcoded known anomalies: Tabby's Star (KIC 8462852), KIC 6543674, KIC 4150804, KIC 11610797, EPIC 201637175, KIC 11852982, KIC 3542116, KIC 8548587, KIC 5955033, KIC 12557548 (disintegrating-planet candidate), KIC 10195478
- Hover-proximity labels over anomalies (one at a time, closest to cursor)
- HUD with RA/Dec coordinates, crosshair, sky minimap, anomaly counter, "Go to nearest anomaly" button
- First-run onboarding overlay (persists dismissal in localStorage)
- FOV-based zoom (wheel changes camera FOV, telescope-style) with damping
- Drag to rotate the view (OrbitControls, keyboard disabled)
- Click-to-select via native raycasting; opens AnomalyPanel
- Star visualization SVG (radial gradient by B-V + corona + anomaly ring)
- Glossary tooltips (?) for MAG/RA/DEC/COLOR/DIP/SCORE/DEPTH/DURATION/BKJD

### Known bugs / pending 🐛
- (none currently tracked)

### Next features 🚀
- More Kepler/K2/TESS anomaly seeds beyond the current 11

## Real-data integration

Both the star catalog and per-star light curves go through Next.js API routes
so the browser never talks to external archives directly (CORS).

### `/api/stars`
- Proxies `https://vizier.cds.unistra.fr/.../I/239/hip_main` (Hipparcos main catalog)
- Parses TSV, prepends `KNOWN_ANOMALIES`, caches the parsed catalog in-process
- Response shape: `{ stars: CatalogStar[], source: 'real' | 'fallback' }`
- On any failure returns just `KNOWN_ANOMALIES` with `source: 'fallback'`; the
  client (`fetchHipparcosCatalog`) then pads with synthetic stars so the sky
  isn't sparse

### `/api/lightcurve/[id]`
- For known-anomaly KIC ids: maps `KIC8462852` → `kplr008462852` (9-digit
  zero-padded), runs one ADQL query against the MAST VO-TAP service
  (`https://mast.stsci.edu/vo-tap/api/v0.1/caom/sync`) on the `ivoa.obscore`
  view filtering by `target_name`. Each row returns a direct `access_url`
  to a Kepler quarter's `_llc.fits`.
- **Downloads ALL quarters in parallel** (up to 100, capped in the TAP `TOP`),
  parses each FITS for `TIME` + `PDCSAP_FLUX` via `lib/fitsReader.ts`,
  normalizes each quarter by its own median (so seams don't jump), then
  concatenates and sorts by time. This is what makes the famous Tabby's
  Star dips visible — they're in Q8 (BKJD ~793) and Q16 (BKJD ~1519); the
  first quarter alone is just commissioning data with no anomalies.
- The TAP `access_url` points at the MAST portal Download proxy which
  returns 400 Bad Request as of 2026 — we extract the embedded `uri=`
  param and download directly from `archive.stsci.edu` over HTTPS.
- Response shape: `{ times: number[], flux: number[], source: 'real' | 'unavailable' | 'synthetic', provenance: { sourceName, mission, dataType } }`
- **Two-level cache** (Kepler PDC files are static, so caching is safe):
  - **L1 in-process** `Map<id, {times, flux}>` — instant, but lost on
    every dev-server restart.
  - **L2 disk** at `<os.tmpdir()>/stellar-cache/{id}.json` with a
    **7-day TTL** (`stat.mtimeMs` vs `Date.now()`). Survives restarts.
    Atomic writes via temp-file + rename so a crash mid-write can't
    leave a corrupt JSON on disk. The id is sanitized
    (`/[^A-Za-z0-9_-]/g → _`) so unexpected characters can't escape
    the cache directory.
  - Request order: L1 → L2 (promotes to L1 on hit) → MAST. Only
    successful full-concatenation results are written; never empty
    arrays or partial fetches. The disk write is fire-and-forget
    (`void writeDiskCache(...)`) so it doesn't delay the response.
- First real fetch can take 30–90s (parallel download of ~17 FITS files,
  ~80KB each); subsequent ones are instant from cache — even after a
  dev-server restart, thanks to L2.
- Do NOT use the legacy `mast.stsci.edu/api/v0/invoke` Mashup endpoint — it
  hangs indefinitely as of 2026. The VO-TAP service is the replacement.
- **Per-quarter diagnostic logging**: when a quarter fails to download
  or parse, the log line names it by filename
  (`kplrNNNNNNNNN-YYYYDDDHHMMSS_llc.fits`) plus the failure reason
  (HTTP status, parse error, or "too few valid rows"). Aggregate
  success log also lists the *failed* filenames when any drop out, so
  "missing quarters" can be diagnosed from a single log read without
  cross-referencing per-quarter errors with the input list.

### Fallback policy (important)
**Synthetic data is never shown to production users.** When the real MAST
fetch fails:
- `NODE_ENV === 'development'` → returns `generateSyntheticLightcurve(id)` with
  `source: 'synthetic'` so the local dev workflow doesn't depend on a network
  round-trip to MAST.
- Otherwise → returns `{ times: [], flux: [], source: 'unavailable' }`. No
  fake curve is substituted; the UI must surface this state to the user.

The client `fetchLightcurve` mirrors the same policy if the route itself is
unreachable (dev server stopped, etc).

### `lib/fitsReader.ts`
- Server-side only, no dependencies; ~150 lines hand-rolled FITS BINTABLE reader
- Only supports the types Kepler files use (`D`, `E`, `J`, `I`)
- Walks HDUs to find the first BINTABLE, then reads two named columns
- DO NOT import this from client code (uses Node Buffer)

### Dip detector calibration
`detectDips()` in `lib/anomalyDetector.ts` is tuned against real Kepler
PDC data. Depth is intentionally uncapped within the formula so a single
deep transit can carry the whole score on its own.

- `threshold` default: **0.990** — catches sub-1% dips.
- Score formula: `depth * 3 + min(sigma / 8, 0.3) + asymmetry * 0.1`,
  clamped to `[0, 1]`. A 20% dip alone contributes 0.60 from the depth
  term (= WOW threshold). Sigma and asymmetry add headroom for clean,
  asymmetric events.
- Label cutoffs: **WOW ≥ 0.60**, INTERESTING ≥ 0.40, NOTABLE ≥ 0.20.

Three mirror sites must stay aligned with the label cutoffs above:
1. `detectDips()` itself (the source of truth)
2. `catalogLabelFor()` in `AnomalyPanel.tsx`
3. `ScoreRing` color cutoffs in `AnomalyPanel.tsx`

### Provenance flow & loading state
Two pieces of API-side metadata flow through to the panel:

1. **`source`** (`'real' | 'unavailable' | 'synthetic'`) — drives the
   `DataSourceBadge` next to the star name (REAL DATA / DATA UNAVAILABLE /
   DEV/SYNTHETIC / LOADING).
2. **`provenance`** (`{ sourceName, mission, dataType }`) — drives the
   one-line citation under each dip card via `DipProvenanceLine`. The route
   exports `KEPLER_PROVENANCE`, `SYNTHETIC_PROVENANCE`, and
   `UNAVAILABLE_PROVENANCE` from `anomalyDetector.ts` so all three states
   produce a consistent label without duplication.

The store also exposes `lightcurveLoading` (set true in `selectStar`
before the fetch, false in the `finally`). While true the panel shows
`<LoadingProgress />` instead of stale dips/chart from the previously
selected star — important because the MAST cold path can take ~60s.

`<LoadingProgress />` cycles through a 5-step narration
(`LOADING_STEPS` in `AnomalyPanel.tsx`) at `LOADING_STEP_MS = 900ms` per
step. The steps mirror what the API route is actually doing (TAP query,
quarter download, FITS parse, anomaly detection) but are time-driven
rather than event-driven — we don't have SSE from the server.

### Fullscreen light curve overlay
Clicking VIEW LIGHT CURVE in the panel opens `<LightCurveFullscreen />`
(declared in `AnomalyPanel.tsx`) instead of expanding the side panel.
The overlay is a fixed-position element at `z-index: 100` with a 0.2s
fade-in, dismissed by Escape or by clicking the dark backdrop outside
the content card. The chart uses the `width`/`height` props on
`<LightCurve />` (default 460×200 inline, 1600×~70vh in fullscreen) so
the canvas stays crisp when stretched.

The side panel width is fixed at 300px; the prior 300↔520 width
animation is gone since the chart no longer renders inline.

### LightCurve rendering details
- **Outlier filter** (asymmetric — this was a real bug for months):
  two cascaded filters replace bad samples with `null` before any
  drawing or range calculation. The draw loop treats nulls as pen-up
  so the line skips cleanly rather than spiking to NaN.
  1. **Absolute hard bounds**: drop `flux > 1.05 || flux < 0.5`.
     Defends against truly broken values (negative flux, ~10× baseline
     spikes) that would otherwise inflate the MAD estimate below.
  2. **ASYMMETRIC MAD filter** (`MAD_K = 5`): compute the median of
     the survivors, then their MAD (median absolute deviation), then
     drop any sample where `f > median + 5 * MAD`. **No lower MAD
     bound** — only the upper side. Cosmic-ray hits in Kepler PDC
     photometry are upward spikes (photon pile-up); real
     astrophysical events (transits, KIC 8462852's dips, KIC 12557548
     dust occultations) are downward. The previous symmetric filter
     rejected the famous −22% Tabby's dips because, in a quiet noise
     band with MAD ≈ 0.0002, a 22% downward excursion was 1100×
     larger than the threshold and looked identical to a cosmic ray.
     The asymmetric form catches upward spikes (which adapt to each
     star's noise level) while leaving downward dips of any depth
     untouched.
- **Y range** (auto-fit, when the user hasn't shift-scrolled): two-stage.
  1. Start from **p1/p99** of the full non-null `cleanedFlux` array
     with 10% padding. (Was p2/p98 — bumped because the 2% cutoff was
     still clipping the noise band on stars with broad intrinsic
     variability.) NO hard cap. With ~60k samples, p1/p99 leaves ~600
     samples of cushion on each side — way more than the few cosmic
     rays that survive the MAD filter.
  2. **Window-aware downward extension**: deep narrow dips (Tabby's
     −22%, KIC 12557548) are sub-1% of total samples, so even p1
     misses them. After computing the percentile range, `getCanvasCoords`
     scans the CURRENT visible X window (via binary search into the
     monotonic `times` array) for any sample below `minF`. If found,
     extends `minF` down to that value with 5% padding. The user
     always sees the deepest dip in their current view.

  When the user has explicitly set `viewYMin`/`viewYMax` (shift+scroll
  or shift+drag), this auto-fit logic is skipped entirely — manual Y
  overrides verbatim.
- **Stroke-only**: the line uses `ctx.stroke()` exclusively; there is no
  fill under the curve. The canvas is also `ctx.clip()`-ed to the plot
  rect so partial segments at the edges (when zoomed in) don't bleed
  into the axis padding.
- **Time axis units**: raw BKJD (Barycentric Kepler Julian Date), 6
  evenly-spaced ticks across the visible window. We tried calendar-date
  ticks ("Jan 2010", "Jun 2011") but reverted — it caused rendering
  glitches and the BKJD numbers are what the dip detector and tooltips
  use anyway, so keeping the axis in BKJD makes the whole UI
  internally consistent.
- **Dip label collision**: when multiple dip markers cluster (e.g.
  periodic dips on KIC 11610797), only the highest-scoring dip in any
  60-CSS-px x-window gets a text label. All dots still draw — only
  the text is suppressed. Implemented as two passes: build
  visible-dips list, sort copy by score desc, walk picking labels
  that don't collide with already-picked labels. The 60-px threshold
  is converted to canvas pixels per render (via
  `canvas.width / rect.width`) so perceived spacing stays consistent
  across the 460-px inline chart and the 1600-px fullscreen chart.

### Interactive LightCurve mode
`<LightCurve interactive />` (used in the fullscreen overlay) adds:
- **Wheel zoom**: plain scroll zooms the X axis around the cursor (factor
  1.25/tick); **Shift + scroll** zooms the Y axis around the cursor at
  the much gentler 1.05/tick — at typical flux scale (~0.01) the
  1.25/tick step felt like jumping an entire pane per click, while
  1.05 gives ~14 ticks to halve the range. Min X window = 0.1% of full
  range. Y zoom is anchored to the cursor's flux value and can go from
  0.1% of the data range (deep flux inspection) up to 10× (zoomed out
  to see context beyond the auto-fit range). Both implemented via a
  single native `wheel` listener with `{ passive: false }` because
  React's synthetic `onWheel` is passive in modern browsers and
  `preventDefault` becomes a no-op there. We ALWAYS preventDefault —
  no Ctrl-key gate. `LightCurveFullscreen` also sets
  `document.body.style.overflow = 'hidden'` while mounted and restores
  the previous value on unmount, so even wheel events outside the
  canvas (e.g. on the legend) can't scroll the page underneath.
- **Y zoom state**: `viewYMin`/`viewYMax` are nullable. `null` means
  "auto-fit to the p2/p98 `fluxRange`"; the moment the user
  shift-scrolls or shift-drags, both become concrete numbers that
  override the auto-fit. The auto-fit is per-dataset so quiet stars
  and noisy variables both start with a sensible default.
- **RESET Y button** next to the hint line: clears `viewYMin`/`Max`
  back to null (auto-fit) without touching the current X zoom.
  Disabled visually when Y is already auto-fit.
- **Drag-to-pan**: pointer down + move pans the chart. Plain drag pans
  the X window in time-space; **Shift+drag** pans the Y window in
  flux-space (and pulls `viewYMin`/`Max` out of auto-fit, same as
  shift+scroll). Mode is locked at pointerdown — releasing shift
  mid-drag doesn't flip the axis. Uses pointer capture so a drag that
  exits the canvas still tracks. Movement below ~5 px is NOT treated
  as a drag, so a small wiggle during a click doesn't pan the chart.
- **Click on a dip marker**: pin the dip and zoom to it. Hit-test
  radius is ~12 CSS px around each marker center. A successful hit
  pins the dip (sticky tooltip with label, score, depth, duration,
  peak time, and provenance line), centers the view on `dip.peakTime`
  with a window width of `max(dip.duration * 8, fullSpan * 0.02)` so
  even short dips show context. Clicking empty chart space dismisses
  the pinned dip. The hover tooltip is suppressed while a dip is
  pinned to avoid two tooltips fighting for the user's attention.
- **Double-click**: resets BOTH X (full data range) and Y (auto-fit).
  This is the "I'm lost, take me back to the overview" gesture.
- **Hover over an inter-quarter gap**: shows a subtle monospace tooltip
  ("Kepler observation gap — telescope reorientation · N.N days") so
  users understand the black bands aren't missing/corrupted data. The
  gap regions are memoized once per dataset from the existing `times`
  array (any `times[i+1] - times[i] > GAP_DAYS` qualifies). Tooltip is
  suppressed when a dip tooltip is also active, so the two never
  collide. NOTE: copy intentionally avoids quoting "~90 days" — that
  was a misconception. Kepler QUARTERS are ~90 days; inter-quarter
  GAPS are typically 1–4 days. The actual gap size is shown.
- **Minimap strip** below the main chart: a downsampled rendering of
  the full curve with a translucent cyan rectangle highlighting the
  current visible window. Clicking the minimap centers the view there
  (preserves zoom level).
- The inline (panel) chart leaves `interactive` off so scrolling the
  side panel doesn't accidentally zoom the chart, and to keep the
  minimap from cluttering the small 460×200 view.

When `interactive` is on, the built-in legend is suppressed because the
fullscreen overlay renders its own larger legend below the chart.

The `provenance` prop is optional but should be passed alongside
`interactive` (`LightCurveFullscreen` forwards `lightcurve.provenance`)
so the pinned-dip tooltip can show the source/mission/dataType line.

### Performance: LTTB downsampling + rAF debounce
Real Kepler curves are ~60,000 samples. Stroking one `lineTo` per
sample into a ~1400-pixel-wide canvas tanks frame rate during wheel
zoom and (depending on how the algorithm groups points) can produce
visual fill artifacts.

We use **LTTB** (Largest Triangle Three Buckets, Steinarsson 2013) —
the standard time-series downsampling algorithm used by Grafana,
Plotly, and similar tools. It reduces N points to ~`LTTB_TARGET_POINTS`
(2000) by picking, in each bucket, the point that forms the largest
triangle with the previous selected point and the average of the next
bucket. Preserves visual peaks (so dips stay visible) and produces a
clean line — no fill artifact, deterministic, O(N).

**Min/max preservation** (custom extension): standard LTTB can still
miss the segment's global y-extremes if they fall in a bucket whose
largest triangle is formed by a different point. For Kepler curves
that can hide deep narrow dips (Tabby's −22% events span <50 samples
out of ~60k). After the standard pass, `lttbIndices` splices in the
global y-min and y-max indices of the segment if not already present,
preserving chronological order via binary-search insertion. Cost: one
extra O(N) pass to find the extremes, +0–2 spliced entries.

We previously tried min/max-per-column envelope rendering and a
heuristic oscillation fallback (toggling envelope vs per-column
average based on column-range stats). Both produced fill artifacts in
practice — envelope stacks vertical strokes per column, and the
average heuristic was hard to tune. LTTB replaces both.

**Segmentation**: LTTB assumes a continuous series. The visible
window is split into contiguous segments at every null (outlier)
sample and at every `> GAP_DAYS` time jump. Each segment runs LTTB
independently with its proportional share of the 2000-point budget,
and is stroked as its own sub-path (`moveTo` at the start, `lineTo`
for the rest). No connection across segment breaks → quarter gaps
render as empty canvas, astronomically correct.

**Fast path**: when a segment has few enough samples (≤ plotW/2) LTTB
has nothing to gain and we just stroke every sample directly.

**Quarter-gap detection**: `GAP_DAYS = 5`. Kepler quarters have 1–4
day inter-quarter gaps (data downlink + reorientation); intra-quarter
cadence is ~30 minutes. The 5-day threshold cleanly separates real
observation windows. Both the main chart and the minimap respect this.

**Minimap** uses the same LTTB+segmentation, targeting `W * 2` total
output points across the strip width.

**rAF-debounced redraw**: the view-change effect schedules the draw
via `requestAnimationFrame` and cancels any pending callback when the
view changes again. A burst of wheel events collapses to one paint
per frame.

### Fullscreen overlay layout invariants
`<LightCurveFullscreen />` must obey these to keep the legend visible:

- Outer: `position: fixed; inset: 0; height: 100vh; overflow: hidden;
  display: flex; flex-direction: column`.
- Inner content card: `height: 100%; display: flex; flex-direction:
  column; min-height: 0; overflow: hidden`.
- Top bar + legend + hint: `flex: 0 0 auto` (fixed-height bookends).
- Chart wrapper: `flex: 1 1 auto; min-height: 0; overflow: hidden`.
- `<LightCurve>` inside the chart wrapper uses `fillContainer` so its
  root becomes a flex column and its main canvas takes `flex: 1` (the
  `height` prop then only controls the rasterization pixel buffer, not
  layout). Minimap + hint stay at their fixed heights, anchored to the
  bottom of the chart wrapper.

No scrollbars should ever appear in the overlay; if they do, the
constraint that got dropped is one of the above.

`LightcurveData.source` flows from the API → `fetchLightcurve` → `selectStar`
→ store → `AnomalyPanel`. The panel renders a `DataSourceBadge` next to the
star name with four states:
- **REAL DATA** (green) — Kepler PDC from MAST.
- **DATA UNAVAILABLE** (grey) — real fetch failed; no fake data substituted.
- **DEV/SYNTHETIC** (orange) — dev-only stand-in. Loud color so it's never
  mistaken for real data in screenshots or demos.
- **LOADING** (faint) — fetch in flight.

When source is `'unavailable'`:
- The light curve chart and "VIEW LIGHT CURVE" button are hidden.
- An explanatory message replaces them: "Real light curve data could not be
  fetched from NASA/MAST. This star exists and has documented anomalies, but
  the raw data is temporarily unavailable."
- The dips list switches to a "DOCUMENTED ANOMALY" card derived from
  `selectedStar.anomalyScore` (so the catalog-recorded severity still shows).
- Report-to-citizen-science buttons remain visible — they don't depend on
  the live fetch.

## Important design decisions

### StarField.tsx — performance-critical
- Stars MUST render as `Points` with `BufferGeometry`, NEVER as individual meshes
- With 8000+ stars individual meshes destroy the GPU
- Anomaly halos are a second `Points` layer on top, animated via `useFrame`

### Camera / zoom model
- Camera orbits the origin at a tiny `CAMERA_RADIUS = 0.1`
- OrbitControls keeps the camera looking at the origin → the view direction is `-position.normalized()`
- Zoom is implemented via `camera.fov` (range 20°–75°), not by translating the camera
- Fly-to: convert target RA/Dec to a unit vector D, place camera at `-D * CAMERA_RADIUS`, lookAt origin (so the user sees `+D`)

### Depth feel on zoom
Point sizes scale with FOV to fake "getting closer to the stars" — at
FOV 75° points render at their base size, at FOV 20° they're scaled up
linearly. Implemented via `depthScale(fov, maxScale)` helper, applied
each frame in `useFrame`:
- Catalog star points: base 3 px, max scale **2.5×**.
- Anomaly rings (outer/mid/core): max scale **3.0×**, multiplied INTO
  the existing pulse animation so the pulse stays visible but at a
  larger amplitude when zoomed in.

This is per-frame scalar mutation of `pointsMaterial.size`, not a
per-vertex buffer rebuild, so it costs ~nothing. Note: the default
`pointsMaterial` shader ignores the per-vertex `attributes-size` buffer
in `StarPoints` — that buffer is dead code; only `material.size`
controls rendered size. A future improvement would be a custom shader
that honors the per-vertex sizes so brighter stars actually render
bigger; until then, all catalog stars render at the same scaled size.

### Real B-V colors
```
B-V < 0      → bright blue   #a0c4ff  (young, very hot stars)
B-V 0.0–0.3  → blue-white    #e8f0ff
B-V 0.3–0.6  → yellow-white  #fff8e7  (solar type)
B-V 0.6–1.0  → yellow/orange #ffd166
B-V > 1.0    → red           #ff6b6b  (red giants, cool)
```

### RA/Dec → XYZ conversion (celestial sphere)
```ts
function raDecToXYZ(ra: number, dec: number, radius: number): [number, number, number] {
  const raRad = (ra * Math.PI) / 180
  const decRad = (dec * Math.PI) / 180
  return [
    radius * Math.cos(decRad) * Math.cos(raRad),
    radius * Math.sin(decRad),
    radius * Math.cos(decRad) * Math.sin(raRad),
  ]
}
```

### No SSR in Three.js
```ts
const StarField = dynamic(() => import('@/components/StarField'), { ssr: false })
```

## Known anomalies (seed data)
Source of truth: `KNOWN_ANOMALIES` in `src/lib/starCatalog.ts`. Keep this table in sync when adding seeds.

| ID | Name | RA | Dec | Mag | B-V | Score | Notes |
|---|---|---|---|---|---|---|---|
| KIC8462852 | Tabby's Star | 301.5642 | 44.4567 | 11.7 | 0.64 | 0.94 | Famous irregular dips (Boyajian's Star) |
| KIC6543674 | KIC 6543674 | 291.12 | 41.88 | 12.3 | 0.71 | 0.67 |  |
| KIC4150804 | KIC 4150804 | 288.55 | 39.42 | 13.1 | 0.58 | 0.72 |  |
| KIC11610797 | KIC 11610797 | 298.77 | 49.21 | 12.8 | 0.81 | 0.61 |  |
| EPIC201637175 | EPIC 201637175 | 174.32 | -4.67 | 12.1 | 0.55 | 0.58 |  |
| KIC11852982 | KIC 11852982 | 294.87 | 47.48 | 12.4 | 0.71 | 0.63 |  |
| KIC3542116 | KIC 3542116 | 284.22 | 38.71 | 13.1 | 0.58 | 0.61 |  |
| KIC8548587 | KIC 8548587 | 296.34 | 44.82 | 11.9 | 0.82 | 0.59 |  |
| KIC5955033 | KIC 5955033 | 290.11 | 41.23 | 12.7 | 0.65 | 0.57 |  |
| KIC12557548 | KIC 12557548 | 295.54 | 51.09 | 15.7 | 0.95 | 0.71 | Disintegrating-planet candidate |
| KIC10195478 | KIC 10195478 | 291.78 | 47.35 | 13.2 | 0.73 | 0.58 |  |

## Citizen-science report links
The AnomalyPanel offers these external links (open in new tab):
- **ZOONIVERSE** → `zooniverseLinkFor(starId)` in `AnomalyPanel.tsx`. Tabby's Star (KIC8462852) routes to `https://www.zooniverse.org/projects/zookeeper/variable-star-zoo`; everything else routes to the generic stars tag listing `https://www.zooniverse.org/projects?tag=stars`.
- **NASA EXOPLANET ARCHIVE** → `https://exoplanetarchive.ipac.caltech.edu/`
- **SETI INSTITUTE** → `https://www.seti.org`

SETI@home was shut down in 2020 — do not re-add it.

The panel layout order is fixed: star visual → score + coordinates → dips detected → light curve (when toggled on) → report buttons. The light curve is the primary evidence and must appear before the report actions, not after them.

## Visual style
- Background: pure black `#000`
- Font: JetBrains Mono everywhere
- UI colors: `#4cc9f0` (info cyan), `#ff4d6d` (anomaly/WOW red), `#f4a261` (INTERESTING orange), `#4361ee` (NOTABLE)
- Whole HUD is `position: fixed`, `pointer-events: none` except interactive elements
- Subtle borders: `rgba(255,255,255,0.06)` to `rgba(255,255,255,0.12)`
- Panel backgrounds: `rgba(0,0,0,0.7)` with `backdropFilter: blur`

## Instruction for starting each new session
Tell Claude Code at the start:
> "Read CLAUDE.md and tell me the current state of the project before making any changes"
