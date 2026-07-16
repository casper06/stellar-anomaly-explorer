/**
 * @description Route-level test for the lightcurve disk cache's
 * CACHE_SCHEMA_VERSION guard — exercising the ACTUAL
 * `GET /api/lightcurve/[id]` handler (not just a helper). Confirms that:
 *   - a disk-cache entry stamped with an OLD schema version is treated as
 *     a MISS: the route does NOT serve its arrays and instead falls
 *     through to a network refetch (observed via a stubbed `fetch`);
 *   - a disk-cache entry stamped with the CURRENT schema version (and
 *     complete segment coverage) IS served as a HIT with `source: 'real'`
 *     and its exact arrays, with NO network fetch.
 *
 * The route hardcodes its cache dir under the OS temp dir and keys entries
 * `"<id>|<mission>"` → `<sanitized>.json`. The test writes those files
 * directly, uses a UNIQUE star id per case (the route also has an
 * in-process L1 cache that would otherwise mask disk behavior across
 * cases), stubs `fetch`, and cleans up the files afterward.
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
