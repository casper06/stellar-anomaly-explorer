/**
 * @description Unit tests for the Gaia DR3 descriptive engine
 * (`src/lib/gaiaSource.ts`) — VOTable parsing + the descriptive
 * interpretation, run against the FOUR frozen REAL Gaia responses in
 * `__tests__/fixtures/gaia/*.json` (captured live 2026-07-21 via
 * `scripts/capture-gaia-fixtures.mjs`).
 *
 * These pin the C1 findings against real data, not synthetic:
 *   - Tabby (2081900940499099136): RV-VARIABLE per the 4-part criterion,
 *     phot_variable_flag = NOT_AVAILABLE (must read NOT_FLAGGED, NEVER
 *     "constant"), NOT in the classifier table.
 *   - HAT-P-7 (2129256395211984000): RV NOT_VARIABLE, phot_variable_flag
 *     = VARIABLE, IN the classifier table (bonus layer = class EP).
 *   - WASP-126 (4666498154837086208): RV NOT_VARIABLE (has_rvs true),
 *     classifier absent.
 *   - K2-22 (3811002791880297600): faint, has_rvs false → all RV columns
 *     null → RV NOT_EVALUATED (must stay distinct from NOT_VARIABLE).
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  parseGaiaSourceVotable,
  parseGaiaClassifierVotable,
  describeGaiaSource,
  classifyRvVariability,
  classifyRuwe,
  readPhotVariableFlag,
  isGaiaErrorEnvelope,
  type GaiaSourceRow,
} from '../gaiaSource'

const FIXDIR = path.join(import.meta.dirname, 'fixtures', 'gaia')

/** @description Loads a frozen Gaia fixture and returns its two VOTable bodies. */
function loadFixture(sourceId: string): { source: string; classifier: string; label: string } {
  const d = JSON.parse(readFileSync(path.join(FIXDIR, `${sourceId}.json`), 'utf8'))
  return { source: d.gaiaSource.votable, classifier: d.variClassifier.votable, label: d.label }
}

const TABBY = '2081900940499099136'
const HATP7 = '2129256395211984000'
const WASP126 = '4666498154837086208'
const K2_22 = '3811002791880297600'

/** @description Parses a fixture's gaia_source body, asserting non-null. */
function rowOf(sourceId: string): GaiaSourceRow {
  const row = parseGaiaSourceVotable(loadFixture(sourceId).source)
  assert.ok(row, `${sourceId} gaia_source parsed to a row`)
  return row
}

describe('parseGaiaSourceVotable — real fixtures', () => {
  it('parses Tabby: source_id as string, RUWE + RV columns, NOT_AVAILABLE flag', () => {
    const row = rowOf(TABBY)
    assert.equal(row.sourceId, TABBY, 'source_id kept as 19-digit string (no precision loss)')
    assert.equal(typeof row.sourceId, 'string')
    assert.equal(row.photVariableFlag, 'NOT_AVAILABLE')
    assert.ok(Math.abs((row.ruwe ?? 0) - 0.8154449) < 1e-6, 'RUWE ≈ 0.8154449')
    assert.equal(row.rvNbTransits, 17)
    assert.ok(Math.abs((row.rvTemplateTeff ?? 0) - 6250) < 1e-6)
    assert.equal(row.rvChisqPvalue, 0)
    assert.ok(Math.abs((row.rvRenormalisedGof ?? 0) - 10.905112) < 1e-5)
    assert.equal(row.hasRvs, false, 'T/F boolean parsed (F → false)')
  })

  it('parses K2-22: faint source, empty RV cells → null (not 0, not NaN)', () => {
    const row = rowOf(K2_22)
    assert.equal(row.rvNbTransits, null, 'empty <TD> → null')
    assert.equal(row.rvChisqPvalue, null)
    assert.equal(row.rvRenormalisedGof, null)
    assert.equal(row.rvTemplateTeff, null)
    assert.equal(row.radialVelocity, null)
    // But RUWE and the flag are still populated for a faint source.
    assert.ok(Math.abs((row.ruwe ?? 0) - 0.99642664) < 1e-6)
    assert.equal(row.photVariableFlag, 'NOT_AVAILABLE')
  })

  it('parses HAT-P-7: phot_variable_flag = VARIABLE', () => {
    const row = rowOf(HATP7)
    assert.equal(row.photVariableFlag, 'VARIABLE')
    assert.equal(row.rvNbTransits, 20)
  })

  it('parses WASP-126: has_rvs = T → true', () => {
    const row = rowOf(WASP126)
    assert.equal(row.hasRvs, true)
    assert.equal(row.photVariableFlag, 'NOT_AVAILABLE')
  })

  it('locates columns by NAME (survives an unrelated schema reorder), throws on a missing required column', () => {
    // A VOTable whose FIELDs are missing `ruwe` must throw a NAMED error,
    // not silently null it — the VizieR lesson.
    const bad =
      '<VOTABLE><RESOURCE><INFO name="QUERY_STATUS" value="OK"/><TABLE>' +
      '<FIELD name="source_id"/><FIELD name="ra"/></TABLE>' +
      '<DATA><TABLEDATA><TR><TD>123</TD><TD>1.0</TD></TR></TABLEDATA></DATA>' +
      '</RESOURCE></VOTABLE>'
    assert.throws(() => parseGaiaSourceVotable(bad), /missing 'phot_g_mean_mag'|missing '.*' column/)
  })

  it('returns null for a well-formed query that matched no source (empty TABLEDATA)', () => {
    // Real Tabby FIELDs, but no <TR>.
    const body = loadFixture(TABBY).source.replace(/<TR>[\s\S]*?<\/TR>/, '')
    const row = parseGaiaSourceVotable(body)
    assert.equal(row, null, 'no data row → null (legitimate no-such-source answer)')
  })

  it('throws on a Gaia ERROR envelope (rejected query)', () => {
    const err =
      '<VOTABLE><RESOURCE type="results"><INFO name="QUERY_STATUS" value="ERROR">' +
      'Unknown column "in_vari_summary"</INFO></RESOURCE></VOTABLE>'
    assert.ok(isGaiaErrorEnvelope(err))
    assert.throws(() => parseGaiaSourceVotable(err), /error envelope/)
  })

  it('throws on an HTTP-200 HTML outage page (no VOTable FIELDs)', () => {
    // The exact failure mode C1 observed: a downtime HTML page served 200.
    const html =
      '<html class="ltr" dir="ltr" lang="en-GB"><head><title>ESDC Archives downtime</title></head>' +
      '<body>Maintenance ongoing!</body></html>'
    assert.equal(isGaiaErrorEnvelope(html), false, 'HTML outage is not an ERROR envelope')
    assert.throws(() => parseGaiaSourceVotable(html), /no VOTable FIELDs|outage/)
  })
})

