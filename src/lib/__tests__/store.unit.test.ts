/**
 * @description Unit tests for Zustand store contracts that React
 * subscribers depend on: referential changes on Set/Map mutations,
 * idempotence short-circuits, cursor resets, and localStorage
 * persistence via a shimmed global. No browser required.
 *
 * Run via `npm run test:unit` (plain Node ≥ 22.6, node:test + native
 * type stripping — no framework).
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { useStore, type Star } from '../store.ts'
import type { SimbadIdentity } from '../simbadIds.ts'
import type { GaiaDescription } from '../gaiaSource.ts'

/** @description In-memory localStorage shim recording writes. */
class LocalStorageShim {
  data = new Map<string, string>()
  setCalls = 0
  getItem = (k: string) => this.data.get(k) ?? null
  setItem = (k: string, v: string) => { this.data.set(k, v); this.setCalls++ }
  removeItem = (k: string) => { this.data.delete(k) }
}

let shim: LocalStorageShim

beforeEach(() => {
  shim = new LocalStorageShim()
  ;(globalThis as Record<string, unknown>).localStorage = shim
  useStore.setState({
    visitedIds: new Set(),
    flaggedIds: new Set(),
    classifiedPatterns: new Map(),
    anomalyStars: [],
    nextAnomalyCursor: -1,
    flyTo: null,
    identity: null,
    identityLoading: false,
    resolvedIdentities: new Map(),
    gaia: null,
    gaiaLoading: false,
  })
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage
})

describe('visited/flagged persistence contracts', () => {
  it('markVisited creates a NEW Set reference and persists', () => {
    const before = useStore.getState().visitedIds
    useStore.getState().markVisited('KIC1')
    const after = useStore.getState().visitedIds
    assert.notEqual(after, before, 'React subscribers need a referential change')
    assert.ok(after.has('KIC1'))
    assert.deepEqual(JSON.parse(shim.data.get('sae_visited') ?? '[]'), ['KIC1'])
  })

  it('markVisited is idempotent — re-marking keeps the same reference and skips the disk write', () => {
    useStore.getState().markVisited('KIC1')
    const ref = useStore.getState().visitedIds
    const writes = shim.setCalls
    useStore.getState().markVisited('KIC1')
    assert.equal(useStore.getState().visitedIds, ref)
    assert.equal(shim.setCalls, writes)
  })

  it('toggleFlagged flips membership with a new reference each time', () => {
    useStore.getState().toggleFlagged('KIC2')
    const on = useStore.getState().flaggedIds
    assert.ok(on.has('KIC2'))
    useStore.getState().toggleFlagged('KIC2')
    const off = useStore.getState().flaggedIds
    assert.ok(!off.has('KIC2'))
    assert.notEqual(off, on)
    assert.deepEqual(JSON.parse(shim.data.get('sae_flagged') ?? 'null'), [])
  })

  it('hydratePersistedSets loads both sets from localStorage', () => {
    shim.data.set('sae_visited', JSON.stringify(['KIC1', 'KIC2']))
    shim.data.set('sae_flagged', JSON.stringify(['KIC2']))
    useStore.getState().hydratePersistedSets()
    const s = useStore.getState()
    assert.deepEqual([...s.visitedIds].sort(), ['KIC1', 'KIC2'])
    assert.deepEqual([...s.flaggedIds], ['KIC2'])
  })

  it('persistence failures are swallowed (private-mode contract)', () => {
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    assert.doesNotThrow(() => useStore.getState().markVisited('KIC3'))
    assert.ok(useStore.getState().visitedIds.has('KIC3'), 'in-memory state still updates')
    assert.doesNotThrow(() => useStore.getState().hydratePersistedSets())
  })
})

describe('selection / navigation contracts', () => {
  it('setAnomalyStars resets nextAnomalyCursor to -1', () => {
    useStore.getState().setNextAnomalyCursor(7)
    assert.equal(useStore.getState().nextAnomalyCursor, 7)
    useStore.getState().setAnomalyStars([{ id: 'KIC9' } as Star])
    assert.equal(useStore.getState().nextAnomalyCursor, -1)
  })

  it('every requestFlyTo carries a fresh command id (same target twice still flies)', () => {
    useStore.getState().requestFlyTo(290, 44)
    const first = useStore.getState().flyTo
    useStore.getState().requestFlyTo(290, 44)
    const second = useStore.getState().flyTo
    assert.ok(first && second)
    assert.notEqual(second.id, first.id)
  })

  it('setClassifiedPattern short-circuits on same value, new Map on change', () => {
    useStore.getState().setClassifiedPattern('KIC5', 'IRREGULAR')
    const ref = useStore.getState().classifiedPatterns
    useStore.getState().setClassifiedPattern('KIC5', 'IRREGULAR')
    assert.equal(useStore.getState().classifiedPatterns, ref, 'same value → no referential churn')
    useStore.getState().setClassifiedPattern('KIC5', 'SPARSE')
    const changed = useStore.getState().classifiedPatterns
    assert.notEqual(changed, ref)
    assert.equal(changed.get('KIC5'), 'SPARSE')
  })
})

