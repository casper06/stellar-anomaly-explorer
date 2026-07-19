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
      stars/route.ts                 # Proxies VizieR Hipparcos catalog (avoids CORS)
      lightcurve/[id]/route.ts       # Fetches & parses Kepler PDC FITS from MAST
      centroid/[id]/route.ts         # On-demand Kepler TPF difference-image centroid vetting
      koi/route.ts                   # Proxies NASA Exoplanet Archive KOI cumulative table
      toi/route.ts                   # Proxies NASA Exoplanet Archive TOI catalog (TESS)
      pattern-cache/route.ts         # GET/POST sky-radar precomputed pattern cache
      batch-classify/route.ts        # POST start / stop the batch classifier
      batch-classify/status/route.ts # GET live progress of the batch job
      identity/[id]/route.ts         # On-demand SIMBAD cross-identifier resolution (30-day cache)
  components/
    StarField.tsx         # 3D sky with Three.js — THE MAIN COMPONENT
    HUD.tsx               # Overlay UI (header, crosshair, counter, minimap, onboarding)
    AnomalyPanel.tsx      # Side panel shown when a star is selected
    LightCurve.tsx        # Canvas 2D light curve chart
    StarSearch.tsx        # Header search field + suggestion dropdown
  lib/
    starCatalog.ts        # Catalog client (calls /api/stars; synthetic fallback)
    anomalyDetector.ts    # App-side lightcurve client + dev synthetic generator
                          # (re-exports the engine's detectDips/Dip for old imports)
    bls.ts / curveClassifier.ts / oddEven.ts / secondaryEclipse.ts /
    fitsCore.ts / fitsReader.ts / tpfReader.ts / centroidVet.ts /
    dipDetector.ts        # ONE-LINE SHIMS re-exporting the MIT engine package
                          # (packages/stellar-vetting-engine — see below)
    centroidClient.ts     # Browser fetch wrapper for /api/centroid
    store.ts              # Global Zustand state
    quadrants.ts          # 6×6 Kepler-field grid (A1–F6); RA/Dec ↔ quadrant id
    persistence.ts        # localStorage Set helpers (visited / flagged)
    curveClassifier.ts    # Descriptive light-curve profile (periodicity / shape / RMS)
    patternCache.ts       # Server-side pattern cache read/write (pattern-cache.json)
    batchClassifier.ts    # Shared runtime state + worker for the batch classify job
    selectStar.ts         # Shared "select + fly + fetch curve" flow used by clicks and search
    externalEndpoints.ts  # Single source of truth for all external URLs (routes + health check import it)
    simbadIds.ts          # Pure SIMBAD TAP response → SimbadIdentity parser +
                          # selectDisplayNames (panel "also known as" filtering);
                          # app-side, NOT engine
    identityClient.ts     # Browser fetch wrapper for /api/identity. fetchIdentity()
                          # never throws (null on any failure, panel path);
                          # fetchIdentityByName() keeps miss vs outage distinct
                          # (search path — the copy differs)
    catalogMembership.ts  # Pure: SIMBAD identity → "is this a star WE render?"
                          # (matched / not-tracked / unknown). Backs the search
                          # box's ask-SIMBAD escape hatch; app-side, NOT engine
packages/
  stellar-vetting-engine/ # MIT-licensed extracted science engine (app is GPL;
                          # see KNOWLEDGE_BASE §9). src/ = the 9 engine modules
                          # + index.ts barrel (SPDX headers); tests/ = engine
                          # unit+regression suites AND the frozen fixtures
                          # (e2e + capture script reference these); own
                          # package.json (tsup build → ESM+CJS+d.ts, own
                          # npm install). NOT published to npm yet.
scripts/
    external-health.mjs   # npm run test:external-health — live probe of the 7 external contracts
    capture-simbad-fixtures.mjs # Refreezes the 4 SIMBAD identity fixtures (live network)
docs/
    KNOWLEDGE_BASE.md     # Permanent record of confirmed findings + design decisions
    DESIGN_tpf-centroid-analysis.md # TPF Phase-0 audit (measured) + phase-1 design record
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
- Navigable 3D sky with the FULL ~118,000-star Hipparcos main catalog
  (all-sky, no magnitude ceiling) rendered as a single `THREE.Points`
  (WebGL). Served through `/api/stars` with a 30-day disk cache (the
  Hipparcos dataset is fixed, ESA 1997) so the ~16 MB parse happens
  once. A custom `ShaderMaterial` honors per-vertex, magnitude-driven
  **size AND alpha** (bright stars big + opaque; the faint mag-8–13
  tail recedes into a dim backdrop) — the earlier default
  `PointsMaterial` ignored the per-vertex size buffer and drew every
  star the same size. `uDepthScale` uniform carries the FOV depth-feel.
- Real star colors based on B-V index (blue=hot, red=cool)
- 11 hardcoded known anomalies as seeds (Tabby's Star, KIC 6543674, KIC 4150804, KIC 11610797, EPIC 201637175, KIC 11852982, KIC 3542116, KIC 8548587, KIC 5955033, KIC 12557548 disintegrating-planet candidate, KIC 10195478) + ~6,000 unique KOI stars loaded from the NASA Exoplanet Archive
- Hover-proximity labels over anomalies (one at a time, closest to cursor)
- HUD with RA/Dec coordinates, crosshair, sky minimap, per-mission anomaly counter card (KEPLER + TESS rows, red and cyan accents matching the marker themes), nav buttons: "GO TO NEAREST ANOMALY" (angular nearest via dot product, scans the merged catalog) and "NEXT ANOMALY ▸" (cycles by score desc through anomalies currently in the viewport; shows "N IN VIEW", flashes "NO ANOMALIES IN VIEW" when empty)
- Quadrant exploration system: 6×6 grid (A1–F6) over the Kepler field with per-quadrant anomaly / visited / flagged counts in a HUD overlay (visible at FOV < 45°), click a quadrant to fly there
- Persistent visited (`sae_visited`) and flagged (`sae_flagged`) sets in localStorage. Visited anomalies render at 0.5 opacity so unvisited ones stand out; flagged stars get a white ring overlay. Bookmark (★) toggle in the AnomalyPanel; collapsible FLAGGED list panel in the HUD with click-to-fly-and-select
- Global progress bar in the header: `EXPLORED: N / TOTAL (P.P%)` based on intersection of visited set and anomaly subset
- Light-curve classifier (`lib/curveClassifier.ts`): measures periodicity, depth consistency, dominant dip shape (U/V), and baseline RMS for each curve. Surfaces a descriptive pattern label (PERIODIC_UNIFORM / IRREGULAR / HIGH_VARIABILITY / SPARSE) in the fullscreen overlay's top-left readout. Strictly descriptive — never asserts a physical cause
- **TESS light curves**: `/api/lightcurve` fetches both Kepler quarters (KIC/kepid → `kplrNNNNNNNNN`) and TESS sectors (TIC → bare integer target_name). Same FITS reader (`readMastLightcurveColumns`) — verified same BINTABLE + column names. Mission-aware gap threshold: 5 days for Kepler quarters, 2 days for TESS sectors. Axis label switches BKJD ↔ TJD based on which mission served the data.
- **On-demand analysis for any star**: VIEW LIGHT CURVE is always visible in the AnomalyPanel — even for Hipparcos background stars. The route position-cone-searches MAST when the id isn't a KIC/TIC/EPIC catalog id; if nothing was observed at that position the panel shows "DATA UNAVAILABLE — this star has not been observed by Kepler or TESS". On-demand fetches NEVER return synthetic data, in any environment.
- **Selection reticle in the 3D sky**: a "you are here" cyan crosshair-in-ring marker that follows the currently-selected star at any FOV. Distinct from the flagged white ring (thinner/static/anomaly-only) and the anomaly pulse (mission-colored, FOV-gated). Clears when the AnomalyPanel is closed.
- First-run onboarding overlay (persists dismissal in localStorage)
- FOV-based zoom (wheel changes camera FOV, telescope-style) with damping
- Drag to rotate the view (OrbitControls, keyboard disabled)
- Click-to-select via native raycasting; opens AnomalyPanel. Dense-field disambiguation: when a click hits 2+ stars within a 6-CSS-pixel screen radius, a popover appears at the click site listing each candidate (name, ΔRA/ΔDec from the clicked sky position in arcminutes) so the user can pick the intended one. Clicking off-card dismisses without selecting.
- Star visualization SVG (radial gradient by B-V + corona + anomaly ring)
- Glossary tooltips (?) for MAG/RA/DEC/COLOR/DIP/SCORE/DEPTH/DURATION/BKJD
- **In-app tutorial** (`components/Tutorial.tsx`, 2026-07-09): a
  "? TUTORIAL" button in the HUD header (next to search) launches a
  7-slide walkthrough — the two datasets (Kepler's fixed ~115 sq-deg
  field vs the ESA Hipparcos whole-sky background), what the mission
  counters count (unique KOI/TOI candidate stars, NOT rendered-star
  totals), the data-source badges incl. PARTIAL and why partial is
  flagged not hidden, navigation (search/click/quadrants/flagging),
  the sky-radar tint legend, lightcurve viewer controls, and the
  citizen-science hand-off. Never auto-opens; Esc/backdrop/SKIP
  dismiss; re-openable; ←/→ navigate; re-open resets to slide 1.
  Deeper than (and separate from) the first-run Onboarding overlay.
  Gotcha encoded in the copy style: Turbopack's JSX transform drops
  the leading space of a text node that continues onto the next
  source line, so boundary spaces after inline elements (`</Em>`,
  badge/dot mocks) must be explicit `{' '}`.
- **Celestial orientation** (`lib/constellations.ts` +
  `data/constellationZones.ts`, 2026-07-09): the HUD header readout
  appends the constellation the camera points at ("RA … · DEC … ·
  CYGNUS", live) and the AnomalyPanel gains a SKY row (constellation
  of the selected star, glossary tooltip) plus a visibility line
  ("Visible north of −46° · circumpolar above +46° · best viewed
  around July"). Constellation lookup = IAU zone table VizieR VI/42
  (Roman 1987; 357 rows, B1875, precedence-ordered) bundled as a
  build-time TS constant — boundaries fixed by the IAU in 1930, never
  change, so NO fetch/cache/health-check (unique among the app's
  datasets); inputs precessed J2000→B1875 (IAU-1976 three-angle,
  computed at module load). Visibility is pure declination geometry
  (φ ∈ (δ−90°, δ+90°); circumpolar where |φ+δ| > 90°, same sign);
  best month = RA mapped to midnight culmination via solar RA
  (±2 weeks, hence "around"). Ground-truth unit tests: 11 known stars
  (Tabby→Cyg, Polaris→UMi, Sirius→CMa, Spica→Vir, …) + a whole-sphere
  sweep. Note the EPIC 201637175 seed sits in LEO (verified against
  Spica/Regulus anchors), not Virgo as a naive RA guess suggests. The
  zone table can't draw boundary OUTLINES — the phase-2 minimap
  overlay needs the separate VI/49 polygon data (not bundled).

- **Pixel-level centroid vetting** (phase 1 2026-07-10 Kepler-only;
  phase 2 same day added the WCS reference + TESS): opt-in "RUN
  PIXEL-LEVEL VETTING" card in the fullscreen overlay (below the
  classifier readout; shown for real-data KIC/TIC targets with a
  confident BLS signal, id matching the serving mission). Downloads
  evenly-spread TPF segments from MAST via `/api/centroid/[id]`
  (Kepler: 6 quarters ~15 MB; TESS: up to 4 sectors ~47 MB EACH),
  stacks in-transit vs out-of-transit pixel stamps at the BLS
  ephemeris, and reports the difference-image centroid offset
  **measured against the target's CATALOG POSITION through each
  segment's FLUX-column WCS** (NASA's `koi_dikco_msky` convention) —
  vector-averaged across segments, error from segment scatter,
  verdict gate = ≥3σ AND a half-pixel floor (Kepler 2″; TESS ~10″).
  Phase-2 finding (measured, hypothesis-driven): the phase-1 ~1.8″
  systematic was NOT frame rotation (Kepler's focal-plane symmetry
  keeps each star's stamp orientation constant across quarters —
  stamp-frame and sky-frame vector means are identical); it was the
  photocenter REFERENCE, biased by crowding/truncation. The WCS
  reference pixel (= catalog position) kills it: K01317.01
  1.81″→0.12″ (NASA dikco 0.04″), K00931.01 1.92″→0.34″ (0.095″),
  while the K02606.01 FP fires at 7.33″ ± 0.86 (dikco 6.889″ ±
  0.091). The 2″ floor STAYS: clean planet K01800.01 reads 1.16″ ±
  0.37 (dikco 0.443″), so a 1″ floor would false-alarm. Saturated
  targets (Kp < 11.5 / Tmag < 6.8, authoritative header magnitude)
  are REFUSED. TESS results are labeled QUALITATIVE/UNVALIDATED in
  the UI (no public per-TOI centroid ground truth; 21″ pixels). Five
  frozen fixtures (4 Kepler vs dikco + WASP-126 b as a TESS drift
  pin) pin verdicts, the floor, the refusal, and the TESS path.
  Segment downloads retry (3 attempts — 47 MB TESS files drop
  connections routinely); `insufficient` outcomes are never cached
  (transient artifact, observed live). Strictly on-demand: never
  batch, never auto-run. See docs/DESIGN_tpf-centroid-analysis.md.

