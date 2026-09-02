/**
 * @description TESS centroid ground-truth agreement — compares this engine's
 * verdict against SPOC's own `msTicCentroidOffsets` values, parsed from each
 * target's Data Validation report (`_dvr.xml`) at capture time and frozen in
 * the fixture's `nasa` block (issue #27).
 *
 * ## Why this is a separate file from centroidRegression.test.ts
 *
 * That file pins OUR OUTPUT against drift — a failure there means the
 * algorithm changed. This file compares against an EXTERNAL pipeline — a
 * failure here means we and SPOC disagree, which could be our bug, their
 * different method, or a real property of the target. Different failure
 * meanings deserve different files.
 *
 * ## Why verdict-level, not numeric
 *
 * A numeric tolerance was evaluated and REJECTED (measured, not assumed):
 * - SPOC aggregates its multi-sector `ms*` values with an INVERSE-VARIANCE
 *   WEIGHTED mean; this engine uses an unweighted vector mean. On the
 *   66-sector WASP-126 report the two estimators differ by 16× in RA.
 * - SPOC's uncertainty does not shrink with sector count (~2.5″ whether 1
 *   or 66 sectors) — it is a systematic floor, not propagated measurement
 *   error. A σ-space criterion would therefore be dominated by that floor
 *   and pass almost anything on a quiet target.
 * - The two sides do not even use the same INPUT SECTORS: SPOC's report
 *   spans whatever it processed, while these fixtures freeze 4 segments.
 *   Both sector sets are recorded per witness so a disagreement can be
 *   diagnosed rather than guessed at.
 *
 * What survives all three differences is the VERDICT: does an independent
 * pipeline see an offset where we see one, and stay quiet where we do?
 *
 * ## Gating, with one pinned disagreement
 *
 * The first baseline was reviewed on 2026-08-01 and this test now FAILS the
 * suite on any unexpected result. Each witness declares what it must
 * demonstrate (see {@link WITNESSES}):
 * - TOI 409.01 and WASP-126 b must AGREE with SPOC — locking in the first
 *   real verdict-level agreement between this engine and TESS ground truth.
 * - TOI 274.01 must DISAGREE, at documented values. It is a real offset
 *   below our TESS floor: the analogue of K01075.01 in the Kepler
 *   fixtures. Pinning the disagreement means both fixing it and worsening
 *   it get noticed.
 * - K00003.01 must be REFUSED (saturated) before any measurement.
 *
 * Run via `npm run test:data` (plain Node ≥ 22.15, no framework, offline).
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runCentroidVet,
  isSaturatedMag,
  type CentroidQuarterInput,
} from '../src/centroidVet.ts'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * @description While true, an unexpected result is logged but does NOT fail
 * the suite. Set to false on 2026-08-01 after the first baseline was
 * reviewed: every witness's outcome is now understood and pinned per
 * witness in {@link WITNESSES}, including one deliberate disagreement.
 */
const REPORT_ONLY = false

/**
 * @description Significance SPOC's own offset must clear to count as a
 * detection on their side. 3σ mirrors this engine's
 * `CENTROID_SIGMA_THRESHOLD`, so neither side is held to a looser bar.
 */
const SPOC_SIGMA_THRESHOLD = 3

/**
 * @description Absolute floor (arcsec) SPOC's offset must clear, on top of
 * significance. SPOC's uncertainty is a systematic ~2.5″ floor rather than
 * a shrinking measurement error, so requiring 2× that keeps a formally
 * significant but physically tiny offset from counting as a detection.
 */
const SPOC_FLOOR_ARCSEC = 5

/**
 * @description What a witness is expected to demonstrate.
 *
 * - `agree` — our verdict must match SPOC's. The normal case.
 * - `disagree` — our verdict must NOT match SPOC's, and our own numbers
 *   must stay at the documented values. Used for a known sensitivity
 *   limitation, so that both fixing it and worsening it are noticed.
 * - `saturated` — the target must be refused before any measurement.
 */
interface WitnessExpectation {
  expect: 'agree' | 'disagree' | 'saturated'
  /** Required when `expect === 'disagree'`: the verdict we must produce. */
  ourVerdict?: 'OFFSET_DETECTED' | 'NO_SIGNIFICANT_OFFSET'
  /** Required when `expect === 'disagree'`: our documented offset (arcsec). */
  ourOffsetArcsec?: number
  /** Required when `expect === 'disagree'`: our documented significance. */
  ourSigma?: number
}

/** @description Tolerance on a pinned offset magnitude (arcsec). */
const OFFSET_TOL = 0.05

/** @description Tolerance on a pinned significance. */
const SIGMA_TOL = 0.3