describe('identity slot contracts (phase B3)', () => {
  /** @description Minimal SimbadIdentity stub; only the fields the store touches matter. */
  function identityStub(mainId: string, commonNames: string[]): SimbadIdentity {
    return {
      mainId,
      otype: '*',
      ra: 301.5,
      dec: 44.4,
      kic: null, tic: null, epic: null, hip: null,
      gaiaDr3: null, twoMass: null, tycho: null,
      commonNames,
      allIds: [mainId, ...commonNames],
    }
  }

  it('setIdentity records a resolved identity into the search index', () => {
    const id = identityStub('TYC 3162-665-1', ["Boyajian's Star"])
    useStore.getState().setIdentity('KIC8462852', id)
    assert.equal(useStore.getState().identity, id)
    assert.equal(useStore.getState().resolvedIdentities.get('KIC8462852'), id)
  })

  it('a miss clears the panel slot WITHOUT touching the search index', () => {
    const id = identityStub('TYC 3162-665-1', ["Boyajian's Star"])
    useStore.getState().setIdentity('KIC8462852', id)
    const indexRef = useStore.getState().resolvedIdentities

    // Selecting a star SIMBAD doesn't know must not evict names already
    // resolved for other stars — those stay searchable all session.
    useStore.getState().setIdentity('KIC99999', null)
    assert.equal(useStore.getState().identity, null, 'panel slot cleared')
    assert.equal(useStore.getState().resolvedIdentities, indexRef, 'index reference unchanged')
    assert.ok(useStore.getState().resolvedIdentities.has('KIC8462852'), 'prior names still searchable')
  })

  it('creates a NEW Map reference on insert so search recomputes', () => {
    const before = useStore.getState().resolvedIdentities
    useStore.getState().setIdentity('KIC1', identityStub('X', ['Alpha']))
    assert.notEqual(useStore.getState().resolvedIdentities, before)
  })

  it('re-selecting the same star does not churn the Map reference', () => {
    const id = identityStub('X', ['Alpha'])
    useStore.getState().setIdentity('KIC1', id)
    const ref = useStore.getState().resolvedIdentities
    useStore.getState().setIdentity('KIC1', id)
    assert.equal(useStore.getState().resolvedIdentities, ref, 'same identity → no referential churn')
  })
})

describe('gaia slot contracts (Bloque C3)', () => {
  /** @description Minimal GaiaDescription stub; only the panel-slot behavior matters here. */
  function gaiaStub(rvVariability: GaiaDescription['rvVariability']): GaiaDescription {
    return {
      sourceId: '2081900940499099136',
      ruwe: 0.82,
      ruweBand: 'WITHIN_REFERENCE',
      rvVariability,
      radialVelocity: -0.46,
      radialVelocityError: 3.9,
      rvNbTransits: 17,
      photVariable: 'NOT_FLAGGED',
      astrometricExcessNoise: 0.05,
      ipdFracMultiPeak: 0,
      nonSingleStar: 0,
      photGMeanMag: 11.76,
      bpRp: 0.78,
    }
  }

  it('setGaia writes the panel slot; there is no session index to touch', () => {
    const g = gaiaStub('VARIABLE')
    useStore.getState().setGaia(g)
    assert.equal(useStore.getState().gaia, g)
  })

  it('a null clears the slot (silent absence, the faint-KOI-host case)', () => {
    useStore.getState().setGaia(gaiaStub('NOT_VARIABLE'))
    useStore.getState().setGaia(null)
    assert.equal(useStore.getState().gaia, null)
  })

  it('setGaiaLoading toggles the flag independently of the slot', () => {
    useStore.getState().setGaiaLoading(true)
    assert.equal(useStore.getState().gaiaLoading, true)
    assert.equal(useStore.getState().gaia, null, 'loading does not fabricate a profile')
    useStore.getState().setGaiaLoading(false)
    assert.equal(useStore.getState().gaiaLoading, false)
  })
})
