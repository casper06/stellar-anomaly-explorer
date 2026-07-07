# Issue drafts — 2026-07-07

Drafted for manual posting (gh CLI not available in the dev
environment). Delete this file once the issues are opened.

---

## Issue 1

**Title:** Dip detector counts noise as dips on high-noise TESS 2-min curves (TOI 5523.02: 12,431 "dips")

**Labels:** bug, calibration

**Body:**

### Symptom

TOI 5523.02 (TIC 443616612) shows **"DIPS DETECTED (12,431)"** and its
fullscreen light curve renders as solid vertical blocks (white band +
cyan/orange marker bars) instead of a readable curve.

### Root cause (diagnosed 2026-07-07 — see `docs/KNOWLEDGE_BASE.md` §7.2)

Not a code bug — a **calibration-domain mismatch**. The detector's fixed
`threshold = 0.990` was calibrated on Kepler PDC 30-min photometry
(σ ≈ 0.1–0.3%, so 0.99 is a 3–10σ cut). This star's TESS 2-min
photometry (Tmag 13.77) has σ ≈ 1.6%, putting the threshold at **0.6σ
below the mean** — 24.3% of all 78,198 samples qualify as "in a dip".
With no minimum duration and no run merging, the noise tail fragments
into 12,431 contiguous runs (70% single-sample; 63% start within ≤3
samples of the previous run's end).

The rendering is downstream of the same pathology: ~71 dip markers per
occupied canvas column (5 sectors of data spread over a 1,003-day
x-span), plus a noise band whose per-column peak-to-peak (8.7%) spans
the full y-range — so the stroke legitimately fills solid.

Existing safeguards behave correctly: the classifier labels the star
HIGH_VARIABILITY ("dips here are hard to trust"), BLS finds no confident
signal, and the odd/even + secondary-eclipse checks correctly return
null. The uncovered surface is the **dip count itself** (panel counter +
canvas markers).

### Fix direction (open for design)

The dip-count analog of the old implausible-period guard:

- a noise-relative (sigma-aware) threshold instead of the fixed 0.990,
  and/or
- a minimum-duration + adjacent-run-merge pass before counting.

Any change must be verified against the seven frozen data-regression
fixtures (`npm run test:data`) so Kepler behavior doesn't drift, per the
calibration methodology used for the odd/even check.

---

## Issue 2

**Title:** Define an explicit freshness/TTL policy for the KOI/TOI catalog caches

**Labels:** enhancement, data-integrity

**Body:**

### Current state

`/api/koi` and `/api/toi` disk-cache the NASA Exoplanet Archive
responses for **24 h** in `<os.tmpdir()>/stellar-cache/` (atomic
temp+rename). The lightcurve cache uses 7 days; Hipparcos 30 days.

### Why this deserves a policy rather than a constant

- The KOI cumulative table is quasi-static, but the **TOI table updates
  frequently** (new TOIs, disposition changes — PC → CP/FP). A
  disposition change flips whether we show a star as an anomaly
  candidate at all, and the current 24 h TTL is an unexamined default,
  not a decision.
- The cache lives in the OS temp directory, so its real lifetime is
  "≤ TTL, or until the OS cleans tmp" — effectively nondeterministic
  freshness.
- There is no user-visible indication of catalog age. The HUD shows
  counts (or CATALOG UNAVAILABLE), but not "as of when".

### Proposal sketch (open for discussion)

1. Document the intended freshness per catalog (KOI vs TOI may
   legitimately differ).
2. Surface `fetchedAt` in the UI (e.g. a small "catalog as of …" line
   in the mission counter card or a tooltip).
3. Consider a stale-while-revalidate pattern: serve the cached catalog
   instantly, refresh in the background, and update counts when the
   fresh copy lands — the current cold-load cost (~5–15 s per catalog)
   is the reason the TTL exists at all.

---

## Issue 3

**Title:** SCORE tooltip should distinguish the catalog anomaly score from the per-dip detector score

**Labels:** documentation, ux

**Body:**

### Problem

The app has **two different "scores"** and one glossary tooltip:

1. **Catalog `anomalyScore`** (the ScoreRing next to a selected star):
   derived from NASA KOI/TOI vetting — `koi.score`, transit depth, and
   a CONFIRMED/KP bonus (`scoreFromKoi` / `scoreFromToi`). It reflects
   NASA's confidence in the candidate, not anything our detector
   measured.
2. **Per-dip `score`** (on each dip card): the local detector's
   `depth × 3 + min(σ/8, 0.3) + asymmetry × 0.1`, which drives the
   WOW / INTERESTING / NOTABLE labels.

A star can carry a high catalog score while the local detector shows no
dips at all (sub-1% transits are below the visible-dip threshold) — the
documented "NASA vetting vs local detector desync"
(`docs/KNOWLEDGE_BASE.md` §3.1). The SCORE (?) tooltip currently doesn't
explain which score it is describing or that the two are different
instruments, which invites exactly the confusion §3.1 documents.

### Fix

- Reword the SCORE glossary tooltip to name its subject explicitly
  ("NASA catalog-derived candidate score") and add one sentence
  distinguishing it from the per-dip detector score.
- Consider a separate tooltip (or a shared one with two short
  paragraphs) on the dip-card score.
- Keep the describe-don't-diagnose framing: both scores are attention-
  routing measurements, not verdicts.
