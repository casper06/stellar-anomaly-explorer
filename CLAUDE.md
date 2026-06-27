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
- Depth feel: stars slightly larger when zoomed in
- More Kepler/K2/TESS anomaly seeds beyond the current 5

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
- Cached in-process per id (Kepler PDC files are static; only successful
  full-concatenation results are cached, never empty arrays)
- First real fetch can take 30–90s (parallel download of ~17 FITS files,
  ~80KB each); subsequent ones are instant from cache
- Do NOT use the legacy `mast.stsci.edu/api/v0/invoke` Mashup endpoint — it
  hangs indefinitely as of 2026. The VO-TAP service is the replacement.

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
- **Outlier filter**: any sample with `flux > 1.05` or `flux < 0.5` is
  replaced with `null` before any drawing or range calculation. The draw
  loop treats nulls as pen-up so the line skips outliers cleanly rather
  than spiking to NaN.
- **Y range**: percentile-based, NOT min/max. We take p5 and p95 of the
  non-null flux samples, add 20% padding, then HARD CAP the result to
  `median ± 0.15`. This guarantees the chart never gets squashed by
  surviving sub-threshold outliers (the failure mode that made KIC
  6543674 look like a solid filled blob).
- **Stroke-only**: the line uses `ctx.stroke()` exclusively; there is no
  fill under the curve. The canvas is also `ctx.clip()`-ed to the plot
  rect so partial segments at the edges (when zoomed in) don't bleed
  into the axis padding.

### Interactive LightCurve mode
`<LightCurve interactive />` (used in the fullscreen overlay) adds:
- **Wheel zoom** on the X axis, centered on the cursor. Min window =
  0.1% of full range. Implemented via a native `wheel` listener with
  `{ passive: false }` because React's synthetic `onWheel` is passive in
  modern browsers and `preventDefault` becomes a no-op there.
- **Drag-to-pan**: pointer down + move pans the X window in time-space.
  Uses pointer capture so a drag that exits the canvas still tracks.
- **Double-click**: resets to full data range.
- **Minimap strip** below the main chart: a downsampled rendering of
  the full curve with a translucent cyan rectangle highlighting the
  current visible window. Clicking the minimap centers the view there
  (preserves zoom level).
- The inline (panel) chart leaves `interactive` off so scrolling the
  side panel doesn't accidentally zoom the chart, and to keep the
  minimap from cluttering the small 460×200 view.

When `interactive` is on, the built-in legend is suppressed because the
fullscreen overlay renders its own larger legend below the chart.

### Performance: adaptive downsampling + rAF debounce
Real Kepler curves are ~60,000 samples. Stroking that many `lineTo`
calls into a 1500-pixel-wide canvas every wheel tick (a) tanks frame
rate and (b) visually piles the line into a solid-looking band because
every horizontal pixel gets multiple antialiased strokes. Two
mitigations:

1. **Adaptive stride** in the main draw loop based on the visible zoom
   fraction `zoomFrac = viewSpan / fullSpan`:
   - `zoomFrac <= 0.1` (zoomed in past 10%) → stride 1, full resolution.
   - `zoomFrac > 0.1` → `stride = floor(times.length * zoomFrac / 2000)`
     so the rendered point count caps at ~2000 regardless of how far
     zoomed out.
2. **rAF-debounced redraw**: the view-change effect schedules the draw
   via `requestAnimationFrame` and cancels any pending callback when
   the view changes again. A burst of wheel events collapses to one
   paint per frame.

The minimap uses its own simple stride (`floor(times.length / W)`) since
it always shows the full range.

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
| ID | Name | RA | Dec | Score |
|---|---|---|---|---|
| KIC8462852 | Tabby's Star | 301.5642 | 44.4567 | 0.94 |
| KIC6543674 | KIC 6543674 | 291.12 | 41.88 | 0.67 |
| KIC4150804 | KIC 4150804 | 288.55 | 39.42 | 0.72 |
| KIC11610797 | KIC 11610797 | 298.77 | 49.21 | 0.61 |
| EPIC201637175 | EPIC 201637175 | 174.32 | -4.67 | 0.58 |

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
