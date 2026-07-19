/**
 * @description Unit tests for `lib/catalogMembership.ts` — the
 * SIMBAD-identity → do-we-actually-render-it resolution behind the
 * search box's explicit "ask SIMBAD" escape hatch (phase B3 mechanism
 * (b)).
 *
 * Every identity here is parsed from a FROZEN REAL SIMBAD response, not
 * hand-written, so the tests pin behavior against the shapes the live
 * service actually returns:
 *   - KIC8462852 (Tabby's Star) — the ordinary match case.
 *   - EPIC201637175 (K2-22) — the EPIC path, and one of the 11 seeds.
 *   - TIC25155310 (WASP-126) — TIC-only record.
 *   - M31 — the counter-case this feature exists for: a real,
 *     unambiguous object with 41 identifiers and NOT ONE stellar
 *     catalog id, so it can only ever resolve to `not-tracked`.
 *
 * The membership rules under test were chosen from measured facts
 * (2026-07-18) that make the naive alternatives wrong:
 *   - Object type is not a proxy for "we track it" — `3C 273` is a
 *     quasar carrying HIP 60936 and EPIC 229151988.
 *   - Carrying a catalog id is not a proxy either — Betelgeuse, Vega
 *     and TRAPPIST-1 all carry a TIC without being in the KOI/TOI
 *     merge. Hence membership is tested against the live catalog.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { parseSimbadIdentityResponse, type SimbadIdentity } from '../simbadIds'
import {
  resolveAgainstCatalog,
  identityLabel,
  type CatalogEntry,
} from '../catalogMembership'

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'simbad',
)

/**
 * @description Loads and parses one frozen SIMBAD fixture.
 * @param name Fixture basename without extension.
 * @returns The parsed identity (fixtures used here all have a record).
 */
function identity(name: string): SimbadIdentity {
  const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'))
  const parsed = parseSimbadIdentityResponse(raw.response)
  assert.ok(parsed, `fixture ${name} should carry a record`)
  return parsed
}

/**
 * @description Builds a minimal catalog from ids.
 * @param ids App-form star ids.
 * @returns Catalog entries.
 */
const catalog = (...ids: string[]): CatalogEntry[] => ids.map(id => ({ id }))

describe('resolveAgainstCatalog — matched', () => {
  it('matches Tabby\'s Star via its KIC when the catalog has it', () => {
    const res = resolveAgainstCatalog(identity('KIC8462852'), catalog('KIC8462852', 'KIC10666592'))
    assert.equal(res.outcome, 'matched')
    if (res.outcome !== 'matched') return
    assert.equal(res.starId, 'KIC8462852')
    assert.equal(res.matchedVia, 'KIC 8462852')
  })

  it('matches K2-22 via its EPIC id (the seed path)', () => {
    const res = resolveAgainstCatalog(identity('EPIC201637175'), catalog('EPIC201637175'))
    assert.equal(res.outcome, 'matched')
    if (res.outcome !== 'matched') return
    assert.equal(res.starId, 'EPIC201637175')
  })

  it('matches WASP-126 via its TIC id', () => {
    const res = resolveAgainstCatalog(identity('TIC25155310'), catalog('TIC25155310'))
    assert.equal(res.outcome, 'matched')
    if (res.outcome !== 'matched') return
    assert.equal(res.starId, 'TIC25155310')
  })

  it('prefers a mission id (KIC) over HIP when the catalog holds both', () => {
    // Tabby's fixture has no HIP, so this asserts the ORDERING rule
    // directly: a synthetic identity carrying both must resolve to the
    // mission target, because that is the one with a light curve.
    const both: SimbadIdentity = { ...identity('KIC8462852'), hip: '999999' }
    const res = resolveAgainstCatalog(both, catalog('HIP999999', 'KIC8462852'))
    assert.equal(res.outcome, 'matched')
    if (res.outcome !== 'matched') return
    assert.equal(res.starId, 'KIC8462852', 'mission target must win over the Hipparcos background star')
  })

  it('falls back to HIP when the mission id is not in the catalog', () => {
    const both: SimbadIdentity = { ...identity('KIC8462852'), hip: '999999' }
    const res = resolveAgainstCatalog(both, catalog('HIP999999'))
    assert.equal(res.outcome, 'matched')
    if (res.outcome !== 'matched') return
    assert.equal(res.starId, 'HIP999999')
  })
})

describe('resolveAgainstCatalog — not-tracked', () => {
  it('reports M31 as recognized-but-not-tracked (no catalog id at all)', () => {
    const m31 = identity('M31')
    // Guards the premise of the fixture: if SIMBAD ever adds a stellar
    // catalog id to M31, this test's meaning would silently change.
    assert.equal(m31.kic, null)
    assert.equal(m31.tic, null)
    assert.equal(m31.epic, null)
    assert.equal(m31.hip, null)

    const res = resolveAgainstCatalog(m31, catalog('KIC8462852', 'HIP91262'))
    assert.equal(res.outcome, 'not-tracked')
  })

  it('reports not-tracked for a real star whose ids we simply do not render', () => {
    // The TRAPPIST-1 shape: carries a TIC, but the TIC is not in the
    // KOI/TOI merge. This is the case a "has a catalog id?" check would
    // get wrong, so it must resolve to not-tracked, never matched.
    const res = resolveAgainstCatalog(identity('TIC25155310'), catalog('KIC8462852'))
    assert.equal(res.outcome, 'not-tracked')
  })

  it('reports not-tracked against an empty catalog', () => {
    const res = resolveAgainstCatalog(identity('KIC8462852'), [])
    assert.equal(res.outcome, 'not-tracked')
  })
})

describe('resolveAgainstCatalog — unknown', () => {
  it('maps a null identity (SIMBAD miss or outage) to unknown', () => {
    assert.equal(resolveAgainstCatalog(null, catalog('KIC8462852')).outcome, 'unknown')
  })
})

describe('identityLabel', () => {
  it('prefers a common name over an obscure main_id', () => {
    const tabby = identity('KIC8462852')
    // main_id is TYC 3162-665-1, which would read as a non-answer to a
    // user who typed "Boyajian's Star".
    assert.equal(identityLabel(tabby), tabby.commonNames[0])
    assert.notEqual(identityLabel(tabby), tabby.mainId)
  })

  it('falls back to main_id when there is no common name', () => {
    const m31 = identity('M31')
    const label = identityLabel(m31)
    assert.ok(label.length > 0)
    assert.equal(label, m31.commonNames[0] ?? m31.mainId)
  })
})