describe('parseGaiaClassifierVotable — bonus layer presence/absence', () => {
  it('parses HAT-P-7 classifier row: class EP, score 1.0', () => {
    const c = parseGaiaClassifierVotable(loadFixture(HATP7).classifier)
    assert.ok(c, 'HAT-P-7 is in vari_classifier_result')
    assert.equal(c.bestClassName, 'EP')
    assert.equal(c.bestClassScore, 1.0)
    assert.equal(c.classifierName, 'nTransits:5+')
  })

  it('returns null for sources NOT in the classifier table (Tabby, WASP-126, K2-22)', () => {
    for (const sid of [TABBY, WASP126, K2_22]) {
      const c = parseGaiaClassifierVotable(loadFixture(sid).classifier)
      assert.equal(c, null, `${sid} is not in vari_classifier_result → null (silent absence, not error)`)
    }
  })

  it('throws only on an error envelope, never on an empty result', () => {
    assert.throws(
      () => parseGaiaClassifierVotable('<VOTABLE><INFO name="QUERY_STATUS" value="ERROR">boom</INFO></VOTABLE>'),
      /error envelope/,
    )
  })
})

describe('classifyRvVariability — Katz 2023 four-part criterion', () => {
  it('Tabby is RV-VARIABLE (all four guards pass: n=17, teff=6250, p=0.0, gof=10.9)', () => {
    assert.equal(classifyRvVariability(rowOf(TABBY)), 'VARIABLE')
  })

  it('HAT-P-7 and WASP-126 are RV NOT_VARIABLE (p and gof fail the cut)', () => {
    assert.equal(classifyRvVariability(rowOf(HATP7)), 'NOT_VARIABLE')
    assert.equal(classifyRvVariability(rowOf(WASP126)), 'NOT_VARIABLE')
  })

  it('K2-22 is NOT_EVALUATED (no RVS data) — NEVER collapsed into NOT_VARIABLE', () => {
    const v = classifyRvVariability(rowOf(K2_22))
    assert.equal(v, 'NOT_EVALUATED')
    assert.notEqual(v, 'NOT_VARIABLE', 'absence of RV data is not evidence of constancy')
  })

  it('applies ALL FOUR guards — a source failing only the teff guard is NOT_VARIABLE, not VARIABLE', () => {
    // Same strong p/gof as Tabby but a template teff outside [3900,8000]:
    // the two-part (task) form would call this VARIABLE; the four-part
    // (correct) form must not.
    const base = rowOf(TABBY)
    const tooHot: GaiaSourceRow = { ...base, rvTemplateTeff: 9000 }
    assert.equal(classifyRvVariability(tooHot), 'NOT_VARIABLE')
    const tooCold: GaiaSourceRow = { ...base, rvTemplateTeff: 3000 }
    assert.equal(classifyRvVariability(tooCold), 'NOT_VARIABLE')
    // And too few transits, likewise.
    const fewTransits: GaiaSourceRow = { ...base, rvNbTransits: 9 }
    assert.equal(classifyRvVariability(fewTransits), 'NOT_VARIABLE')
  })
})