/** @description Fixture shape — only the fields this test reads. */
interface TessFixture {
  label: string
  mission: 'Kepler' | 'TESS'
  note: string
  magHeader: number | null
  capturedSegments?: number[]
  nasa: {
    disposition: string
    periodDays: number
    epochBkjd: number
    durationHours: number
    tmag?: number
    spocMeanSkyOffsetArcsec?: number | null
    spocMeanSkyOffsetErrArcsec?: number | null
    spocDvrFile?: string | null
    spocSectorSpan?: string | null
    spocSectorsObserved?: number[] | null
  }
  quarters: {
    label: string
    segment: number
    nx: number
    ny: number
    wcs: CentroidQuarterInput['wcs']
    times: number[]
    quality: number[]
    flux: (number | null)[]
  }[]
}

/**
 * @description The witnesses. Every TESS fixture that carries SPOC ground
 * truth, plus the Kepler saturation case — included because the refusal
 * path must stay verifiable alongside the measured ones.
 */
const WITNESSES: Record<string, WitnessExpectation> = {
  // TOI 409.01 — the TESS offset ANCHOR (K02606.01's analogue). SPOC reads
  // 63.78″ ± 2.51 (25.5σ); we read ~31.8″ at 6.8σ off a different 4-sector
  // subset. Magnitudes differ, verdicts must not.
  'centroid-TIC167754523': { expect: 'agree' },

  // TOI 274.01 — KNOWN LIMITATION, pinned as a DISAGREEMENT on purpose.
  //
  // This is the TESS analogue of K01075.01's role in the Kepler fixtures:
  // a REAL centroid offset that our sensitivity cannot resolve. SPOC's DV
  // reports 14.04″ ± 2.95 (4.8σ) — a genuine detection, corroborated
  // independently by ExoFOP's human vetting ("centroid offset onto another
  // star a pixel away… also apparent in SPOC multisector"). We measure
  // ~6.3″ at 0.8σ, below our ~9.8″ TESS half-pixel floor, so we correctly
  // decline to call it.
  //
  // That is a documented limitation, not a bug: the floor exists because a
  // moment centroid on 21″ TESS pixels cannot honestly resolve offsets of
  // this size (see centroidVet.ts's floor rationale). Asserting agreement
  // here would be asserting that we can do something we cannot.
  //
  // Pinning the disagreement means a future engine change gets noticed in
  // BOTH directions: if sensitivity improves enough to detect this, the
  // test fails and the improvement must be acknowledged (and the floor
  // re-examined); if something degrades our numbers further, that fails
  // too. Silence would hide either.
  'centroid-TIC281979481': {
    expect: 'disagree',
    ourVerdict: 'NO_SIGNIFICANT_OFFSET',
    ourOffsetArcsec: 6.267,
    ourSigma: 0.84,
  },

  // WASP-126 b — clean confirmed planet; SPOC reads a non-detection
  // (0.11″ ± 2.50) and so do we. Locks in the quiet end.
  'centroid-TIC25155310': { expect: 'agree' },

  // K00003.01 — saturated Kepler target. No offset to compare; the refusal
  // itself is what must hold, since a refused target can never agree or
  // disagree on numbers.
  'centroid-KIC10748390': { expect: 'saturated' },
}

// NOTE: TOI 5523.02 (TIC 443616612) is NOT a witness here. Its fixture is a
// LIGHT-CURVE fixture (dip detector / classifier), not a centroid fixture —
// it carries no TPF pixel data, so there is nothing for this engine to
// measure. Adding it would mean a fifth ~180 MB TPF capture; deferred as a
// separate decision rather than assumed.

/**
 * @description Loads a frozen fixture.
 * @param key Fixture file key.
 * @returns Parsed fixture, or null when the file is absent.
 */
function loadFixture(key: string): TessFixture | null {
  try {
    return JSON.parse(
      gunzipSync(readFileSync(path.join(FIXTURE_DIR, `${key}.json.gz`))).toString('utf8'),
    ) as TessFixture
  } catch {
    return null
  }
}

/**
 * @description Converts a fixture segment into engine input (null → NaN).
 * @param q Fixture segment.
 * @returns Engine-ready segment.
 */
