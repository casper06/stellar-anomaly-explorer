/**
 * @description Centroid-vetting regression test — runs the difference-image
 * centroid engine (`lib/centroidVet.ts`) against five frozen fixtures
 * (real Kepler/TESS TPF pixel data captured 2026-07-10, trimmed to the
 * transit-window neighborhoods; see `scripts/capture-centroid-fixtures.mjs`)
 * and compares against hand-verified expected values. Fails loudly (per-field
 * diff + exit 1) on any drift.
 *
 * Since phase 2 the engine measures offsets against the TARGET'S CATALOG
 * POSITION through each segment's WCS — the same convention as NASA
 * DR25's `koi_dikco_msky`, which is the ground-truth column the Kepler
 * expectations are verified against.
 *
 * The fixtures pin both verdict directions, the sensitivity floor, the
 * saturation refusal, and the (unvalidated) TESS path:
 * - K02606.01 — DR25 centroid-offset FALSE POSITIVE. NASA dikco
 *   6.889″ ± 0.091″; the engine must fire OFFSET_DETECTED and agree with
 *   NASA within its own error bar.
 * - K01075.01 — DR25 centroid-offset FP whose offset (dikco 0.787″) is
 *   BELOW our 2″ floor. Must NOT fire — this fixture IS the documented
 *   sensitivity limitation, frozen so it can't silently change.
 * - K01800.01 — clean CONFIRMED planet (dikco 0.443″). Negative control,
 *   and the anchor for why the floor stays at 2″: it reads ~1.16″ on our
 *   pipeline, so a 1″ floor would false-alarm on a real planet.
 * - K00003.01 — Kp 9.17 saturated star. Must be REFUSED (status
 *   `saturated`), never measured.
 * - WASP-126 b (TIC 25155310) — TESS DRIFT PIN. No public TESS centroid
 *   ground truth exists (why the UI labels TESS qualitative); the
 *   expected values are our own frozen output so the TESS path can't
 *   drift silently. Also pins the TESS half-pixel floor (~10″).
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
  type CentroidWcs,
} from '../src/centroidVet.ts'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const PRINT_MODE = process.argv.includes('--print')

/** @description Shape of a frozen centroid fixture file (see capture script). */
interface CentroidFixture {
  label: string
  mission: 'Kepler' | 'TESS'
  note: string
  nasa: {
    disposition: string
    periodDays: number
    epochBkjd: number
    durationHours: number
    dikcoArcsec: number | null
    dikcoErrArcsec: number | null
  }
  magHeader: number | null
  quarters: Array<{
    label: string
    segment: number | null
    nx: number
    ny: number
    wcs: CentroidWcs | null
    times: number[]
    quality: number[]
    flux: (number | null)[]
  }>
}

/** @description Expected engine output per fixture (hand-verified 2026-07-10). */
interface Expected {
  status: CentroidVetResult['status']
  verdict: CentroidVetResult['verdict']
  referenceFrame: CentroidVetResult['referenceFrame']
  quartersUsed: number
  /** Expected offset magnitude in arcsec (± tolerance); null for non-measured statuses. */
  offsetArcsec: number | null
  /** Expected significance (± tolerance); null for non-measured statuses. */
  sigma: number | null
  /** Expected verdict floor (arcsec, exact). */
  floorArcsec: number
  /** When set, the measured offset must agree with NASA's dikco within k× our error. */
  nasaAgreementSigmaMax: number | null
}

/**
 * @description Hand-verified expectations. Offsets/sigmas were measured on
 * the frozen fixtures with `--print`, then verified against each
 * fixture's embedded NASA `dikco` ground truth (Kepler) or frozen as a
 * drift pin (TESS — no ground truth exists). Tolerances are loose enough
 * to survive float-order changes, tight enough to catch a real algorithm
 * drift.
 */
const EXPECTED: Record<string, Expected> = {
  'centroid-KIC5991936': {
    status: 'measured',
    verdict: 'OFFSET_DETECTED',
    referenceFrame: 'catalog-wcs',
    quartersUsed: 6,
    offsetArcsec: 7.326, // NASA dikco 6.889″ ± 0.091 — 0.51× our 0.858″ error
    sigma: 8.54,
    floorArcsec: 2,
    nasaAgreementSigmaMax: 1.0,
  },
  'centroid-KIC10232123': {
    status: 'measured',
    verdict: 'NO_SIGNIFICANT_OFFSET', // dikco 0.787″ — real but sub-floor; must NOT fire
    referenceFrame: 'catalog-wcs',
    quartersUsed: 6,
    offsetArcsec: 1.282,
    sigma: 2.62,
    floorArcsec: 2,
    nasaAgreementSigmaMax: null,
  },
  'centroid-KIC11017901': {
    status: 'measured',
    verdict: 'NO_SIGNIFICANT_OFFSET', // dikco 0.443″ — clean planet; anchors the 2″ floor
    referenceFrame: 'catalog-wcs',
    quartersUsed: 6,
    offsetArcsec: 1.163,
    sigma: 3.15,
    floorArcsec: 2,
    nasaAgreementSigmaMax: null,
  },
  'centroid-KIC10748390': {
    status: 'saturated',
    verdict: null,
    referenceFrame: null,
    quartersUsed: 0,
    offsetArcsec: null,
    sigma: null,
    floorArcsec: 2,
    nasaAgreementSigmaMax: null,
  },
  'centroid-TIC25155310': {
    status: 'measured',
    verdict: 'NO_SIGNIFICANT_OFFSET', // drift pin only — NOT validated (no TESS ground truth)
    referenceFrame: 'catalog-wcs',
    quartersUsed: 4,
    offsetArcsec: 2.352,
    sigma: 0.74,
    floorArcsec: 10.166, // TESS half-pixel (0.5 × |CDELT2| × 3600, sector 6's WCS)
    nasaAgreementSigmaMax: null,
  },
}