describe('classifyRuwe — 1.4 reference band (descriptive)', () => {
  it('all four real sources are WITHIN_REFERENCE (RUWE < 1.4)', () => {
    for (const sid of [TABBY, HATP7, WASP126, K2_22]) {
      assert.equal(classifyRuwe(rowOf(sid).ruwe), 'WITHIN_REFERENCE')
    }
  })

  it('bands a synthetic elevated RUWE and a null', () => {
    assert.equal(classifyRuwe(2.1), 'ELEVATED')
    assert.equal(classifyRuwe(1.4), 'WITHIN_REFERENCE', '1.4 itself is the reference edge, not elevated')
    assert.equal(classifyRuwe(1.41), 'ELEVATED')
    assert.equal(classifyRuwe(null), 'UNKNOWN')
  })
})

describe('readPhotVariableFlag — the NOT_AVAILABLE ≠ constant trap', () => {
  it('NOT_AVAILABLE reads as NOT_FLAGGED, never as a constancy claim', () => {
    const reading = readPhotVariableFlag('NOT_AVAILABLE')
    assert.equal(reading, 'NOT_FLAGGED')
    // The type has no CONSTANT/NOT_VARIABLE member by construction, but
    // assert the string too as a guard against a future well-meaning edit.
    assert.notEqual(reading as string, 'CONSTANT')
    assert.notEqual(reading as string, 'NOT_VARIABLE')
  })

  it('VARIABLE reads as FLAGGED_VARIABLE; anything else is UNKNOWN', () => {
    assert.equal(readPhotVariableFlag('VARIABLE'), 'FLAGGED_VARIABLE')
    assert.equal(readPhotVariableFlag(null), 'UNKNOWN')
    assert.equal(readPhotVariableFlag('CONSTANT'), 'UNKNOWN', 'DR3 never emits CONSTANT, but if it did we would not trust it here')
  })

  it('Tabby (the canonical irregular variable) reads NOT_FLAGGED — and that is correct, not a bug', () => {
    // The whole point: Tabby is a textbook variable yet Gaia DR3 did not
    // flag it. The engine faithfully reports NOT_FLAGGED and makes NO
    // constancy claim.
    const d = describeGaiaSource(rowOf(TABBY))
    assert.equal(d.photVariable, 'NOT_FLAGGED')
  })
})

describe('describeGaiaSource — full profile, real fixtures', () => {
  it('Tabby: RV VARIABLE, RUWE within reference, phot NOT_FLAGGED, no classifier', () => {
    const source = parseGaiaSourceVotable(loadFixture(TABBY).source)!
    const classifier = parseGaiaClassifierVotable(loadFixture(TABBY).classifier)
    const d = describeGaiaSource(source, classifier)
    assert.equal(d.rvVariability, 'VARIABLE')
    assert.equal(d.ruweBand, 'WITHIN_REFERENCE')
    assert.equal(d.photVariable, 'NOT_FLAGGED')
    assert.equal(d.classifier, undefined, 'bonus layer absent → property omitted entirely')
    assert.ok('classifier' in d === false || d.classifier === undefined)
  })

  it('HAT-P-7: bonus classifier present (EP, 1.0), RV NOT_VARIABLE, phot FLAGGED_VARIABLE', () => {
    const source = parseGaiaSourceVotable(loadFixture(HATP7).source)!
    const classifier = parseGaiaClassifierVotable(loadFixture(HATP7).classifier)
    const d = describeGaiaSource(source, classifier)
    assert.equal(d.rvVariability, 'NOT_VARIABLE')
    assert.equal(d.photVariable, 'FLAGGED_VARIABLE')
    assert.ok(d.classifier, 'bonus layer present')
    assert.equal(d.classifier?.className, 'EP')
    assert.equal(d.classifier?.score, 1.0)
  })

  it('K2-22: RV NOT_EVALUATED, RUWE banded, no classifier', () => {
    const source = parseGaiaSourceVotable(loadFixture(K2_22).source)!
    const classifier = parseGaiaClassifierVotable(loadFixture(K2_22).classifier)
    const d = describeGaiaSource(source, classifier)
    assert.equal(d.rvVariability, 'NOT_EVALUATED')
    assert.equal(d.ruweBand, 'WITHIN_REFERENCE')
    assert.equal(d.classifier, undefined)
  })

  it('a null classifier arg leaves the classifier field undefined (silent absence)', () => {
    const d = describeGaiaSource(rowOf(WASP126), null)
    assert.equal(d.classifier, undefined)
  })
})
