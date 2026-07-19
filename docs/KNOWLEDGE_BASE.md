# Stellar Anomaly Explorer — Knowledge Base

Permanent record of **confirmed findings and design decisions**. This is
distinct from the other two docs:

- **README.md** — the pitch / how to run it (audience: newcomers).
- **CLAUDE.md** — operational quick-reference for day-to-day work
  (audience: whoever is editing the code next, human or AI).
- **KNOWLEDGE_BASE.md** (this file) — the *why*: investigations that
  concluded, incidents and their root causes, methodology choices, and
  open issues we understand but haven't fixed. Things that would
  otherwise be re-derived from scratch.

Entries are written to survive: each states what was concluded, how it
was confirmed, and — where relevant — what remains uncertain. Dates are
absolute.

---

## 1. Classifier methodology

### 1.1 Describe, don't diagnose (the hard rule)

The light-curve classifier (`lib/curveClassifier.ts`) and every UI
surface that consumes it are **strictly descriptive**. No string is
allowed to assert a physical cause — no "planet", "binary", "eclipse",
"alien megastructure", "Dyson sphere". The classifier MEASURES features
of the data (periodicity, depth consistency, dip shape, baseline RMS);
the user interprets. The IRREGULAR label's copy is deliberately framed
as a prompt ("worth a closer look"), not a conclusion.

Why this is a rule and not a preference:
- The app reports to citizen-science platforms (Zooniverse, NASA, SETI).
  A tool that whispers "planet" to a volunteer poisons the very data
  those platforms exist to collect. The scientific value is in the
  human making the call on real data — the app's job is to route
  attention, not to pre-judge.
- It keeps us honest about what the measurement can actually support. A
  periodic dip pattern is a *measurement*; "transiting planet" is an
  *inference* that requires ruling out eclipsing binaries, star spots,
  instrumental effects, etc. (See §5, the TPF centroid future feature,
  for the first-order false-positive test we deliberately do NOT yet
  run.)

### 1.2 Plausibility guards (v1) → and why they were replaced

Classifier **v1** used an interval-folding heuristic to detect
periodicity: take consecutive dip-to-dip intervals, fold, score by the
residual. This produced two failure modes that needed guards:
- **Cadence lock-on**: the dip detector could lock onto the observation
  cadence itself and report a spuriously perfect "period" equal to a
  small multiple of the sampling interval. v1 guarded this with an
  *implausible-period* floor and a *dip-density* ceiling.
- **Deep-transit swallowing**: the plausibility guards were tuned
  conservatively and ended up **suppressing real periodic signals** on
  deep-transit stars — labeling genuinely periodic transiting systems
  UNCERTAIN because the raw scalars looked "too clean to be real."

### 1.3 Why BLS was added (classifier v2, 2026-07-04)

A budgeted, dependency-free **Box Least Squares** search (`lib/bls.ts`)
replaced the interval-folding gate. BLS is the standard transit-search
algorithm: it slides a box (in-transit / out-of-transit) across a
log-spaced period grid and maximizes the signal residue, yielding an
SDE (Signal Detection Efficiency) statistic. `BLS_SDE_THRESHOLD = 7.5`
is the confidence bar.

