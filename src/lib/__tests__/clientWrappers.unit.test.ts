/**
 * @description Unit tests for the thin browser-side wrappers:
 * `classifyAsync`, `identityClient`, `centroidClient`.
 *
 * These three share one contract worth testing together: each collapses
 * EVERY failure mode to a documented safe value and never throws. They
 * are called from render/selection paths where an unhandled rejection
 * would break the UI, so "returns null" and "returns an error payload"
 * are load-bearing behaviors rather than incidental ones.
 *
 * `classifyCurveAsync` additionally has two code paths that must agree:
 * the Web Worker path (browser) and the direct-call fallback (Node,
 * plus any worker failure). `Worker` is stubbed on `globalThis` to
 * exercise both without a browser.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCurveAsync } from '../classifyAsync.ts'
import { classifyCurve } from '../curveClassifier.ts'
import { detectDips } from '../anomalyDetector.ts'
import { fetchIdentity, fetchIdentityByName } from '../identityClient.ts'
import { fetchCentroidVet } from '../centroidClient.ts'
import type { BlsResult } from '../bls.ts'

const realFetch = globalThis.fetch
const realConsoleError = console.error
/** @description `Worker` is absent in Node; captured so stubs can be undone. */
const realWorker = (globalThis as { Worker?: unknown }).Worker

/**
 * @description Builds a light curve with repeating dips so the
 * classifier produces a non-trivial, deterministic profile.
 * @returns times/flux/dips ready for classification.
 */
function sample(): { times: number[]; flux: number[]; dips: ReturnType<typeof detectDips> } {
  const times: number[] = []
  const flux: number[] = []
  for (let i = 0; i < 600; i++) {
    times.push(i * 0.02)
    flux.push(i % 50 < 3 ? 0.97 : 1)
  }
  return { times, flux, dips: detectDips(flux, times) }
}

/**
 * @description Stubs `globalThis.fetch` with a fixed outcome.
 * @param outcome `'throw'`, an HTTP status, `'bad-json'`, or a JSON body.
 */
