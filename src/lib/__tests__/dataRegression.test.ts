/**
 * @description Data-pipeline regression test for the dip detector and the
 * curve classifier. Runs `detectDips` + `classifyCurve` against four
 * frozen real-data fixtures (gzipped MAST Kepler PDC curves in
 * `fixtures/`) and compares the results to hand-verified expected values.
 * Any drift — an edit to `anomalyDetector.ts`, `curveClassifier.ts`, or a
 * change in how the MAST fetch layer normalizes segments — fails loudly.
 *
 * Run with: `npm run test:data` (plain Node ≥ 22.6; TypeScript runs via
 * Node's native type stripping, no test framework needed).
 *
 * To inspect the currently-measured values (e.g. after an INTENTIONAL
 * algorithm change, before updating EXPECTED): `npm run test:data -- --print`.
 *
 * Fixture provenance: real NASA/MAST PDCSAP flux served by
 * `/api/lightcurve` (per-quarter median-normalized), captured 2026-07-02/03.
 * Expected values were cross-checked against independently observed
 * behavior: K02357.02's dip card in the live AnomalyPanel (1 dip, NOTABLE,
 * t=1273.1 BKJD), Tabby's famous D792/D1519 deep-dip events, and the NASA
 * Exoplanet Archive orbital periods for the two CONFIRMED KOIs.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { detectDips } from '../anomalyDetector.ts'
import { classifyCurve } from '../curveClassifier.ts'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * @description One star's expected pipeline output. Numeric fields carry a
 * tolerance; string fields must match exactly. `null` for
 * `bestFitPeriodDays` asserts the classifier did NOT surface a period.
 */
interface Expectation {
  /** Fixture file stem, e.g. "KIC8462852". */
  id: string
  /** Human label for the report line. */
  label: string
  /** Exact number of dips detectDips must return. */
  dipCount: number
  /** Exact classifier pattern label. */
  pattern: string
  /** Deepest dip's label (dips[0]; detectDips sorts by score desc). Omit when dipCount is 0. */
  topDipLabel?: string
  /** Deepest dip's peak time, BKJD. Tolerance TIME_TOL. Omit when dipCount is 0. */
  topDipPeakTime?: number
  /** Deepest dip's depth as a fraction (0.2069 = 20.69%). Tolerance DEPTH_TOL. */
  topDipDepth?: number
  /** Classifier best-fit period in days, or null when it must not report one. Tolerance PERIOD_TOL. */
  bestFitPeriodDays: number | null
  /** Independent NASA Exoplanet Archive orbital period (days) for context; not asserted. */
  nasaPeriodDays?: number
}

const TIME_TOL = 0.05 // days
const DEPTH_TOL = 0.005 // absolute fraction (0.5 percentage points)
const PERIOD_TOL = 0.05 // days

/**
 * @description Hand-verified expected values, frozen 2026-07-03. These
 * freeze CURRENT measured behavior on the frozen fixture data — including
 * two classifier quirks documented below — so any code change that shifts
 * them is surfaced and must be re-verified deliberately.
 * - KIC8462852 (Tabby's Star): 9 dips led by the famous D1519 −20.7%
 *   event (D792 −14.2% is second) — matches the live panel observed in
 *   the 2026-07-02 verification session. IRREGULAR (depthConsistency 0).
 *   Quirk: periodicity computes 0.601, so a physically meaningless
 *   0.307 d "best-fit period" IS surfaced (the implausible-period guard
 *   only runs on the would-be-PERIODIC branch). Frozen as-is.
 * - KIC7449554 (K02357.02): matches the live-session values (1 dip,
 *   NOTABLE, t=1273.1 BKJD, SPARSE), not re-derived. Depth on this
 *   fixture measures 1.00% (the session panel displayed −1.08% from an
 *   earlier cache copy — per-quarter segment availability can shift the
 *   normalization slightly between fetches; the fixture freezes the
 *   2026-07-03 fetch).
 * - KIC9166862 (K00931.01): CONFIRMED planet, 16,653 ppm transits.
 *   351 dips ≈ the ~360 transits NASA's 3.8556 d period predicts over
 *   the ~1,421 d baseline (minus gaps) — strong independent agreement.
 *   Quirk: periodicity computes ≈0.4996, a hair UNDER the 0.5 cutoff,
 *   so this textbook periodic transiter labels IRREGULAR and surfaces
 *   no period. Frozen as-is; if classifier tuning ever fixes this, the
 *   test fails and the expectation should be updated to
 *   PERIODIC_UNIFORM with P ≈ 3.856 d.
 * - KIC10905746 (K01725.01): the CONFIRMED planet's 1,473 ppm (0.15%)
 *   transits are BELOW the detector's 1% threshold; the 53 detected
 *   dips are the star's own variability (baselineRMS 0.58%). Raw scores
 *   look periodic (0.995/0.884) but the candidate period is implausibly
 *   short, so the sanity guard downgrades to UNCERTAIN and suppresses
 *   the period. Guards both the dip threshold and the UNCERTAIN branch.
 */
