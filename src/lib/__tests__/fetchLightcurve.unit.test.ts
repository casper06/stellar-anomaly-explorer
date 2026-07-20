/**
 * @description Unit tests for `fetchLightcurve`'s fallback branching
 * (`lib/anomalyDetector.ts`) — the client-side half of the project's
 * "no silent synthetic data" rule.
 *
 * The rule has two independent switches, and the interesting cases are
 * the combinations:
 *   - `onDemand` (set whenever the star id is not KIC/TIC/EPIC, i.e. the
 *     user clicked a Hipparcos background star) — NEVER synthesizes, in
 *     ANY environment.
 *   - `NODE_ENV === 'development'` — the only condition under which a
 *     synthetic curve may be produced at all, and then only for catalog
 *     stars.
 * A regression in either switch would put fabricated photometry in front
 * of a user badged as if it were real, so all four combinations are
 * pinned explicitly rather than by inference from two of them.
 *
 * Seams used (no production code was changed to make this testable):
 * `globalThis.fetch` is stubbed, and `process.env.NODE_ENV` is read at
 * call time by the function under test, so both are settable per test
 * and restored afterwards.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchLightcurve,
  SYNTHETIC_PROVENANCE,
  UNAVAILABLE_PROVENANCE,
  KEPLER_PROVENANCE,
} from '../anomalyDetector.ts'

const realFetch = globalThis.fetch
const realNodeEnv = process.env.NODE_ENV
/** @description Silences the intentional fallback console.error noise. */
const realConsoleError = console.error

/**
 * @description Sets (or clears) `NODE_ENV` for one test.
 *
 * Next.js's ambient types declare `process.env.NODE_ENV` as readonly,
 * so a direct assignment fails `tsc` even though it works at runtime —
 * which is exactly what the function under test reads. The cast is
 * confined to this one helper instead of being sprinkled across every
 * test, and the value is always restored in `afterEach`.
 * @param value Environment to simulate, or undefined to unset it.
 */
function setNodeEnv(value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>
  if (value === undefined) delete env.NODE_ENV
  else env.NODE_ENV = value
}

/** @description Captures the URLs the client requested, for assertion. */
let requested: string[] = []

/**
 * @description Stubs `globalThis.fetch` with a fixed outcome.
 * @param outcome `'throw'` (network error), a status number (HTTP
 * failure), or a body object to serve as a 200.
 */