function stubFetch(outcome: 'throw' | 'bad-json' | number | Record<string, unknown>): void {
  globalThis.fetch = (async () => {
    if (outcome === 'throw') throw new Error('simulated network failure')
    if (outcome === 'bad-json') {
      return new Response('<html>not json</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }
    if (typeof outcome === 'number') return new Response('upstream down', { status: outcome })
    return new Response(JSON.stringify(outcome), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

before(() => { console.error = () => {} })
after(() => {
  globalThis.fetch = realFetch
  console.error = realConsoleError
})
afterEach(() => {
  globalThis.fetch = realFetch
  if (realWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker
  else (globalThis as { Worker?: unknown }).Worker = realWorker
})

describe('classifyCurveAsync — worker unavailable (Node path)', () => {
  it('falls back to a direct call and matches classifyCurve exactly', async () => {
    assert.equal(typeof (globalThis as { Worker?: unknown }).Worker, 'undefined', 'no Worker in Node')
    const { times, flux, dips } = sample()
    const viaAsync = await classifyCurveAsync(times, flux, dips)
    assert.deepEqual(viaAsync, classifyCurve(times, flux, dips))
  })

  it('resolves rather than rejecting on an empty curve', async () => {
    const profile = await classifyCurveAsync([], [], [])
    assert.ok(profile, 'a profile object is still produced')
    assert.deepEqual(profile, classifyCurve([], [], []))
  })
})

describe('classifyCurveAsync — worker available', () => {
  /**
   * @description Installs a fake `Worker` class.
   * @param behavior How the fake worker should respond.
   */
  function stubWorker(behavior: 'message' | 'error' | 'construct-throws'): { terminated: number } {
    const stats = { terminated: 0 }
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null
      onerror: (() => void) | null = null
      constructor() {
        if (behavior === 'construct-throws') throw new Error('spawn blocked (CSP)')
      }
      postMessage(payload: { times: number[]; flux: number[]; dips: unknown[] }): void {
        // Reply asynchronously, as a real worker does.
        setTimeout(() => {
          if (behavior === 'error') this.onerror?.()
          else {
            // A real worker runs the SAME classifier, so mirror that
            // rather than inventing a shape the app never receives.
            this.onmessage?.({
              data: classifyCurve(payload.times, payload.flux, payload.dips as never),
            })
          }
        }, 0)
      }
      terminate(): void { stats.terminated++ }
    }
    ;(globalThis as { Worker?: unknown }).Worker = FakeWorker
    return stats
  }

  it('uses the worker result when the worker replies', async () => {
    const stats = stubWorker('message')
    const { times, flux, dips } = sample()
    const profile = await classifyCurveAsync(times, flux, dips)
    assert.deepEqual(profile, classifyCurve(times, flux, dips))
    assert.equal(stats.terminated, 1, 'worker is terminated, not leaked')
  })

  it('falls back inline when the worker errors — same result, different thread', async () => {
    const stats = stubWorker('error')
    const { times, flux, dips } = sample()
    const profile = await classifyCurveAsync(times, flux, dips)
    assert.deepEqual(profile, classifyCurve(times, flux, dips), 'fallback matches the worker path')
    assert.equal(stats.terminated, 1)
  })

  it('falls back inline when the worker cannot even be constructed', async () => {
    stubWorker('construct-throws')
    const { times, flux, dips } = sample()
    const profile = await classifyCurveAsync(times, flux, dips)
    assert.deepEqual(profile, classifyCurve(times, flux, dips))
  })
})

describe('fetchIdentity — every failure collapses to null', () => {
  it('returns the identity on success', async () => {
    const identity = { mainId: 'TYC 3162-665-1', kic: '8462852', commonNames: ["Boyajian's Star"] }
    stubFetch({ source: 'real', identity })
    assert.deepEqual(await fetchIdentity('KIC8462852'), identity as never)
  })

  it('returns null on a confirmed SIMBAD miss', async () => {
    stubFetch({ source: 'real', identity: null })
    assert.equal(await fetchIdentity('KIC999'), null)
  })

  it('returns null on a non-ok HTTP status', async () => {
    stubFetch(500)
    assert.equal(await fetchIdentity('KIC1'), null)
  })

  it('returns null on a thrown network error', async () => {
    stubFetch('throw')
    assert.equal(await fetchIdentity('KIC1'), null)
  })

  it('returns null when the body is not JSON', async () => {
    stubFetch('bad-json')
    assert.equal(await fetchIdentity('KIC1'), null)
  })

  it('returns null when the body lacks an identity field', async () => {
    stubFetch({ unexpected: true })
    assert.equal(await fetchIdentity('KIC1'), null)
  })
})

describe('fetchIdentityByName — keeps a miss distinct from an outage', () => {
  it('returns the identity on a hit', async () => {
    const identity = { mainId: 'M 31', kic: null }
    stubFetch({ source: 'real', identity })
    assert.deepEqual(await fetchIdentityByName('M31'), identity as never)
  })

  it('returns null (not error) for a confirmed miss', async () => {
    stubFetch({ source: 'real', identity: null })
    assert.equal(await fetchIdentityByName('zzznotastar'), null)
  })

  it("returns 'error' when the route reports it could not ask", async () => {
    // The distinction the search box needs: "SIMBAD doesn't know that
    // name" vs "we couldn't reach SIMBAD" get different UI copy, and
    // reporting our own outage as the user's typo would be a lie.
    stubFetch({ source: 'unavailable', identity: null })
    assert.equal(await fetchIdentityByName('anything'), 'error')
  })

  it("returns 'error' on HTTP failure, a thrown error, or non-JSON", async () => {
    stubFetch(503)
    assert.equal(await fetchIdentityByName('x'), 'error')
    stubFetch('throw')
    assert.equal(await fetchIdentityByName('x'), 'error')
    stubFetch('bad-json')
    assert.equal(await fetchIdentityByName('x'), 'error')
  })

  it('returns null for empty/whitespace input without hitting the network', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response('{}') }) as typeof fetch
    assert.equal(await fetchIdentityByName('   '), null)
    assert.equal(called, false, 'no query is spent on empty input')
  })
})

describe('fetchCentroidVet — every failure becomes an error payload, never a throw', () => {
  const bls: BlsResult = {
    periodDays: 2.1718,
    epochDays: 133.2,
    durationHours: 3.4,
    depthPpm: 1200,
    sde: 12.3,
  } as BlsResult

  it('passes a well-formed route payload through', async () => {
    const payload = { status: 'measured', offsetArcsec: 0.12, sigma: 1.1 }
    stubFetch(payload)
    assert.deepEqual(await fetchCentroidVet('KIC4275739', bls), payload as never)
  })

  it('sends period/epoch/duration as query params', async () => {
    let seen = ''
    globalThis.fetch = (async (url: string) => {
      seen = String(url)
      return new Response(JSON.stringify({ status: 'measured' }), { status: 200 })
    }) as typeof fetch
    await fetchCentroidVet('KIC4275739', bls)
    const u = new URL(seen, 'http://localhost')
    assert.equal(u.pathname, '/api/centroid/KIC4275739')
    assert.equal(u.searchParams.get('period'), '2.1718')
    assert.equal(u.searchParams.get('epoch'), '133.2')
    assert.equal(u.searchParams.get('duration'), '3.4')
  })

  it('returns an error payload on a thrown network failure', async () => {
    stubFetch('throw')
    const r = await fetchCentroidVet('KIC1', bls)
    assert.equal(r.status, 'error')
    assert.ok('message' in r && r.message.length > 0, 'carries a human-readable reason')
  })

  it('returns an error payload when the body is not JSON', async () => {
    stubFetch('bad-json')
    assert.equal((await fetchCentroidVet('KIC1', bls)).status, 'error')
  })

  it('returns an error payload for a well-formed body with no status field', async () => {
    stubFetch({ unexpected: 'shape' })
    const r = await fetchCentroidVet('KIC1', bls)
    assert.equal(r.status, 'error')
    assert.match((r as { message: string }).message, /malformed/i)
  })

  it('returns an error payload for a null JSON body', async () => {
    stubFetch(null as unknown as Record<string, unknown>)
    assert.equal((await fetchCentroidVet('KIC1', bls)).status, 'error')
  })
})
