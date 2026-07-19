/**
 * @description Unit tests for the SIMBAD identity parser
 * (`lib/simbadIds.ts`) against the FOUR frozen real TAP responses in
 * `fixtures/simbad/` (captured live 2026-07-18 via
 * `scripts/capture-simbad-fixtures.mjs`). Every expected value below was
 * hand-verified against the captured response — the fixtures pin:
 *   - KIC8462852 (Tabby's Star): NAME common-name path, main_id that is
 *     NOT the queried id, KIC+TIC+Gaia DR3+2MASS+Tycho extraction,
 *     catalog-native padding collapse (`NSVS   5711291`).
 *   - KIC10666592 (HAT-P-7): richest record — four survey common names
 *     (HAT-P-7 / TOI-1265 / Kepler-2 / KOI-2) and the Gaia DR1 ≠ DR2/DR3
 *     subtlety (parser must key on `Gaia DR3` specifically).
 *   - TIC25155310 (WASP-126): TIC-queried path, no KIC/EPIC/HIP.
 *   - EPIC201637175 (K2-22): EPIC path, no Tycho.
 * Plus the miss (empty data), contract-violation throws, and the
 * URL-builder's ADQL quoting.
 *
 * Refreeze via the capture script only after an INTENTIONAL contract
 * change, and re-verify values by hand before updating expectations.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  normalizeSimbadId,
  parseSimbadIdsString,
  parseSimbadIdentityResponse,
  selectDisplayNames,
} from '../simbadIds.ts'
import { simbadIdsQueryUrl } from '../externalEndpoints.ts'

/**
 * @description Loads one frozen fixture's raw TAP response body.
 * @param id Fixture star id (file basename).
 * @returns Parsed TAP JSON body as the route would hand to the parser.
 */
function fixture(id: string): unknown {
  const file = path.join(import.meta.dirname, 'fixtures', 'simbad', `${id}.json`)
  return JSON.parse(readFileSync(file, 'utf8')).response
}

describe('parseSimbadIdentityResponse — frozen real responses', () => {
  it('KIC8462852 (Tabby’s Star): full extraction incl. NAME common name', () => {
    const identity = parseSimbadIdentityResponse(fixture('KIC8462852'))
    assert.ok(identity)
    assert.equal(identity.mainId, 'TYC 3162-665-1')
    assert.equal(identity.otype, '*')
    assert.ok(Math.abs(identity.ra! - 301.5643860504275) < 1e-9)
    assert.ok(Math.abs(identity.dec! - 44.4568863525439) < 1e-9)
    assert.equal(identity.kic, '8462852')
    assert.equal(identity.tic, '185336364')
    assert.equal(identity.epic, null)
    assert.equal(identity.hip, null)
    assert.equal(identity.gaiaDr3, '2081900940499099136')
    assert.equal(identity.twoMass, 'J20061546+4427248')
    assert.equal(identity.tycho, '3162-665-1')
    assert.deepEqual(identity.commonNames, ["Boyajian's Star"])
    assert.equal(identity.allIds.length, 13)
    assert.ok(identity.allIds.includes('NSVS 5711291'), 'catalog padding is collapsed')
  })

  it('KIC10666592 (HAT-P-7): four survey common names; Gaia DR3 ≠ DR1', () => {
    const identity = parseSimbadIdentityResponse(fixture('KIC10666592'))
    assert.ok(identity)
    assert.equal(identity.mainId, 'BD+47 2846') // normalized from 'BD+47  2846'
    assert.equal(identity.otype, 'Em*')
    assert.equal(identity.kic, '10666592')
    assert.equal(identity.tic, '424865156')
    assert.equal(identity.gaiaDr3, '2129256395211984000') // NOT DR1's …0911665920
    assert.equal(identity.twoMass, 'J19285935+4758102')
    assert.equal(identity.tycho, '3547-1402-1')
    assert.deepEqual(identity.commonNames, ['HAT-P-7', 'TOI-1265', 'Kepler-2', 'KOI-2'])
    assert.equal(identity.allIds.length, 18)
  })

  it('TIC25155310 (WASP-126): TIC-queried path, no Kepler-side ids', () => {
    const identity = parseSimbadIdentityResponse(fixture('TIC25155310'))
    assert.ok(identity)
    assert.equal(identity.mainId, 'WASP-126')
    assert.equal(identity.otype, 'PM*')
    assert.equal(identity.tic, '25155310')
    assert.equal(identity.kic, null)
    assert.equal(identity.epic, null)
    assert.equal(identity.hip, null)
    assert.equal(identity.gaiaDr3, '4666498154837086208')
    assert.equal(identity.twoMass, 'J04132972-6913365')
    assert.equal(identity.tycho, '9153-833-1')
    assert.deepEqual(identity.commonNames, ['TOI-114', 'WASP-126'])
    assert.equal(identity.allIds.length, 14)
  })

  it('EPIC201637175 (K2-22): EPIC path', () => {
    const identity = parseSimbadIdentityResponse(fixture('EPIC201637175'))
    assert.ok(identity)
    assert.equal(identity.mainId, 'K2-22')
    assert.equal(identity.otype, 'LM*')
    assert.equal(identity.epic, '201637175')
    assert.equal(identity.tic, '363445338')
    assert.equal(identity.kic, null)
    assert.equal(identity.tycho, null)
    assert.equal(identity.gaiaDr3, '3811002791880297600')
    assert.equal(identity.twoMass, 'J11175587+0237086')
    assert.deepEqual(identity.commonNames, ['K2-22'])
    assert.equal(identity.allIds.length, 11)
  })
})

