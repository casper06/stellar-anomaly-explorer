/**
 * @description Route-level tests for `GET /api/lightcurve/[id]` —
 * exercising the ACTUAL handler (not just a helper). Two groups:
 *
 * 1. The disk cache's CACHE_SCHEMA_VERSION guard. Confirms that a
 *    disk-cache entry stamped with an OLD schema version is treated as a
 *    MISS (the route does NOT serve its arrays and instead falls through
 *    to a network refetch, observed via a stubbed `fetch`), while an entry
 *    stamped with the CURRENT version and complete segment coverage IS
 *    served as a HIT with `source: 'real'` and its exact arrays, with NO
 *    network fetch.
 *
 * 2. The failure-`reason` contract (issue #18). The route used to discard
 *    WHY a fetch failed, so a 429 and a genuine coverage gap both rendered
 *    as "not observed by Kepler or TESS". These cases pin that a 429
 *    surfaces `'rate-limited'`, an empty-but-successful listing surfaces
 *    `'no-coverage'`, a listing with rows but no PDC product surfaces
 *    `'no-product'`, and other transport failures surface
 *    `'fetch-error'` — all distinct.
 *
 *    The `no-coverage` / `no-product` split matters for user-facing
 *    precision: only an EMPTY listing proves neither mission pointed at
 *    the star. Rows-without-a-light-curve means it WAS observed, so the
 *    panel must not claim non-observation.
 *
 * The route hardcodes its cache dir under the OS temp dir and keys entries
 * `"<id>|<mission>"` → `<sanitized>.json`. The test writes those files
 * directly, uses a UNIQUE star id per case (the route also has an
 * in-process L1 cache that would otherwise mask disk behavior across
 * cases), stubs `fetch`, and cleans up the files afterward.
 *
 * ALL network is stubbed — `globalThis.fetch` is replaced per-case, so no
 * case reaches MAST. Reason classification is driven purely by the
 * synthetic status codes / bodies the stubs return.
 *
 * Run via `npm run test:routes` (route-test resolver: maps `@/…`,
 * shims `next/server`).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GET as lightcurveGET } from '@/app/api/lightcurve/[id]/route'

const CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')

/** @description The route's CACHE_SCHEMA_VERSION at time of writing (mirrored — must match the route constant). */
const CURRENT_SCHEMA_VERSION = 2
const OLD_SCHEMA_VERSION = 1

/** @description Cache file path for a `"<id>|<mission>"` key, matching the route's sanitizer. */
function cacheFileFor(id: string, mission: string): string {
  const key = `${id}|${mission}`
  const safe = key.replace(/[^A-Za-z0-9_-]/g, '_')
  return path.join(CACHE_DIR, `${safe}.json`)
}

/** @description Writes a lightcurve disk-cache entry with an explicit schema version and complete coverage. */
async function writeEntry(id: string, mission: string, schemaVersion: number): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true })
  const times = Array.from({ length: 20 }, (_, i) => 100 + i * 0.02)
  const flux = times.map(() => 1.0)
  const entry = {
    schemaVersion,
    fetchedAt: new Date().toISOString(),
    sampleCount: times.length,
    segmentFiles: ['seg-a_llc.fits'],
    expectedSegments: 1, // complete (not partial) so the read isn't rejected for coverage
    times,
    flux,
  }
  await fs.writeFile(cacheFileFor(id, mission), JSON.stringify(entry), 'utf8')
}

/** @description Builds a Request for the route (no ra/dec, catalog-driven, not on-demand). */
function req(id: string): Request {
  return new Request(`http://localhost/api/lightcurve/${id}`)
}

/** @description Route ctx with the dynamic id param. */
function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

/** @description Fetch stub recording call count; returns a failing TAP response so the refetch path resolves to unavailable. */
class FetchRecorder {
  called = 0
  private original = globalThis.fetch
  install(): void {
    this.called = 0
    globalThis.fetch = (async () => {
      this.called++
      // 500 → tryFetchRealLightcurve treats the TAP query as failed → null → unavailable.
      return new Response('upstream down', { status: 500, statusText: 'err' })
    }) as typeof fetch
  }
  restore(): void {
    globalThis.fetch = this.original
  }
}

