/**
 * @description Centroid-vetting regression test — runs the difference-image
 * centroid engine (`lib/centroidVet.ts`) against four frozen ground-truth
 * fixtures (real Kepler TPF pixel data captured 2026-07-10, trimmed to the
 * transit-window neighborhoods; see `scripts/capture-centroid-fixtures.mjs`)
 * and compares against hand-verified expected values. Fails loudly (per-field
 * diff + exit 1) on any drift.
 *
 * The fixtures pin BOTH directions of the verdict gate, the sensitivity
 * floor, and the saturation refusal:
 * - K02606.01 — DR25 centroid-offset FALSE POSITIVE. NASA measured
 *   7.069″ ± 0.091″; the engine must fire OFFSET_DETECTED and agree with
 *   NASA within its own error bar.
 * - K01075.01 — DR25 centroid-offset FP whose offset (1.016″) is BELOW
 *   our 2″ moment-centroid floor. Must NOT fire — this fixture IS the
 *   documented sensitivity limitation, frozen so it can't silently change.
 * - K01800.01 — clean CONFIRMED planet (NASA 0.008″ ± 0.07″). Negative
 *   control; must read NO_SIGNIFICANT_OFFSET.
 * - K00003.01 — Kp 9.17 saturated star. Must be REFUSED (status
 *   `saturated`), never measured: NASA's own table carries a bogus 6.6″
 *   offset for this CONFIRMED planet, caused by saturation bleed.
 *
 * After an INTENTIONAL engine change: run with `--print` to dump the newly
 * measured values, re-verify them by hand (against the `nasa` block each
 * fixture embeds), then update EXPECTED below.
 *
 * Run via `npm run test:data` (plain Node ≥ 22.6, no framework, offline).
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runCentroidVet,
  type CentroidQuarterInput,
  type CentroidVetResult,
} from '../centroidVet.ts'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const PRINT_MODE = process.argv.includes('--print')

/** @description Shape of a frozen centroid fixture file (see capture script). */
interface CentroidFixture {
  kepoi: string
  kic: number
  note: string
  nasa: {
    disposition: string
    fpflagCo: number
    periodDays: number
    epochBkjd: number
    durationHours: number
    kepmag: number
    diccoArcsec: number | null
    diccoErrArcsec: number | null
  }
  kepmagHeader: number | null
  quarters: Array<{
    label: string
    quarter: number | null
    nx: number
    ny: number
    times: number[]
    quality: number[]
    flux: (number | null)[]
  }>
}

/** @description Expected engine output per fixture (hand-verified 2026-07-10). */
interface Expected {
  status: CentroidVetResult['status']
  verdict: CentroidVetResult['verdict']
  quartersUsed: number
  /** Expected offset magnitude in arcsec (± tolerance); null for non-measured statuses. */
  offsetArcsec: number | null
  /** Expected significance (± tolerance); null for non-measured statuses. */
  sigma: number | null
  /** When set, the measured offset must agree with NASA's dicco within k× our error. */
  nasaAgreementSigmaMax: number | null
}

/**
 * @description Hand-verified expectations. Offsets/sigmas were measured on
 * the frozen fixtures, then verified against the fixture's embedded NASA
 * ground truth (K02606.01: NASA 7.069″ ± 0.091″ — ours must overlap; the
 * two below-floor cases were verified to sit under the documented 2″
 * moment-centroid floor). Tolerances are loose enough to survive
 * float-order changes, tight enough to catch a real algorithm drift.
 */
const EXPECTED: Record<string, Expected> = {
  'K02606.01': {
    status: 'measured',
    verdict: 'OFFSET_DETECTED',
    quartersUsed: 6,
    offsetArcsec: 7.196, // NASA 7.069″ ± 0.091 — 0.18× our 0.697″ error
    sigma: 10.32,
    nasaAgreementSigmaMax: 1.0,
  },
  'K01075.01': {
    status: 'measured',
    verdict: 'NO_SIGNIFICANT_OFFSET', // NASA 1.016″ — real but sub-floor; must NOT fire
    quartersUsed: 6,
    offsetArcsec: 1.491,
    sigma: 2.59,
    nasaAgreementSigmaMax: null,
  },
  'K01800.01': {
    status: 'measured',
    verdict: 'NO_SIGNIFICANT_OFFSET', // NASA 0.008″ ± 0.07 — clean negative control
    quartersUsed: 6,
    offsetArcsec: 0.909,
    sigma: 1.54,
    nasaAgreementSigmaMax: null,
  },
  'K00003.01': {
    status: 'saturated',
    verdict: null,
    quartersUsed: 0,
    offsetArcsec: null,
    sigma: null,
    nasaAgreementSigmaMax: null,
  },
}

/** @description Tolerance on the offset magnitude (arcsec). */
const OFFSET_TOL = 0.05

/** @description Tolerance on the significance. */
const SIGMA_TOL = 0.3

/**
 * @description Loads one frozen fixture and rehydrates nulls to NaN.
 * @param kic KIC integer of the fixture file.
 * @returns Parsed fixture.
 */
function loadFixture(kic: number): CentroidFixture {
  const raw = gunzipSync(readFileSync(path.join(FIXTURE_DIR, `centroid-KIC${kic}.json.gz`)))
  return JSON.parse(raw.toString('utf8')) as CentroidFixture
}