/** @description Tolerance on the offset magnitude (arcsec). */
const OFFSET_TOL = 0.05

/** @description Tolerance on the significance. */
const SIGMA_TOL = 0.3

/** @description Tolerance on the floor (arcsec — derived from the WCS pixel scale). */
const FLOOR_TOL = 0.01

/**
 * @description Loads one frozen fixture and rehydrates nulls to NaN.
 * @param key Fixture file key (e.g. "centroid-KIC5991936").
 * @returns Parsed fixture.
 */
function loadFixture(key: string): CentroidFixture {
  const raw = gunzipSync(readFileSync(path.join(FIXTURE_DIR, `${key}.json.gz`)))
  return JSON.parse(raw.toString('utf8')) as CentroidFixture
}

/**
 * @description Converts a fixture segment into engine input (null → NaN).
 * @param q Fixture segment.
 * @returns Engine-ready segment.
 */
function toEngineInput(q: CentroidFixture['quarters'][number]): CentroidQuarterInput {
  return {
    label: q.label,
    nx: q.nx,
    ny: q.ny,
    times: q.times,
    quality: q.quality,
    flux: q.flux.map(v => (v === null ? NaN : v)),
    wcs: q.wcs,
  }
}

const FIXTURE_KEYS = Object.keys(EXPECTED)
let failures = 0

for (const key of FIXTURE_KEYS) {
  const fixture = loadFixture(key)
  const { nasa } = fixture
  const result = runCentroidVet(
    fixture.quarters.map(toEngineInput),
    nasa.periodDays,
    nasa.epochBkjd,
    nasa.durationHours,
    fixture.magHeader,
    fixture.mission,
  )

  if (PRINT_MODE) {
    console.log(
      `${fixture.label}: status=${result.status} verdict=${result.verdict ?? '-'} ref=${result.referenceFrame ?? '-'} ` +
        `offset=${result.offsetArcsec?.toFixed(3) ?? '-'}″ ±${result.offsetErrArcsec?.toFixed(3) ?? '-'} ` +
        `σ=${result.sigma?.toFixed(2) ?? '-'} floor=${result.floorArcsec.toFixed(3)} segs=${result.quartersUsed} ` +
        `| NASA dikco=${nasa.dikcoArcsec ?? '-'}″ ±${nasa.dikcoErrArcsec ?? '-'} (${nasa.disposition})`,
    )
    for (const q of result.quarterOffsets) {
      console.log(`    ${q.label}: r=${q.rArcsec.toFixed(3)}″ (dx=${q.dxArcsec.toFixed(3)}, dy=${q.dyArcsec.toFixed(3)}) nIn=${q.nIn} nOut=${q.nOut}`)
    }
    continue
  }

  const expected = EXPECTED[key]
  const problems: string[] = []
  if (result.status !== expected.status) problems.push(`status: got ${result.status}, expected ${expected.status}`)
  if (result.verdict !== expected.verdict) problems.push(`verdict: got ${result.verdict}, expected ${expected.verdict}`)
  if (result.referenceFrame !== expected.referenceFrame) {
    problems.push(`referenceFrame: got ${result.referenceFrame}, expected ${expected.referenceFrame}`)
  }
  if (result.quartersUsed !== expected.quartersUsed) {
    problems.push(`quartersUsed: got ${result.quartersUsed}, expected ${expected.quartersUsed}`)
  }
  if (Math.abs(result.floorArcsec - expected.floorArcsec) > FLOOR_TOL) {
    problems.push(`floorArcsec: got ${result.floorArcsec.toFixed(3)}, expected ${expected.floorArcsec}`)
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
  // PRF-fitted dikco within k× OUR error bar (theirs is ~10× tighter).
  if (expected.nasaAgreementSigmaMax !== null && nasa.dikcoArcsec !== null) {
    const err = result.offsetErrArcsec ?? 0
    const dev = err > 0 ? Math.abs((result.offsetArcsec ?? 0) - nasa.dikcoArcsec) / err : Infinity
    if (dev > expected.nasaAgreementSigmaMax) {
      problems.push(
        `NASA agreement: |${result.offsetArcsec?.toFixed(3)} − ${nasa.dikcoArcsec}| = ${dev.toFixed(2)}× our error (max ${expected.nasaAgreementSigmaMax})`,
      )
    }
  }
  if (result.status === 'saturated' && result.stamp !== null) {
    problems.push('saturated result must not carry a stamp')
  }

  if (problems.length > 0) {
    failures++
    console.error(`❌ ${fixture.label} — ${fixture.note}`)
    for (const p of problems) console.error(`     ${p}`)
  } else {
    console.log(
      `✅ ${fixture.label}: ${result.status}${result.verdict ? ` · ${result.verdict}` : ''}` +
        `${result.offsetArcsec !== null ? ` · ${result.offsetArcsec.toFixed(2)}″ ±${result.offsetErrArcsec!.toFixed(2)} (${result.sigma!.toFixed(1)}σ)` : ''}` +
        `${nasa.dikcoArcsec !== null ? ` · NASA dikco ${nasa.dikcoArcsec}″` : fixture.mission === 'TESS' ? ' · drift pin (unvalidated)' : ''}`,
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
