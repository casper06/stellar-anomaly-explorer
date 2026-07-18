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
  private pendingIdentity = new Map<string, (json: unknown) => void>()
  patternCachePosts: string[] = []
  install(): void {
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.startsWith('/api/pattern-cache')) {
        this.patternCachePosts.push(String(init?.body ?? ''))
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      // Identity resolves on its own deferred track — it runs CONCURRENTLY
      // with the lightcurve (SIMBAD ~1s vs a MAST cold path ~60s), so the
      // tests must be able to land the two in either order.
      if (u.startsWith('/api/identity/')) {
        const id = decodeURIComponent(u.split('/api/identity/')[1]?.split('?')[0] ?? '')
        return new Promise<Response>(resolve => {
          this.pendingIdentity.set(id, (json) => resolve(new Response(JSON.stringify(json), { status: 200 })))
        })
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
  /** Resolves the in-flight identity fetch for `id` with `json`. */
  resolveIdentity(id: string, json: unknown): void {
    const r = this.pendingIdentity.get(id)
    assert.ok(r, `no pending identity fetch for ${id}`)
    this.pendingIdentity.delete(id)
    r(json)
  }
  /** True when an identity fetch for `id` is still outstanding. */
  hasPendingIdentity(id: string): boolean {
    return this.pendingIdentity.has(id)
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
    identity: null,
    identityLoading: false,
    resolvedIdentities: new Map(),
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

describe('identity resolution during selection (phase B3)', () => {
  /** @description /api/identity payload with one common name. */
  function identityJson(mainId: string, commonNames: string[]) {
    return {
      source: 'real',
      fetchedAt: Date.now(),
      identity: {
        mainId,
        otype: '*',
        ra: 290, dec: 44,
        kic: null, tic: null, epic: null, hip: null,
        gaiaDr3: null, twoMass: null, tycho: null,
        commonNames,
        allIds: [mainId, ...commonNames],
      },
    }
  }

  it('resolves concurrently with the light curve, not behind it', async () => {
    const p = selectStarAndFetchCurve(star('KIC8462852'))
    assert.equal(useStore.getState().identityLoading, true)

    // Identity lands FIRST, while the (slow) MAST fetch is still in
    // flight — the whole point of not awaiting it inside the curve path.
    stub.resolveIdentity('KIC8462852', identityJson('TYC 3162-665-1', ["Boyajian's Star"]))
    await tick()
    assert.equal(useStore.getState().identityLoading, false)
    assert.equal(useStore.getState().identity?.mainId, 'TYC 3162-665-1')
    assert.equal(useStore.getState().lightcurveLoading, true, 'curve still loading')

    stub.resolve('KIC8462852', lightcurveJson(111))
    await p
    assert.equal(useStore.getState().identity?.mainId, 'TYC 3162-665-1', 'survives the curve landing')
  })

  it('a resolved identity becomes searchable via resolvedIdentities', async () => {
    const p = selectStarAndFetchCurve(star('KIC8462852'))
    stub.resolveIdentity('KIC8462852', identityJson('TYC 3162-665-1', ["Boyajian's Star"]))
    stub.resolve('KIC8462852', lightcurveJson(111))
    await p
    const entry = useStore.getState().resolvedIdentities.get('KIC8462852')
    assert.deepEqual(entry?.commonNames, ["Boyajian's Star"])
  })

  it('a stale identity response never overwrites a newer selection', async () => {
    // Star A selected, then superseded by B before A's SIMBAD reply lands.
    const pA = selectStarAndFetchCurve(star('KIC_A'))
    const pB = selectStarAndFetchCurve(star('KIC_B'))

    stub.resolveIdentity('KIC_B', identityJson('MAIN-B', ['Bee']))
    await tick()
    assert.equal(useStore.getState().identity?.mainId, 'MAIN-B')

    // A's late reply must be discarded — it belongs to a dead selection.
    stub.resolveIdentity('KIC_A', identityJson('MAIN-A', ['Ay']))
    await tick()
    assert.equal(useStore.getState().identity?.mainId, 'MAIN-B', 'stale identity discarded')

    // But A's names are still legitimately indexed for search: the star
    // WAS resolved, it just isn't the selected one anymore. Discarding
    // them would throw away a SIMBAD query we already paid for.
    assert.ok(useStore.getState().resolvedIdentities.has('KIC_A'))
    assert.deepEqual(useStore.getState().resolvedIdentities.get('KIC_A')?.commonNames, ['Ay'])
    // ...and indexing it must not have disturbed the displayed identity.
    assert.equal(useStore.getState().identity?.mainId, 'MAIN-B')

    stub.resolve('KIC_A', lightcurveJson(1))
    stub.resolve('KIC_B', lightcurveJson(2))
    await Promise.all([pA, pB])
  })

  it('a stale identity does not clear the newer selection’s loading flag', async () => {
    const pA = selectStarAndFetchCurve(star('KIC_A'))
    const pB = selectStarAndFetchCurve(star('KIC_B'))

    // A resolves late while B is still asking SIMBAD. If A were allowed
    // to clear the flag, the panel would stop showing "resolving" while
    // B's lookup is genuinely still in flight.
    stub.resolveIdentity('KIC_A', identityJson('MAIN-A', ['Ay']))
    await tick()
    assert.equal(useStore.getState().identityLoading, true, 'B is still resolving')
    assert.ok(stub.hasPendingIdentity('KIC_B'))

    stub.resolveIdentity('KIC_B', identityJson('MAIN-B', ['Bee']))
    await tick()
    assert.equal(useStore.getState().identityLoading, false)

    stub.resolve('KIC_A', lightcurveJson(1))
    stub.resolve('KIC_B', lightcurveJson(2))
    await Promise.all([pA, pB])
  })

  it('a SIMBAD miss clears the slot and stays silent', async () => {
    const p = selectStarAndFetchCurve(star('KIC_UNKNOWN'))
    // Route's "consulted, object unknown" answer.
    stub.resolveIdentity('KIC_UNKNOWN', { source: 'real', fetchedAt: Date.now(), identity: null })
    await tick()
    assert.equal(useStore.getState().identity, null)
    assert.equal(useStore.getState().identityLoading, false, 'not stuck resolving')
    assert.equal(useStore.getState().resolvedIdentities.size, 0, 'nothing indexed for a miss')

    stub.resolve('KIC_UNKNOWN', lightcurveJson(1))
    await p
  })
})
