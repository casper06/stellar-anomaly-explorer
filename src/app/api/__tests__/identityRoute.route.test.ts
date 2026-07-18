/**
 * @description Route-level tests for the SIMBAD identity handler —
 * exercising the ACTUAL `GET` function to pin the cache/TTL wiring
 * end to end:
 *   - a FRESH entry (< 30-day TTL) is served from disk with no SIMBAD
 *     fetch;
 *   - an EXPIRED entry triggers a live refetch; success rewrites the
 *     cache and serves `real`;
 *   - an EXPIRED entry + fetch FAILURE serves the expired entry with
 *     `stale: true` (graceful degradation);
 *   - no cache + fetch failure → `unavailable`;
 *   - a MISS (SIMBAD empty data) is cached as `identity: null` and the
 *     next request is served from disk without a fetch;
 *   - a schema-version-mismatched entry is refetched even when fresh,
 *     and is NEVER served as the stale fallback;
 *   - an unsafe id is rejected 400 before any network or disk touch.
 *
 * The route hardcodes its per-star cache file under the OS temp dir;
 * tests write that exact file with a controlled `fetchedAt`, stub
 * `globalThis.fetch` with the FROZEN real KIC8462852 fixture, and back
 * up / restore any pre-existing cache.
 *
 * Run via `npm run test:routes` (route-test resolver: `@/…` alias +
 * `next/server` shim).
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GET } from '@/app/api/identity/[id]/route'

const CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')
const STAR = 'KIC8462852'
const CACHE_FILE = path.join(CACHE_DIR, `identity-${STAR}.json`)

const DAY = 24 * 3600 * 1000

/** @description The frozen real SIMBAD TAP body for Tabby's Star. */
const TABBY_BODY = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'lib', '__tests__', 'fixtures', 'simbad', `${STAR}.json`), 'utf8'),
).response

/** @description A structurally valid SIMBAD response with zero rows (a miss). */
const MISS_BODY = { metadata: TABBY_BODY.metadata, data: [] }

/**
 * @description Invokes the route handler for one star id.
 * @param id Star id path segment.
 * @returns Parsed JSON body and HTTP status.
 */
async function call(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET(new Request('http://localhost/api/identity/' + id), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}

/** @description Writes the route's cache file with a controlled age and version. */
async function writeCache(identity: unknown, ageMs: number, schemaVersion = 1): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true })
  await fs.writeFile(CACHE_FILE, JSON.stringify({ schemaVersion, fetchedAt: Date.now() - ageMs, identity }), 'utf8')
}

/** @description Fetch stub: counts calls; serves a fixed body or rejects. */
class FetchStub {
  called = 0
  private original = globalThis.fetch
  install(body: unknown | 'fail'): void {
    this.called = 0
    globalThis.fetch = (async () => {
      this.called++
      if (body === 'fail') throw new Error('simulated network failure')
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
  }
  restore(): void {
    globalThis.fetch = this.original
  }
}

const fetchStub = new FetchStub()
let saved: string | null = null

before(async () => {
  try {
    saved = await fs.readFile(CACHE_FILE, 'utf8')
  } catch {
    saved = null
  }
})
after(async () => {
  if (saved === null) await fs.rm(CACHE_FILE, { force: true })
  else await fs.writeFile(CACHE_FILE, saved, 'utf8')
})
afterEach(async () => {
  fetchStub.restore()
  await fs.rm(CACHE_FILE, { force: true })
})

describe('identity route — cache + TTL + fallback wiring', () => {
  it('serves a FRESH entry from disk with no SIMBAD fetch', async () => {
    await writeCache({ mainId: 'TYC 3162-665-1', otype: '*', ra: 1, dec: 2, kic: '8462852', tic: null, epic: null, hip: null, gaiaDr3: null, twoMass: null, tycho: null, commonNames: [], allIds: [] }, 1 * DAY)
    fetchStub.install(TABBY_BODY)
    const { body } = await call(STAR)
    assert.equal(body.source, 'cached')
    assert.equal((body.identity as Record<string, unknown>).kic, '8462852')
    assert.equal(body.stale, undefined)
    assert.equal(fetchStub.called, 0)
  })

  it('refetches an EXPIRED entry, rewrites the cache, serves real', async () => {
    await writeCache(null, 40 * DAY) // 40d > 30-day TTL
    fetchStub.install(TABBY_BODY)
    const { body } = await call(STAR)
    assert.equal(body.source, 'real')
    assert.equal(fetchStub.called, 1)
    const identity = body.identity as Record<string, unknown>
    assert.equal(identity.mainId, 'TYC 3162-665-1')
    assert.equal(identity.tic, '185336364')
    // Cache was rewritten with a fresh fetchedAt.
    const onDisk = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))
    assert.ok(Date.now() - onDisk.fetchedAt < 60_000, 'cache fetchedAt is fresh')
    assert.equal(onDisk.identity.mainId, 'TYC 3162-665-1')
  })

  it('serves an EXPIRED entry with stale:true when the live refetch fails', async () => {
    const expired = { mainId: 'TYC 3162-665-1', otype: '*', ra: 1, dec: 2, kic: '8462852', tic: null, epic: null, hip: null, gaiaDr3: null, twoMass: null, tycho: null, commonNames: [], allIds: [] }
    await writeCache(expired, 40 * DAY)
    fetchStub.install('fail')
    const { body } = await call(STAR)
    assert.equal(body.source, 'cached')
    assert.equal(body.stale, true)
    assert.ok(body.error, 'failure reason is surfaced')
    assert.equal((body.identity as Record<string, unknown>).kic, '8462852')
  })

  it('returns unavailable when there is no cache and the fetch fails', async () => {
    fetchStub.install('fail')
    const { body } = await call(STAR)
    assert.equal(body.source, 'unavailable')
    assert.equal(body.identity, null)
    assert.ok(body.error)
  })

  it('caches a MISS (identity:null) and serves the second request from disk', async () => {
    fetchStub.install(MISS_BODY)
    const first = await call(STAR)
    assert.equal(first.body.source, 'real')
    assert.equal(first.body.identity, null, 'SIMBAD consulted, object unknown')
    assert.equal(fetchStub.called, 1)
    const second = await call(STAR)
    assert.equal(second.body.source, 'cached')
    assert.equal(second.body.identity, null)
    assert.equal(fetchStub.called, 1, 'miss was served from cache, no second query')
  })

  it('treats a schema-version mismatch as a miss (refetch even when fresh, never the stale fallback)', async () => {
    await writeCache({ mainId: 'old-shape' }, 1 * DAY, 0) // fresh but v0
    fetchStub.install(TABBY_BODY)
    const { body } = await call(STAR)
    assert.equal(body.source, 'real', 'mismatched entry refetched despite being fresh')
    assert.equal(fetchStub.called, 1)

    // And a mismatched entry must NOT be served when the refetch fails.
    await writeCache({ mainId: 'old-shape' }, 1 * DAY, 0)
    fetchStub.install('fail')
    const failed = await call(STAR)
    assert.equal(failed.body.source, 'unavailable', 'v0 entry is not a usable fallback')
  })

  it('rejects an unsafe id with 400 before any fetch', async () => {
    fetchStub.install(TABBY_BODY)
    const { status, body } = await call('KIC1/../evil')
    assert.equal(status, 400)
    assert.equal(body.source, 'unavailable')
    assert.equal(fetchStub.called, 0)
  })
})