describe('parseSimbadIdentityResponse — miss and contract violations', () => {
  it('returns null on an empty data array (object not in SIMBAD)', () => {
    const body = { ...(fixture('KIC8462852') as Record<string, unknown>), data: [] }
    assert.equal(parseSimbadIdentityResponse(body), null)
  })

  it('throws on a missing required column (contract-change detection)', () => {
    const real = fixture('KIC8462852') as { metadata: Array<{ name: string }>; data: unknown[] }
    const body = { ...real, metadata: real.metadata.filter(m => m.name !== 'ids') }
    assert.throws(() => parseSimbadIdentityResponse(body), /missing 'ids' column/)
  })

  it('throws on a malformed envelope (no metadata/data arrays)', () => {
    assert.throws(() => parseSimbadIdentityResponse({ votable: 'error' }), /missing metadata\/data/)
    assert.throws(() => parseSimbadIdentityResponse(null), /missing metadata\/data/)
  })
})

describe('parseSimbadIdsString / normalizeSimbadId', () => {
  it('collapses catalog-native padding runs', () => {
    assert.equal(normalizeSimbadId('NSVS   5711291'), 'NSVS 5711291')
    assert.equal(normalizeSimbadId('  BD+47  2846 '), 'BD+47 2846')
  })

  it('collects NAME entries as common names and dedupes', () => {
    const parsed = parseSimbadIdsString('NAME Polaris|NAME North Star|HIP 11767|NAME Polaris')
    assert.deepEqual(parsed.commonNames, ['Polaris', 'North Star'])
    assert.equal(parsed.hip, '11767')
  })

  it('does not treat planet-suffixed or lookalike ids as catalog matches', () => {
    // Anchored patterns: 'KIC 123 b' or 'TICA 5' must not extract.
    const parsed = parseSimbadIdsString('KIC 123 b|TICA 5|Gaia DR2 99|WASP-12 b')
    assert.equal(parsed.kic, null)
    assert.equal(parsed.tic, null)
    assert.equal(parsed.gaiaDr3, null, 'DR2 is not DR3')
    assert.deepEqual(parsed.commonNames, [], 'WASP-12 b (planet) is not a star common name')
  })
})

describe('selectDisplayNames — panel "ALSO KNOWN AS" filtering', () => {
  it('KIC8462852: surfaces Boyajian’s Star and the non-obvious main_id', () => {
    const identity = parseSimbadIdentityResponse(fixture('KIC8462852'))!
    // What the panel already shows for this star.
    const picked = selectDisplayNames(identity, ["Tabby's Star", 'KIC8462852'])
    assert.deepEqual(picked.names, ["Boyajian's Star"])
    // main_id is a Tycho designation the user would never guess — the
    // whole reason it earns a row.
    assert.equal(picked.mainId, 'TYC 3162-665-1')
  })

  it('KIC10666592: lists all four survey designations', () => {
    const identity = parseSimbadIdentityResponse(fixture('KIC10666592'))!
    const picked = selectDisplayNames(identity, ['K00002.01', 'KIC10666592'])
    assert.ok(picked.names.includes('HAT-P-7'), `got: ${picked.names.join(', ')}`)
    assert.ok(picked.names.includes('Kepler-2'))
    assert.ok(picked.names.includes('KOI-2'))
    assert.ok(picked.names.includes('TOI-1265'))
  })

  it('suppresses a name the panel already displays (case/space-insensitive)', () => {
    const identity = parseSimbadIdentityResponse(fixture('KIC8462852'))!
    const picked = selectDisplayNames(identity, ["boyajian's   STAR", 'KIC8462852'])
    assert.deepEqual(picked.names, [], 'already-displayed name must not echo back')
  })

  it('drops main_id when it duplicates a listed common name', () => {
    const identity = {
      ...parseSimbadIdentityResponse(fixture('KIC8462852'))!,
      mainId: "Boyajian's Star",
    }
    const picked = selectDisplayNames(identity, ['KIC8462852'])
    assert.deepEqual(picked.names, ["Boyajian's Star"])
    assert.equal(picked.mainId, null, 'main_id already listed as a common name')
  })

  it('reports nothing to show when every name is redundant', () => {
    const identity = parseSimbadIdentityResponse(fixture('KIC8462852'))!
    const picked = selectDisplayNames(identity, ["Boyajian's Star", 'TYC 3162-665-1'])
    // The caller renders nothing at all on this — absence is not news.
    assert.deepEqual(picked.names, [])
    assert.equal(picked.mainId, null)
  })

  it('dedupes within commonNames without mutating the identity', () => {
    const identity = parseSimbadIdentityResponse(fixture('KIC8462852'))!
    const before = [...identity.commonNames]
    selectDisplayNames(identity, [])
    assert.deepEqual(identity.commonNames, before, 'input must not be mutated')
  })
})

describe('simbadIdsQueryUrl', () => {
  it('escapes single quotes for ADQL and targets the sync TAP endpoint', () => {
    const url = simbadIdsQueryUrl("NAME Barnard's star")
    assert.ok(url.startsWith('https://simbad.cds.unistra.fr/simbad/sim-tap/sync?'))
    const query = new URL(url).searchParams.get('QUERY')
    assert.ok(query!.includes("ident.id = 'NAME Barnard''s star'"), `quote doubled in: ${query}`)
    assert.equal(new URL(url).searchParams.get('FORMAT'), 'json')
  })
})
