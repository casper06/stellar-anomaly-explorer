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
import { BLS_SDE_THRESHOLD } from '../bls.ts'

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
  /** Whether the BLS search must produce a CONFIDENT detection (SDE ≥ threshold). */
  blsConfident: boolean
  /** BLS period in days when confident (tolerance PERIOD_TOL); ignored otherwise. */
  blsPeriodDays?: number
  /** Independent NASA Exoplanet Archive orbital period (days) for context; not asserted. */
  nasaPeriodDays?: number
}

const TIME_TOL = 0.05 // days
const DEPTH_TOL = 0.005 // absolute fraction (0.5 percentage points)
const PERIOD_TOL = 0.05 // days

/**
 * @description Hand-verified expected values, re-frozen 2026-07-04 for
 * classifier v2 (BLS period search). These freeze CURRENT measured
 * behavior on the frozen fixture data so any code change that shifts
 * them is surfaced and must be re-verified deliberately.
 * - KIC8462852 (Tabby's Star): 9 dips led by the famous D1519 −20.7%
 *   event — IRREGULAR, no period, and the BLS search must NOT reach a
 *   confident detection (aperiodic dips refuse to fold; measured
 *   SDE ≈ 4.9 vs threshold 7.5).
 * - KIC7449554 (K02357.02): 1 visible dip → SPARSE (the dipCount ≥ 3
 *   promotion gate holds), but BLS confidently finds P ≈ 2.4210 d at
 *   ~157 ppm — which is the SIBLING planet K02357.01 (NASA period
 *   2.42088277 d, 223 ppm): more transits than the 15.9 d .02 planet,
 *   so it wins the fold-SNR. Independent NASA cross-check to 5e-5
 *   relative. The "statistical signal on a SPARSE star" case, pinned.
 * - KIC9166862 (K00931.01): CONFIRMED planet, deep transits. Under v1
 *   this was the frozen quirk (periodicity 0.4996, a hair under the
 *   0.5 cutoff → IRREGULAR). BLS resolves it: PERIODIC_UNIFORM with
 *   P ≈ 3.85563 d vs NASA 3.855603916 d — 6e-6 relative agreement.
 * - KIC10905746 (K01725.01): red-noise canary. Raw scalars look
 *   periodic (0.995/0.884) because the dips are variability-driven,
 *   but BLS finds no confident fold (SDE ≈ 5.3) → UNCERTAIN, no
 *   period. The real 1,473 ppm/9.88 d planet stays below detection in
 *   this noise — an honest non-claim.
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
    bestFitPeriodDays: null,
    blsConfident: false,
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
    blsConfident: true,
    blsPeriodDays: 2.4209, // = sibling K02357.01; NASA 2.42088277 d
    nasaPeriodDays: 15.9042402,
  },
  {
    id: 'KIC9166862',
    label: 'K00931.01',
    dipCount: 351,
    pattern: 'PERIODIC_UNIFORM',
    topDipLabel: 'NOTABLE',
    topDipPeakTime: 718.18,
    topDipDepth: 0.0197,
    bestFitPeriodDays: 3.8556,
    blsConfident: true,
    blsPeriodDays: 3.8556,
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
    blsConfident: false,
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
    if (profile.bls) {
      const b = profile.bls
      console.log(`  bls: P=${b.periodDays.toFixed(4)}d depth=${b.depthPpm.toFixed(0)}ppm dur=${b.durationHours.toFixed(1)}h epoch=${b.epochDays.toFixed(2)} SDE=${b.sde.toFixed(1)}`)
    } else {
      console.log('  bls: null')
    }
    continue
  }

  const failures: string[] = []
  check(failures, 'dipCount', dips.length, exp.dipCount)
  check(failures, 'pattern', profile.pattern, exp.pattern)
  check(failures, 'bestFitPeriodDays', profile.bestFitPeriodDays, exp.bestFitPeriodDays, PERIOD_TOL)
  const measuredBlsConfident = profile.bls !== null && profile.bls.sde >= BLS_SDE_THRESHOLD
  check(failures, 'blsConfident', String(measuredBlsConfident), String(exp.blsConfident))
  if (exp.blsConfident && exp.blsPeriodDays !== undefined) {
    check(failures, 'bls.periodDays', profile.bls?.periodDays ?? null, exp.blsPeriodDays, PERIOD_TOL)
  }
  if (exp.dipCount > 0) {
    check(failures, 'topDip.label', top?.label ?? null, exp.topDipLabel ?? null)
    check(failures, 'topDip.peakTime', top?.peakTime ?? null, exp.topDipPeakTime ?? null, TIME_TOL)
    check(failures, 'topDip.depth', top?.depth ?? null, exp.topDipDepth ?? null, DEPTH_TOL)
  }

  if (failures.length === 0) {
    const period = profile.bestFitPeriodDays === null ? 'no period' : `P=${profile.bestFitPeriodDays.toFixed(3)}d`
    const blsNote = measuredBlsConfident && profile.bls
      ? `BLS P=${profile.bls.periodDays.toFixed(4)}d SDE ${profile.bls.sde.toFixed(1)}`
      : 'BLS: no confident signal'
    console.log(`✅ ${exp.id} (${exp.label}): ${dips.length} dips · ${profile.pattern} · ${period} · ${blsNote}`)
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