A real phase-folding search inherently rejects cadence lock-on (a
cadence artifact doesn't fold coherently across the whole baseline), so
the v1 implausible-period and dip-density guards were **removed** — BLS
subsumes them. The pattern-label priority became:

1. `HIGH_VARIABILITY` if baseline RMS ≥ 1% (even over a confident BLS
   hit — the BLS line still shows separately).
2. `SPARSE` if fewer than 3 visible dips. **Deliberate gate**:
   PERIODIC_UNIFORM's copy describes the VISIBLE dip pattern, so a
   confident BLS signal with 0–2 visible dips must NOT promote — that
   would make the label describe something the user can't verify by
   looking at the curve. (This is the describe-don't-diagnose rule
   expressed as code. See §4.4 for the K00931.01 consequence.)
3. `PERIODIC_UNIFORM` if BLS found a confident signal.
4. `UNCERTAIN` if the raw scalars look periodic but BLS found nothing
   confident (the signature of the detector locking onto flicker).
5. `IRREGULAR` otherwise.

`CLASSIFIER_VERSION` is bumped on any change that can alter labels;
pattern-cache entries record it and the batch treats old-version
entries as missing (re-classifies).

---

## 2. BLS v2 rollout results

### 2.1 The re-batch (2026-07)

After landing BLS v2, the whole ~9k-star KOI+TOI population was
re-classified (the sky-radar batch). The run completed **10,931/10,931
processed, 0 errors, 8,769 v2 pattern-cache entries** (plus 6 legacy
pre-versioning TIC entries that a future batch will refresh — see the
note in §4 on cache versioning).

Pattern distribution shift, v1 → v2:

| Pattern           |   v1 |   v2 |      Δ |
|-------------------|-----:|-----:|-------:|
| SPARSE            | 4336 | 4331 |     −5 |
| UNCERTAIN         | 3164 | 2032 | −1,132 |
| IRREGULAR         |  522 |  370 |   −152 |
| HIGH_VARIABILITY  |  416 |  416 |      0 |
| PERIODIC_UNIFORM  |  336 | 1620 | +1,284 |

The headline: **PERIODIC_UNIFORM nearly 5×'d (+1,284)** while UNCERTAIN
fell by ~1,132. The BLS search is promoting the periodic signals that
v1's plausibility guards were swallowing (§1.2). Of the deep-transit
population (NASA depth ≥ 10,000 ppm), 783 of 1,592 classified stars now
carry PERIODIC_UNIFORM. (We cannot report the exact *previously-
UNCERTAIN → now-PERIODIC* transition count because the v1 per-star
labels were overwritten by the batch; the aggregate movement is the
evidence, and it's consistent with the deep-transit hypothesis.)

### 2.2 The K02357.02 sibling-planet validation (surprise from the
unit-test session)

While freezing regression fixtures, K02357.02 (KIC7449554) produced a
result that at first looked like a bug and turned out to be a
validation:

- The star shows **1 visible dip** in the rendered curve → the local
  detector labels it **SPARSE**.
- But **BLS finds a confident signal at P = 2.4210 d** (157 ppm),
  matching NASA's catalog period for the SIBLING planet **K02357.01**
  to ~5×10⁻⁵ relative.

So BLS recovered a real second planet's signal that is below the visual
noise band of the rendered curve — the classifier is genuinely more
sensitive than eyeballing. Critically, the star **stays SPARSE** (the
< 3-visible-dip gate holds), so the label still honestly describes what
the user can see, while the BLS line reports the statistical detection
separately. This is the describe-don't-diagnose gate and the BLS
sensitivity BOTH working, on the same star, at the same time. It is now
pinned as a regression fixture.

---

## 3. Data integrity findings

### 3.1 NASA vetting vs. local 1% detector are different instruments
(the score/detector "desync")

A recurring confusion: a star can carry a high catalog `anomalyScore`
(derived from NASA's KOI/TOI vetting — disposition, depth, score) yet
show **no dip** the local detector flags, because the two are
**different instruments measuring different things**, and they are
**not merged by design**:

- NASA's disposition reflects the full vetting pipeline (pixel-level
  centroid tests, multi-quarter folding, ephemeris matching, human
  review) applied to a specific planet candidate's transit.
- The local detector (`detectDips`, threshold 0.990) is a simple
  depth/consistency pass over the rendered full-mission flux at a **1%
  dip threshold**. A 0.5%-depth 4-hour transit spans ~8 samples out of
  ~60k and is, correctly, below its threshold.

They answer different questions ("has NASA's pipeline vetted a candidate
here?" vs. "is there a ≥1% dip in this rendered curve?"). Keeping them
separate — and letting the classifier's BLS line bridge them
statistically when it can (§2.2) — is intentional. The `anomalyScore`
drives attention/markers; the detector drives the per-star dip readout.

**Prior art (for context, not a claim of parity):** the Planet Hunters
TESS team's **"NotPlaNET"** work (a machine-learning false-positive
filter layered on volunteer classifications) addresses the same *class*
of problem — reconciling a sensitive-but-noisy detector against a
vetting instrument, and deciding what to surface to a human. We are NOT
claiming to have solved what they solved; we do far less. The parallel
is noted only to place our score-vs-detector separation in the lineage
of "detector output ≠ vetted disposition" problems that established
citizen-science pipelines also grapple with.

### 3.2 Lightcurve cache staleness (K02357.02 depth drift) — FIXED

**Incident (2026-06/07):** the lightcurve disk cache has a 7-day TTL.
The route was edited multiple times during a dev period while old
entries kept being served. K02357.02's dip measured **1.08% deep from a
stale entry vs 1.00% from a fresh fetch** of the same star (same reader
code, different write-time pipeline). Leave-one-quarter-out testing
ruled out MAST segment availability as the cause (it moves depth
≤ 0.0001 pp) — the remaining explanation was mixed-provenance cached
data written by different code iterations.

**Fix:** `CACHE_SCHEMA_VERSION` on every L2 entry. An entry whose version
≠ the current constant (including pre-versioning entries with none) is
treated as a MISS and refetched, never served. The constant is bumped
whenever the fetch pipeline changes in a way that can alter the arrays.
This eliminates mixed-provenance data as a class.

### 3.3 Hipparcos synthetic-fallback incident (VizieR contract drift) —
FIXED, and now guarded

**Incident (discovered 2026-07-04 audit):** the app had been silently
serving the **synthetic** star fallback for an unknown period. Two
independent VizieR contract changes caused it:
- The `/viz-bin/TSV` endpoint path started returning 404 (VizieR moved
  it to `/viz-bin/asu-tsv`).
- The requested `RArad`/`DErad` position columns stopped being honored;
  VizieR **silently drops unknown requested columns**, and the old
  positional parser turned that into garbage coordinates.

Both failed *silently* because the route fell back to
`KNOWN_ANOMALIES` + client synthetic padding without a loud signal.

**Fixes:**
- Endpoint corrected to `/viz-bin/asu-tsv`; columns switched to the
  catalog-native `RAICRS`/`DEICRS` and located **BY NAME** from the
  header (a missing required column now **throws** — contract-change
  detection, not garbage coordinates).
- Fallback now logs **loudly** (`[stars] VizieR fetch FAILED`).
- **`npm run test:external-health`** (added 2026-07-05) probes all five
  external dependencies against the *exact* shared endpoint constants
  (`lib/externalEndpoints.ts`) the routes use, verifying the CONTRACT
  (required columns present, TOI `tid` column, MAST returns FITS), not
  just reachability. This is the standing guard against silent
  contract drift of exactly this kind.

**Live note (2026-07-05):** the health check immediately earned its
keep — it caught a real, ongoing VizieR-side outage of the Hipparcos
`I/239/hip_main` table (backend DB "not currently reachable", then a
table-specific empty-response state while other VizieR catalogs served
data normally). The check correctly distinguishes this "upstream
service degraded" condition from a column-contract change. This is an
EXTERNAL outage, not an app bug; the route falls back cleanly and the
30-day disk cache will serve real data once VizieR recovers.

---

## 4. K00931.01 (KIC9166862) — **NOT a resolved case; actively
investigated**

This one must be stated precisely, because it is easy to over-summarize
as "fixed."

**What IS confirmed:** the BLS engine computes K00931.01's period
correctly. In the frozen regression fixture (full-mission curve, 351
dips) it labels PERIODIC_UNIFORM at **P ≈ 3.85563 d** vs NASA's
**3.855603916 d** — agreement to ~6 significant figures. The classifier
math is right and pinned by the test.

**What is NOT resolved:** the **live single-star view's displayed label
depends on how many quarters MAST serves at fetch time**, and that is
currently *not always complete*. On 2026-07-05, a live on-demand fetch
of K00931.01 returned only **2 of 17 available quarters (8,023 of ~65k
samples)**, yielding **1 detected dip** → the SPARSE gate fires → the
live view shows **SPARSE with no displayed period**, even though BLS on
that same truncated data still finds the correct 3.8555 d signal (SDE
16.6). So the fixture passes while the live app can show a different,
"downgraded" label for the same star.

**Root cause of the truncation (confirmed 2026-07-05, cross-referenced
to §4.5):** it is NOT a MAST availability problem and NOT a difference
between the batch and on-demand request paths (both call the same
`/api/lightcurve` route with identical query params). The cause is in
the route's **segment-download stage**: it downloads all N quarter FITS
files with unbounded `Promise.all` parallelism, and `archive.stsci.edu`
/ the undici connection pool **drops a random subset of simultaneous
connections** (bare `TypeError: fetch failed`, connection-level, no HTTP
status). The route silently drops failed segments and only bails if ALL
fail, so it caches a **random partial curve**.

Measured on kplr009166862 (17 quarters available at MAST *right now*):

| Download strategy      | Segments recovered |
|------------------------|--------------------|
| Sequential (1 at a time) | **17 / 17** (every trial) |
| Concurrency 3          | 12 / 17 |
| Concurrency 5          | 6 / 17 |
| Full parallel (17)     | 2–5 / 17 (random each run) |

The failure rate scales directly with concurrency. The famous 2-quarter
cache entry was just a bad parallel-download roll that got latched into
the in-process (L1) and disk (L2) caches. (The earlier "forced cold
re-fetch" that appeared to reproduce the 2-quarter result was actually
defeated by the L1 in-process cache serving the stale result in 0.3s.)

**Widespread, not one star:** sampled PERIODIC_UNIFORM KIC stars have
cached segment counts ranging from 2 to 18. KIC11414511 has 2 cached
but **17 available** at MAST — same truncation.

**Status: OPEN.** A fix has been diagnosed but deliberately NOT
implemented pending review, because the right fix depends on the design
call: bounded-concurrency download pool (sequential recovered 100%),
retry on `fetch failed`, a minimum-quarter threshold before caching, or
surfacing "partial data (N/M quarters)" to the user — or some
combination. Tracked in §7.

---

## 5. Known visual / UX bugs — FIXED

These are recorded because each was subtle and the wrong fix was tried
first; the reasoning is worth keeping.

### 5.1 Raycast disambiguation popover filter (dense-field over-listing)

**Symptom:** clicking in a dense KOI/TOI cluster opened a
disambiguation popover listing 20–30 "candidates" up to ~27 arcmin from
the cursor, all reading 0.0px distance.

**Root cause:** the code projected `intersection.point` to screen space
to compute click distance. For `THREE.Points`, raycasting sets
`intersection.point` to the closest point ON THE RAY, not the star's
position — so it projected back onto the click pixel for *every* hit,
and the 6px screen filter passed everything inside the much wider
world-space raycaster threshold.

**Fix:** project the STAR'S OWN world position (read from the geometry
buffer at `hit.index`), then filter to `CLICK_DISAMBIG_RADIUS_PX = 6`.
Measured on a fixed 16-click grid at FOV ≈ 24°: before = popovers with
5–30 candidates (mean 15.6); after = 2–4 candidates, most clicks
direct-select.

