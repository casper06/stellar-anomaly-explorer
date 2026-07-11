# stellar-vetting-engine

Portable, **dependency-free** TypeScript tools for transit-photometry
measurement and vetting: read Kepler/TESS FITS products, detect and score
brightness dips, search for periodic box signals (BLS), classify light-curve
patterns descriptively, and run the three standard first-order
false-positive vetting checks (odd/even depths, phase-0.5 dimming,
difference-image centroid offset) — each calibrated against NASA Kepler DR25
ground truth.

Extracted from (and developed inside)
[Stellar Anomaly Explorer](https://github.com/casper06/stellar-anomaly-explorer);
the engine is MIT-licensed so other researchers and tools can adopt it
without copyleft friction (the app around it remains GPL-3.0-or-later).

- **Zero runtime dependencies.** Only `node:` builtins (`zlib` in the TPF
  reader; `Buffer` in the FITS readers). The measurement modules (BLS,
  classifier, vetting checks) are plain math and also run in browsers/workers.
- **Describe, don't diagnose.** No API in this package asserts a physical
  cause. Functions return measurements (depths, periods, significances,
  offsets) and threshold verdicts on those measurements — never "planet",
  "binary", or "false positive". Interpretation belongs to the human.
- **Calibrated, regression-pinned.** Detection thresholds and verdict floors
  were calibrated against real Kepler PDC data and DR25 Robovetter ground
  truth; frozen real-data fixtures in `tests/` pin every behavior described
  below.

## Install / build

Not yet published to npm. From this repo:

```bash
cd packages/stellar-vetting-engine
npm install        # dev tooling only (tsup, typescript)
npm run build      # dist/index.js (ESM) + dist/index.cjs (CJS) + dist/index.d.ts
npm test           # unit + frozen real-data regression suites (offline, Node ≥ 22.6)
```

## Quick start

```ts
import {
  readMastLightcurveColumns,
  detectDips,
  runBls,
  classifyCurve,
  BLS_SDE_THRESHOLD,
} from 'stellar-vetting-engine'

// 1. Parse a Kepler `_llc.fits` / TESS `_lc.fits` PDC file you downloaded.
const { col1: times, col2: flux } = readMastLightcurveColumns(buf, ['TIME', 'PDCSAP_FLUX'])

// 2. Normalize however you prefer (per-segment median works well), then:
const dips = detectDips(normFlux, cleanTimes)          // scored dips, best first
const profile = classifyCurve(cleanTimes, normFlux, dips) // pattern + BLS + vetting checks

if (profile.bls && profile.bls.sde >= BLS_SDE_THRESHOLD) {
  console.log(`periodic box signal: P=${profile.bls.periodDays} d, ` +
              `depth≈${profile.bls.depthPpm} ppm, SDE ${profile.bls.sde}`)
  console.log('odd/even:', profile.oddEven?.verdict)     // 'CONSISTENT' | 'MISMATCH'
  console.log('phase 0.5:', profile.secondary?.verdict)  // 'DETECTED' | 'NOT_DETECTED'
}
```

## API

All inputs are plain arrays/typed arrays; times are days in the product's
native system (Kepler BKJD = BJD − 2454833; TESS TJD = BJD − 2457000 — the
engine treats them as opaque day offsets). Flux is normalized (~1.0
baseline). `NaN` entries are tolerated everywhere and skipped.

### FITS reading (Node only — uses `Buffer`)

- **`readMastLightcurveColumns(buf, [colA, colB])`** → `{ col1, col2 }`
  (`(number | null)[]` each). Extracts two named columns from the first
  BINTABLE of a Kepler `_llc.fits` / TESS `_lc.fits` file. Throws when no
  BINTABLE exists or a column is missing (contract-change detection).
- **`readTpf(buf)`** → `TpfQuarter`. Parses a Kepler `_lpd-targ.fits.gz`
  (gzip handled) or TESS `_tp.fits` Target Pixel File: per-cadence
  `times`/`quality`, the `flux` image cube (`Float32Array`, pixel `(x, y)`
  at `x + y*nx`), stamp shape, `mission`, header magnitude (Kp/Tmag),
  segment number, the optimal-aperture bitmask, and the FLUX column's
  per-segment **WCS** (`TpfWcs`) — whose reference pixel is the target's
  catalog position.
- **`fitsCore` primitives** (`parseFitsHeader`, `enumerateHdus`,
  `bintableColumnLayout`, `FITS_TYPE_INFO`, `FITS_BLOCK`) for building
  further readers on the same 2880-byte-block plumbing.

### Dip detection

- **`detectDips(flux, times, threshold = 0.990)`** → `Dip[]` sorted by
  score. A dip is a sustained run below the threshold; on high-noise curves
  (robust σ > 0.75%) the effective threshold becomes a 3σ floor so "dip"
  means the same statistical thing across missions. Each `Dip` carries
  indices, times, `depth`, `duration`, `asymmetry`, a [0, 1] `score`
  (`depth*3 + min(σ/8, 0.3) + asymmetry*0.1`, clamped) and a label
  (`WOW ≥ 0.60`, `INTERESTING ≥ 0.40`, `NOTABLE ≥ 0.20`, else `NORMAL`).
- **`robustFluxSigma(flux)`** → 1.4826 × MAD robust noise estimate.

### Period search

- **`runBls(times, flux)`** → `BlsResult | null` —
  `{ periodDays, epochDays, depthPpm, durationHours, sde }`. A budgeted Box
  Least Squares (Kovács et al. 2002) search: 3 h time-binning, log-spaced
  coarse grid capped by an ops budget (P 0.5–120 d), 15× peak refinement;
  ~1–2 s for a full Kepler mission curve. `sde ≥ BLS_SDE_THRESHOLD` (7.5)
  is a confident detection. Sensitivity degrades for durations ≲ 3 h and
  P ≲ 1 d unless the signal is deep; treat sub-threshold as "no confident
  detection", never "no signal".

### Classification

- **`classifyCurve(times, flux, dips)`** → `CurveProfile`: a descriptive
  `pattern` label (`PERIODIC_UNIFORM` | `IRREGULAR` | `HIGH_VARIABILITY` |
  `SPARSE` | `UNCERTAIN`), the measured scalars behind it (periodicity,
  depth consistency, dominant dip shape U/V, baseline RMS), the raw `bls`
  result, and — whenever BLS is confident — the two fold-based vetting
  measurements below. `CLASSIFIER_VERSION` identifies the labeling
  algorithm for cache-invalidation schemes.

### Vetting checks (all: measurements + a threshold verdict, never a cause)

- **`measureOddEvenDepths(times, flux, bls)`** → `OddEvenResult | null` —
  per-parity transit depths compared via a z-statistic;
  `verdict: 'MISMATCH'` needs ≥ 3σ AND ≥ 5% relative difference (floor
  calibrated on the DR25 `DEPTH_ODDEVEN`-flagged false positive K01317.01:
  Δ9.5% at 15.4σ).
- **`measureSecondaryEclipse(times, flux, bls)`** → dimming at phase 0.5:
  `{ depthPpm, sigma, cycles, ratioToPrimaryPct, verdict }`. Ground truth:
  detects K01130.01's 2,311 ppm secondary at 74σ and HAT-P-7b's real 59 ppm
  occultation at 31σ (which is why no cause is asserted).
- **`runCentroidVet(quarters, periodDays, epochDays, durationHours, mag, mission)`**
  → `CentroidVetResult`. Difference-image centroid vetting from TPF pixel
  data: stacks in-transit vs out-of-transit stamps per segment, measures
  the difference image's centroid **against the target's catalog position**
  (the TPF WCS reference pixel — NASA's `koi_dikco_msky` convention),
  converts to sky arcseconds through the WCS, and vector-averages across
  segments. Returns offset ± error, significance, per-segment offsets, and
  stamp visuals. Verdict `OFFSET_DETECTED` needs ≥ 3σ AND a half-pixel
  floor (Kepler ≈ 2″, TESS ≈ 10″). Saturated targets (Kp < 11.5 /
  Tmag < 6.8) are refused (`status: 'saturated'`) — moment centroids of
  bleeding stars are meaningless. Calibration: the DR25 centroid-offset
  false positive K02606.01 measures 7.33″ ± 0.86 vs NASA's 6.889″ ± 0.091;
  the clean planet K01800.01 reads 1.16″ ± 0.37 (dikco 0.443″), which is
  why the floor is 2″ and not lower. **TESS results are unvalidated** (no
  public per-target ground truth) — label them qualitative.

## Tests

`tests/` contains the full suite: synthetic-FITS unit tests, BLS injection
recovery tests, and two frozen real-data regression suites (Kepler PDC
curves and TPF pixel stamps captured from NASA/MAST, with the NASA
ground-truth values embedded in each fixture). Everything runs offline on
plain Node ≥ 22.6 (`node --test` + native type stripping — no framework).

## License

MIT © 2026 Fer ([github.com/casper06](https://github.com/casper06)). Every
source file carries an SPDX header. The Stellar Anomaly Explorer app that
hosts this package remains GPL-3.0-or-later; same copyright holder, and MIT
here is deliberate — measurement code this general should be adoptable by
other researchers without copyleft friction (the numpy/astropy pattern).