function stubFetch(outcome: 'throw' | number | Record<string, unknown>): void {
  globalThis.fetch = ((url: string) => {
    requested.push(String(url))
    if (outcome === 'throw') return Promise.reject(new Error('simulated network failure'))
    if (typeof outcome === 'number') {
      return Promise.resolve(new Response('upstream down', { status: outcome }))
    }
    return Promise.resolve(
      new Response(JSON.stringify(outcome), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

/** @description A well-formed successful route response. */
const REAL_BODY = {
  times: [1, 2, 3],
  flux: [1, 0.99, 1],
  source: 'real',
  provenance: KEPLER_PROVENANCE,
  mission: 'Kepler',
  gapDays: 5,
}

before(() => { console.error = () => {} })
after(() => {
  globalThis.fetch = realFetch
  console.error = realConsoleError
  setNodeEnv(realNodeEnv)
})
afterEach(() => {
  globalThis.fetch = realFetch
  setNodeEnv(realNodeEnv)
  requested = []
})

describe('fetchLightcurve — success path', () => {
  it('passes a successful route response through UNCHANGED', () => {
    setNodeEnv('development')
    stubFetch(REAL_BODY)
    return fetchLightcurve('KIC8462852').then(r => {
      // Even in dev, a working route must never be second-guessed.
      assert.deepEqual(r, REAL_BODY)
      assert.equal(r.source, 'real')
    })
  })

  it('builds the request URL with ra/dec/onDemand query params', async () => {
    stubFetch(REAL_BODY)
    await fetchLightcurve('HIP12345', { ra: 301.5642, dec: 44.4567, onDemand: true })
    const url = new URL(requested[0], 'http://localhost')
    assert.equal(url.pathname, '/api/lightcurve/HIP12345')
    assert.equal(url.searchParams.get('ra'), '301.5642')
    assert.equal(url.searchParams.get('dec'), '44.4567')
    assert.equal(url.searchParams.get('onDemand'), '1')
  })

  it('omits non-finite coordinates rather than sending NaN', async () => {
    stubFetch(REAL_BODY)
    await fetchLightcurve('KIC1', { ra: NaN, dec: Infinity })
    const url = new URL(requested[0], 'http://localhost')
    assert.equal(url.searchParams.get('ra'), null)
    assert.equal(url.searchParams.get('dec'), null)
  })

  it('encodes the star id into the path', async () => {
    stubFetch(REAL_BODY)
    await fetchLightcurve('KIC 1/2')
    assert.ok(requested[0].startsWith('/api/lightcurve/KIC%201%2F2'), requested[0])
  })
})

describe('fetchLightcurve — dev + catalog star ⇒ synthetic allowed', () => {
  it('falls back to synthetic with synthetic provenance when the fetch throws', async () => {
    setNodeEnv('development')
    stubFetch('throw')
    const r = await fetchLightcurve('KIC8462852', { onDemand: false })
    assert.equal(r.source, 'synthetic')
    assert.deepEqual(r.provenance, SYNTHETIC_PROVENANCE)
    assert.ok(r.times.length > 0, 'synthetic curve carries samples')
    assert.equal(r.times.length, r.flux.length)
    assert.equal(r.mission, null, 'synthetic data claims no mission')
  })

  it('also falls back on a non-ok HTTP status (not just a thrown error)', async () => {
    setNodeEnv('development')
    stubFetch(500)
    const r = await fetchLightcurve('KIC8462852')
    assert.equal(r.source, 'synthetic')
  })

  it('treats a missing onDemand flag as not-on-demand', async () => {
    setNodeEnv('development')
    stubFetch('throw')
    const r = await fetchLightcurve('KIC8462852') // no opts at all
    assert.equal(r.source, 'synthetic')
  })
})

describe('fetchLightcurve — onDemand ⇒ NEVER synthetic, in any environment', () => {
  it('returns unavailable in DEVELOPMENT when onDemand is set', async () => {
    // The load-bearing case: dev is the only env that may synthesize,
    // and onDemand must override it. The user explicitly clicked a
    // background star; the UI promised real data or an honest "not
    // observed".
    setNodeEnv('development')
    stubFetch('throw')
    const r = await fetchLightcurve('HIP12345', { onDemand: true, ra: 10, dec: 20 })
    assert.equal(r.source, 'unavailable')
    assert.deepEqual(r.provenance, UNAVAILABLE_PROVENANCE)
    assert.deepEqual(r.times, [])
    assert.deepEqual(r.flux, [])
  })

  it('returns unavailable in PRODUCTION when onDemand is set', async () => {
    setNodeEnv('production')
    stubFetch('throw')
    const r = await fetchLightcurve('HIP12345', { onDemand: true })
    assert.equal(r.source, 'unavailable')
  })
})

describe('fetchLightcurve — production ⇒ never synthetic', () => {
  it('returns unavailable for a CATALOG star in production', async () => {
    setNodeEnv('production')
    stubFetch('throw')
    const r = await fetchLightcurve('KIC8462852', { onDemand: false })
    assert.equal(r.source, 'unavailable')
    assert.deepEqual(r.provenance, UNAVAILABLE_PROVENANCE)
    assert.deepEqual(r.times, [])
  })

  it('returns unavailable when NODE_ENV is unset (neither dev nor prod)', async () => {
    // Fail-closed: anything that is not literally 'development' must
    // not synthesize.
    setNodeEnv(undefined)
    stubFetch('throw')
    const r = await fetchLightcurve('KIC8462852')
    assert.equal(r.source, 'unavailable')
  })

  it('returns unavailable for a test-like NODE_ENV', async () => {
    setNodeEnv('test')
    stubFetch('throw')
    const r = await fetchLightcurve('KIC8462852')
    assert.equal(r.source, 'unavailable')
  })
})

describe('fetchLightcurve — provenance constants stay distinguishable', () => {
  it('never labels synthetic or unavailable data as a real mission product', () => {
    // The badge in the panel is driven off these; if two of them ever
    // collapsed to the same shape, DEV/SYNTHETIC could render as REAL.
    assert.notDeepEqual(SYNTHETIC_PROVENANCE, KEPLER_PROVENANCE)
    assert.notDeepEqual(UNAVAILABLE_PROVENANCE, KEPLER_PROVENANCE)
    assert.notDeepEqual(SYNTHETIC_PROVENANCE, UNAVAILABLE_PROVENANCE)
  })
})
