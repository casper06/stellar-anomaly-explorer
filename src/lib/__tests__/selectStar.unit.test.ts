/**
 * @description Unit tests for the selection-generation guard in
 * `selectStarAndFetchCurve` — previously only ever verified manually via
 * Playwright. `globalThis.fetch` is stubbed with manually-resolvable
 * deferred responses so two selections can race in a controlled order:
 * the stale response resolving AFTER the newer pick must be discarded
 * (no lightcurve overwrite, no premature clearing of the loading flag).
 *
 * Run via `npm run test:unit` (plain Node ≥ 22.6, node:test + native
 * type stripping — no framework, no browser).
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { useStore, type Star } from '../store.ts'
import { selectStarAndFetchCurve } from '../selectStar.ts'

/** @description Minimal catalog star for driving selections. */
function star(id: string): Star {
  return {
    id,
    name: id,
    ra: 290,
    dec: 44,
    magnitude: 12,
    colorIndex: 0.6,
    hasAnomaly: true,
    anomalyScore: 0.5,
  } as Star
}

/**
 * @description Successful /api/lightcurve JSON payload whose times array is
 * tagged with a distinct first value so tests can tell which star's data
 * landed in the store.
 * @param tag Distinguishing first time value.
 */
function lightcurveJson(tag: number) {
  return {
    times: [tag, tag + 0.02, tag + 0.04, tag + 0.06, tag + 0.08],
    flux: [1, 1, 1, 1, 1],
    source: 'real',
    provenance: { sourceName: 'NASA/MAST', mission: 'Kepler', dataType: 'PDCSAP flux' },
    mission: 'Kepler',
    gapDays: 5,
  }
}

/**
 * @description Deferred fetch stub: every `/api/lightcurve/*` call queues a
 * resolver the test releases by star id; `/api/pattern-cache` POSTs resolve
 * immediately and are recorded.
 */
class FetchStub {
  private pending = new Map<string, (json: unknown) => void>()
  patternCachePosts: string[] = []
  install(): void {
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.startsWith('/api/pattern-cache')) {
        this.patternCachePosts.push(String(init?.body ?? ''))
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      const id = decodeURIComponent(u.split('/api/lightcurve/')[1]?.split('?')[0] ?? '')
      return new Promise<Response>(resolve => {
        this.pending.set(id, (json) => resolve(new Response(JSON.stringify(json), { status: 200 })))
      })
    }) as typeof fetch
  }
  /** Resolves the in-flight lightcurve fetch for `id` with `json`. */
  resolve(id: string, json: unknown): void {
    const r = this.pending.get(id)
    assert.ok(r, `no pending fetch for ${id}`)
    this.pending.delete(id)
    r(json)
  }
}

const realFetch = globalThis.fetch
let stub: FetchStub

/** @description Flushes microtasks so awaited store writes settle. */
const tick = () => new Promise<void>(r => setTimeout(r, 0))

beforeEach(() => {
  stub = new FetchStub()
  stub.install()
  useStore.setState({
    selectedStar: null,
    lightcurve: null,
    lightcurveLoading: false,
    anomalies: [],
    mode: 'explore',
    visitedIds: new Set(),
    classifiedPatterns: new Map(),
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('selectStarAndFetchCurve generation guard', () => {
  it('a single selection writes its own curve and clears loading', async () => {
    const p = selectStarAndFetchCurve(star('KIC1'))
    assert.equal(useStore.getState().selectedStar?.id, 'KIC1')
    assert.equal(useStore.getState().lightcurveLoading, true)
    stub.resolve('KIC1', lightcurveJson(111))
    await p
    const s = useStore.getState()
    assert.equal(s.lightcurve?.times[0], 111)
    assert.equal(s.lightcurveLoading, false)
    assert.ok(s.visitedIds.has('KIC1'), 'selection marks the star visited')
  })

  it('discards the stale response when it resolves AFTER a newer pick (the bug ordering)', async () => {
    const pA = selectStarAndFetchCurve(star('KIC_A'))
    const pB = selectStarAndFetchCurve(star('KIC_B')) // supersedes A while A is in flight
    stub.resolve('KIC_B', lightcurveJson(222))
    await pB
    assert.equal(useStore.getState().lightcurve?.times[0], 222)
    // Stale A lands late — must be discarded wholesale.
    stub.resolve('KIC_A', lightcurveJson(111))
    await pA
    const s = useStore.getState()
    assert.equal(s.selectedStar?.id, 'KIC_B')
    assert.equal(s.lightcurve?.times[0], 222, 'stale response must not overwrite the newer curve')
    assert.equal(s.lightcurveLoading, false)
  })

  it('a stale response resolving BEFORE the newer one neither writes data nor clears loading', async () => {
    const pA = selectStarAndFetchCurve(star('KIC_A'))
    const pB = selectStarAndFetchCurve(star('KIC_B'))
    // A (stale) resolves first, while B is still in flight.
    stub.resolve('KIC_A', lightcurveJson(111))
    await pA
    let s = useStore.getState()
    assert.equal(s.lightcurve, null, 'stale data must not appear under the newer star')
    assert.equal(s.lightcurveLoading, true, 'stale finally must not hide the newer fetch’s spinner')
    stub.resolve('KIC_B', lightcurveJson(222))
    await pB
    s = useStore.getState()
    assert.equal(s.lightcurve?.times[0], 222)
    assert.equal(s.lightcurveLoading, false)
  })

  it('only the winning selection posts to the pattern cache', async () => {
    const pA = selectStarAndFetchCurve(star('KIC_A'))
    const pB = selectStarAndFetchCurve(star('KIC_B'))
    stub.resolve('KIC_B', lightcurveJson(222))
    await pB
    stub.resolve('KIC_A', lightcurveJson(111))
    await pA
    await tick()
    assert.equal(stub.patternCachePosts.length, 1)
    assert.match(stub.patternCachePosts[0], /KIC_B/)
  })
})