### 5.2 Panel z-index occlusion ("clicking a flagged star does nothing")

**Symptom:** clicking a row in the bottom-right FLAGGED list did
nothing while the AnomalyPanel was open.

**Root cause:** the AnomalyPanel is a 300px right-edge column at
z-index 20; the HUD (with the flagged list) is z-index 10 at
`right: 24`. With the panel open, every bottom-right HUD element
rendered UNDERNEATH it — invisible, and clicks aimed at the flagged
rows silently hit the panel instead. The data path was never at fault.

**Fix:** while a star is selected, the bottom-right HUD column AND the
minimap shift left to `right: PANEL_CLEARANCE_RIGHT = 324` (0.25s ease)
so they clear the open panel.

### 5.3 Selection race conditions (star A's header + star B's curve)

**Symptom:** two rapid selections (or an explicit pick immediately
followed by an auto-select) could pair one star's panel header with a
different star's light curve, because whichever MAST fetch resolved LAST
won the store — and the cold path can take ~60s.

**Fix:** `selectStarAndFetchCurve` claims a module-level
`selectionGeneration` counter at entry; after its `fetchLightcurve`
await resolves, it only writes lightcurve/anomaly state (and only clears
the loading flag) if it is STILL the latest generation. The classifier
await re-checks the same generation. Synchronous pre-fetch writes stay
unguarded (the latest call always runs them last). Pinned by a unit test
that stubs `fetch` with manually-ordered deferred responses for both
stale orderings.

A related fix in the same area: the CameraSync **auto-select transition
guard** (`centeredAnomalyRef`) only fires auto-select when the centered
anomaly's id CHANGES frame-to-frame, so an explicit off-center pick
survives; plus a ~1.3s **fly-to suppression window** so a mid-tween
centered-star change doesn't steal a just-completed search pick.

---

## 6. Comparison to prior art (Zooniverse / Planet Hunters TESS)

This app is an **exploration and triage front-end**, not a
classification pipeline or a discovery platform. Being explicit about
the differences keeps us from overclaiming:

- **Planet Hunters / Planet Hunters TESS (Zooniverse)** collect
  volunteer transit classifications at scale and feed them into vetting
  pipelines; their "NotPlaNET" ML filter reduces the false-positive
  load on volunteers (see §3.1). They produce *science-grade candidate
  lists* reviewed by professional teams.
