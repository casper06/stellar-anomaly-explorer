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