/**
 * @description Converts a fixture quarter into engine input (null → NaN).
 * @param q Fixture quarter.
 * @returns Engine-ready quarter.
 */
function toEngineInput(q: CentroidFixture['quarters'][number]): CentroidQuarterInput {
  return {
    label: q.label,
    nx: q.nx,
    ny: q.ny,
    times: q.times,
    quality: q.quality,
    flux: q.flux.map(v => (v === null ? NaN : v)),
  }
}

const FIXTURE_KICS = [5991936, 10232123, 11017901, 10748390]
let failures = 0

for (const kic of FIXTURE_KICS) {
  const fixture = loadFixture(kic)
  const { nasa } = fixture
  const result = runCentroidVet(
    fixture.quarters.map(toEngineInput),
    nasa.periodDays,
    nasa.epochBkjd,
    nasa.durationHours,
    fixture.kepmagHeader,
  )

  if (PRINT_MODE) {
    console.log(
      `${fixture.kepoi} KIC${kic}: status=${result.status} verdict=${result.verdict ?? '-'} ` +
        `offset=${result.offsetArcsec?.toFixed(3) ?? '-'}″ ±${result.offsetErrArcsec?.toFixed(3) ?? '-'} ` +
        `σ=${result.sigma?.toFixed(2) ?? '-'} quarters=${result.quartersUsed} ` +
        `| NASA dicco=${nasa.diccoArcsec ?? '-'}″ ±${nasa.diccoErrArcsec ?? '-'} (${nasa.disposition}, fpflag_co=${nasa.fpflagCo})`,
    )
    for (const q of result.quarterOffsets) {
      console.log(`    ${q.label}: r=${q.rArcsec.toFixed(3)}″ (dx=${q.dxArcsec.toFixed(3)}, dy=${q.dyArcsec.toFixed(3)}) nIn=${q.nIn} nOut=${q.nOut}`)
    }
    continue
  }

  const expected = EXPECTED[fixture.kepoi]
  const problems: string[] = []
  if (result.status !== expected.status) problems.push(`status: got ${result.status}, expected ${expected.status}`)
  if (result.verdict !== expected.verdict) problems.push(`verdict: got ${result.verdict}, expected ${expected.verdict}`)
  if (result.quartersUsed !== expected.quartersUsed) {
    problems.push(`quartersUsed: got ${result.quartersUsed}, expected ${expected.quartersUsed}`)
  }
  if (expected.offsetArcsec !== null) {
    if (result.offsetArcsec === null || Math.abs(result.offsetArcsec - expected.offsetArcsec) > OFFSET_TOL) {
      problems.push(`offsetArcsec: got ${result.offsetArcsec?.toFixed(3) ?? 'null'}, expected ${expected.offsetArcsec} ± ${OFFSET_TOL}`)
    }
  } else if (result.offsetArcsec !== null) {
    problems.push(`offsetArcsec: got ${result.offsetArcsec.toFixed(3)}, expected null`)
  }
  if (expected.sigma !== null) {
    if (result.sigma === null || Math.abs(result.sigma - expected.sigma) > SIGMA_TOL) {
      problems.push(`sigma: got ${result.sigma?.toFixed(2) ?? 'null'}, expected ${expected.sigma} ± ${SIGMA_TOL}`)
    }
  }
  // Ground-truth agreement gate: our measured offset must overlap NASA's
  // PRF-fitted dicco within k× OUR error bar (theirs is ~10× tighter).
  if (expected.nasaAgreementSigmaMax !== null && nasa.diccoArcsec !== null) {
    const err = result.offsetErrArcsec ?? 0
    const dev = err > 0 ? Math.abs((result.offsetArcsec ?? 0) - nasa.diccoArcsec) / err : Infinity
    if (dev > expected.nasaAgreementSigmaMax) {
      problems.push(
        `NASA agreement: |${result.offsetArcsec?.toFixed(3)} − ${nasa.diccoArcsec}| = ${dev.toFixed(2)}× our error (max ${expected.nasaAgreementSigmaMax})`,
      )
    }
  }
  if (result.status === 'saturated' && result.stamp !== null) {
    problems.push('saturated result must not carry a stamp')
  }

  if (problems.length > 0) {
    failures++
    console.error(`❌ ${fixture.kepoi} (KIC${kic}) — ${fixture.note}`)
    for (const p of problems) console.error(`     ${p}`)
  } else {
    console.log(
      `✅ ${fixture.kepoi} (KIC${kic}): ${result.status}${result.verdict ? ` · ${result.verdict}` : ''}` +
        `${result.offsetArcsec !== null ? ` · ${result.offsetArcsec.toFixed(2)}″ ±${result.offsetErrArcsec!.toFixed(2)} (${result.sigma!.toFixed(1)}σ)` : ''}` +
        `${nasa.diccoArcsec !== null ? ` · NASA ${nasa.diccoArcsec}″` : ''}`,
    )
  }
}

if (!PRINT_MODE) {
  if (failures > 0) {
    console.error(`\n${failures} centroid fixture(s) FAILED.`)
    process.exit(1)
  }
  console.log('\nAll centroid regression fixtures pass.')
}