function toEngineInput(q: TessFixture['quarters'][number]): CentroidQuarterInput {
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

/**
 * @description Whether SPOC's own numbers constitute a detection.
 * @param offsetArcsec SPOC `meanSkyOffset`.
 * @param errArcsec SPOC `meanSkyOffset` uncertainty.
 * @returns True when SPOC sees a real offset.
 */
function spocDetects(offsetArcsec: number, errArcsec: number): boolean {
  const sigma = errArcsec > 0 ? offsetArcsec / errArcsec : 0
  return sigma >= SPOC_SIGMA_THRESHOLD && offsetArcsec >= SPOC_FLOOR_ARCSEC
}

console.log('TESS centroid ground-truth agreement (SPOC msTicCentroidOffsets — issue #27)')
console.log(`Mode: ${REPORT_ONLY ? 'REPORT-ONLY (never fails the suite)' : 'GATING'}\n`)

let failures = 0

for (const [key, want] of Object.entries(WITNESSES)) {
  const fixture = loadFixture(key)
  if (!fixture) {
    console.error(`❌ ${key} — fixture missing (expected a frozen witness)`)
    failures++
    continue
  }
  const { nasa } = fixture
  const mag = fixture.magHeader
  const result = runCentroidVet(
    fixture.quarters.map(toEngineInput),
    nasa.periodDays,
    nasa.epochBkjd,
    nasa.durationHours,
    mag,
    fixture.mission,
  )
  const problems: string[] = []

  // ── Saturation-refusal witness ────────────────────────────────────────
  if (want.expect === 'saturated') {
    if (!isSaturatedMag(fixture.mission, mag)) {
      problems.push(`mag ${mag} is not below the ${fixture.mission} saturation limit`)
    }
    if (result.status !== 'saturated') {
      problems.push(`status: got ${result.status}, expected saturated`)
    }
    if (problems.length === 0) {
      console.log(`✅ ${fixture.label.padEnd(26)} REFUSED (saturated, mag ${mag})`)
    } else {
      failures++
      console.error(`❌ ${fixture.label} — ${fixture.note}`)
      for (const p of problems) console.error(`     ${p}`)
    }
    continue
  }

  // ── Measured witnesses: compare verdicts against SPOC ─────────────────
  const spocOffset = nasa.spocMeanSkyOffsetArcsec
  const spocErr = nasa.spocMeanSkyOffsetErrArcsec
  if (spocOffset === null || spocOffset === undefined || !spocErr) {
    console.error(`❌ ${fixture.label} — no SPOC ground truth in fixture; re-capture to add it`)
    failures++
    continue
  }

  const theyDetect = spocDetects(spocOffset, spocErr)
  const weDetect = result.verdict === 'OFFSET_DETECTED'
  const agrees = theyDetect === weDetect
  const spocSigma = spocErr > 0 ? spocOffset / spocErr : 0

  if (want.expect === 'agree' && !agrees) {
    problems.push(
      `verdict disagreement: ours ${weDetect ? 'DETECT' : 'no detect'}, SPOC ${theyDetect ? 'DETECT' : 'no detect'}`,
    )
  }

  if (want.expect === 'disagree') {
    if (agrees) {
      problems.push(
        `expected the DOCUMENTED disagreement, but the verdicts now AGREE ` +
          `(ours ${weDetect ? 'DETECT' : 'no detect'}, SPOC ${theyDetect ? 'DETECT' : 'no detect'}). ` +
          `If sensitivity genuinely improved, that is good news — acknowledge it, ` +
          `re-examine the TESS floor, and update this witness.`,
      )
    }
    // Pin our own numbers too: "disagrees" must stay disagreeing FOR THE
    // DOCUMENTED REASON, not because something else drifted.
    if (result.verdict !== want.ourVerdict) {
      problems.push(`our verdict: got ${result.verdict}, expected ${want.ourVerdict}`)
    }
    if (
      result.offsetArcsec === null ||
      Math.abs(result.offsetArcsec - want.ourOffsetArcsec!) > OFFSET_TOL
    ) {
      problems.push(
        `our offset: got ${result.offsetArcsec?.toFixed(3) ?? 'null'}″, expected ${want.ourOffsetArcsec}″ ± ${OFFSET_TOL}`,
      )
    }
    if (result.sigma === null || Math.abs(result.sigma - want.ourSigma!) > SIGMA_TOL) {
      problems.push(
        `our sigma: got ${result.sigma?.toFixed(2) ?? 'null'}, expected ${want.ourSigma} ± ${SIGMA_TOL}`,
      )
    }
  }

  const mark = problems.length === 0 ? (want.expect === 'disagree' ? '📌' : '✅') : '❌'
  const line =
    `${mark} ${fixture.label.padEnd(26)} ` +
    `ours ${result.offsetArcsec !== null ? `${result.offsetArcsec.toFixed(2)}″ ±${result.offsetErrArcsec!.toFixed(2)} (${result.sigma!.toFixed(1)}σ, floor ${result.floorArcsec.toFixed(1)}″)` : result.status} ` +
    `→ ${weDetect ? 'DETECT' : 'no detect'}  |  ` +
    `SPOC ${spocOffset.toFixed(2)}″ ±${spocErr.toFixed(2)} (${spocSigma.toFixed(1)}σ) → ${theyDetect ? 'DETECT' : 'no detect'}`

  if (problems.length === 0) {
    console.log(line)
    console.log(
      `     sectors — ours [${(fixture.capturedSegments ?? []).join(',') || '?'}]  ` +
        `SPOC ${nasa.spocSectorSpan ?? '?'}`,
    )
    if (want.expect === 'disagree') {
      console.log(`     known limitation: below our ${result.floorArcsec.toFixed(1)}″ TESS floor — pinned on purpose`)
    }
  } else {
    failures++
    console.error(`❌ ${fixture.label} — ${fixture.note}`)
    for (const p of problems) console.error(`     ${p}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} TESS ground-truth witness(es) FAILED.`)
  if (!REPORT_ONLY) process.exit(1)
  console.error('(REPORT_ONLY is set — not failing the suite.)')
} else {
  console.log('\nAll TESS ground-truth witnesses behaved as documented.')
}