const EXPECTED: Expectation[] = [
  {
    id: 'KIC8462852',
    label: "Tabby's Star",
    dipCount: 9,
    pattern: 'IRREGULAR',
    topDipLabel: 'WOW',
    topDipPeakTime: 1519.52,
    topDipDepth: 0.2069,
    bestFitPeriodDays: 0.3065,
  },
  {
    id: 'KIC7449554',
    label: 'K02357.02',
    dipCount: 1,
    pattern: 'SPARSE',
    topDipLabel: 'NOTABLE',
    topDipPeakTime: 1273.06,
    topDipDepth: 0.01,
    bestFitPeriodDays: null,
    nasaPeriodDays: 15.9042402,
  },
  {
    id: 'KIC9166862',
    label: 'K00931.01',
    dipCount: 351,
    pattern: 'IRREGULAR',
    topDipLabel: 'NOTABLE',
    topDipPeakTime: 718.18,
    topDipDepth: 0.0197,
    bestFitPeriodDays: null,
    nasaPeriodDays: 3.855603916,
  },
  {
    id: 'KIC10905746',
    label: 'K01725.01',
    dipCount: 53,
    pattern: 'UNCERTAIN',
    topDipLabel: 'NOTABLE',
    topDipPeakTime: 1364.48,
    topDipDepth: 0.0158,
    bestFitPeriodDays: null,
    nasaPeriodDays: 9.8786461,
  },
]

/**
 * @description Loads a gzipped fixture and returns its parsed content.
 * @param id Fixture file stem (KIC id).
 * @returns Parsed fixture with times/flux arrays and provenance metadata.
 */
function loadFixture(id: string): { times: number[]; flux: number[]; name: string } {
  const file = path.join(FIXTURE_DIR, `${id}.json.gz`)
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
}

/**
 * @description Compares a measured number against an expectation within a
 * tolerance, recording a failure message on mismatch.
 * @param failures Sink for failure messages.
 * @param what Human-readable field name for the message.
 * @param measured Measured value (null allowed for period).
 * @param expected Expected value (null = must be null).
 * @param tol Absolute tolerance for numeric comparison.
 */
function check(
  failures: string[],
  what: string,
  measured: number | string | null,
  expected: number | string | null,
  tol = 0,
): void {
  if (expected === null || measured === null || typeof expected === 'string' || typeof measured === 'string') {
    if (measured !== expected) failures.push(`${what}: expected ${expected}, measured ${measured}`)
    return
  }
  if (Math.abs(measured - expected) > tol) {
    failures.push(`${what}: expected ${expected} ±${tol}, measured ${measured}`)
  }
}

const printMode = process.argv.includes('--print')
let anyFailure = false

for (const exp of EXPECTED) {
  const { times, flux } = loadFixture(exp.id)
  const dips = detectDips(flux, times)
  const profile = classifyCurve(times, flux, dips)
  const top = dips[0]

  if (printMode) {
    console.log(`${exp.id} (${exp.label}):`)
    console.log(`  dipCount=${dips.length} pattern=${profile.pattern} bestFitPeriodDays=${profile.bestFitPeriodDays}`)
    console.log(`  periodicity=${profile.periodicity.toFixed(3)} depthConsistency=${profile.depthConsistency.toFixed(3)} baselineRMS=${profile.baselineRMS.toFixed(5)} dipShape=${profile.dipShape}`)
    if (top) console.log(`  topDip: label=${top.label} peakTime=${top.peakTime.toFixed(2)} depth=${top.depth.toFixed(5)} duration=${top.duration.toFixed(2)}d score=${top.score.toFixed(3)}`)
    continue
  }

  const failures: string[] = []
  check(failures, 'dipCount', dips.length, exp.dipCount)
  check(failures, 'pattern', profile.pattern, exp.pattern)
  check(failures, 'bestFitPeriodDays', profile.bestFitPeriodDays, exp.bestFitPeriodDays, PERIOD_TOL)
  if (exp.dipCount > 0) {
    check(failures, 'topDip.label', top?.label ?? null, exp.topDipLabel ?? null)
    check(failures, 'topDip.peakTime', top?.peakTime ?? null, exp.topDipPeakTime ?? null, TIME_TOL)
    check(failures, 'topDip.depth', top?.depth ?? null, exp.topDipDepth ?? null, DEPTH_TOL)
  }

  if (failures.length === 0) {
    const period = profile.bestFitPeriodDays === null ? 'no period' : `P=${profile.bestFitPeriodDays.toFixed(3)}d`
    console.log(`✅ ${exp.id} (${exp.label}): ${dips.length} dips · ${profile.pattern} · ${period}`)
  } else {
    anyFailure = true
    console.error(`❌ ${exp.id} (${exp.label}) DRIFTED from hand-verified values:`)
    for (const f of failures) console.error(`   - ${f}`)
  }
}

if (!printMode) {
  if (anyFailure) {
    console.error('\nDATA REGRESSION TEST FAILED — detectDips/classifyCurve output no longer')
    console.error('matches the frozen fixtures. If the change is INTENTIONAL, re-run with')
    console.error('--print, re-verify the new values by hand, and update EXPECTED.')
    process.exit(1)
  }
  console.log('\nAll data regression fixtures pass.')
}