- **This app** does not collect classifications, does not train models,
  and does not vet candidates. It renders real Hipparcos/Kepler/TESS
  data, routes attention toward anomalies via a **descriptive**
  classifier (§1), lets a user inspect a real light curve, and hands
  off to the established platforms (Zooniverse, NASA Exoplanet Archive,
  SETI) for actual reporting. The BLS line and the sky radar are
  attention-routing aids, not verdicts.

Where we DO overlap conceptually is the detector-vs-vetting reconciliation
(§3.1) — a problem those platforms also face — but our handling is a
deliberate *separation* (show both, merge neither), not a solution to
their harder problem.

---

## 7. Known open issues — NOT yet fixed

### 7.1 MAST quarter-availability inconsistency (partial light curves)

Fully diagnosed in §4: the `/api/lightcurve` route downloads all
segments with unbounded parallelism, and `archive.stsci.edu` drops a
random subset under concurrency, so on-demand single-star fetches cache
**random partial curves** (2/17 to full). This makes the live label for
deep-transit stars fetch-dependent (K00931.01 shows SPARSE live despite
being PERIODIC_UNIFORM with the full curve). **Fix diagnosed, held for
design review** — candidate approaches: bounded-concurrency download
pool (sequential recovered 100% in testing), retry on `fetch failed`,
minimum-quarter threshold before caching, and/or surfacing "partial
data (N/M quarters)" in the UI.

### 7.2 TOI 5523.02 — chart renders as solid blocks (12,431 dips)