- **SIMBAD identity resolver** (phase B2 server-side + phase B3 UI,
  2026-07-18): `/api/identity/[id]` resolves any star's SIMBAD
  cross-identifier record on demand (KIC/TIC/EPIC/HIP/Gaia DR3/2MASS/
  Tycho + common names like "Boyajian's Star", HAT-P-7, K2-22) with a
  30-day schema-versioned per-star disk cache, expired-cache-on-outage
  fallback, and cached misses. Pure parser in `lib/simbadIds.ts`
  (app-side, NOT the engine package), 4 frozen real-response
  fixtures, health check #7. See the `/api/identity/[id]` section
  below.

  **B3 UI mechanism (a)** (the instant, no-extra-query half; the
  explicit press-Enter-to-ask escape hatch is mechanism (b), covered
  after this):
  - **"ALSO KNOWN AS" block** in the AnomalyPanel, between the
    visibility copy and the dips list: common-name chips + SIMBAD's
    `main_id` when it adds information (Tabby's reads
    `TYC 3162-665-1`) + a "via SIMBAD (CDS)" attribution line.
    Resolved via `selectDisplayNames` in `lib/simbadIds.ts`, which
    drops any name the panel already shows (case/whitespace-
    insensitive) so the block never echoes the header back.
  - **Absence is not news**: on a SIMBAD miss, a route failure, or
    when every name was redundant, the block renders NOTHING — no
    error state, no "not found" row. Most faint KOI hosts are simply
    not in SIMBAD; that is a normal answer, and this is bonus
    context, not a core feature. Do not "improve" this into an error
    message.
  - **Loading**: `identityLoading` in the store, but the placeholder
    is gated behind `IDENTITY_PLACEHOLDER_DELAY_MS = 400` in
    AnomalyPanel — a warm disk-cache hit returns in a few ms, and
    without the delay every revisit flashed a one-frame
    "RESOLVING IDENTITY…" that read as a glitch.
  - **Concurrency**: the identity fetch runs CONCURRENTLY with the
    light curve (`resolveIdentityFor` in `selectStar.ts`, not
    awaited inline) — SIMBAD answers in ~0.3–2.4 s while a MAST cold
    path can take ~60 s, so serializing would hide the names behind
    the slowest thing on screen.
  - **Generation guard, deliberately narrower than the curve's**: a
    superseded response must not take the PANEL slot, but it IS
    still indexed into `resolvedIdentities` via `indexIdentity`. The
    index is keyed by star id, so storing it cannot mislabel the
    current selection, and discarding it would throw away a SIMBAD
    query already spent.
  - **Search by common name**: `resolvedIdentities` (session Map,
    id → identity) folds into `StarSearch`'s match set, so
    "boyajian" finds Tabby's Star once that star has been opened.
    Alias hits rank BELOW the equivalent catalog hit and the
    dropdown row shows `↳ <alias>` so a row whose visible text
    lacks the query explains itself. **INSTANT coverage is
    visited-stars-only BY DESIGN** — universal common-name search
    AS YOU TYPE needs a query per keystroke, which CDS's rate
    policy rules out. Names for never-opened stars resolve through
    mechanism (b) below instead.

  **B3 mechanism (b) — the ask-SIMBAD escape hatch** (shipped
  2026-07-18; closes the design question formerly open in
  KNOWLEDGE_BASE §10):
  - **Trigger is EXPLICIT and one-shot**: pressing Enter when local
    search has NO match (a link in the empty state mirrors it).
    Enter keeps its normal meaning whenever a local match exists.
    **NEVER per-keystroke** — CDS blacklists IPs above ~5–10
    queries/second. This is not just a convention: `ask-simbad.spec.ts`
    asserts typing fires ZERO `/api/identity` requests and one Enter
    fires exactly one. Do not "improve" this into search-as-you-type.
  - **Flow**: `fetchIdentityByName` → same `/api/identity/[id]`
    route (SIMBAD's `ident` join matches ANY alias, so a name and an
    id are the same query upstream — no new endpoint) →
    `resolveAgainstCatalog(identity, anomalyStars)` in
    `lib/catalogMembership.ts` → one of three outcomes.
  - **Three outcomes, deliberately distinct**: `matched` (a
    cross-id IS in our catalog → fly + select, exactly like a normal
    search); `not-tracked` (SIMBAD knows the name, none of its
    cross-ids is a star we render → say so, **move nothing**);
    `unknown` (SIMBAD doesn't know it). `error` (couldn't reach
    SIMBAD) is kept separate from `unknown` — reporting our own
    outage as "no such name" would blame the user for our failure.
  - **Membership is tested against the LIVE catalog, never
    inferred.** Object type is not a proxy (`3C 273` is a quasar
    carrying HIP + EPIC ids) and neither is carrying a catalog id
    (Betelgeuse and Vega both have a TIC without being in the
    KOI/TOI merge). Id preference order is KIC → TIC → EPIC → HIP:
    a mission id means real photometry, HIP only means we can point
    at a background star.
  - **Route input alphabet widened** (`SAFE_ID` → `SAFE_LOOKUP`):
    real names carry spaces and apostrophes, and the old regex would
    have 400ed `"Boyajian's Star"`. Cache filenames are now derived
    separately by `cacheKeyFor` (lowercased, whitespace-collapsed,
    non-filename chars replaced), so widening the input did NOT
    widen filesystem exposure — and case/spacing variants now share
    one cache entry, matching SIMBAD's own matching. Cache schema
    v1 → v2 because keys moved.
  - **A successful ask permanently improves local search**: the
    resolved identity is folded into `resolvedIdentities`, so that
    name matches instantly from then on.

### Known bugs / pending 🐛
- (none currently tracked)