const createdFiles: string[] = []
const fetchStub = new FetchRecorder()
const savedNodeEnv = process.env.NODE_ENV

/** @description Sets NODE_ENV at runtime (its type is read-only, but it's a plain env var). */
function setNodeEnv(value: string | undefined): void {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

before(() => {
  // Force the production fallback (unavailable, not synthetic) so the
  // "old schema → refetch" case has a deterministic non-cached response.
  setNodeEnv('production')
})
after(async () => {
  setNodeEnv(savedNodeEnv)
  for (const f of createdFiles) await fs.rm(f, { force: true })
})
beforeEach(() => fetchStub.install())
afterEach(() => fetchStub.restore())

describe('lightcurve route — CACHE_SCHEMA_VERSION guard', () => {
  it('treats an OLD-schema-version disk entry as a miss and refetches (does not serve stale arrays)', async () => {
    const id = 'KIC900000001' // unique id → no L1 contamination
    const file = cacheFileFor(id, 'Kepler')
    createdFiles.push(file)
    await writeEntry(id, 'Kepler', OLD_SCHEMA_VERSION)

    const res = await lightcurveGET(req(id), ctx(id))
    const body = await res.json()

    assert.notEqual(body.source, 'real', 'an old-version entry must NOT be served as real cached data')
    assert.equal(body.source, 'unavailable', 'the refetch failed (stubbed 500) → unavailable, proving cache was bypassed')
    assert.deepEqual(body.times, [], 'no cached arrays leaked through')
    assert.ok(fetchStub.called >= 1, 'a network refetch was attempted (cache treated as a miss)')
  })

  it('serves a CURRENT-schema-version disk entry as a real hit with no network fetch', async () => {
    const id = 'KIC900000002' // different id → independent L1 slot + cache file
    const file = cacheFileFor(id, 'Kepler')
    createdFiles.push(file)
    await writeEntry(id, 'Kepler', CURRENT_SCHEMA_VERSION)

    const res = await lightcurveGET(req(id), ctx(id))
    const body = await res.json()

    assert.equal(body.source, 'real', 'a current-version complete entry is served as real')
    assert.equal(body.mission, 'Kepler')
    assert.equal(body.times.length, 20, 'the cached arrays are returned verbatim')
    assert.equal(body.partial, false, 'complete coverage → not partial')
    assert.equal(fetchStub.called, 0, 'a cache hit performs no network fetch')
  })
})

/**
 * @description Replaces `globalThis.fetch` with a stub returning a fixed
 * response, overriding the suite-wide 500 stub for one case. NO real
 * network is involved — the route's reason classification is driven
 * entirely by the status/body supplied here.
 * @param status HTTP status the fake MAST TAP endpoint returns.
 * @param body Response body text.
 * @returns A counter object whose `called` field tracks stub invocations.
 */
function stubFetchWith(status: number, body: string): { called: number } {
  const counter = { called: 0 }
  globalThis.fetch = (async () => {
    counter.called++
    return new Response(body, { status, statusText: status === 429 ? 'Too Many Requests' : 'stubbed' })
  }) as typeof fetch
  return counter
}

/** @description A well-formed but EMPTY MAST TAP listing (query succeeded, archive knows of nothing here). */
const EMPTY_TAP_LISTING = JSON.stringify({
  info: [{ name: 'obs_id' }, { name: 'access_url' }, { name: 'access_format' }],
  data: [],
})

/**
 * @description A well-formed MAST TAP listing that DOES carry observation
 * rows, none of which is a PDC light-curve product (here: a target-pixel
 * file and a full-frame image). The target was observed; there is just
 * nothing plottable — the `no-product` case, which must NOT be reported as
 * non-observation.
 */
const NO_PDC_TAP_LISTING = JSON.stringify({
  info: [{ name: 'obs_id' }, { name: 'access_url' }, { name: 'access_format' }],
  data: [
    ['kplr000000006_lpd-targ', 'https://archive.stsci.edu/x/kplr000000006_lpd-targ.fits.gz', 'application/fits'],
    ['kplr000000006_ffi', 'https://archive.stsci.edu/x/kplr000000006_ffi.fits', 'application/fits'],
  ],
})

describe('lightcurve route — unavailable failure reason (issue #18)', () => {
  it('surfaces reason "rate-limited" when MAST answers HTTP 429', async () => {
    const id = 'KIC900000003'
    const stub = stubFetchWith(429, 'rate limit exceeded')

    const res = await lightcurveGET(req(id), ctx(id))
    const body = await res.json()

    assert.equal(body.source, 'unavailable')
    assert.equal(body.reason, 'rate-limited', 'a 429 must be reported as throttling, not as a coverage gap')
    assert.notEqual(body.reason, 'no-coverage', 'a throttled request proves nothing about observation coverage')
    assert.ok(typeof body.error === 'string' && body.error.includes('429'), 'error detail names the status')
    assert.ok(stub.called >= 1, 'the stubbed TAP query ran (no real network)')
  })

  it('surfaces reason "no-coverage" when the TAP query succeeds with a fully EMPTY listing', async () => {
    const id = 'KIC900000004'
    const stub = stubFetchWith(200, EMPTY_TAP_LISTING)

    const res = await lightcurveGET(req(id), ctx(id))
    const body = await res.json()

    assert.equal(body.source, 'unavailable')
    assert.equal(
      body.reason,
      'no-coverage',
      'a successful query returning NO rows at all is the strongest confirmed absence',
    )
    assert.ok(stub.called >= 1, 'the stubbed TAP query ran (no real network)')
  })

  it('surfaces reason "no-product" when TAP returns rows but none is a PDC light curve', async () => {
    const id = 'KIC900000006'
    const stub = stubFetchWith(200, NO_PDC_TAP_LISTING)

    const res = await lightcurveGET(req(id), ctx(id))
    const body = await res.json()

    assert.equal(body.source, 'unavailable')
    assert.equal(
      body.reason,
      'no-product',
      'rows present but no PDC product means the star WAS observed — nothing to plot, not nothing there',
    )
    assert.notEqual(
      body.reason,
      'no-coverage',
      'reporting an observed target as "not observed" overstates what the listing proves',
    )
    assert.ok(
      typeof body.error === 'string' && body.error.includes('2'),
      'error detail names how many observation rows were listed',
    )
    assert.ok(stub.called >= 1, 'the stubbed TAP query ran (no real network)')
  })

  it('surfaces reason "fetch-error" for a non-429 upstream failure, distinct from both above', async () => {
    const id = 'KIC900000005'
    // The suite-wide stub already returns 500; assert it classifies as
    // indeterminate rather than as a coverage gap.
    const res = await lightcurveGET(req(id), ctx(id))
    const body = await res.json()

    assert.equal(body.source, 'unavailable')
    assert.equal(body.reason, 'fetch-error', 'a 500 leaves coverage unknown')
    assert.notEqual(body.reason, 'no-coverage', 'an upstream outage must never read as "not observed"')
    assert.ok(fetchStub.called >= 1, 'the stubbed TAP query ran (no real network)')
  })

  it('surfaces reason "fetch-error" when no mission id and no position were supplied (MAST never queried)', async () => {
    const id = 'HIP12345' // not KIC/TIC/numeric, and req() supplies no ra/dec
    const res = await lightcurveGET(req(id), ctx(id))
    const body = await res.json()

    assert.equal(body.source, 'unavailable')
    assert.equal(
      body.reason,
      'fetch-error',
      'never asking MAST cannot be reported as a confirmed coverage gap',
    )
    assert.equal(fetchStub.called, 0, 'no query is attempted without an id or a position')
  })
})
