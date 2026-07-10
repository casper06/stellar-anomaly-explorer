# Design: TPF centroid analysis — Phase 0 feasibility & design audit

**Status:** Phase 1 IMPLEMENTED 2026-07-10, Kepler-only scope
(`fitsCore.ts` extraction, `tpfReader.ts`, `centroidVet.ts`,
`/api/centroid/[id]`, opt-in UI in the fullscreen overlay, 4 frozen
regression fixtures, TESS-TPF-derivation health-check entry). TESS
support explicitly deferred (derived-URL contract, no queryable ground
truth). Sections below are the Phase-0 audit record that motivated the
design; measured numbers were reproduced by the shipped engine.
This is the Phase-0 audit for the "Target Pixel File (TPF) centroid
analysis" future feature listed in CLAUDE.md. Everything below marked
*measured* was empirically confirmed against live MAST / NASA Exoplanet
Archive services on **2026-07-10**; nothing in section 1 or the
prototype results is theoretical.

**Bottom line up front:** the feature is feasible and cheaper than the
original plan assumed. TPF discovery reuses the exact TAP
infrastructure we already have (Kepler TPFs literally come back from
our current obscore query today — we filter them out by filename).
Per-quarter files are 1–7 MB (not "tens of MB"), a full TESS sector is
47 MB, and a working difference-image centroid engine prototyped
during this audit reproduced NASA's DR25 ground-truth offset on a known
centroid false positive to within 0.2σ — **7.20″ ± 0.70″ measured vs
NASA's 7.069″ ± 0.091″** — using 6 quarters fetched and processed in
~8 s total. Ground-truth calibration values are directly queryable from
the same NASA TAP endpoint `/api/koi` already uses. Nothing found
changes the "worth pursuing" answer; two assumptions from the original
plan were wrong in our favor and one honest sensitivity limitation
must be documented in the UI (section 3.4).

---

## 1. Real-data confirmation (all measured 2026-07-10)

### 1.1 Discovery: how MAST actually serves TPFs

