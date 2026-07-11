# Issue drafts — 2026-07-10

Drafted for manual posting (gh CLI not available in the dev
environment). Delete this file once the issues are opened.

Supersedes `docs/issue-drafts-2026-07-07.md`, whose three drafts
(TOI 5523.02 dip-count, catalog TTL policy, SCORE tooltip) all
describe work that has since shipped:
- dip-count: fixed by the sigma-aware threshold + fragmentation
  guards (commit `0ed7842`, "TOI 5523.02, 12,431 → 20 dips").
- catalog TTL: fixed by the per-catalog TTL + stale-while-revalidate
  policy (commit `4da21ed`).
- SCORE tooltip: addressed by the NASA-score independence clarification
  in AnomalyPanel (commit `8ded887`).

The four below are what is genuinely still open today.

---

## Issue 1

**Title:** TESS centroid vetting results are qualitative/unvalidated — no ground-truth column exists to calibrate against

**Labels:** enhancement, data-integrity, centroid

**Body:**

### Current state

The pixel-level centroid vetting (`lib/centroidVet.ts`, `/api/centroid`)
was calibrated for **Kepler** against NASA's `koi_dikco_msky` /
`koi_dicco_msky` difference-image centroid-offset columns from the DR25
catalog. Five frozen fixtures pin the Kepler verdicts, the 2″
half-pixel floor, the saturation refusal, and one TESS drift pin
(WASP-126 b).

**TESS results are labeled QUALITATIVE / UNVALIDATED in the UI** and
must stay that way: there is **no public per-TOI centroid-offset table**
equivalent to `koi_dikco_msky`, so we have nothing to calibrate the
TESS path's absolute accuracy against. TESS's 21″ pixels also make the
half-pixel floor (~10″) far coarser than Kepler's 2″.

### Why this is still open

The engine runs the same difference-image + catalog-position/WCS
reference machinery for TESS and reports a number, but we can only
assert that the machinery *runs* and produces plausible drift on the
one WASP-126 b pin — not that a given TOI's measured offset is
accurate to any stated error bar. A user could over-trust a TESS
centroid verdict that the code itself flags as unvalidated.

### What would close it

- A public per-TOI centroid ground-truth table appears (TESS DV
  reports, ExoFOP, or a TFOPWG data product) → freeze ≥3 TESS fixtures
  against it, the way the Kepler path is pinned to `koi_dikco_msky`, and
  promote the TESS UI label from UNVALIDATED to validated.
- Until then: keep the UNVALIDATED label, and consider narrowing the
  claim in the UI copy to "difference-image drift shown for context,
  not a vetting verdict" so the qualitative status is unmistakable.

Blocked on external data availability, not on our code. Tracking so the
UNVALIDATED label isn't silently removed before the calibration exists.

---

## Issue 2

**Title:** Publish `stellar-vetting-engine` to npm — package name availability unconfirmed

**Labels:** enhancement, packaging, engine

**Body:**

### Current state

`packages/stellar-vetting-engine` is the MIT-licensed science engine
extracted from the (GPL) app. It has its own `package.json`, a
tsup build (`build` → ESM + CJS + `.d.ts`), its own test suite, a
README, a LICENSE, and now a package-scoped CITATION.cff. It is
structured to be publishable **but has NOT been published to npm.**

### What's unconfirmed / open

1. **Name availability**: `stellar-vetting-engine` has not been checked
   against the npm registry. If it's taken, we need a scope
   (`@casper06/stellar-vetting-engine` or similar) — which also changes
   the `name` field, the README install line, and every "npm consumers
   can cite this" assumption in the package CITATION.cff.
2. **First-publish checklist** is undone: `npm publish --dry-run` to
   confirm the `files` allow-list (`dist`, `README.md`, `LICENSE`)
   produces the intended tarball; confirm the build output is committed
   or built in a prepublish step; decide public vs. restricted access;
   set an initial version tag/policy.
3. **Provenance**: the package `version` is `0.1.0`, matching the
   package CITATION.cff — a first publish should keep those in lockstep
   (and going forward, a release step that bumps both together).

### Why this is still open

The extraction (commit `5b54b5f`) deliberately did the "cheap now"
structural work and left publishing as a separate, reversible-once
decision. Publishing claims a global name and starts a version history
that can't be un-published cleanly after 72h — worth doing deliberately,
not as a drive-by.

### First step