### Next features 🚀
- More Kepler/K2/TESS anomaly seeds beyond the current 11
- **Celestial orientation phase 2 — minimap boundary overlay**: faint
  constellation boundary polylines on the existing sky Minimap. Phase
  1 (labels + visibility, see "What works") shipped 2026-07-09; the
  outline overlay needs the VI/49 boundary POLYGONS (~200 KB, the
  zone table can't draw outlines) — separate bundling decision.
  Future idea — not being implemented now.
- **TPF centroid vetting phase 3 — refinements**: phases 1–2 shipped
  2026-07-10 (see "What works"; phase 2 = catalog-position/WCS
  reference + TESS). Remaining ideas: (a) PRF-fitted difference-image
  centroid (would approach NASA's 0.07″ dicco precision and could
  lower the 2″ floor — the moment centroid + catalog reference is the
  current accuracy limit); (b) per-transit bootstrap errors as a
  cross-check on the segment-scatter error bar; (c) TESS validation
  if a public per-TOI centroid table ever appears. Future ideas — not
  being implemented now.
- *(SIMBAD identity phase B3 mechanism (b) shipped 2026-07-18 — see
  "What works". No further SIMBAD identity work is planned.)*

## Real-data integration

Both the star catalog and per-star light curves go through Next.js API routes
so the browser never talks to external archives directly (CORS).

### `/api/stars`
- Proxies the Hipparcos main catalog (I/239/hip_main) from VizieR via
  **`/viz-bin/asu-tsv`** — the older `/viz-bin/TSV` path 404s as of
  2026-07 (VizieR moved it), which silently pushed the app onto the
  synthetic fallback for an unknown period before the 2026-07-04 audit
  caught it.
- Selection: **the FULL catalog, no `Vmag` ceiling (~118,000 rows),
  all-sky** (`-out.max=130000`). Replaced the earlier `Vmag < 6.5`
  naked-eye filter (~8,785 rows) — the app now renders the whole
  Hipparcos main catalog. The URL constant lives in
  `src/lib/externalEndpoints.ts` (`VIZIER_HIP_URL`), shared with the
  external-health check so probe and production URLs can't drift.
- Position columns are the catalog-native **`RAICRS` / `DEICRS`**
  (degrees). The previously-requested `RArad`/`DErad` names are no
  longer honored; VizieR silently DROPS unknown requested columns, so
  the parser now locates columns BY NAME from the header row and
  throws if a required column is missing (contract-change detection
  instead of garbage coordinates). The parser also detects VizieR's
  error-envelope (`#INFO QUERY_STATUS=ERROR`, seen during a 2026-07-05
  backend DB outage) and the HTTP-header-echo lines it prepends to the
  body, so neither is mistaken for data.
- **Disk cache** at `<os.tmpdir()>/stellar-cache/hipparcos-catalog.json`,
  schema-versioned, **30-day TTL** (the Hipparcos dataset is a fixed
  historical catalog, so the TTL is just a bound on local staleness /
  a periodic re-fetch to recover from a cache written during a VizieR
  outage). Atomic temp+rename; rejects entries with < 10,000 rows
  (a cache written during a partial fetch).
- **`KNOWN_ANOMALIES` seeds are guaranteed on EVERY served path** via
  `withKnownAnomalies(parsed)` — prepended (deduped by id, seed wins)
  on the live-fetch path AND re-injected on the disk-cache read path,
  not just baked into the stored array. The 11 seeds (Tabby's Star et
  al.) carry real Kepler light-curve data and must stay searchable /
  flaggable / visible regardless of the Hipparcos path. Regression
  guarded: they were baked into the stored array at write time only,
  so a disk cache written WITHOUT them (injected synthetic-scale test
  data during the 2026-07-05 VizieR outage) silently dropped Tabby's
  Star from search and the flagged list. The store/persistence was
  never at fault — `flaggedIds` still held the id; the catalog just no
  longer contained the star for the FlaggedPanel/StarSearch to resolve.
- Response shape: `{ stars: CatalogStar[], source: 'real' | 'fallback' }`
- On any failure returns just `KNOWN_ANOMALIES` with `source: 'fallback'`
  — and logs the reason LOUDLY (`[stars] VizieR fetch FAILED`); the
  client (`fetchHipparcosCatalog`) then pads with synthetic stars so
  the sky isn't sparse. Silent fallback is how the endpoint breakage
  went undetected.

### External endpoint constants (`src/lib/externalEndpoints.ts`)
Single source of truth for every EXTERNAL data URL the app hits
(VizieR, NASA KOI/TOI TAP, MAST VO-TAP, MAST FITS download, SIMBAD
TAP). Both the API routes AND the external-health check import from
here, so a probe can never test a different URL than production sends.
Dependency-free (no `next/*`) so the plain-Node health harness can
import it. The lightcurve route's `mastTapQueryUrl` /
`mastConeSearchUrl` / `resolveSegmentDownloadUrl` moved here; the
KOI/TOI/stars routes import their TAP/VizieR URLs from here; the
identity route imports `simbadIdsQueryUrl` from here.

### External-dependency health check (`npm run test:external-health`)
Live-network probe of the 7 external contracts, using the exact
`externalEndpoints.ts` constants. NOT part of `npm test` (which stays
offline/fast). Each check verifies the CONTRACT, not just reachability:
Hipparcos required columns present; KOI schema; TOI `tid` column
present (the historical `tic_id` mistake); MAST TAP returns
`access_url` rows; a MAST segment actually downloads as valid FITS
(`SIMPLE  =` magic); the **TESS TPF URL derivation** — an
UNSHIPPED contract (`-s_lc.fits` → `-s_tp.fits` naming pattern, not a
documented MAST interface) monitored from day one so a future TESS
pixel-vetting implementation never builds on an unwatched assumption
(ranged GET, first FITS block magic only — never the ~47 MB sector
file); and **SIMBAD TAP identity resolution** — JSON envelope (vs the
VOTable XML error envelope), `main_id`/`ids` columns by name, and
Tabby's Star still resolving with its KIC + a TIC cross-id. Exit 0 =
all healthy, 1 = any failure. Designed
to catch the class of silent contract change (VizieR column rename,
endpoint move) that degraded the app to a fallback undetected. It
distinguishes a VizieR upstream outage ("service degraded") from a
real column-contract change so the report is actionable.

### `/api/koi`
- Proxies the NASA Exoplanet Archive's KOI cumulative table via TAP
  (`https://exoplanetarchive.ipac.caltech.edu/TAP/sync?...`) filtering to
  `koi_disposition in ('CONFIRMED','CANDIDATE')`. Selects only the
  columns we render/score against (kepid, kepoi_name, disposition,
  period, depth, duration, score, ra, dec). Returns ~9,500 rows as of
  2026 — one per Kepler Object of Interest (a single star can host
  many KOIs; Kepler-90 has 8).
- Response shape: `{ source: 'real' | 'cached' | 'unavailable', rows: KoiRow[], fetchedAt: number, stale?: boolean, error?: string }`.
  `fetchedAt` is the REAL upstream fetch time persisted in the cache
  file (pre-2026-07-08 the route reported `Date.now()` for cached data
  — the age was invisible and the response misleading).
- **Disk cache + freshness (stale-while-revalidate, 2026-07-08)**:
  `<os.tmpdir()>/stellar-cache/koi-catalog.json` via the shared
  `lib/catalogCache.ts` helper (persists `{fetchedAt, rows}`, atomic
  temp+rename; legacy `{rows}`-only files read as a miss — one
  migration refetch). **TTL = 7 days** (Kepler stopped observing in
  2013; the cumulative table sees only occasional batch disposition
  revisions). The TTL decides when a BACKGROUND refresh fires, not
  whether data is available: any cached copy is served immediately
  with its true `fetchedAt`; past-TTL copies additionally carry
  `stale: true` and trigger a deduped background TAP refetch. This
  also fixes the old failure mode where TTL-expiry + NASA outage =
  "CATALOG UNAVAILABLE" despite a usable copy on disk. This is
  catalog CONTENT freshness — deliberately a separate mechanism from
  the lightcurve/pattern-cache SCHEMA versioning (which guards our
  own pipeline changing, not NASA's data changing).
- On failure with NO cache returns `{ source: 'unavailable', rows: [], error }`.
  The client surfaces this in the HUD counter as "CATALOG UNAVAILABLE"
  rather than rendering a misleading 0.

### KOI catalog merge (`fetchKOICatalog` + `mergeKoiIntoHipparcos`)
The page loads Hipparcos and KOI in parallel and merges them in the
browser after both resolve. `fetchKOICatalog` dedupes by kepid (keeping
the highest-scoring KOI per star; secondary KOIs aren't lost — they're
counted via `koiCount`). `mergeKoiIntoHipparcos` then:

1. Looks up each KOI by id in the existing Hipparcos catalog (handles
   `KNOWN_ANOMALIES` seeds like Tabby's that are already present).
2. Falls back to position match within `KOI_HIPPARCOS_MATCH_DEG = 0.01°`
   (~36 arcsec). Uses a sparse RA/Dec bucket grid (bucket size = match
   threshold) so each KOI checks 9 buckets instead of all ~5,000
   Hipparcos entries — O(N + M) instead of O(N × M).
3. Matched: marks the existing entry `hasAnomaly: true` and bumps
   `anomalyScore` if the KOI score is higher.
4. Unmatched: adds the KOI as a new sky entry with default magnitude
   (13.5) and color index (0.65, solar-yellow) since TAP doesn't return
   photometry.

In practice Hipparcos tops out at mag ~9 while Kepler PDC targets are
mag 11–17, so they almost never overlap — the merge is mostly
defensive correctness for the few overlap cases (the seeded
`KNOWN_ANOMALIES` always match by id).

`scoreFromKoi(koi)` = `koi.score * 0.5 + min(koi.depth/20000, 0.3) + (CONFIRMED ? 0.2 : 0)`,
clamped to [0, 1]. CONFIRMED planets always score ≥ 0.2 (NOTABLE
band); deep transits (depth ≫ 20,000 ppm = 2%) saturate the depth
term at 0.3.

**Catalog metadata ≠ rendered curve.** This is a gotcha worth
calling out: `koi.depth` / `koi.duration` describe ONE PLANET's
transit signature (e.g. K00526.01's 2,000 ppm × 4 h dip). The
rendered light curve is the parent STAR's full-mission flux series
(`KIC{kepid}` → `kplrNNNNNNNNN` → all ~17 quarters concatenated).
If a star hosts multiple KOIs they all show the same curve but each
has its own catalog row. A high anomalyScore therefore doesn't
promise a visibly deep dip — a 0.5%-depth transit lasting 4 hours
spans ~8 samples out of ~60k. Without zooming to the transit window
or phase-folding, the planetary signal is below the noise band of
the visual rendering. The id mapping (`KOI row → KIC{kepid} →
kplrNNNNNNNNN`) was verified during the K00526.01 investigation and
is correct; the apparent mismatch is interpretive, not a lookup
bug.

### `/api/toi`
- Proxies the NASA Exoplanet Archive's TOI (TESS Object of Interest)
  table via TAP. Selects `toi, tid, ra, dec, tfopwg_disp, pl_trandep,
  pl_trandurh, pl_orbper, st_tmag`. Filters dispositions client-side
  in the parser: kept = `CP` (Confirmed Planet), `KP` (Known Planet,
  externally confirmed), `PC` (Planet Candidate). Dropped = `FP`,
  `FA`, `APC`, etc.
- **Heads-up on column names**: the user-supplied spec called the
  TIC ID column `tic_id`. The actual schema uses **`tid`**. Confirmed
  live; using `tic_id` returns `ORA-00904: invalid identifier`.
- Same response shape and stale-while-revalidate disk-cache pattern
  as `/api/koi` (shared `lib/catalogCache.ts`; separate file at
  `<os.tmpdir()>/stellar-cache/toi-catalog.json`) but with **TTL =
  24 hours** — deliberately tighter than KOI's 7 days because TESS is
  still observing: new TOIs land continuously and TFOPWG dispositions
  get revised (PC → CP/FP).

### TOI catalog merge (`fetchTOICatalog` + `mergeToiIntoCatalog`)
Same algorithm as KOI: dedupe by TIC id (keeping the highest-scoring
TOI per star), then id-match + position-match into the working catalog.
The merge runs AFTER the KOI merge in `page.tsx`, so when a star is in
both KOI and TOI catalogs the TOI merge wins the `source` tag and the
star renders as TESS-themed. This is a small minority and acceptable
for visual distinction; documented in `mergeToiIntoCatalog`.

`scoreFromToi(toi)` = `min(toi.depth/20000, 0.3) + (CP || KP ? 0.2 : 0)`,
clamped to [0, 1]. Mirrors KOI's depth+confirmation structure (no
`koi.score` equivalent in TOI, so the base score term is dropped).
The literal spec asked for the per-dip detector formula
(`depth*3 + sigma/8 + asymmetry*0.1`) but TOI doesn't carry sigma or
asymmetry and `pl_trandep` is in ppm; that formula would give a 1%
dip score 0.03 (NORMAL band). Using KOI's shape keeps score scales
comparable across both missions.

New TOI sky entries inherit `magnitude` from `st_tmag` when available
(TESS magnitudes 6–13, brighter than Kepler PDC's 11–17) with a fallback
of 11 when missing. `colorIndex` defaults to 0.65 (solar-yellow) since
TAP doesn't return photometric color.

### `/api/lightcurve/[id]`
Serves BOTH Kepler and TESS PDC light curves via one route. Dispatch
based on id prefix — `identifyMastTarget(id)` returns
`{ mission, targetName }` or null:
- **`KIC{N}` / bare numeric** → Kepler collection. `targetName =
  kplrNNNNNNNNN` (9-digit zero-padded). Verified against MAST VO-TAP.
- **`TIC{N}`** → TESS collection. `targetName` is the **bare TIC
  integer** (no `TIC` prefix, no padding — verified live; the padded
  or prefixed forms return zero rows in `ivoa.obscore`).
- **Anything else** (HIP*, SYN*, EPIC*, etc.) → null → the route
  falls through to the on-demand cone search if `?ra=…&dec=…` were
  provided, else returns `unavailable` immediately.

**Query params**:
- `ra`, `dec` — position hint. Required by the on-demand path (any
  id not KIC/TIC) so the route can cone-search MAST for coverage.
- `onDemand=1` — disables the dev-only synthetic fallback even in
  dev. The client sets this whenever the star id is NOT a
  KIC/TIC/EPIC catalog id, so Hipparcos background clicks get "real
  data or unavailable" and never fake output.

**Fetch pipeline** (one ADQL query per mission target, ~1 sync round-
trip):
- `SELECT TOP 100 obs_id, access_url, access_format FROM ivoa.obscore
  WHERE obs_collection='<Kepler|TESS>' AND dataproduct_type='timeseries'
  AND target_name='<targetName>'`
- Filter response rows to PDC lightcurve files: `_llc.fits` for
  Kepler, `_lc.fits` for TESS. TESS filter also rejects
  `_fast-lc.fits` (20-second cadence — we use the 2-min standard) and
  `_llc.fits` (which contains `_lc.fits` as a substring but is
  Kepler). URL / path must include a TESS indicator (`mast:TESS/`,
  `/tess/`, `/tess20…`) to distinguish.
- Download all segments in parallel (up to 100 — TESS continuous-
  viewing-zone stars can have 50+ sectors). Parse each via
  `lib/fitsReader.ts` (same reader for both missions — verified same
  BINTABLE structure and same `TIME` + `PDCSAP_FLUX` column names).
  Normalize each segment by its own median (Kepler throughput and
  TESS pointing/aperture drift both cause seam jumps).
- TESS access_urls use a `mast:TESS/product/…` URI scheme. The route
  rewrites them to `https://mast.stsci.edu/api/v0.1/Download/file?uri=…`
  (the Download API accepts the raw `mast:` URI). Kepler URLs use
  `archive.stsci.edu` paths via the existing `uri=` extraction.
- Kepler quarters carry `TIME = BJD − 2454833` (BKJD); TESS sectors
  carry `TIME = BJD − 2457000` (TJD). Both are just linear day
  offsets for the consumer — dip detection and gap detection work
  identically, only the axis label differs.

**Cone-search fallback** (on-demand path): when `identifyMastTarget`
returns null but `ra`/`dec` are supplied, run
`resolveTargetByPosition` — a `CONTAINS(POINT, CIRCLE(ra, dec, 0.001°))`
ADQL query across BOTH Kepler and TESS collections. If any row
comes back, use its `target_name` and `obs_collection` as if it were
a KIC/TIC id and continue through the fetch pipeline. Prefers TESS
when both missions cover the position (broader sky coverage, more
current).

**Response shape**:
```
{
  times: number[],
  flux: number[],
  source: 'real' | 'unavailable' | 'synthetic',
  provenance: { sourceName, mission, dataType },
  mission: 'Kepler' | 'TESS' | null,
  gapDays: number   // 5 for Kepler, 2 for TESS
}
```

**`gapDays`** is the recommended canvas-line-break threshold in days.
Kepler has 1–4 day inter-quarter gaps → 5 is safe. TESS sector
boundaries are typically ~1 day → 2 is tighter and still safely
above the 2-min intra-sector cadence. If Kepler's 5-day threshold
were used for TESS the canvas would draw a diagonal line across
every sector boundary, fusing them.

**Two-level cache** (both mission PDC products are static, so
caching is safe):
- **L1 in-process** `Map<key, {times, flux}>` keyed by
  `<id>|<mission>`. Instant, lost on dev-server restart.
- **L2 disk** at `<os.tmpdir()>/stellar-cache/<key>.json` with a
  **7-day TTL**. Same atomic-write pattern. The mission tag in the
  key means a Kepler hit and a TESS hit at the same star can cache
  independently — rare but the right semantics.

**L2 entries are schema-versioned** (`CACHE_SCHEMA_VERSION` in the
route; currently 1). Each entry stores `schemaVersion`, `fetchedAt`
(ISO timestamp), `sampleCount`, and `segmentFiles` (the archive
filenames that parsed successfully) BEFORE the times/flux arrays, so
`head`-ing the JSON answers "when / which schema / which segments"
without parsing megabytes. On read, an entry whose `schemaVersion`
doesn't match the current constant (including pre-versioning entries
with none) is logged and treated as a MISS — refetched, never
served. **Bump the constant whenever the fetch pipeline changes in a
way that can alter the arrays** (segment filtering, per-segment
normalization, stitching, FITS parsing, TAP query). Why this exists:
during the 2026-06/07 dev period, 7-day-TTL entries written by older
route iterations kept being served after the code changed —
K02357.02's dip measured 1.08% deep from a stale-provenance entry vs
1.00% from a fresh fetch (leave-one-quarter-out testing ruled out
MAST segment availability: it moves depth ≤0.0001 pp). Versioning
eliminates mixed-provenance data as a class. L1 needs no version —
it dies with the process that wrote it.

**Per-segment diagnostic logging**: when a segment fails to download
or parse, the log line names it by filename plus the failure reason.
Aggregate success log also lists the *failed* filenames when any
drop out, so "missing segments" can be diagnosed from a single log
read. Log prefix includes mission tag.

Do NOT use the legacy `mast.stsci.edu/api/v0/invoke` Mashup endpoint —
it hangs indefinitely as of 2026. The VO-TAP service is the
replacement for both Kepler and TESS.

### Fallback policy (important)
**Synthetic data is never shown to production users, and never for
on-demand clicks in any environment.** When the real MAST fetch fails:
- Catalog stars (KIC/TIC/EPIC), `NODE_ENV === 'development'` →
  returns `generateSyntheticLightcurve(id)` with `source: 'synthetic'`
  so the local dev workflow doesn't depend on a network round-trip
  to MAST. This is the ONLY case that produces synthetic data.
- Catalog stars, production → `source: 'unavailable'`.
- **On-demand stars** (`?onDemand=1`, set when the id is not
  KIC/TIC/EPIC) → `source: 'unavailable'` in EVERY environment,
  even dev. The user explicitly clicked a Hipparcos background
  star; the UI promises "real data or a clear 'not observed'
  message", never fake. Enforced in both the route and the client
  (`fetchLightcurve` mirror).

The client `fetchLightcurve(id, { ra, dec, onDemand })` passes
through to the route with matching query params. `StarField.selectStar`
sets `onDemand: !/^(KIC|TIC|EPIC)\d+$/.test(id)` and always includes
the star's RA/Dec so the cone-search path has what it needs.

### `/api/centroid/[id]` (pixel-level vetting, Kepler + TESS)
- GET with required `period` / `epoch` (BKJD/TJD) / `duration` (hours)
  query params — the confident BLS ephemeris. `KIC{N}` → Kepler,
  `TIC{N}` → TESS; 400 `unsupported` otherwise.
- Discovery reuses the SAME obscore TAP query as `/api/lightcurve`.
  Kepler TPF rows are listed directly (filter `_lpd-targ.fits.gz`,
  never short-cadence `_spd-targ`). TESS `_tp.fits` rows are NOT in
  obscore — URLs are DERIVED from the `-s_lc.fits` listing via
  `deriveTessTpfUrl` (the load-bearing naming contract watched by
  health check 6). Kepler: 6 quarters; TESS: 4 sectors (~47 MB each).
  Bounded pool of 3, 3 attempts per segment (big TESS files drop
  connections routinely — observed live).
- **Saturation gate order matters**: the FIRST segment is downloaded
  alone and its header KEPMAG/TESSMAG checked (authoritative —
  catalog magnitudes for merged KOI/TOI entries are defaults); a
  saturated target (Kp < 11.5 / Tmag < 6.8) is refused before the
  remaining downloads happen.
- Disk cache `centroid-KIC*/TIC*.json` (schema v2 — v1 entries used
  the biased photocenter reference; 30-day TTL) ALSO keyed on the
  ephemeris: served only when period/epoch/duration match within
  tolerance (rel 1e-3 / 0.1 d / 25%). `insufficient` results are
  NEVER cached — they're usually transient download artifacts and
  would otherwise stick for the TTL.
- Engine: `lib/centroidVet.ts` (`runCentroidVet`) — offsets measured
  against the target's catalog position through each segment's WCS
  (`referenceFrame: 'catalog-wcs'`; photocenter fallback only when
  WCS keywords are absent). Calibration + gate constants documented
  in-module (ground truth = `koi_dikco_msky`). Regression: 5 frozen
  fixtures in `centroidRegression.test.ts` (runs in `npm run
  test:data`); refreeze via `packages/stellar-vetting-engine/scripts/capture-centroid-fixtures.mjs`
  (live network) + `--print` on the test before updating EXPECTED.

### `/api/identity/[id]` (SIMBAD cross-identifier resolution, 2026-07-18)
- On-demand resolution of a star's SIMBAD identity record: `main_id`,
  `otype`, ICRS position, bare KIC/TIC/EPIC/HIP/Gaia DR3/2MASS/Tycho
  ids, common names (`NAME …` entries + HAT-P/WASP/Kepler/KOI/K2/TOI
  survey designations), and the full normalized identifier list
  (`allIds`). Consumed by the panel's ALSO KNOWN AS block and the
  session search index (phase B3 mechanism (a)) AND by the search
  box's explicit ask-SIMBAD action (mechanism (b)) — both shipped,
  see "What works". The browser calls it through
  `lib/identityClient.ts`, never directly: `fetchIdentity(starId)`
  for the panel (flattens miss vs outage) and
  `fetchIdentityByName(name)` for the search box (keeps them
  distinct, because the copy differs).
- **The `[id]` segment is any SIMBAD lookup key**, not just an app
  star id: `KIC8462852` and `Boyajian's Star` are the same kind of
  query upstream, because the ADQL joins `ident` (matches ANY
  alias). Accepted input is `SAFE_LOOKUP` — wider than the app's id
  alphabet (spaces, apostrophes, `+`) since real designations need
  it. Filename safety does NOT depend on that regex: `cacheKeyFor`
  normalizes every key (lowercase, whitespace-collapsed,
  non-`[a-z0-9._-]` replaced) before it becomes a path, which also
  makes case/spacing variants share one cache entry.
- Queries the CDS SIMBAD TAP sync service via `simbadIdsQueryUrl` in
  `externalEndpoints.ts` (ADQL over `basic` ⋈ `ids` ⋈ `ident`; the
  `ident` join matches ANY alias). **Measured facts (2026-07-17/18)**:
  identifier matching is whitespace-normalized, so app-form un-spaced
  ids (`KIC8462852`) are sent verbatim; warm latency ~0.3–1.6 s, cold
  ~2.4 s; a miss is HTTP 200 + empty `data`; a query error is a
  VOTable XML envelope EVEN with `FORMAT=json` (JSON parse failure ⇒
  error, never data); the column list lives under `metadata`, NOT
  `info` as MAST's TAP uses. Parsing locates columns BY NAME and
  throws on a missing column (contract-change detection, the VizieR
  lesson).
- **Rate posture**: CDS blacklists IPs above ~5–10 queries/second (up
  to an hour). One query per click is far below; NEVER point a batch
  at this route without throttling (≲2 concurrent + delays).
- **Per-lookup disk cache** `<os.tmpdir()>/stellar-cache/identity-<key>.json`
  where `<key>` is the `cacheKeyFor`-normalized lookup (lowercased —
  `identity-kic8462852.json`), schema-versioned
  (`CACHE_SCHEMA_VERSION`, currently **2**; bump on any query/shape/
  parsing/KEY-derivation change — mismatched entries are refetched,
  never served; v1 used un-normalized keys),
  **30-day TTL** (SIMBAD is a living compilation but identifier data
  is nearly append-only — ids arrive with major catalog releases).
  Two deliberate behaviors: an EXPIRED same-version entry is served
  with `stale: true` when the live refetch fails (KOI-outage lesson),
  and MISSES are cached as `identity: null` (most faint KOI hosts are
  not in SIMBAD; without this every click re-queries).
- Response: `{ source: 'real'|'cached'|'unavailable', identity:
  SimbadIdentity|null, fetchedAt, stale?, error? }`. `identity: null`
  with source real/cached = "SIMBAD consulted, object unknown" —
  distinct from `unavailable` (couldn't ask).
- Parsing lives in `lib/simbadIds.ts` — pure, dependency-free,
  deliberately app-side (catalog-identifier plumbing, not vetting
  science; kept OUT of the MIT engine package). Unit-tested against
  five frozen REAL responses in `src/lib/__tests__/fixtures/simbad/`
  (KIC8462852 Tabby, KIC10666592 HAT-P-7, TIC25155310 WASP-126,
  EPIC201637175 = K2-22, and **M31** — a real object with 41
  identifiers and NO stellar catalog id, pinning mechanism (b)'s
  `not-tracked` branch — captured 2026-07-18); refreeze via
  `node --import ./scripts/register-ts-resolver.mjs scripts/capture-simbad-fixtures.mjs`
  and hand-verify before updating expectations. Route-level cache/TTL
  wiring is pinned in `src/app/api/__tests__/identityRoute.route.test.ts`.

### `lib/fitsCore.ts` / `lib/fitsReader.ts` / `lib/tpfReader.ts`
- `fitsCore.ts` holds the shared low-level primitives (2880-byte block +
  header parsing, HDU walking with data-size arithmetic, BINTABLE
  column layout incl. TDIM, the TFORM type table). Extracted from
  `fitsReader.ts` when TPF support landed — the image-cube reader
  needed ~65 of its ~150 lines verbatim. `fitsReader` keeps the
  scalar two-column extraction; `tpfReader.readKeplerTpf` reads the
  Kepler `_lpd-targ.fits.gz` pixel product (gunzip + TDIM-shaped FLUX
  array column + APERTURE bitmask image + KEPMAG/QUARTER metadata).
- Server-side only, no dependencies.
- Supports the types Kepler AND TESS PDC files use (`D`, `E`, `J`, `I`).
  Both mission products share the same HDU layout, the same BINTABLE
  structure, and the same `TIME` / `PDCSAP_FLUX` column names —
  verified against a live TESS `_lc.fits` sample. Only the TIME
  offset differs (Kepler = BJD−2454833 = BKJD; TESS = BJD−2457000 =
  TJD), and the consumer treats time as opaque days.
- Exported as `readMastLightcurveColumns` (renamed from the earlier
  `readKeplerLightcurveColumns` when TESS support landed).
- Walks HDUs to find the first BINTABLE, then reads two named columns.
- DO NOT import this from client code (uses Node Buffer).

### Dip detector calibration
`detectDips()` in `lib/anomalyDetector.ts` is tuned against real Kepler
PDC data. Depth is intentionally uncapped within the formula so a single
deep transit can carry the whole score on its own.

- `threshold` default: **0.990** — catches sub-1% dips.
- **High-noise guard (2026-07-07, the TOI 5523.02 fix)**: the fixed
  0.990 threshold was calibrated for Kepler noise (σ_rob 0.03–0.6% on
  the frozen fixtures); on a σ≈1.6% TESS 2-min curve it sat at 0.6σ and
  produced 12,431 noise-fragment "dips". Three measures, all constants
  in `anomalyDetector.ts`:
  1. **Sigma-relative floor**: when `robustFluxSigma` (1.4826×MAD) >
     `DIP_NOISE_GATE_SIGMA = 0.0075`, the effective threshold becomes
     `min(threshold, 1 − 3·σ_rob)` — a consistent 3σ cut. The gate sits
     between the noisiest calibrated Kepler fixture (K01725.01, 0.575%)
     and the pathological case (1.43%), so Kepler-domain behavior is
     bit-identical. An ungated `min(0.990, 1−3σ)` was measured and
     REJECTED: it drifts K01725.01 (53→0 dips) and K01317.01 (461→411).
  2. **Fragmentation merge**: runs separated by < `DIP_MERGE_GAP_DAYS =
     0.01` merge into one dip.
  3. **Min duration**: dips shorter than `MIN_DIP_DURATION_DAYS = 0.02`
     are dropped. Both time guards are structural no-ops at Kepler's
     30-min cadence (one sample spans 0.0204 d) — active only on
     high-cadence data.
  Detection-sensitivity calibration, not a realness claim: "dip" now
  means the same statistical thing (≥3σ, sustained) across missions.
  TOI 5523.02: 12,431 → 20 dips; all 7 Kepler fixtures unchanged.
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

### Anomaly counter semantics (three distinct counts)
There are THREE different "anomaly counts" in this codebase; don't
confuse them:

1. **`koiCount`** (store, set by `page.tsx` after KOI merge): unique
   Kepler-mission stars (Kepler Objects of Interest) loaded from
   NASA. Drives the **KEPLER** row in the bottom-left HUD card; red
   accent color (matching the Kepler marker theme). When the KOI
   fetch fails the row shows "CATALOG UNAVAILABLE".
2. **`toiCount`** (store, set by `page.tsx` after TOI merge): unique
   TESS-mission stars (TESS Objects of Interest) loaded from NASA.
   Drives the **TESS** row in the same card; cyan accent (matching
   the TESS marker theme). Same "CATALOG UNAVAILABLE" treatment on
   fetch failure.
3. **`anomalies.length`** (store, set in `selectStar` after a
   light-curve fetch): per-star detected-dip count for the
   currently-selected star. Drives the header status color/label
   (`ANOMALY DETECTED` / `EXPLORING`) — describes what's in the data
   the user is currently looking at.

All three are valid. The first two answer "how big is each mission's
catalog?", the third answers "is there something interesting in this
specific star's light curve?". HUD's `MissionCount` helper renders
the per-mission rows.

### Sky radar (precomputed classifier patterns)
A cross-session cache of `CurvePattern` results, driving an extra
tint layer over the anomaly markers so the user can see which stars
have already been classified — and which pattern they landed in —
without opening each light curve.

**Persistence** (`lib/patternCache.ts`, server-side): single JSON
file at `<os.tmpdir()>/stellar-cache/pattern-cache.json`, shape
`{ entries: { [starId]: { pattern, computedAt, classifierVersion } } }`.
No TTL — a star's PDC data doesn't change over time — but the
ALGORITHM does: entries record the `CLASSIFIER_VERSION` that computed
them, `getCachedIds()` (the batch resume skip-list) only counts
current-version entries, and `onlyIfMissing` writes overwrite
old-version entries. Bumping the version therefore makes the next
batch run re-classify the whole catalog instead of serving
mixed-provenance labels. The GET endpoint still serves old-version
entries to the radar until the re-batch replaces them. Full ~9k-star population is ~500 KB; we
rewrite the whole file on every mutation (atomic temp+rename, same
pattern as the lightcurve cache). Concurrent writers serialize
through a `writeChain` promise so batch + organic fill can't race.

**Endpoints**:
- **GET `/api/pattern-cache`** → `{ entries }`. Read once by
  `page.tsx` on mount and stashed in the store's `classifiedPatterns`
  Map<starId, CurvePattern>. Payload is small enough that
  streaming/paginating adds no value.
- **POST `/api/pattern-cache`** with `{ starId, pattern }` → the
  lazy fill-in write path. Called from `selectStar` in StarField
  after any organic click that produces a `profile`. Server-side
  uses `onlyIfMissing: true` so the batch job's fresh entry wins
  when both paths race on the same star.
- **POST `/api/batch-classify`** → starts the batch. Idempotent
  (a POST while a run is in flight returns `{ started: false,
  alreadyRunning: true }`). When body is empty the route pulls
  the KOI + TOI catalogs from our own `/api/koi` + `/api/toi`
  and uses their union as input.
- **POST `/api/batch-classify?action=stop`** → cancels the run
  after the current chunk. No-op if nothing is running.
- **GET `/api/batch-classify/status`** → live progress snapshot:
  `{ running, processed, total, currentStar, startedAt,
  lastUpdatedAt, lastError, succeeded, skippedNoData, errored }`.
  Poll every few seconds during a run.

**Batch behavior** (`lib/batchClassifier.ts`):
- Detached async worker running inside the Next.js server process.
  Killing the process ends it; a page reload does NOT.
- **Resumable**: at start time we read the current pattern cache
  and skip any star already present. Restarting after an
  interruption picks up where the last run left off. Progress
  counters reflect the FULL input length (already-cached stars
  count as "processed").
- Reuses `/api/lightcurve` end-to-end for each fetch, so the
  batch is essentially a bulk pre-warm of the lightcurve disk
  cache AND the pattern cache simultaneously. When the batch
  hits a star that's already in the lightcurve L2 cache
  (previous cold fetch), classification is near-instant
  (~10ms) — otherwise it pays the cold MAST round-trip.
- `MAX_CONCURRENCY = 5` in-flight fetches at a time, with a
  `BATCH_DELAY_MS = 250` pause between chunks to avoid bursting
  MAST. Adjust in-source only; not exposed as a runtime param.
- Stars where MAST returned `source: 'unavailable'` are skipped
  silently (counted in `skippedNoData`) — no pattern cache
  entry is written. Next batch will retry them.
- Full ~9k-star cold pass: **realistic ~28 hours** (14–40h
  range depending on how many stars hit the disk cache). Meant
  to run as a background overnight job, resumable across
  sessions. Progress is durable to the disk cache so a Ctrl-C
  loses at most `MAX_CONCURRENCY` in-flight stars.

**Client rendering** (`PatternRadarMarkers` in StarField.tsx):
- Extra `<points>` overlay layer drawn just after `AnomalyMarkers`
  and before `SelectionMarker`. One `<points>` mesh per pattern
  bucket (IRREGULAR / PERIODIC_UNIFORM / HIGH_VARIABILITY); SPARSE
  and UNCERTAIN intentionally have NO radar entry — the
  classifier is admitting it can't tell, so those stars keep their
  plain mission-color marker with no tint.
- Colors: **IRREGULAR** = `#ff2ea6` (bright magenta, "worth a
  closer look"), **PERIODIC_UNIFORM** = `#4ade80` (dim green,
  "boring, known"), **HIGH_VARIABILITY** = `#facc15` (dim yellow,
  "noisy backdrop").
- Sits at `STAR_SPHERE_RADIUS - 3` so the radar dot always draws on
  top of the anomaly cores at −1. `depthTest: false + depthWrite:
  false` avoids Z-fighting at near-equal radii.
- Follows the same FOV tier gates as `AnomalyMarkers` — hidden at
  FOV ≥ ANOMALY_HARD_CUTOFF_FOV = 55° (so the wide-view sky doesn't
  gain a rash of new colored dots), linear fade across 40°–50°,
  full opacity below 40°.
- Static-latch pattern (`isStaticRef`) mirrors the anomaly layer:
  material size/opacity are mutated ONCE on the transition into
  wide-FOV, then the useFrame short-circuits.

**Kicking off the batch** (dev-only; no user-facing UI):
```
# Start (no body → auto-loads KOI + TOI catalog):
curl -X POST http://localhost:3000/api/batch-classify

# Or start with an explicit star list:
curl -X POST http://localhost:3000/api/batch-classify \
  -H 'content-type: application/json' \
  -d '{"stars":[{"id":"KIC8462852","ra":301.5642,"dec":44.4567}]}'

# Poll progress:
curl -s http://localhost:3000/api/batch-classify/status | jq

# Stop the run (finishes current chunk, then exits):
curl -X POST "http://localhost:3000/api/batch-classify?action=stop"
```

### Star search (header search field)
`<StarSearch>` in the HUD header lets the user find a specific star
by identifier when they don't want to hunt through the sky. Input
sits next to the app title, dropdown appears below at ≥2 chars.

**Match rules** (`rank()` in `StarSearch.tsx`, lower is better):
- 0 — exact match on `id` OR `name` (after normalization).
- 1 — prefix match on either.
- 2 — substring match on either.
- 3 — KOI/TOI "stem" match: query contains `.` and the pre-dot
  segment equals the star name's pre-dot segment. Handles the
  after-dedupe gap where the sibling KOI name is what got stored
  (catalog stores one KOI per KIC — the highest-scoring sibling
  wins in `fetchKOICatalog`, which can be `.01`, `.02`, or higher
  depending on which planet scored best). Example: on KIC7449554
  the raw KOI catalog carries both `K02357.01` (score 0.999) and
  `K02357.02` (score 1.000), so `.02` wins the dedupe; searching
  `K02357.01` still finds the star via the stem `K02357`.

Normalization strips non-alphanumeric-dot characters and
lowercases, so `KIC 8462852`, `kic8462852`, `KIC-8462852`, etc. all
key the same way.

**Search dataset**: `anomalyStars` from the store (post-KOI+TOI merge,
plus the 11 `KNOWN_ANOMALIES` seeds like "Tabby's Star"). Hipparcos
background stars are NOT searchable — their names are literal
`"Star 3421"` placeholders and would clutter the dropdown without
being findable by a human-meaningful query.

**Interaction**:
- ≥2 chars → dropdown; typing debounced 120 ms.
- ↓ / ↑ move highlight, Enter selects, Esc dismisses.
- Click a row → picks; click outside → dismisses.

**On select**: calls `selectStarAndFetchCurve(star)` from
`lib/selectStar.ts` — the shared "fly + selectStar + fetch
lightcurve + classify + write pattern cache" flow. Every entry
point that opens the AnomalyPanel with a new star routes through
this same helper (sky click, click disambiguation popover, auto-
select-on-center, search dropdown pick, FlaggedPanel row click).
StarField.tsx used to carry an in-file copy of the same logic; it
was deleted when FlaggedPanel was fixed so there's only one
source of truth going forward. `QuadrantPanel` and the Minimap
click do NOT select a star (they navigate the camera to a REGION,
not to a specific target), so they intentionally stay on plain
`requestFlyTo`. Same for `GO TO NEAREST ANOMALY` and `NEXT
ANOMALY ▸` — those are "position the camera on a star"
gestures, not "open its analysis panel" gestures; the user still
has to click through if they want the light curve.

**Selection staleness guard**: `selectStarAndFetchCurve` claims a
module-level `selectionGeneration` counter at entry; after its
`fetchLightcurve` await resolves it only writes lightcurve/anomaly
state (and only clears `lightcurveLoading`) if it is STILL the
latest generation. Without this, two racing selections (explicit
pick immediately followed by auto-select, or rapid clicks while
the MAST cold path takes ~60s) let whichever fetch resolves LAST
win the store — pairing star A's panel header with star B's curve.
The synchronous pre-fetch writes (`setSelectedStar`, `markVisited`,
`setLightcurveLoading(true)`) are intentionally unguarded: the
latest call always runs them last.

### Auto-select on center (CameraSync) — transition semantics
`CameraSync` in StarField.tsx auto-selects an anomaly when the user
is zoomed in (FOV ≤ `AUTO_SELECT_FOV = 28`) and an anomaly sits
within `halfFov * 0.5` of screen center. Two guards keep it from
stealing explicit selections; both are needed, they cover different
failure shapes:

1. **Transition guard** (`centeredAnomalyRef`): auto-select fires
   ONLY when the id of the centered anomaly CHANGES from the
   previous frame — i.e. camera movement brought a *different*
   anomaly to center. A frame where the centered star is unchanged
   never fires, no matter what `selectedStar` is. This is what lets
   an explicit pick of an OFF-CENTER star survive (disambiguation
   popover row, direct click): the pick changes `selectedStar` but
   not the centered star, so no transition, no override. The
   previous design (a guard ref synced to `selectedStar` via
   useEffect) re-armed on every explicit pick — `ref` became the
   picked id, the centered star's id then differed, and auto-select
   stole the selection back within one frame. Symptoms: popover
   pick "didn't register" (snapped back to the already-selected
   centered star) or "opened a different star". The ref resets to
   null at FOV > 28 so zooming back in re-evaluates fresh.
2. **Fly-to suppression window** (`flyToSuppressUntilRef`): any
   `flyTo` command mutes auto-select for ~1.3s (tween is ~1s).
   The transition guard alone can't cover this: mid-tween the
   centered anomaly GENUINELY changes frame to frame, so those are
   real transitions. Verified failure case without it: search picks
   K02357.02 (KIC7449554); K07016.01 sits 2.36° away and gets
   latched mid-flight.

Consequence of (1): after an explicit off-center pick, ANY camera
rotation that changes which anomaly is centered will fire auto-
select and replace the selection. That's the feature's intent
("zoomed in + centered = lock on"), accepted behavior.

### Anomaly cycle navigation
Two HUD buttons cycle through the merged KOI catalog. Both fall back
to the 11 hardcoded `KNOWN_ANOMALIES` while the KOI fetch is still
pending or if it failed.

- **GO TO NEAREST ANOMALY**: scans `anomalyStars` (store, populated
  by `page.tsx` after the KOI merge) for the angularly nearest entry
  to the camera's current pointing direction. Uses dot product of
  unit vectors so it works correctly near the celestial poles and
  across the RA=0/360 seam. Scans the WHOLE catalog (not view-
  filtered) — this button is for "take me to the nearest anomaly
  even if I can't see one from here". After flying, syncs the
  `nextAnomalyCursor` so a subsequent NEXT click advances from the
  flown-to position rather than jumping somewhere arbitrary.
- **NEXT ANOMALY ▸**: cycles through anomalies *currently in the
  viewport* by score desc. View filter = dot product of camera and
  anomaly unit vectors above `cos(halfFov * 1.3)` (the 1.3× covers
  horizontal extent on typical aspect ratios; approximate but cheap
  and doesn't need Three.js projection). Cursor stores the GLOBAL
  rank index, not the in-view rank — so a pan-then-resume picks up
  the user's place in the score ranking rather than restarting from
  the top each time. Button label shows "N IN VIEW". When no
  anomalies are visible, flashes a transient "NO ANOMALIES IN VIEW"
  toast (1.5s) and does nothing.

The cursor starts at -1 ("haven't started cycling"); the first NEXT
click moves to the highest-ranked visible anomaly. Setting a new
catalog via `setAnomalyStars` resets the cursor to -1.

### Quadrant exploration + visited/flagged persistence
A navigation layer on top of the catalog merges, plus persistent
per-session state so users can pick up where they left off.

**Quadrant grid** (`lib/quadrants.ts`): 6×6 grid covering the Kepler
field (RA 290–305°, Dec 36–52°). Columns A–F map RA low→high; rows
1–6 map Dec north→south (row 1 is the northernmost so the grid
reads like a sky map with north up). Each anomaly star inside the
field gets `quadrant: string` (e.g. "C4") assigned at merge time by
`quadrantFor(ra, dec)` in BOTH `mergeKoiIntoHipparcos` and
`mergeToiIntoCatalog` (all branches — id match, position match, and
new entries). Stars outside the grid get `quadrant: undefined` —
most TOI stars and seeds are off-field, which is fine.
`quadrantCenter(id)` is the inverse (returns the RA/Dec at the
quadrant center, for click-to-fly).

**Persisted state** (`lib/persistence.ts`): two localStorage keys.
- `sae_visited` (Set of star ids): every star whose light curve
  the user has opened, including failed-fetch cases (the persisted
  record is "I tried", not "I succeeded" — prevents pestering the
  user to revisit dead targets). Written by `markVisited` (called
  from `selectStar` in StarField).
- `sae_flagged` (Set of star ids): every star the user has
  explicitly bookmarked via the ★ button in `AnomalyPanel`.
  Toggled by `toggleFlagged`.

Both keys store JSON arrays. `loadIdSet` / `saveIdSet` swallow
private-mode and quota throws — the in-memory state still works,
it just doesn't survive a reload.

Store fields `visitedIds` and `flaggedIds` start empty (Zustand
runs during SSR; `window` isn't available there). `page.tsx` calls
`hydratePersistedSets()` once on mount in a `useEffect` to load
both from localStorage. Setters create new `Set` references so
React subscribers see referential changes and recompute.

**Visual reflection (StarField)**: `AnomalyMarkers` partitions
each mission bucket by visited status and renders TWO
`<ThemedAnomalyMarkers>` layers per mission — unvisited at full
opacity, visited at `dimFactor = VISITED_DIM_FACTOR = 0.5`. Result:
unvisited anomalies pop against a sea of dimmed visited ones,
which is the whole point. The `dimFactor` prop scales every
opacity term (outer pulse, mid pulse, core pulse, AND the static-
overview core at wide FOV); a `useEffect([dimFactor])` resets
`isStaticRef` so the next wide-FOV transition snaps the new dim
value.

Flagged stars get an additional `<FlaggedRingMarkers>` overlay — a
single `<points>` layer at flagged positions with a white sprite,
size ~14×detail (no pulse — flag is a status badge, not an
animation). Hidden at FOV ≥ ANOMALY_TIER_HIGH_FOV so the wide
view doesn't gain noise just because the user flagged things.
Flagged+visited overlap shows BOTH effects: dim core + white ring.

**Selection reticle (`<SelectionMarker />`)** — a "you are here"
overlay drawn at the currently-`selectedStar` position, distinct
from every other marker so a user in a dense field never loses
track of what they clicked. Rendered as a single `<points>` mesh
using a procedural 128×128 sprite (`makeReticleTexture`): a solid
white ring with four short crosshair ticks poking inward and a
subtle cyan halo. Material is bright cyan (`#4cc9f0`) with
additive blending so it pops against dark space and dense
backgrounds. `useFrame` breathes the size ±15% and modulates
opacity 0.55–0.9 on offset sine phases at `SELECTION_PULSE_OMEGA
= 2π/2.2s` — slower than the anomaly pulse (`2π/1.5s`) so the two
read as distinct when they co-occur on a flagged/anomaly star
that's ALSO the current selection.

**Visible at ALL FOVs** — unlike the anomaly pulse (gated at 40°/
50°/55°), the reticle renders at any zoom level. The user needs to
find their selection regardless of how far out they've zoomed. A
gentle `fovBoost` (1× at FOV_MAX, up to 1.6× at narrow FOV) keeps
it proportional to the star point as the user zooms in.

Rendered AFTER `AnomalyMarkers` in the Canvas tree so it draws on
top of any anomaly pulse at the same position. `depthTest: false`
guarantees the reticle stays visible even when a Hipparcos
foreground star might otherwise occlude it (all `Points` sit at
`STAR_SPHERE_RADIUS`, but Z-fighting near equal radii is
unpredictable). Position buffer is a single `Float32Array(3)`
mutated in place via a `useEffect([selectedStar])` — no full mesh
remount on selection change. Renders `size=0 opacity=0` when
`selectedStar` is null (mesh stays mounted but invisible for the
next selection).

**HUD additions** (`components/HUD.tsx`):
- **Global progress bar** in the header row: thin cyan bar +
  `EXPLORED: N / TOTAL (P.P%)` label. Count is the INTERSECTION
  of `anomalyStars` and `visitedIds` (`countVisitedAnomalies`) —
  NOT `visitedIds.size`, because the user can visit Hipparcos
  stars that aren't in the anomaly subset and we don't want those
  to inflate "anomaly progress". Hidden while `anomalyStars` is
  empty (catalog still loading; "0 / 0" is meaningless).
- **`<QuadrantPanel>`** bottom-right above the minimap: lists
  every quadrant intersecting the current view with per-quadrant
  anomaly / visited / flagged counts. Visible only when `fov <
  QUADRANT_PANEL_FOV_THRESHOLD = 45` — a quadrant only fills a
  useful portion of the screen at narrower FOV. Clicking a row
  calls `requestFlyTo(quadrantCenter(id))`. Quadrants render in
  canonical A1..F6 order, not score-sorted, so the layout reads
  like a grid index rather than shuffling on every visit.
- **`<FlaggedPanel>`** bottom-right above the QuadrantPanel,
  collapsible. Collapsed = a single `★ FLAGGED (N) ▸` button.
  Expanded = a scrollable list of `name · score · quadrant` rows
  sorted by score desc. Clicking a row both flies the camera AND
  selects the star (sets `selectedStar` + `mode: 'analyze'`) so
  the AnomalyPanel opens immediately.

  **Stacking**: both panels are children of a single absolutely-
  positioned column container (`bottom: 130`, `right: 24`, flex
  column with `align-items: flex-end`). FlaggedPanel is rendered
  FIRST in source order so it sits at the top of the column; the
  QuadrantPanel sits below it. Neither panel sets its own
  `position`/`bottom`/`right` anymore — the parent owns the stack.
  Previous layout used two absolutely-positioned siblings with
  hardcoded `bottom` swaps when expanded, which collided when both
  were active.

  **Panel clearance**: while a star is selected, the column AND the
  Minimap shift left to `right: PANEL_CLEARANCE_RIGHT = 324` (0.25s
  ease). The AnomalyPanel is a 300px-wide right-edge column at
  z-index 20; the HUD root is z-index 10, so at `right: 24` every
  bottom-right HUD element rendered UNDERNEATH the open panel —
  invisible, and clicks aimed at the flagged list silently hit the
  panel instead (reported as "clicking a flagged star does
  nothing"). The data path was never at fault: FlaggedPanel rows
  always went through `selectStarAndFetchCurve`; the click just
  never reached the row while the panel was open.

**Bookmark button in AnomalyPanel**: next to the star name in the
header, before the data-source badge. Outline ☆ when unflagged,
solid ★ (white) when flagged. Clicking toggles
`flaggedIds.has(starId)` via `toggleFlagged`, which persists
immediately.

### Anomaly marker tiered rendering (per-mission themes)
The KOI + TOI catalogs together plant thousands of anomaly markers,
heavily concentrated in their respective survey fields. At wide FOV
overlapping halos would fuse into an unusable blob. Solution: two
render modes with a smooth cross-fade, driven by FOV. Then the same
machinery is applied separately per mission with different color
themes, so Kepler and TESS anomalies are visually distinguishable.

**FOV tier behavior (applies to both missions):**
- **FOV ≥ ANOMALY_HARD_CUTOFF_FOV (55°)** — *hard cutoff*. Outer +
  mid rings rendered at size 0 / opacity 0 (effectively absent);
  core is a 1px static dot at solid 0.7 opacity. The `useFrame`
  body short-circuits — no trig, no lerp, no per-frame material
  mutation. This is the performance fix for the wide-FOV blob: the
  smear at wide FOV came from animating thousands of overlapping
  rings every frame, not from the dot count itself. The latch
  (`isStaticRef`) ensures the static-state snap happens ONCE on the
  transition into wide FOV, not every frame.
- **ANOMALY_TIER_HIGH_FOV (50°) ≤ FOV < 55°** — useFrame body is
  ALSO gated off (`fov >= 50` triggers the early-return). Materials
  hold the values the 40°–50° fade math drove them to as the user
  crossed 50°, which by that math are already at overview state
  (`detail = 0`). Render output is effectively identical to the
  ≥55° region. The 50°–55° gap exists to honor both thresholds
  named in the spec literally — useFrame off at ≥50, hard cutoff at
  ≥55.
- **ANOMALY_TIER_LOW_FOV (40°) ≤ FOV < 50°** — animation runs;
  linear cross-fade via `detailAmount(fov)` (returns 0→1). Ring
  opacities scale by `detail`, core size lerps from 1px to 8px,
  core color lerps between overview and detail palettes, core
  opacity blends between the static overview value and the pulsing
  detail value.
- **FOV ≤ 40°** — *detail mode*. Full three-layer pulse animation.

Initial material props in JSX match the static-overview state
(outer/mid size 0 opacity 0, core 1px opacity 0.7) so first paint
is correct even when the camera starts wide. The useFrame body
mutates these values only when FOV < 50°.

**Per-mission color themes** (declared as `AnomalyTheme` objects;
applied via `<ThemedAnomalyMarkers theme={…} />`):
- **Kepler**: overview `#f4a261` (orange), detail core `#ff0000`
  (red), mid ring `#ff4d6d`, outer ring `#ff0000`.
- **TESS**: overview `#7df9ff` (pale cyan), detail core `#00e5ff`
  (saturated cyan), mid ring `#00bcd4` (teal), outer ring `#00e5ff`.

`AnomalyMarkers` partitions the catalog into two buckets by
`star.source` (`'TESS'` → TESS theme; anything else, including
`undefined` and `'Hipparcos'`, → Kepler theme — most legacy seeds
ARE historically Kepler targets) and renders one `ThemedAnomalyMarkers`
layer per mission. Dual-mission stars (in both KOI and TOI) end up
tagged `'TESS'` because the TOI merge runs after KOI in `page.tsx`.

### Initial loading screen
`page.tsx` shows a multi-stage loader before the 3D view appears.
Three catalogs fetch in parallel (Hipparcos via `/api/stars`, Kepler
KOI via `/api/koi`, TESS TOI via `/api/toi`); the loader displays
each as its own line with state markers (`…` pending, `✓` ready,
`(unavailable)` failed). The sky renders as soon as Hipparcos
resolves; KOI and TOI overlays are merged together once both mission
fetches have completed (or were skipped silently if they failed —
Hipparcos alone is still navigable). KOI merges first, then TOI on
top, so dual-mission stars end up tagged as `'TESS'`. Cold first
load: ~1s for Hipparcos via the proxy, ~5–15s for each mission
catalog (then 24h disk-cached).

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
- **Outlier filter** (three cascaded passes — passes 1 and 2 were a
  real bug for months; pass 3 caught regressions on KOI stars like
  K00526.01): all three replace bad samples with `null` before any
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
  3. **Neighbor-based single-point spike detector** (`SPIKE_K = 5`,
     `NEIGHBOR_AGREE_K = 3`, **symmetric**): walks the array; for
     each interior surviving sample, compare it to its immediate
     previous and next surviving samples. If `|f[i] - f[i-1]| > 5 *
     MAD` AND `|f[i] - f[i+1]| > 5 * MAD` AND `|f[i-1] - f[i+1]| < 3
     * MAD`, null out `f[i]`. This is **symmetric** (both upward and
     downward single-sample spikes get dropped) — safe because real
     transits are multi-sample events (Kepler 30-min cadence ×
     ~3-hour transit = at least 4–8 consecutive in-dip samples), so
     the in/out-of-dip edges always have at least one neighbor in
     agreement with the candidate. Time-gap aware: won't compare
     across observation gaps > `GAP_DAYS` so quarter boundaries don't
     trigger false detections at the seams. Added after K00526.01
     showed a sharp single-point downward V-spike near BKJD 763 that
     the asymmetric MAD doesn't catch (it's downward — a hot-pixel
     masking artifact or similar instrument glitch). The asymmetric
     MAD remains the primary global cleanup; this pass is the
     targeted follow-up for sample-isolated artifacts of either sign.

  **Diagnostic logging**: append `?debugStar=<any-string>` to the
  page URL to get a one-shot console log per render with the
  median, MAD, both thresholds, and the dropped-by-pass counts for
  whichever star you select. The string doesn't have to match the
  star id; the presence of the param turns logging on. Used during
  the K00526.01 investigation; left in because the cost is one URL
  param read per render.
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
- **Dip label collision (bucket-winner selection)**: when many dip
  markers cluster within a short time span (e.g. periodic transits
  on KIC 11610797), labels could pile into an unreadable wall.
  Algorithm:
  1. Partition the canvas x-axis into fixed
     `LABEL_BUCKET_CSS_PX = 80` wide buckets (CSS px, converted
     per render so spacing is consistent across the 460-px inline
     and the 1600-px fullscreen chart).
  2. For each visible dip, compute `bucket = floor(x / bucketWidth)`.
  3. Keep one winner per bucket: the highest-`score` dip in that
     bucket gets its label rendered. All others render dot-only.

  Guarantees ≤1 label per 80 CSS px of horizontal space → evenly-
  spaced labels at any zoom level, no overlap math needed. Dots
  still render for every visible dip so all transits remain
  hover/click targets.

  Earlier approaches and why they were replaced:
  - **Suppress all but the highest-scoring in a 60-px x-window**:
    same idea as the current bucket approach but with a sliding
    window instead of fixed buckets; replaced by cascading because
    the team wanted to keep more labels visible.
  - **Cascade y against the immediately-previous label**: compared
    only one neighbor, so a cluster of 8 transits stacked all the
    way down to the bottom axis and still overlapped sideways.
  - **Bounding-box retry + suppress (4 attempts)**: checked against
    all placed neighbors but over-corrected — at wide zoom-out
    every retry slot was also taken in dense regions, so almost
    every label got suppressed and the chart had no labels at all.
    Bucket-winner is the right balance: always shows at least one
    label per 80-px region, never tries to fit more than fits.

### Light-curve classifier (`lib/curveClassifier.ts`)
`classifyCurve(times, flux, dips)` returns a `CurveProfile` — a set
of MEASURED features of the data, plus a descriptive pattern label.

**Hard rule: descriptive, never causal.** No string in this file or
in the consuming UI is allowed to assert a physical cause. No
"planet", "binary", "alien megastructure", "Dyson sphere". The
classifier measures; the user interprets. Labels and notes are
phrased as observations about the data, with the IRREGULAR copy
explicitly framed as a prompt ("worth a closer look") rather than
a conclusion.

**Measurements:**
- **Periodicity (0–1)**: candidate period = smallest non-trivial
  consecutive interval between dip peaks (> 0.04 d to skip
  same-transit double-counts). For each interval Δt, fold to
  `[-P/2, P/2]` and take `|folded| / (P/2)` as the phase residual.
  Score = `1 - median(residuals)`, clamped. Robust to missed
  cycles because any integer multiple of P folds cleanly back to 0.
- **Depth consistency (0–1)**: `1 - std(depths) / mean(depths)`,
  clamped. Inverted coefficient of variation. 1 = all dips same
  depth; 0 = depths vary by 100%+ relative to mean.
- **Dip shape (U / V / MIXED / UNKNOWN)**: vote among the top
  `SHAPE_VOTE_TOP_N = 5` deepest dips. For each, compute the mean
  of `(flux[min±k] - flux[min]) / depth` for k=1..3 (~90 minutes
  of Kepler 30-min cadence on each side of the minimum). Ratio <
  `SHAPE_SPLIT_RATIO = 0.3` → U vote; ≥ → V vote. Returns the
  dominant vote, MIXED on tie or near-tie (margin of 1 with ≥ 4
  voters), UNKNOWN when no dip had usable flanking samples.
- **Baseline RMS**: `std(flux outside dip ranges) / mean(flux
  outside dip ranges)`. Excludes any sample whose index falls in
  any `[dip.startIdx, dip.endIdx]`. Returned as a fraction, so
  0.002 = 0.2% noise.

**BLS period search (classifier v2, 2026-07-04)**: `lib/bls.ts` is a
budgeted plain-TS Box Least Squares search (no deps): upper-only MAD
clip → 3 h time-binning → log-spaced coarse frequency grid capped by
an ops budget (P 0.5–120 d, 200 phase bins, 6 box durations) → SDE
statistic over the SR spectrum → 15× refinement around the peak.
~1–2 s per full-mission curve; `BLS_SDE_THRESHOLD = 7.5` is the
confidence bar. Documented approximations: sensitivity degrades for
durations ≲ 3 h and periods ≲ 1 d unless the signal is deep; red
noise suppresses SDE (sub-threshold = "no confident detection",
never "no signal"). `CurveProfile.bls` carries the raw result
(period/epoch/depth/duration/SDE) REGARDLESS of pattern label — the
readout shows it as its own "Statistical periodic signal detected
(BLS)" line. A SPARSE star with a confident BLS line is the
NASA-score-vs-local-detector desync case made self-explanatory
(e.g. K02357.02: 1 visible dip, but BLS finds the sibling planet
K02357.01 at P=2.4210 d / 157 ppm, matching NASA to 5e-5).

**Pattern label priority (v2):**
1. `HIGH_VARIABILITY` if `baselineRMS ≥ 0.01` (1% noise floor).
   Takes precedence — even over a confident BLS hit (the BLS line
   still shows separately).
2. `SPARSE` if dip count < `MIN_DIPS_FOR_PATTERN = 3`. This gate is
   deliberate: PERIODIC_UNIFORM's copy describes the VISIBLE dip
   pattern, so a confident BLS signal with 0–2 visible dips must NOT
   promote — that would make the label describe something the user
   can't verify by looking at the curve (describe-don't-diagnose).
3. `PERIODIC_UNIFORM` if the BLS search found a confident signal
   (SDE ≥ 7.5, period ≥ MIN_PLAUSIBLE_PERIOD_DAYS). Replaced the old
   interval-folding gate + implausible-period/dip-density guards — a
   real phase-folding search inherently rejects cadence lock-on.
4. `UNCERTAIN` if the raw scalars look periodic (periodicity ≥ 0.5
   AND depthConsistency ≥ 0.5) but BLS found nothing confident — the
   signature of the dip detector locking onto flicker.
5. `IRREGULAR` otherwise.

`bestFitPeriodDays` is sourced from BLS and surfaced only when the
label is `PERIODIC_UNIFORM` (anywhere else a period would contradict
the label). `CLASSIFIER_VERSION` (currently 3) must be bumped on any
change that can alter LABELS — pattern-cache entries record it, and
the batch treats old-version entries as missing (re-classifies).
Purely additive `CurveProfile` fields that never feed `pickPattern`
(e.g. `oddEven`) do NOT bump it: the cache stores only the label, so
new fields can't go stale there.

**Odd/even transit depth check (`lib/oddEven.ts`, 2026-07-06)**: the
standard first-order vetting measurement on a confident periodic
signal — `CurveProfile.oddEven`, computed on the same gate as the
BLS readout line (SDE ≥ 7.5, plausible period; independent of the
pattern label, so SPARSE K02357.02 still gets measured). Flux-fold
method mirroring Kepler DV (NOT dip-detector-based — the 1% dip
threshold would drop shallow transits): each sample gets a cycle
index `n = round((t − t₀)/P)`; in-transit = inside the BLS box;
per-cycle local baseline from the 0.5–2.5×duration flanking window
(robust to slow variability); per-cycle depth = median(baseline) −
median(in-transit), needing ≥3 in-transit + ≥5 baseline samples per
cycle. Cycles split by parity of `n`; group means compared via a
z-statistic from empirical standard errors. Verdict `MISMATCH`
requires diffSigma ≥ 3 AND relDiff ≥ 5%; else `CONSISTENT`; null
when either parity has < 3 usable cycles or the folded box isn't a
dimming. The 5% relative floor is CALIBRATED against ground truth:
KIC4275739 (K01317.01), a DR25 `DEPTH_ODDEVEN`-flagged FALSE
POSITIVE, measures Δ9.5% at 15.4σ on our pipeline — an earlier 10%
floor wrongly read it CONSISTENT. The ClassifierReadout renders the
result as its own line ("Odd/even transit depths differ: …" /
"… consistent: …") — numbers only, never "binary"/"planet".

- **Partial curves**: odd/even RUNS on partial data, deliberately.
  A missing quarter spans many periods, so it removes odd and even
  cycles in near-equal numbers — no systematic parity bias, only
  reduced N, which the standard errors widen for (partial data makes
  the check MORE conservative, never more alarmist). The one
  geometry that could bias parity (P ~ quarter length) can't reach 3
  cycles per parity and nulls out via the ordinary gate. The
  readout's ⚠ PARTIAL DATA caveat already marks everything
  provisional. Unit-tested (simulated missing-quarter block must not
  fake a mismatch).
- **Half-period lock is a precondition** (learned building the
  fixture): the mismatch is only measurable when OUR BLS locks the
  same half-period NASA's pipeline flagged. KIC12506351 (also
  DEPTH_ODDEVEN-flagged) was evaluated and REJECTED as a fixture —
  our BLS finds its TRUE period (2× the flagged one), so odd/even
  compares primary-vs-primary and is genuinely CONSISTENT at that
  fold. Not a bug; a property of the fold geometry.
- **No re-batch was needed** for this feature: labels unchanged,
  version stays 2, cached patterns remain valid.

**Secondary-eclipse check (`lib/secondaryEclipse.ts`, 2026-07-06)**:
the companion vetting measurement to odd/even —
`CurveProfile.secondary`, same confident-BLS gate, same
non-label-affecting status (version stays 2, no re-batch). Same
per-cycle machinery aimed at phase 0.5: per-cycle depth at
`t₀ + P/2 ± duration/2` vs the 0.5–2.5×duration local flank, pooled
across cycles into mean ± SE → z-statistic. `DETECTED` when depth > 0
and σ ≥ 3; `NOT_DETECTED` otherwise; null under 3 usable cycles.
Result carries depthPpm, sigma, cycles, and `ratioToPrimaryPct` so
the "comparable depth" comparison is stated numerically, never
labeled. LIMITATION (documented in-module): fixed phase-0.5 window —
an eccentric system's displaced secondary is missed; the check
answers "is there a dimming AT phase 0.5", not "anywhere in the
fold".

- **Complementarity with odd/even** (verified on ground truth, both
  directions): which check fires depends on which period BLS locks.
  Half-period lock → secondary folds ONTO phase 0 → odd/even fires,
  phase 0.5 empty (K01317.01: odd/even Δ9.5%/15.4σ, phase 0.5 reads
  −80 ppm/−2.9σ — the slight brightening is the binary's ellipsoidal
  peak at quadrature). True-period lock → secondary sits at phase
  0.5 → this check fires, odd/even consistent (K01130.01: 2,311 ppm
  at 74σ, ratio 13.8%, odd/even 0.4σ; KIC12506351: ratio 99.6% —
  near-equal binary — odd/even 1.1σ, measured but not frozen).
- **Hot-Jupiter edge case is handled by being descriptive**: a real
  planetary occultation is just a shallow detected dimming with a
  tiny ratio. Ground truth HAT-P-7b (K00002.01, CONFIRMED, DR25
  MOD_SEC + PLANET_OCCULT flags): DETECTED 59 ppm at 30.9σ, ratio
  1.1% — matches the literature occultation. The check reports the
  numbers; it never says "false positive".
- **Partial curves**: same policy and reasoning as odd/even — the
  phase-0.5 window recurs EVERY cycle, so a missing quarter removes
  whole cycles (phase-0 and phase-0.5 slices alike), not the
  secondary window preferentially; lost coverage only widens the SE.
  The preferential-loss geometry (P ~ quarter length) can't reach 3
  usable cycles and nulls out. Unit-tested (missing-quarter block
  must not fake a detection).
- No threshold calibration was needed (unlike odd/even's 5% floor):
  3σ cleanly separates all seven fixtures' measured values.

**Client thread**: classification (dominated by BLS) runs in a Web
Worker via `lib/classifyAsync.ts` → `workers/classify.worker.ts`;
Node paths (batch, unit tests) and any worker failure fall back to a
direct call. `selectStar` re-checks its selection generation after
the await, same rule as after the fetch.

**Flow:** `selectStar` in `StarField.tsx` calls `classifyCurve`
after `detectDips`, stuffs the result into `lightcurve.profile`,
which flows through the store to `LightCurveFullscreen` →
`<ClassifierReadout>` (top-left floating panel inside the
overlay). The readout shows pattern label + the four scalars +
best-fit period when present + dips counted, with a one-line
descriptive note keyed off the pattern. `profile` is `null` when
the lightcurve source is `'unavailable'` (no data to classify) —
the readout returns null in that case.

### Data regression test (`npm run test:data`)
`src/lib/__tests__/dataRegression.test.ts` runs `detectDips` +
`classifyCurve` against eight frozen real-data fixtures
(`src/lib/__tests__/fixtures/*.json.gz`, gzipped MAST Kepler PDC
curves captured 2026-07-02/03 and 2026-07-06) and compares to
hand-verified expected values (dip count, pattern label, top-dip
label / peak time / depth, best-fit period, odd/even verdict +
relative depth difference, secondary-eclipse verdict + depth). Fails
loudly (per-field diff + exit 1) on any drift.

Plain Node ≥ 22.6 executes the TS via native type stripping — no
test framework, no extra deps (`allowImportingTsExtensions` was
added to tsconfig for the `.ts` imports). When to run it: see the
**pre-change checklist** in the Testing section below.

After an INTENTIONAL algorithm change: `npm run test:data -- --print`
dumps the newly-measured values; re-verify them by hand, then update
`EXPECTED` in the test file.

Fixtures: Tabby's Star (KIC8462852 — 9 dips, D1519 −20.7% top),
K02357.02 (KIC7449554 — 1 dip, NOTABLE, t=1273.1, SPARSE),
K00931.01 (KIC9166862 — 351 dips ≈ NASA's 3.856 d period over the
baseline; hand-verified via transit-count agreement), K01725.01
(KIC10905746 — 53 variability dips, UNCERTAIN via the
implausible-period guard; its real 0.15% transits are below the 1%
dip threshold), K01317.01 (KIC4275739, added 2026-07-06 —
DR25 DEPTH_ODDEVEN false positive; BLS locks NASA's flagged
half-period 2.1718 d and odd/even must read MISMATCH Δ9.5%/15.4σ;
captured complete, 11/11 quarters), K01130.01 (KIC8279765, added
2026-07-06 — DR25 MOD_SEC false positive; secondary DETECTED
2,311 ppm/74σ at NASA's true period, odd/even CONSISTENT — the
complement of K01317.01's geometry), and K00002.01 = HAT-P-7b
(KIC10666592, added 2026-07-06 — CONFIRMED hot Jupiter with the
PLANET_OCCULT flag; secondary DETECTED 59 ppm/30.9σ, ratio 1.1%,
0 dips → SPARSE). The odd/even and secondary expectations also pin
the negative paths: no-confident-BLS stars (Tabby, K01725.01) must
yield null for both checks, K02357.02/K00931.01 must stay
CONSISTENT / NOT_DETECTED, and K01317.01 must read NOT_DETECTED at
phase 0.5 (its secondary folds onto phase 0 under the half-period
lock).

Expectations were re-frozen 2026-07-04 for classifier v2 (BLS): the
old K00931.01 quirk (periodicity 0.4996, a hair under the cutoff →
IRREGULAR) is RESOLVED — BLS promotes it to PERIODIC_UNIFORM at
P ≈ 3.85563 d (NASA: 3.855603916, 6e-6 relative agreement). The
fixtures now also pin BLS behavior: Tabby must NOT fold confidently
(aperiodic), K02357.02 must find the sibling planet's 2.4210 d
signal while staying SPARSE (promotion gate), and K01725.01's
variability-driven raw periodicity must stay UNCERTAIN because BLS
finds no confident signal in its red noise.

### Testing — layers & pre-change checklist
Three test layers, one lookup table. **Run the matching commands
BEFORE and AFTER touching the listed area:**

| Touching | Run |
|---|---|
| `anomalyDetector` / `curveClassifier` / `fitsReader` / `fitsCore` / `/api/lightcurve` fetch or normalization | `npm run test:data` + `npm run test:unit` |
| `tpfReader` / `centroidVet` / `/api/centroid` | `npm run test:data` + `npm run test:unit` (centroid fixtures live in test:data) |
| `selectStar` / `store` / `persistence` | `npm run test:unit` (+ `test:e2e` if the selection flow changed) |
| `simbadIds` / `catalogMembership` / `/api/identity` / `identityClient` | `npm run test:unit` + `npm run test:routes` (frozen SIMBAD fixtures live in `src/lib/__tests__/fixtures/simbad/`) |
| `AlsoKnownAs` panel block / identity store slot / `StarSearch` alias ranking | `npm run test:unit` (+ `test:e2e` if the selection flow changed) |
| `StarSearch` ask-SIMBAD flow / `catalogMembership` outcomes | `npm run test:unit` + `npm run test:e2e` (`ask-simbad.spec.ts` — it also guards the never-query-on-keystroke rate posture) |
| `StarField` selection paths / CameraSync / disambiguation popover / HUD panels | `npm run test:e2e` |
| anything else | `npx tsc --noEmit` + verify in the browser, as always |

`npm test` = `test:unit && test:routes && test:engine` — the fast
no-browser gate, safe to run reflexively. `test:unit` = APP unit tests
(`src/lib/__tests__`); `test:routes` = API route handlers run directly
under `node --test` (`src/app/api/__tests__/*.route.test.ts`, via the
route-test resolver that maps `@/…` and shims `next/server`);
`test:engine` = the engine package's full suite
(its unit tests + both data-regression suites + the architecture
guard, run via `npm --prefix packages/stellar-vetting-engine test`);
`test:data` delegates to the package's data-regression suites only
(for `--print` refreezing, run inside the package:
`cd packages/stellar-vetting-engine && node --import ./scripts/register-ts-resolver.mjs tests/centroidRegression.test.ts --print`).
Engine tests and the frozen fixtures LIVE in the package
(`packages/stellar-vetting-engine/tests/`).

**Layer 1 — unit (`npm run test:unit`)**: `node --test` over
`src/lib/__tests__/*.unit.test.ts`. Zero dependencies — plain Node
≥ 22.6 native type stripping plus `scripts/register-ts-resolver.mjs`,
a module hook that retries the app's bundler-style extensionless
relative imports with `.ts` (Node's ESM loader alone rejects them;
`test:data` uses the same hook since the classifier now imports
`./bls` at runtime). Covers: `fitsReader` (synthetic FITS buffers
built to spec — HDU walking, TTYPE lookup, TFORM D/E/J/I,
repeat-count offsets, NaN→null, multi-block headers, both error
paths), the BLS engine (`bls.unit.test.ts`: deterministic synthetic
transit injections — deep/short-period and shallow 500 ppm at
full-mission scale with a 3 s wall-clock budget — plus pure-noise
and aperiodic-dips null tests), the `selectStar`
selection-generation guard (stubbed `globalThis.fetch` with
manually-ordered deferred responses — both stale orderings,
loading-flag ownership, pattern-cache POST suppression), and store
contracts (new Set/Map references on mutation, idempotence
short-circuits, cursor reset, flyTo command ids, localStorage
persistence + private-mode swallow via a shim).

**Layer 2 — data regression (`npm run test:data`)**: see the
section above.

**Layer 3 — E2E (`npm run test:e2e`)**: Playwright (`@playwright/
test` devDependency; one-time `npx playwright install chromium`).
Config in `playwright.config.ts`: boots `npm run dev` itself, or
reuses a server already on :3000 (`reuseExistingServer`); 1 worker
(specs share server caches); SwiftShader flag for headless WebGL.
Specs in `e2e/` formalize scenarios previously only verified by
hand:
- `auto-select-transition.spec.ts` — transition-on-center fires,
  search picks survive the suppression window, drags re-fire.
- `popover-disambiguation.spec.ts` — dense-field candidate counts
  stay single-digit (the screen-distance fix) and an off-center
  pick sticks.
- `selection-race.spec.ts` — the stale-response race made
  deterministic: `page.route()` serves the repo's gzipped fixtures
  and holds the stale star's response until after the newer pick
  resolves. No cold MAST, fully offline-reproducible.
- `ask-simbad.spec.ts` — the mechanism-(b) escape hatch: all three
  outcomes (matched → selects; not-tracked → message, camera does
  NOT move; unknown), plus the rate-posture guard that typing fires
  ZERO `/api/identity` requests and one Enter fires exactly one.
  `/api/identity/*` is intercepted and served from the frozen SIMBAD
  fixtures, so the suite never puts CI traffic on CDS.
Full E2E run ≈ 3–5 min warm; first-ever run adds the chromium
download and cold catalog fetches.

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
bucket. Preserves visual peaks (so dips stay visible), deterministic,
O(N).

**Min/max preservation** (custom extension): standard LTTB can still
miss the segment's global y-extremes if they fall in a bucket whose
largest triangle is formed by a different point. For Kepler curves
that can hide deep narrow dips (Tabby's −22% events span <50 samples
out of ~60k). After the standard pass, `lttbIndices` splices in the
global y-min and y-max indices of the segment if not already present,
preserving chronological order via binary-search insertion. Cost: one
extra O(N) pass to find the extremes, +0–2 spliced entries.

**Per-pixel-column dedupe** (custom extension): even after LTTB +
min/max preservation, the budget allocation can leave multiple picked
points in the same screen column on high-frequency oscillators (KIC
6543674, KIC 11852982, etc). Each consecutive pair in the same
column emits a near-vertical `lineTo`, and antialiasing bridges the
gap between up/down strokes — the chart visually fills in as a solid
block. The draw loop runs a single O(N) pass over the picked indices
after LTTB: when `floor(x[k]) === floor(x[k+1])`, drop the point
whose `y` is closer to `toY(median)` and keep the one further out
(equivalent to "further from median in flux space" since `toY` is
monotonic). Guarantees ≤ 2 points per column in the final stroke
path — eliminates the fill artifact without touching the visible
shape of the curve.

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
output points across the strip width. Does NOT apply the per-pixel-
column dedupe — the strip is small enough that the fill artifact has
never been observed there, and the dedupe was scoped to the main
chart in the bug report that prompted it. If the minimap ever shows
the same symptom, the dedupe pass would port over trivially.

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

### Click disambiguation (`ClickRaycastBridge` + `ClickDisambiguationPopover`)
Dense KOI/TOI clusters often stack multiple stars onto the same
screen pixel. Single-hit raycasting was silently picking whichever
sample the raycaster returned first — the user had no signal that
other stars were there. Fix:

1. `raycaster.intersectObject(mesh)` returns EVERY hit along the
   ray (already does; we just weren't using them all).
2. For each hit, project the STAR'S OWN world position (read from
   the geometry position buffer at `hit.index`) to screen space via
   `camera.project` + NDC-to-CSS-pixels, and compute the Euclidean
   distance from the click point in CSS pixels.
   **Pitfall (was a live bug)**: do NOT project `intersection.point`
   — for `THREE.Points`, raycasting sets it to the closest point ON
   THE RAY (`Ray.closestPointToPoint`), not the star's position, so
   it projects back onto the click pixel for every hit. With that,
   the 6px screen filter passed EVERYTHING inside the world-space
   Points threshold (~0.5° of sky at the star-sphere radius) and
   dense-field popovers listed 20–30 "candidates" up to ~27′ from
   the cursor, all reading 0.0px. Measured on a fixed 16-click grid
   over the Kepler field at FOV ≈ 24°: before = 10/16 popovers,
   5–30 candidates (mean 15.6); after = 5/16 popovers, 2–4
   candidates, the rest direct-select.
3. Keep only hits within `CLICK_DISAMBIG_RADIUS_PX = 6`. That's the
   direct "clicked on this spot" filter — wider world-space
   raycaster thresholds catch stars that are far off in perspective
   at narrow FOV; this filter re-anchors to what the user actually
   clicked.
4. **0 candidates**: fall back to the single closest-to-ray hit
   (`distanceToRay`) so a slightly-off click still selects
   something — matches the old edge-case behavior.
5. **1 candidate**: select immediately, no UI change.
6. **2+ candidates**: open `<ClickDisambiguationPopover>` at the
   click coordinates. Popover lists each candidate sorted by
   ascending screen distance, showing name · ΔRA · ΔDec, where the
   deltas are the star's angular offset from the clicked sky
   position in arcminutes (ΔRA cos δ-corrected, RA-seam-wrapped;
   sub-0.1′ values get two decimals). The previous mag · px columns
   rendered identically for every row in dense KOI stacks (mag 13.5
   · 0.0px — the KOI default magnitude and a sub-pixel projected
   distance) and gave zero signal to tell candidates apart;
   `screenDistPx` is still computed as the sort key, just not
   displayed. Click a row → select + close. Click the backdrop →
   close without selecting.

The popover's backdrop is a full-viewport transparent
`position: fixed` layer that captures React `onClick` to dismiss.
The card `stopPropagation`s its own click so backdrop dismiss
doesn't fire from a card click.

**Native-event isolation** (this was a real bug for one iteration):
the outer container registers NATIVE `pointerdown`/`pointerup`
listeners on its root div via `addEventListener` — those don't
participate in React's synthetic-event tree, so React
`stopPropagation` on the backdrop does NOT stop them from
firing on bubble. First attempt at fixing this attached a native
`stopPropagation` listener on the backdrop; but the backdrop
sits BELOW the react root, and React 17+ delegates its synthetic
events on the root, so stopping propagation at the backdrop
prevented the row's `onClick` from firing at all — the whole
popover broke.

Correct fix: the container's native `pointerdown`/`pointerup`
listeners check `disambigOpenRef.current` and bail immediately
when the popover is open. The ref mirrors the `disambig` state
via a `useEffect([disambig])`, so the ONE stable listener stays
correct without re-binding on every open/close. While the
popover is up:
- Container pointerdown → skip (no `downPosRef` update).
- Container pointerup → skip (picker never fires, no raycaster,
  no `selectStar` on the star underneath the popover).
- Row `onClick` fires normally in React's synthetic tree →
  `onPick(star)` → correct selection.
- Backdrop `onClick` fires when the click misses the card →
  dismiss without selecting.

This makes "no event reaches the raycaster while the popover is
open" literal, and preserves React's synthetic event flow for
the popover's own interactions.

Popover position is clamped to `viewport - card size - 8px` so
clicks near the bottom-right edge don't push the card off-screen.

No fetching happens until the user picks — the raycaster + reproject
pass is pure computation, and `selectStar` (which triggers the MAST
fetch) only fires from the row-click handler.

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
- Catalog star points: per-vertex magnitude-driven base size, max scale
  **2.5×** applied via the `uDepthScale` shader uniform.
- Anomaly rings (outer/mid/core): max scale **3.0×**, multiplied INTO
  the existing pulse animation so the pulse stays visible but at a
  larger amplitude when zoomed in.

`StarPoints` now uses a custom `ShaderMaterial` (`STAR_VERTEX_SHADER` /
`STAR_FRAGMENT_SHADER`) that DOES honor the per-vertex `size` and
`alpha` buffers — brighter (lower-magnitude) stars render bigger AND
more opaque; the faint mag-8–13 tail recedes into a dim backdrop.
`gl_PointSize = size * uDepthScale * uPixelRatio` (no size attenuation
— all catalog stars sit on the same sphere, so screen size tracks
magnitude, not distance). The depth-feel is now a single per-frame
uniform write (`uDepthScale`), NOT a per-vertex buffer rebuild, so it
still costs ~nothing — and it scales all 118k per-vertex sizes
uniformly. The anomaly/radar/selection overlay layers still use plain
`pointsMaterial` (their point counts are small and they animate their
own size scalars). The old note that the per-vertex size buffer was
"dead code" is obsolete — the custom shader consumes it.

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