**Kepler — TPFs are already in our obscore query results.** The exact
query production sends today (`mastTapQueryUrl('Kepler', target)`,
`dataproduct_type='timeseries'`) returns the TPF rows alongside the
lightcurve rows. For `kplr008462852` (Tabby's Star): 40 product rows —
18 `_llc.fits` (lightcurves, what we keep today), 18
`_lpd-targ.fits.gz` (long-cadence target pixel files, what the
lightcurve route's filename filter currently discards), plus tar
bundles and PNG previews. **No new discovery endpoint, no new query
shape** — the TPF path is "same TAP call, filter for `_lpd-targ`
instead of `_llc`". The `access_url` resolves through the existing
`resolveSegmentDownloadUrl` pattern (portal `uri=` extraction →
`https://archive.stsci.edu/missions/kepler/target_pixel_files/…`).
Confirmed by downloading real files (below).

Short-cadence TPFs (`_spd-targ.fits.gz`) also appear for targets that
have them (HAT-P-7b: 49 files, 2.7 GB total). **Avoid them** — the
filename filter must accept `_lpd-targ` only, mirroring how the
lightcurve route already rejects `_slc.fits`/`_fast-lc.fits`.

**TESS — TPFs are NOT in obscore, but the URL is derivable.** The same
cone/target query against the TESS collection at Tabby's position
(TIC 185336364) returned 28 rows: `_lc.fits`, `_fast-lc.fits`, and DV
products — **zero `_tp.fits` rows**. The TPFs exist in the archive;
this obscore view just doesn't list them. However, the SPOC naming
convention is deterministic: the TPF shares the lightcurve's full stem
with suffix `-s_tp.fits` instead of `-s_lc.fits`. Tested by deriving
the URL for all 5 of Tabby's TESS sectors and HEAD-requesting
`https://mast.stsci.edu/api/v0.1/Download/file?uri=mast:TESS/product/<stem>_tp.fits`:
**5/5 returned HTTP 200** with sizes 45.96–47.93 MB. So the TESS path
is "take the `_lc.fits` access_url the route already finds, string-swap
the suffix". This derivation is a contract assumption (same class as
the `tid` column) and belongs in the external-health check if the
feature ships.

There is presumably also a `_fast-tp.fits` for 20-second targets —
never request it (same reason we reject `_fast-lc.fits`).

### 1.2 Real file sizes and the lightcurve multiplier

Measured per-file sizes (obscore `access_estsize` cross-checked by
actually downloading four files — estsize matched real Content-Length
in every checked case; note the column's "kbyte" unit label is wrong,
values are bytes):

| Star | LC files total | TPF files total | Multiplier |
|---|---|---|---|
| Tabby's Star (18 Q) | 7.5 MB | 74.8 MB (gz) | 10.0× |
| K00931.01 (17 Q) | 7.4 MB | 24.0 MB (gz) | 3.2× |
| HAT-P-7b (18 Q, LC only) | 7.5 MB | 93.1 MB (gz) | 12.4× |
| Tabby TESS (per sector) | 1.94 MB | 46.9 MB | 24× |

Per-quarter Kepler TPFs for Tabby range **0.88–6.9 MB gzipped**
(median ~4.2 MB; unpacks ~1.7×, e.g. Q12: 4.80 MB gz → 8.23 MB). The
multiplier varies star-to-star because it scales with stamp area
(Tabby 8×8, K02606.01 7×5, HAT-P-7b much larger due to saturation
bleed columns).

Real download timings on this connection: Kepler quarter TPF
(4.8 MB gz) in 3.8 s; full TESS sector TPF (46.9 MB) in 6.1 s at
7.7 MB/s; same-quarter `_llc.fits` (0.51 MB) in 1.4 s. **The
"MB–tens of MB per quarter/sector" fear in the original plan note was
half wrong**: per *quarter* it's single-digit MB; only per *sector*
(TESS) does it reach ~47 MB, and even that downloaded in ~6 s.

**Feasibility verdict on size alone:** on-demand per-star analysis is
comfortably practical. A 6-quarter Kepler analysis moves ~20 MB
(measured end-to-end at 8.2 s including compute); a 1-sector TESS
analysis moves 47 MB (~6–10 s). What remains genuinely impractical —
and the plan already forbids — is batch/every-selection use: a full
~9k-star pass would move ~350 GB.

### 1.3 Real FITS structure (informs the parser design)

Dissected `kplr008462852-2012004120508_lpd-targ.fits.gz` (Kepler Q11,
8.23 MB unpacked) and
`tess2021204101404-s0041-0000000185336364-0212-s_tp.fits` (TESS s41,
46.92 MB). The two missions' layouts are near-identical:

```
HDU 0  PRIMARY   — no data. Identity keywords: KEPLERID/TICID, OBJECT,
                   QUARTER/SECTOR, MODULE+OUTPUT / CAMERA+CCD, RA_OBJ, DEC_OBJ.
HDU 1  BINTABLE  — EXTNAME=TARGETTABLES (Kepler) / PIXELS (TESS).
                   One row per cadence (Q11: 4,754 rows; s41: 19,149 rows).
HDU 2  IMAGE     — EXTNAME=APERTURE. int32 (BITPIX=32) image, same shape
                   as the stamp (8×8 / 11×11). Bitmask: bit 1 = pixel
                   collected, bit 2 = pixel in the optimal photometric
                   aperture. Header carries CRVAL1P/CRVAL2P = physical CCD
                   coordinates of the stamp corner.
HDU 3  BINTABLE  — TESS only: EXTNAME=TARGET COSMIC RAY (0 rows in the
                   inspected file). Ignore.
```

HDU 1 columns (Kepler / TESS identical names unless noted):

| Column | TFORM | Notes |
|---|---|---|
| TIME | D | BKJD / TJD, same offsets as the LC files |
| TIMECORR | E | |
| CADENCENO | J | |
| RAW_CNTS | 64J / 121J, TDIM=(8,8)/(11,11) | **array column** — the image, row-major, first TDIM axis fastest |
| FLUX | 64E / 121E + TDIM | calibrated, background-subtracted e-/s — the cube we centroid |
| FLUX_ERR | 64E / 121E + TDIM | |
| FLUX_BKG(_ERR) | arrays | |
| COSMIC_RAYS | 64E (Kepler only) | |
| QUALITY | J | same flag semantics as LC files; filter ≠ 0 |
| POS_CORR1/2 | E | pipeline-measured pointing offset, pixels |
| RB_LEVEL | 40E TDIM=(5,8) (Kepler only) | rolling-band metric; ignore |

Parser-relevant deltas from what `fitsReader.ts` handles today:
1. **Array columns** — TFORM repeat counts > 1 with a TDIM shape. The
   existing reader parses the repeat count for offset math but only
   ever reads scalar element 0. New capability: read `repeat` elements
   per row into a typed array, plus parse TDIM.
2. **IMAGE extension reading** — the APERTURE HDU is not a BINTABLE;
   need a raw BITPIX=32 image read (trivial: NAXIS1×NAXIS2 int32 BE).
3. **HDU selection by EXTNAME** — "first BINTABLE" happens to be
   correct for the pixel table in both missions, but the APERTURE HDU
   must be found by name.
4. **gzip** — Kepler TPFs are served `.gz`. `zlib.gunzipSync` (Node
   built-in, server-side route — no new deps). TESS TPFs are served
   uncompressed.

## 2. Parser architecture: extract `fitsCore.ts`? — **Yes, recommended**

The prototype scripts written for this audit are the empirical answer:
to read TPFs they had to copy, character-for-character, `parseHeader`
(~30 lines), the HDU-walking/data-size arithmetic (~20 lines), and the
TFORM column-layout scan (~15 lines) from `fitsReader.ts` — roughly
**65 of fitsReader's ~150 lines are needed verbatim by the image-cube
reader**. That's the definition of a shared core.

Proposed split:

- **`lib/fitsCore.ts`** (extracted, no behavior change): `BLOCK`,
  `parseHeader`, an `enumerateHdus(buf)` generator yielding
  `{header, dataStart, dataBytes}` per HDU (formalizes the walk both
  readers do), `TYPE_INFO`, and a `columnLayout(header)` returning
  `{name → {offsetInRow, repeat, type, tdim}}`. Server-side only, no
  deps, same constraints as today.
- **`lib/fitsReader.ts`** (existing API preserved):
  `readMastLightcurveColumns` re-implemented on the core. Its exported
  signature and behavior must be bit-identical — `npm run test:unit`
  (synthetic FITS buffers) + `npm run test:data` (8 frozen real
  fixtures) are the regression gate, and they cover exactly this
  surface. No `CACHE_SCHEMA_VERSION` bump needed if outputs are
  identical (verify with test:data before/after).
- **`lib/tpfReader.ts`** (new): `readTpf(buf)` → `{times, quality,
  posCorr1, posCorr2, flux: Float32Array (nCadences × nPx), stampW,
  stampH, apertureMask: Int32Array, refCol, refRow, mission
  identity}`. Gunzips when the buffer starts with the gzip magic.

**Cost estimate, separated as requested:**
- Extraction refactor: **small — ~½ day** including re-running both
  test layers. Mechanical; the risk is regression in the lightcurve
  path, and that path has the strongest test coverage in the repo.
- New `tpfReader.ts` on top of the core: **~1 day** including unit
  tests in the established synthetic-FITS-buffer style (array columns,
  TDIM parse, APERTURE bitmask, gzip path, TESS's extra HDU 3).

The alternative (self-contained tpfReader duplicating the primitives)
saves the ½-day refactor but leaves two divergent copies of header
parsing — the audit scripts already demonstrated the copy drifts the
moment one side needs a tweak (the prototype's copy grew TDIM support
the original lacks). Given the regression gate is strong and cheap,
extraction is the right call.

## 3. Centroid engine: difference imaging — **recommended, empirically**

Both candidate methods were prototyped against real TPF data with NASA
DR25 ground truth (the BLS-vs-TLS discipline). Targets:

- **K02606.01 / KIC 5991936** — DR25 centroid-offset FALSE POSITIVE
  (`koi_fpflag_co=1`, all other flags 0), NASA difference-image
  centroid offset `koi_dicco_msky = 7.069″ ± 0.091″`, depth 569 ppm,
  P=6.0974 d, mag 13.4.
- **K01800.01 / KIC 11017901** — clean CONFIRMED planet (all flags 0),
  `koi_dicco_msky = 0.008″ ± 0.07″`, depth 3387 ppm, P=7.794 d,
  mag 12.4.

Method (a), **per-cadence flux-weighted photocenter, in-transit mean vs
out-of-transit mean**: on the FP it measured a shift of **36 mas** —
technically nonzero, but 200× smaller than the true 7″ offset, because
the photocenter shift is the source offset *diluted by the observed
depth* (7″ × ~few-hundred ppm ≈ mas scale). At Kepler's 3.98″/px and
real pointing jitter, mas-level signals are hopeless for shallow
transits. Method (a) is only viable for deep (percent-level) events.
**Rejected as the primary method.**

Method (b), **difference imaging** (mean out-of-transit stamp − mean
in-transit stamp; centroid of the difference image vs centroid of the
out-of-transit image): the difference image *is* the transit signal
localized on the sky, undiluted. This is what the Kepler DV pipeline
computes (`koi_dicco_*` are literally its outputs), so calibrating
against DR25 is apples-to-apples. Prototype results (plain
flux-weighted moment centroid, no PRF fit):

| Configuration | K02606.01 (FP, truth 7.069″±0.091″) | K01800.01 (clean, truth 0.008″±0.07″) |
|---|---|---|
| 1 quarter, no clip | 7.787″ | 1.870″ |
| 4–6 quarters, **vector-averaged**, no clip | **7.196″ ± 0.697″** | **0.909″ ± 0.592″** |
| 4 quarters, 2σ noise clip | 9.761″ ± 0.328″ (biased!) | unusable (3/4 quarters zeroed; survivor read 14″) |

Runtime: engine compute is negligible (**≤ 2 ms per quarter** for
parse + both centroids on a 4,768-cadence × 7×5 cube; the TESS
19,149 × 11×11 cube parsed in ~50 ms in earlier timing). Wall time is
entirely download-bound: 6-quarter end-to-end = 8.2–21.5 s measured.

Design decisions locked by these measurements:

1. **Per-quarter difference images, vector-averaged** (mean of the
   (dx, dy) vectors, error from scatter/√N). Quarter noise directions
   are random; averaging magnitudes instead would bias high (per-quarter
   |offset| for the clean planet runs 0.5–2.8″, but the vector mean is
   0.9″). This also handles Kepler's quarterly roll (stamp geometry
   changes every quarter — offsets must be averaged in sky/CCD-physical
   frame, not stamp frame; the prototype's residual clean-planet bias
   partly comes from doing this naively in stamp frame).
2. **No noise clipping of the difference image.** Measured and
   REJECTED (same discipline as the ungated 3σ dip threshold): a 2σ
   clip zeroes shallow-transit difference images entirely and biases
   surviving centroids toward the brightest residual pixel (FP read
   9.8″ vs truth 7.1″; clean planet read 14″).
3. **In-transit = |dt| < 0.35×duration (core), out = 0.75–2.5×duration
   flanks**, QUALITY==0 only, per-cycle local windows — directly reuses
   the windowing idiom from `oddEven.ts`/`secondaryEclipse.ts`.
4. **Verdict gate**: report `offsetArcsec ± σ` and a z-statistic;
   significance requires **σ ≥ 3 AND offset above a calibrated floor**
   (~2″ ≈ half a Kepler pixel, to be frozen in Phase 4 against the
   fixture set — same structure as odd/even's 3σ + 5% floor). Measured
   z on the prototype: FP ≈ 10σ, clean planet ≈ 1.5σ — clean
   separation.

### 3.4 Honest sensitivity limitation (must reach the UI copy)

Our moment-centroid + vector-averaging floor is ~0.6″ (measured on a
3,387-ppm planet, 6 quarters). NASA's PRF-fitted, all-quarter pipeline
quotes 0.07″. **We can reliably detect offsets ≳ 2″; we cannot vet
sub-pixel blends.** Most background-EB false positives have multi-arcsec
offsets (resolved neighbors), so the check retains real value — but the
readout must say "no significant offset measured (sensitivity ~2″)",
never "centroid clean". Additionally, **saturated stars (Kp ≲ 11.5)
produce meaningless centroids** — NASA's own table shows Kepler-3b
(mag 9.2, CONFIRMED) with a 6.6″ "offset" from bleed columns; HAT-P-7b
(mag 10.5) reads 3.97″. Gate the feature off (or add a loud caveat)
when the target is brighter than the saturation threshold.

## 4. Ground-truth fixture candidates (verified accessible)

The DR25 vetting columns are served TODAY by the same NASA TAP endpoint
`/api/koi` uses (`cumulative` table): `koi_fpflag_co` (centroid-offset
flag), `koi_dicco_msky ± err` (PRF difference-image centroid offset,
arcsec), `koi_dikco_msky ± err` (offset vs KIC position). Queried live
2026-07-10. Candidates, all with LC TPFs confirmed present at MAST:

**Offset false positives (koi_fpflag_co=1, other flags 0):**
- **K02606.01 / KIC 5991936** — dicco 7.069″ ± 0.091″ (78σ), depth
  569 ppm, P=6.10 d, mag 13.4, 18 quarter TPFs (~3 MB gz each).
  *Prototype-validated in this audit (7.20″ ± 0.70″). Primary fixture.*
- **K01075.01 / KIC 10232123** — dicco 1.016″ ± 0.067″, depth
  4,703 ppm, P=1.344 d, mag 13.1. A *sub-pixel* offset FP: tests the
  boundary of our sensitivity floor — likely reads "not significant"
  on our pipeline; freezing that expectation documents the limitation.
- **K01254.01 / KIC 8454250** — dicco 2.075″ ± 0.082″, depth
  1,974 ppm, P=5.08 d, mag 12.8. Near the proposed 2″ floor; good
  discriminator fixture.

**Clean confirmed planets (all flags 0):**
- **K01800.01 / KIC 11017901** — dicco 0.008″ ± 0.07″, depth
  3,387 ppm, P=7.79 d, mag 12.4. *Prototype-validated (0.91″ ± 0.59″,
  1.5σ ⇒ not significant). Primary negative fixture.*
- **K00012.01 / KIC 5812701** — dicco 0.06″ ± 0.31″, depth 9,065 ppm,
  mag 11.4 (unsaturated, deep — high-SNR negative).

**Saturation pathology (freeze as a "must NOT report" case):**
- **K00003.01 / KIC 10748390** — mag 9.2 CONFIRMED planet with
  dicco = 6.6″ ± 1.8″ from bleed. Our pipeline must refuse/caveat here
  rather than echo a bogus offset.

Existing fixtures for reference: K01317.01 and K01130.01 (our odd/even
and secondary-eclipse FPs) have `koi_fpflag_co=0` — their EBs are
on-target blends, correctly invisible to a centroid check. Good
cross-check that the three vetting measurements are complementary, not
redundant.

## 5. UI concept (sketch only)

Opt-in per star, from the fullscreen lightcurve overlay (the only
surface where the BLS period/epoch context already exists):

- **Entry point**: a `PIXEL-LEVEL CHECK` button in the
  ClassifierReadout, shown only when the confident-BLS gate passes
  (same gate as odd/even — the check is meaningless without a
  period/epoch) and the star has a KIC/TIC id. Click → confirmation
  line ("downloads ~20 MB of pixel data, ~15 s") → progress steps in
  the LOADING_STEPS style.
- **Result panel** (three elements, simplest honest version):
  1. **Pixel stamp** — canvas rendering of the mean out-of-transit
     image (log stretch), optimal-aperture pixels outlined, at
     realistic size (a Kepler stamp is 8×8 — render each pixel as a
     ~24 px cell). This alone is new information: the user sees what
     the photometer actually saw.
  2. **Difference image** beside it, same scale, with two markers:
     × = out-of-transit photocenter, ○ = difference-image centroid,
     connected by an arrow when the offset is significant.
  3. **One descriptive line**, numbers only, describe-don't-diagnose:
     "Transit-signal centroid offset: 7.2″ ± 0.7″ (10σ) from the
     target's photocenter — the dimming source may not be the target
     star" / "No significant offset measured (0.9″ ± 0.6″;
     sensitivity ~2″)" / "Target too bright for a reliable centroid
     (saturated)".
- **Not in v1**: per-cadence centroid trajectory animation (method (a)
  is rejected anyway), TESS sector picker, multi-planet per-KOI
  selection (use the BLS-locked signal only).
- Result cached (L2, schema-versioned like the lightcurve cache) so
  reopening the star is instant.

## 6. Effort estimate (informed by measurements above)

| Phase | Work | Estimate | Key risk |
|---|---|---|---|
| 1. Parser | `fitsCore.ts` extraction (½ d) + `tpfReader.ts` + unit tests (1 d) | **1.5 d** | regression in lightcurve path — gated by test:unit + test:data, both cheap |
| 2. Centroid engine | port prototype into `lib/centroidVet.ts`; quarter selection (nearest-to-transit N=6); CCD-frame vector averaging; verdict gate; route `/api/centroid/[id]` with L2 cache | **2 d** | quarterly-roll frame handling (the prototype's 0.9″ clean-planet residual must drop once averaging is done in physical-CCD frame; if it doesn't, floor stays ~1″ and the calibrated floor moves up) |
| 3. UI | stamp + difference canvases, readout line, opt-in button + progress | **1.5 d** | none serious; canvas work is well-trodden here |
| 4. Calibration | freeze 4–5 fixtures from §4 (gzipped TPF quarters ~15–20 MB total in repo — larger than existing fixtures; consider fetch-on-first-run instead), extend `test:data` with expected offsets ± tolerances, calibrate the significance floor | **1.5 d** | fixture size in git; K01075.01 may straddle the floor — that's the point, but freezing a borderline expectation needs care |
| 5. Integration | health-check entry for the TESS `_tp.fits` URL-derivation contract; CLAUDE.md + KNOWLEDGE_BASE.md entries; provenance line | **1 d** | — |
| **Total** | | **~7.5 dev-days** | |

Risks that could grow the estimate:
- **TESS calibration ground truth is weaker**: there is no public
  per-TOI equivalent of `koi_dicco_msky` in the TOI TAP table (TESS
  centroid vetting lives in per-target DV reports, not a queryable
  column). Proposal: calibrate on Kepler DR25 (done above), apply to
  TESS with the same math (21″/px scale — the floor in arcsec is ~10×
  worse, worth stating in the UI), and treat TESS results as
  qualitative until a TESS fixture path is found. If TESS parity is
  required for launch, add ~2 d.
- **Saturation gating** needs a magnitude source for the selected star
  (we have `magnitude` in the catalog; Kepler saturation ≈ Kp 11.5,
  TESS ≈ Tmag 6.8) — cheap, but the cutoffs should be verified against
  one saturated fixture (K00003.01) during Phase 4.

### What this audit changes about prior assumptions

1. **"TPFs are large (per-cadence postage-stamp images, MB–tens of MB
   per quarter/sector)"** (CLAUDE.md) — Kepler quarters are 1–7 MB gz,
   not tens; only TESS sectors hit ~47 MB. On-demand cost is ~15 s,
   not minutes. The opt-in/on-demand-only policy stands (batch would
   be ~350 GB), but the per-star UX is much better than feared.
2. **"Computing centroids is far heavier than the light-curve path"**
   — false. Engine compute measured at ≤ 2 ms/quarter; the cost is
   purely download, and download is *smaller* than a cold full-mission
   lightcurve fetch in wall time (8–21 s vs ~60 s) because we only
   need ~6 quarters, not 17.
3. **New assumption to encode**: TESS TPF discovery relies on filename
   derivation from the `_lc.fits` access_url (not obscore listing) —
   a live contract that belongs in `externalEndpoints.ts` + the
   external-health check, exactly like the `tid` column lesson.

---

*Audit scripts (probe/download/inspect/prototype) were run from the
session scratchpad and are not part of the repo; the prototype's
final-configuration numbers in §3 are reproducible from the parameters
given there (targets, quarters spread evenly across the mission,
window multipliers, no clip, vector averaging).*