`npm view stellar-vetting-engine` (name check) + `npm publish
--dry-run` from the package dir. Report the tarball contents and whether
the bare name is free before deciding scope.

---

## Issue 3

**Title:** Lightcurve x-axis calendar dates (BKJD/TJD → Gregorian) remain deferred — broke once, cause undocumented

**Labels:** enhancement, ux, lightcurve

**Body:**

### Current state

The lightcurve chart's time axis is drawn in **raw BKJD** (Barycentric
Kepler Julian Date, `BJD − 2454833`) for Kepler and **TJD**
(`BJD − 2457000`) for TESS — 6 evenly-spaced numeric ticks across the
visible window. Dip detection, tooltips, and the dip-marker labels all
speak the same offset-day units, so the whole UI is internally
consistent in BKJD/TJD.

### The deferred feature

Human-readable **calendar-date ticks** ("Jan 2010", "Jun 2011") were
attempted and **reverted** — they caused rendering glitches. The exact
cause was never root-caused or written down, only that reverting fixed
it. So this is deferred with a known failure but an unknown mechanism.

### Why it's non-trivial

- The conversion itself is arithmetic (`BJD = t + offset`; `offset`
  differs Kepler vs TESS; then BJD → Gregorian), but the *tick
  placement* is the suspect: nice-number calendar boundaries (month/
  year) don't map to nice-number BKJD values, so the tick-spacing loop
  that assumes evenly-spaced numeric ticks likely misbehaved (possible
  infinite/again-zero step, label overlap, or NaN from an edge case).
- Any implementation must keep the internal BKJD/TJD coordinate system
  (dips, tooltips, minimap, zoom math all depend on it) and only
  *format* the axis labels — a display-layer change, not a data change.

### What would close it

- Reproduce the original glitch on purpose (git archaeology for the
  reverted commit would help — capture what it did) and document the
  actual cause here before re-attempting.
- Re-implement as label formatting only, with dual display (e.g. BKJD
  on top, calendar below, or a toggle) so the numeric system the rest
  of the UI relies on stays visible.
- Guard tick generation against the non-uniform calendar-spacing edge
  cases that the numeric loop never had to handle.

Low priority — BKJD is functional and self-consistent — but tracked so
the "we tried, it broke, we don't know why" state doesn't get lost.

---

## Issue 4

**Title:** Celestial-orientation Phase 2 (minimap constellation boundary polylines) needs a ~200 KB GeoJSON bundling decision

**Labels:** enhancement, ui, celestial-orientation

**Body:**

### Current state

Celestial-orientation **Phase 1** shipped (commits `288ce3a`,
`11809d3`): the HUD header appends the constellation the camera points
at, and the AnomalyPanel gains a SKY row + a declination-geometry
visibility line. Lookup uses the IAU zone table (VizieR VI/42, Roman
1987) bundled as a build-time TS constant — boundaries are fixed by the
IAU (1930) and never change, so there's no fetch / cache / health check
for it (unique among the app's datasets).

### The open Phase 2 work

Draw faint **constellation boundary polylines** on the existing sky
Minimap so the user can see which constellation they're in visually,
not just as a text label.

### Why it's blocked on a decision, not just effort

The VI/42 zone table used in Phase 1 **cannot draw outlines** — it maps
a point to a constellation but carries no boundary polygon geometry.
The outlines need the separate **VI/49 boundary-polygon data**
(~200 KB GeoJSON). That's a bundling decision with trade-offs:

- **Bundle it as a build-time constant** (like VI/42): +200 KB in the
  JS payload, always present, no network dependency, consistent with
  the "boundaries never change so no fetch" philosophy. But 200 KB is
  ~7× the zone table and every user pays it whether or not they open
  the minimap.
- **Lazy-load** it (dynamic import or a static `/public` asset fetched
  on first minimap open): keeps the main bundle lean, but reintroduces
  a network dependency and a loading state for a dataset that, by the
  same 1930-is-forever logic, could just be bundled.
- **Simplify the polygons** (decimate vertices) to shrink the payload
  before bundling — boundary lines at minimap scale don't need full
  precision.

### What would close it

Pick a bundling strategy (bundle vs. lazy-load vs. decimate-then-bundle),
then render the polylines on the Minimap at low opacity, respecting the
same FOV/zoom gating the other minimap overlays use. The rendering is
straightforward once the data-delivery decision is made.

Future idea — not being implemented now; tracked so the VI/49
dependency and the size trade-off are recorded.