**FIXED 2026-07-07** (same day as the root-cause below). Fix: (1) a
sigma-relative threshold floor — when `robustFluxSigma` (1.4826×MAD)
exceeds `DIP_NOISE_GATE_SIGMA = 0.0075`, the in-dip cut becomes
`min(0.990, 1 − 3σ_rob)`; the gate sits between the noisiest calibrated
Kepler fixture (K01725.01, σ_rob 0.575%) and this star (1.43%), chosen
by a measured sweep that showed the UNGATED form drifts two Kepler
fixtures (K01725.01 53→0, K01317.01 461→411) — the gate preserves all 7
bit-identically. (2) Fragmentation merge (`DIP_MERGE_GAP_DAYS = 0.01`)
and (3) min duration (`MIN_DIP_DURATION_DAYS = 0.02`) — both structural
no-ops at Kepler's 30-min cadence, active at TESS 2-min. Result:
TOI 5523.02 = 12,431 → **20 dips** (≥3σ sustained excursions, deepest
8.5%), frozen as the 8th regression fixture; the dip-marker blocks in
the chart are gone (the white per-sector noise envelope remains — that
part is a faithful rendering of σ=1.6% data, per the diagnosis).
`CLASSIFIER_VERSION` bumped 2→3 (dip count feeds the SPARSE gate, so
high-noise stars' labels can change); the pattern cache needs a
re-batch to refresh v2 entries. Original diagnosis kept below.

**v3 re-batch completed 2026-07-08**: 10,931/10,931 processed, 0
errors, 8,759 v3 entries (18 stragglers kept at old versions — their
refetch returned no-data/partial; next batch retries). Distribution
v2 → v3: SPARSE 4,331→5,785 (+1,454), UNCERTAIN 2,032→904 (−1,128),
PERIODIC_UNIFORM 1,620→1,172 (−448), IRREGULAR 370→612 (+242),
HIGH_VARIABILITY 416→286 (−130). Direction matches the fix: noise
dips vanish, so flicker-driven UNCERTAIN collapses into SPARSE, and
PERIODIC_UNIFORM promotions that rested on noise "visible dips" drop
to SPARSE (their BLS line still shows). Caveat: the v2 batch ran on
potentially-truncated pre-concurrency-fix curves while v3 ran on
complete ones, so the shift conflates detector calibration with data
completeness — not decomposable without a per-star diff, which the
overwritten v2 labels no longer allow. Operational note: the batch
run surfaced that Next dev auto-restarts on a memory threshold
(~every 4k stars — the lightcurve L1 Map grows unboundedly under
batch load); a 5-min watchdog that re-POSTs on worker death carried
the run to completion across two auto-restarts. The unbounded L1
was FIXED 2026-07-08: it is now a 40-entry LRU (`lib/lruCache.ts`),
bounding L1 at ~80 MB worst-case while keeping the on-demand
repeated-access benefit.

**Root-caused 2026-07-07**. The original CVZ
hypothesis was WRONG: TIC 443616612 is an ordinary 5-sector TESS
target near the ecliptic (Dec −3.98°), 78,198 samples at 2-min
cadence, fetched complete (5/5). Measured diagnosis:

- **Detector: out-of-domain calibration, not a code bug.** The star's
  photometric scatter is σ ≈ 1.6% (Tmag 13.77 at 2-min cadence), so
  the fixed `threshold = 0.990` sits at **0.6σ below the mean** —
  24.3% of ALL samples qualify as "in a dip". With no minimum
  duration and no merging, the noise tail fragments into 12,431
  contiguous runs: 70% are single-sample (one 2-min point), 63%
  start within ≤3 samples of the previous dip's end. On Kepler PDC
  (σ ~0.1–0.3%) the same threshold is 3–10σ, which is why it worked.
  The count is the detector doing exactly what it's coded to do on
  input outside its calibration domain. Fix direction: noise-relative
  (sigma-aware) threshold, and/or minimum-duration + adjacent-run
  merging — the dip-count analog of the implausible-period guard.
- **Chart blocks: two compounding effects, both renderer-faithful.**
  (1) The 5 sectors cover ~109 observed days spread across a
  1,003-day x-span, so all data (and all 12,431 markers) pile into
  ~11% of the canvas columns — ~71 dip markers per occupied column →
  solid cyan/orange/white blocks (NOTABLE 5,320 / INTERESTING 994 /
  NORMAL 6,116 dots stacked). (2) Mean per-column flux peak-to-peak
  is 8.69% vs a p1–p99 y-range of 8.24% — every occupied column's
  samples span the FULL y-range, so even perfect LTTB + per-column
  dedupe (which deliberately keeps the extremes) strokes a
  full-height vertical line per column. The white band is a faithful
  rendering of a 1.6%-σ noise band; the colored blocks are the
  12,431 dip markers. No renderer algorithm failure (detectDips runs
  in 19 ms; classifyCurve in 526 ms).
- **Classifier + vetting checks degrade gracefully.** baselineRMS
  1.18% → HIGH_VARIABILITY (correct, priority rule 1: "dips here are
  hard to trust"). BLS finds no confident signal (SDE 3.5 — red-noise
  suppression, documented) → odd/even and secondary-eclipse checks
  correctly return null. The known planet (P=3.47 d, 4,280 ppm) is
  genuinely below detectability under this noise. The side panel
  slices to 6 dip cards, so only the "DIPS DETECTED (12,431)" counter
  and the canvas markers surface the pathology to the user.

### 7.3 TOI score cap asymmetry (KOI vs TOI scoring scale)

`scoreFromToi` = `min(depth/20000, 0.3) + (CP||KP ? 0.2 : 0)`, so a TOI
tops out around 0.5 in practice (deep + confirmed), whereas
`scoreFromKoi` adds `koi.score * 0.5` on top of the same depth+
confirmation terms and can reach 1.0. TOI has no `koi.score` equivalent
(TAP doesn't carry a comparable per-object score), so the TOI base term
was dropped — but the consequence is that **TESS anomalies systematically
score lower than Kepler ones** and rank below them in score-sorted
views (NEXT ANOMALY, flagged list). This is a scoring-scale asymmetry,
not a bug per se, but it means the two missions' scores are not directly
comparable. Open question whether to renormalize TOI onto the KOI scale
or accept the asymmetry.

---

## 8. Current data pipeline (Mermaid)

```mermaid
flowchart TD
    subgraph External["External archives"]
        VIZ["VizieR<br/>Hipparcos I/239/hip_main<br/>(~118k stars)"]
        KOI_TAP["NASA Exoplanet Archive<br/>KOI cumulative (TAP)"]
        TOI_TAP["NASA Exoplanet Archive<br/>TOI (TAP)"]
        MAST_TAP["MAST VO-TAP<br/>ivoa.obscore"]
        MAST_DL["MAST archive<br/>PDC FITS segments"]
    end

    subgraph Endpoints["src/lib/externalEndpoints.ts (single source of truth)"]
        EP["URL constants + builders<br/>imported by BOTH routes and health check"]
    end
    EP -.shared.-> HEALTH["npm run test:external-health<br/>(5 contract probes)"]

    subgraph Routes["Next.js API routes (server-side, CORS-safe)"]
        R_STARS["/api/stars<br/>parse TSV + 30d disk cache"]
        R_KOI["/api/koi<br/>24h disk cache"]
        R_TOI["/api/toi<br/>24h disk cache"]
        R_LC["/api/lightcurve/[id]<br/>TAP discover → download segments<br/>→ FITS parse → L1+L2 cache"]
    end

    VIZ --> R_STARS
    KOI_TAP --> R_KOI
    TOI_TAP --> R_TOI
    MAST_TAP --> R_LC
    MAST_DL --> R_LC
    EP -.URLs.-> R_STARS & R_KOI & R_TOI & R_LC

    subgraph Client["Browser (React + Three.js)"]
        MERGE["starCatalog: fetch Hipparcos,<br/>merge KOI then TOI by id+position"]
        FIELD["StarField: 118k Points<br/>custom shader (per-vertex size+alpha)"]
        SELECT["selectStar: fetch curve →<br/>detectDips → classifyCurve (BLS, Web Worker)"]
        PANEL["AnomalyPanel + LightCurve<br/>fullscreen interactive chart"]
    end

    R_STARS --> MERGE
    R_KOI --> MERGE
    R_TOI --> MERGE
    MERGE --> FIELD
    FIELD -->|click / search / auto-select| SELECT
    R_LC --> SELECT
    SELECT --> PANEL

    subgraph Batch["Sky-radar batch (server worker)"]
        BATCH["batchClassifier<br/>reuses /api/lightcurve per star"]
        PCACHE["pattern-cache.json<br/>(CLASSIFIER_VERSION stamped)"]
    end
    R_LC --> BATCH
    BATCH --> PCACHE
    PCACHE -->|GET on mount| FIELD

    subgraph Report["Citizen science (hand-off)"]
        ZOO["Zooniverse"]
        NASA["NASA Exoplanet Archive"]
        SETI["SETI Institute"]
    end
    PANEL --> ZOO & NASA & SETI
```

## 9. Dual-license structure: GPL app + MIT engine package (2026-07-10)

The core science modules were extracted into a standalone package at
`packages/stellar-vetting-engine` (npm-ready, NOT yet published):
`dipDetector`, `bls`, `curveClassifier`, `oddEven`, `secondaryEclipse`,
`fitsCore`, `fitsReader`, `tpfReader`, `centroidVet`, exported through
`src/index.ts` and built to ESM + CJS + `.d.ts` with tsup.

**Licensing decision (deliberate, same copyright holder):**
- The **app** (everything outside `packages/`) stays
  **GPL-3.0-or-later** — it is a product, and copyleft is the intended
  posture for it.
- The **engine package** is **MIT** — measurement code this general
  should be adoptable by other researchers, pipelines, and tools without
  copyleft friction. This is the numpy/astropy/scipy pattern: the
  scientific commons layers under permissive licenses, applications on
  top choose their own. Fer is the sole copyright holder of both, so the
  relicensing of the extracted subset required no third-party consent;
  a dependency-license audit (2026-07-10) confirmed the subset imports
  ONLY `node:` builtins — zero third-party code is being relicensed.
- MIT code flowing INTO the GPL app is compatible (the app consumes the
  package); the reverse direction is the one that must stay conscious:
  moving APP code into the PACKAGE changes its license, so it's a
  reviewed decision, enforced culturally and by the package's
  architecture-guard test (default-deny imports; every `src/` file
  carries an `// SPDX-License-Identifier: MIT` header).

**Mechanics:**
- The app imports the engine through one-line shims in `src/lib/`
  (`bls.ts`, `curveClassifier.ts`, …) that `export *` from the package
  SOURCE (`../../packages/stellar-vetting-engine/src/…`) — call sites
  are unchanged, Next bundles the TS directly, and there is exactly one
  source of truth. The app does NOT consume the built `dist/`.
- `anomalyDetector.ts` was split at extraction time: `detectDips` +
  `Dip` + the noise-guard constants moved into the package
  (`dipDetector.ts`); the app kept the lightcurve fetch client and the
  dev-only synthetic generator, re-exporting the detector for existing
  imports. This retired the architecture guard's single documented
  exception — the guard now runs with ZERO exceptions, inside the
  package's own test suite.
- Engine tests + the frozen real-data fixtures moved into
  `packages/stellar-vetting-engine/tests/` (fixtures are NOT duplicated:
  the e2e specs and the fixture-capture script reference the package's
  copy). Root `npm test` = app unit tests + the package's full suite;
  root `npm run test:data` delegates to the package. The package suite
  runs standalone (`npm test` inside the package, app not running) —
  verified, including the built dist via both ESM and CJS entry points.
- Publish decision deferred (possibly aligned with JOSS submission).
  The name `stellar-vetting-engine` is provisional until an npm
  availability check at publish time.

## 10. SIMBAD TAP identity resolution — measured contract (2026-07-17/18)

Phase B1 (investigation, 2026-07-17) measured the CDS SIMBAD TAP
service against real queries before any code; phase B2 (2026-07-18)
shipped the server side: `/api/identity/[id]` + `lib/simbadIds.ts` +
health check #7 + four frozen fixtures; phase B3 (2026-07-18) shipped
the UI, mechanism (a) only (see the B3 subsection at the end of this
§). Everything below was MEASURED, not assumed from documentation.

**Service contract (all verified live):**
- Endpoint `https://simbad.cds.unistra.fr/simbad/sim-tap/sync`, same
  ADQL/TAP GET pattern as MAST (`REQUEST=doQuery&LANG=ADQL&FORMAT=json`).
  No auth.
- Query shape: `basic ⋈ ids ⋈ ident WHERE ident.id = '<alias>'` —
  the `ident` join matches ANY known alias; `ids.ids` returns every
  identifier pipe-concatenated in one row.
- **Identifier matching is whitespace-normalized**: `KIC8462852`
  (app form) resolves identically to `KIC 8462852`. Verified for
  KIC/TIC/EPIC/HIP prefixes. App ids are sent verbatim.
- **Latency**: warm ~0.3–1.6 s (median ~0.8 s), cold ~2.4 s.
  Payloads ~0.5–1 KB.
- **Miss** = HTTP 200 with empty `data` (expected for most faint KOI
  hosts — SIMBAD indexes studied objects, not all of Kepler's field).
- **Query error** = VOTable XML envelope (`QUERY_STATUS=ERROR`) even
  with `FORMAT=json`. JSON parse failure must be treated as an
  upstream/query error, never as data.
- **JSON shape gotcha**: columns are listed under `metadata`, NOT
  `info` as MAST's TAP uses. The parser locates columns BY NAME and
  throws on a missing one (the VizieR column-rename lesson).
- **Rate policy** (CDS, quoted in astroquery docs; not on the TAP
  pages themselves): > ~5–10 queries/second ⇒ IP blacklisted up to an
  hour. On-demand per-click use is orders of magnitude below. Any
  future batch resolution must throttle to ≲2 concurrent with delays
  — do NOT reuse the batch classifier's MAX_CONCURRENCY=5 pattern.

**Identity payoffs found during measurement:**
- EPIC 201637175 (one of the 11 seeds) is **K2-22** — the famous
  disintegrating-planet host. The seed table never knew this.
- HAT-P-7 (KIC 10666592) pins the **Gaia DR1 ≠ DR2/DR3 source_id**
  subtlety (DR1 …0911665920 vs DR2/DR3 …5211984000) — parsers must
  key on `Gaia DR3` specifically, never "Gaia".
- SIMBAD's `main_id` is often NOT the queried id (Tabby's is
  `TYC 3162-665-1`; HAT-P-7's was served as `BD+47  2846` — note the
  catalog-native double space, which is why normalization collapses
  whitespace runs).

**Design decisions (B1, approved 2026-07-18):**
- On-demand resolution with a 30-day schema-versioned per-star disk
  cache — SIMBAD is a living compilation, but identifier data is
  nearly append-only (ids arrive with major catalog releases), so
  30 days bounds staleness without churn. Expired same-version
  entries are served `stale: true` when the refetch fails; misses
  are cached as `identity: null`.
- Parsing is pure and offline-testable but deliberately APP-SIDE
  (`lib/simbadIds.ts`), not in the MIT engine package: identifier
  string munging is catalog plumbing, not vetting science — putting
  it in the package would dilute its scope (JOSS framing) even
  though it would technically pass the architecture guard.
- Fixtures are the four REAL captured responses (Tabby, HAT-P-7,
  WASP-126, K2-22) under `src/lib/__tests__/fixtures/simbad/`, with
  capture provenance (date + exact URL) embedded in each file.
  Refreeze: `scripts/capture-simbad-fixtures.mjs` (throttled 1 q/s).

**Phase B3 — UI integration, mechanism (a) (2026-07-18):**

Shipped: the AnomalyPanel's "ALSO KNOWN AS" block and
search-by-already-resolved-common-name. Mechanism (b) — the explicit
press-Enter-to-ask-SIMBAD escape hatch for stars never opened — was
deferred at the time and shipped later the same day; see the
mechanism (b) section below.

- **Absence renders as nothing, not as an error.** A SIMBAD miss is
  the COMMON case (most faint KOI hosts aren't indexed), so a
  "not found" row would fire constantly while telling the user
  something unactionable. Miss, route failure, and
  everything-was-redundant all collapse to the same output: no
  block. `identityClient.fetchIdentity` flattens the route's
  miss-vs-outage distinction for exactly this reason — the
  distinction is real and matters SERVER-side (a confirmed miss is
  cached, an outage is not), but it buys the UI nothing.
- **The 400 ms placeholder gate is a measured fix, not a guess.**
  Warm disk-cache hits return in single-digit ms; without the delay
  every revisit flashed a one-frame "RESOLVING IDENTITY…" that read
  as a rendering glitch. Verified in-browser: the placeholder does
  NOT appear on a warm re-select.
- **Identity resolves CONCURRENTLY with the light curve.** SIMBAD is
  ~0.3–2.4 s; a MAST cold path is ~60 s. Awaiting identity inside
  the curve path would hide the names behind the slowest thing on
  screen for no reason — they share nothing.
- **The generation guard is narrower for identity than for the
  curve, and the difference is load-bearing.** A superseded curve is
  discarded wholesale (writing it would pair star A's header with
  star B's data). A superseded IDENTITY is kept out of the panel
  slot but still written to the search index via `indexIdentity`:
  the index is keyed by star id, so it cannot mislabel the current
  selection, and dropping it would discard a SIMBAD query already
  spent. This asymmetry was caught by a unit test written on the
  wrong assumption (that the curve's discard-everything rule should
  apply verbatim) — the test failed, and the failure was the
  correct signal. Both behaviors are now pinned:
  `resolvedIdentities` gains the stale star, `identity` does not.
- **INSTANT search coverage is visited-stars-only BY DESIGN.**
  Folding resolved identities into the local match set is free and
  instant. Universal common-name search AS YOU TYPE would require a
  SIMBAD query per keystroke, which the B1 rate posture (~5–10 q/s ⇒
  blacklist) rules out categorically. Alias hits rank BELOW the
  equivalent catalog hit, and matched rows show `↳ <alias>` so a row
  whose visible text lacks the query explains itself. (Mechanism (b)
  later added an EXPLICIT one-query-per-keypress escape hatch on top
  of this — it does not change the typing-fires-nothing rule, which
  is now enforced by an E2E test.)
- **`selectDisplayNames` lives in `lib/simbadIds.ts`, not the
  component** — it is identifier string munging (that module's
  stated scope) and the redundancy check is the same
  whitespace/case-insensitive matching the file already owns. Keeps
  it pure and offline-testable against the frozen fixtures.

**Phase B3 — mechanism (b), the ask-SIMBAD escape hatch (2026-07-18):**

Shipped. Pressing Enter when local search has NO match resolves the
typed text through SIMBAD, then checks the answer against the catalog
the app actually renders. This CLOSES the open question recorded here
previously ("what to do with a hit that resolves to a star we don't
render") — the answer is a third outcome, `not-tracked`, reported
honestly and without moving the camera.

- **The open question's answer: say both facts, move nothing.** The
  copy names SIMBAD's recognition AND our non-coverage — "SIMBAD
  recognizes Andromeda, but it isn't in our tracked
  Kepler/TESS/Hipparcos catalog". Reporting only the second half
  would read as "no such object", which is false and would leave a
  user doubting a correctly-typed name. Flying to the resolved
  coordinates was rejected outright: it would point at empty sky and
  present that as a result.
- **Membership is tested against the LIVE catalog, never inferred.**
  Two cheaper proxies were measured and both are WRONG:
  (a) object type — `3C 273` is a BL Lac quasar that nonetheless
  carries `HIP 60936` and `EPIC 229151988`; (b) mere presence of a
  catalog id — Betelgeuse and Vega both carry a TIC (TESS observed
  most of the bright sky). Only `resolveAgainstCatalog(identity,
  anomalyStars)` can answer it, so the catalog is passed in and read
  through a ref (it can finish merging while the query is in flight).
- **TRAPPIST-1 is the case that proves the design.** It carries
  `TIC 278892590` + `EPIC 200164267` and LOOKS like an
  out-of-catalog object — but NASA's TOI table lists `TOI 6838.01`
  with `tid = 278892590`, the same star. Asking resolves it to a
  real, rendered TOI and flies there (verified in-browser: landed at
  RA 346.626°/−5.043°, within ~18″ of SIMBAD's position). A
  "probably not ours" heuristic would have wrongly refused it.
- **Id preference order is KIC → TIC → EPIC → HIP, deliberately.**
  A mission id means real photometry (the point of the app); a HIP
  hit means we can only point at a background star with no light
  curve. HIP last ensures a mission target wins whenever both are
  present. Unit-pinned in both directions.
- **One route, no new endpoint.** Names go through
  `/api/identity/[id]` unchanged, because the existing ADQL joins
  SIMBAD's `ident` table, which matches ANY alias — upstream, an id
  and a name are the same query (measured: "Boyajian's Star",
  "BOYAJIAN'S STAR", "boyajian's star" all return one record in
  0.3–1.7 s). What DID change: `SAFE_ID` → `SAFE_LOOKUP`, since real
  names carry spaces and apostrophes and the old regex would have
  400ed the feature's own headline case.
- **Widening the input alphabet did NOT widen filesystem exposure.**
  `SAFE_ID` had been doing double duty as the cache-filename guard.
  Cache keys are now derived by `cacheKeyFor` (lowercase,
  whitespace-collapsed, every non-`[a-z0-9._-]` char replaced), so
  filename safety no longer depends on the input regex at all. The
  normalization also makes case/spacing variants share ONE cache
  entry, matching SIMBAD's own matching semantics. Cache schema
  bumped 1 → 2 because keys moved (`identity-KIC8462852.json` →
  `identity-kic8462852.json`); v1 files are simply never read again.
- **Explicit-only, and the invariant is TESTED, not just intended.**
  An E2E test asserts that typing a 8-char query fires ZERO
  `/api/identity` requests and that one Enter fires exactly one.
  This is the B1 rate posture (~5–10 q/s ⇒ CDS blacklists the IP)
  turned into a regression guard, so a future "search as you type"
  refactor fails loudly instead of quietly getting the IP banned.
- **`unknown` and `error` stay separate.** `fetchIdentityByName`
  returns `'error'` distinctly from `null`, unlike the panel's
  `fetchIdentity` which flattens both. The panel can afford to
  flatten (both mean "render nothing"); the search box cannot —
  reporting our own outage as "SIMBAD doesn't know that name" would
  blame the user for our failure.
- **A successful ask permanently improves local search.** The
  resolved identity is folded into `resolvedIdentities` via
  `indexIdentity`, so the name matches INSTANTLY next time. One
  query buys a permanent alias rather than being spent once.
- **M31 is the frozen fixture for the not-tracked branch** — a real
  captured response with 41 identifiers and not one KIC/TIC/EPIC/HIP.
  The unit test asserts that premise explicitly, so if SIMBAD ever
  adds a stellar id to M31 the test fails loudly instead of silently
  changing meaning.

---

## 11. Data-source acknowledgments & citations (2026-07-18)

**Framing — this is NOT §9.** §9 is about SOFTWARE LICENSING (GPL app
/ MIT engine): what others may legally do with this code. This section
is about ACADEMIC CITATION NORMS: what the data providers ask users of
their DATA to reproduce in a publication. The two are independent
obligations with different enforcement (copyright law vs. scholarly
convention) and neither substitutes for the other. Keep them
separate — conflating "we acknowledged NASA" with "we complied with a
license" would be wrong in both directions.

The verbatim text for all five providers lives in **README.md → Data
sources & attribution → Required acknowledgments**, which is the
single source of truth. It is not duplicated here; this section
records the FINDINGS behind it.

**Findings (all verified live 2026-07-18, not assumed):**

- **VizieR and SIMBAD need SEPARATE acknowledgments** even though both
  are CDS Strasbourg services. Using one does not cover the other, and
  this project uses both (VizieR for Hipparcos, SIMBAD for
  cross-identifiers). Their citable papers are likewise separate — and
  are companion papers in the same volume: Ochsenbein+ 2000, A&AS 143,
  **23** (VizieR) and Wenger+ 2000, A&AS 143, **9** (SIMBAD). Easy to
  conflate; don't.
- **STScI's Kepler and TESS texts are asymmetric, and that is not a
  transcription error.** Kepler reads "Funding **to** US Institutions
  for the Kepler mission **was** provided…" (past tense — the mission
  ended in 2018); TESS reads "Funding **for** US Institutions for the
  TESS mission **is** provided…" (present — still observing). Both
  close with the identical STScI/AURA sentence. Reproduce them as
  STScI words them rather than normalizing them to match each other.
- **The NAS contract number uses an EN-DASH**: `NAS 5–26555`, not a
  hyphen. Verified against the STScI page.
- **Older Kepler/TESS wording circulates widely in the literature**
  ("Funding for the Kepler mission is provided by the NASA Science
  Mission Directorate", without the "US Institutions" qualifier).
  Papers using it are not wrong — it was the text at the time — but
  this project follows the CURRENT STScI page. If STScI revises it
  again, README is the file to update.
- **The NASA Exoplanet Archive's citable paper changed in 2025.**
  Christiansen et al. 2025, PSJ 6, 186 (10.3847/PSJ/ade3c2) now
  supersedes Akeson et al. 2013, PASP 125, 989 (10.1086/672273) as the
  reference the archive asks users to cite. Cite Christiansen; the
  Akeson DOI is recorded here only so a future reader recognizes it as
  the superseded one rather than a second required citation.
- **Acknowledgment text ≠ paper citation.** Most of these providers
  want BOTH: the acknowledgment paragraph in the acknowledgments
  section, and the paper in the reference list. Satisfying one does
  not satisfy the other.

**Reference list stub for the eventual `paper.md`** (all five DOIs
resolved and title/volume/page-checked against Crossref on
2026-07-18 — none of these were reconstructed from memory):

| Source | Reference | DOI |
|---|---|---|
| Kepler | Borucki et al. 2010, *Science*, 327, 977 | 10.1126/science.1185402 |
| TESS | Ricker et al. 2015, *JATIS*, 1, 014003 | 10.1117/1.JATIS.1.1.014003 |
| NASA Exoplanet Archive | Christiansen et al. 2025, *PSJ*, 6, 186 | 10.3847/PSJ/ade3c2 |
| VizieR | Ochsenbein, Bauer & Marcout 2000, *A&AS*, 143, 23 | 10.1051/aas:2000169 |
| SIMBAD | Wenger et al. 2000, *A&AS*, 143, 9 | 10.1051/aas:2000332 |

Deliberately NOT included: a Hipparcos-catalog reference (ESA 1997,
SP-1200) — the catalog is consumed THROUGH VizieR, whose own
acknowledgment is required and covered above; whether the JOSS paper
should additionally cite ESA 1997 for the catalog itself is a
paper-writing decision, not a data-attribution one, and no source
consulted here demands it. Also not included: any MAST-specific
citation beyond the mission papers, since MAST's requirement is
satisfied by the acknowledgment text rather than a separate reference.

---

*Last updated 2026-07-18 (§11 added: data-source acknowledgments +
verified citable references, deliberately distinct from §9's software
licensing).*

*Previously: §10 extended with phase B3 mechanism (b);
its previously-open design question is now CLOSED — resolved as the
`not-tracked` outcome.
When an open issue in §7 is fixed, move it to
the relevant "FIXED" section with its root cause, and update the K00931.01
entry (§4) once §7.1 is resolved.*
