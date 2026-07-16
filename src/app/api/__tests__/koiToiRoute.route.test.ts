/**
 * @description Route-level tests for the KOI and TOI catalog handlers —
 * exercising the ACTUAL `GET` route functions (not just the
 * `catalogCache.ts` helper) to pin the TTL + stale-while-revalidate
 * wiring end to end:
 *   - a FRESH cache entry is served straight from disk with no TAP fetch
 *     and no `stale` flag;
 *   - a STALE entry (past the route's TTL) is served immediately WITH
 *     `stale: true` while a background TAP refresh fires (deduped);
 *   - the two routes' different TTLs are each respected — an entry aged
 *     between 24 h and 7 days is STALE for TOI (24 h TTL) but still FRESH
 *     for KOI (7-day TTL).
 *
 * The routes hardcode their cache file path under the OS temp dir; these
 * tests write that exact file with a controlled `fetchedAt`, stub
 * `globalThis.fetch`, and back up / restore any pre-existing cache so the
 * developer's real cache is untouched.
 *
 * Run via `npm run test:routes` (uses the route-test resolver, which maps
 * `@/…` and shims `next/server`).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GET as koiGET } from '@/app/api/koi/route'
import { GET as toiGET } from '@/app/api/toi/route'

const CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')
const KOI_FILE = path.join(CACHE_DIR, 'koi-catalog.json')
const TOI_FILE = path.join(CACHE_DIR, 'toi-catalog.json')

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

/** @description A minimal KOI cache row (only the fields the route reads back verbatim). */
const KOI_ROW = { id: 'KIC1', name: 'K00001.01', ra: 290, dec: 44, disposition: 'CONFIRMED', period: 3, depth: 500, duration: 4, score: 0.9 }
/** @description A minimal TOI cache row. */
const TOI_ROW = { id: 'TIC1', name: 'TOI 1.01', ra: 100, dec: -20, disposition: 'PC', period: 5, depth: 800, duration: 3, magnitude: 10 }

/** @description Saves a file's contents (or null if absent) for later restore. */
async function backup(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** @description Restores (or deletes) a file to a previously backed-up state. */
async function restore(file: string, saved: string | null): Promise<void> {
  if (saved === null) {
    await fs.rm(file, { force: true })
  } else {
    await fs.writeFile(file, saved, 'utf8')
  }
}

/** @description Writes a cache file with rows and an explicit fetchedAt age. */
async function writeCache(file: string, rows: unknown[], ageMs: number): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true })
  await fs.writeFile(file, JSON.stringify({ fetchedAt: Date.now() - ageMs, rows }), 'utf8')
}

/**
 * @description Fetch stub that records whether it was called and returns a
 * fresh TAP-shaped payload. KOI TAP returns an array of row objects; the
 * route's `fetchFromTap` parses those. For these tests we only care
 * WHETHER a background refresh fired, so a small valid payload suffices.
 */
class FetchRecorder {
  called = 0
  private original = globalThis.fetch
  install(rows: unknown[]): void {
    this.called = 0
    globalThis.fetch = (async () => {
      this.called++
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  }
  restore(): void {
    globalThis.fetch = this.original
  }
}

/** @description Yields to the microtask/timer queue so a fire-and-forget background refresh can settle. */
async function settle(): Promise<void> {
  await new Promise(r => setTimeout(r, 20))
}

let savedKoi: string | null = null
let savedToi: string | null = null
const fetchStub = new FetchRecorder()

before(async () => {
  savedKoi = await backup(KOI_FILE)
  savedToi = await backup(TOI_FILE)
})
after(async () => {
  await restore(KOI_FILE, savedKoi)
  await restore(TOI_FILE, savedToi)
})
beforeEach(() => {
  // TAP row objects the routes can parse into ≥1 row (so a refresh "succeeds").
  fetchStub.install([
    { kepid: 2, kepoi_name: 'K00002.01', ra: 291, dec: 45, koi_disposition: 'CONFIRMED', koi_period: 4, koi_depth: 600, koi_duration: 3, koi_score: 0.8 },
    { tid: 2, toi: '2.01', ra: 101, dec: -21, tfopwg_disp: 'PC', pl_orbper: 6, pl_trandep: 900, pl_trandurh: 2, st_tmag: 11 },
  ])
})
afterEach(async () => {
  await settle() // let any background revalidation finish before the next test swaps the cache
  fetchStub.restore()
})

describe('KOI route — TTL + stale-while-revalidate', () => {
  it('serves a FRESH cache entry from disk with no TAP fetch and no stale flag', async () => {
    await writeCache(KOI_FILE, [KOI_ROW], 1 * HOUR) // 1h old ≪ 7-day TTL
    const res = await koiGET()
    const body = await res.json()
    assert.equal(body.source, 'cached')
    assert.equal(body.rows.length, 1)
    assert.equal(body.stale, undefined, 'a fresh entry is not flagged stale')
    assert.equal(fetchStub.called, 0, 'no background refresh for a fresh entry')
  })

  it('serves a STALE entry immediately with stale:true and fires a background refresh', async () => {
    await writeCache(KOI_FILE, [KOI_ROW], 10 * DAY) // 10d old > 7-day TTL
    const res = await koiGET()
    const body = await res.json()
    assert.equal(body.source, 'cached')
    assert.equal(body.stale, true, 'past-TTL entry is flagged stale')
    assert.equal(body.rows.length, 1, 'stale data is still served immediately')
    await settle()
    assert.equal(fetchStub.called, 1, 'exactly one background TAP refresh fired')
  })
})

describe('TOI route — TTL + stale-while-revalidate', () => {
  it('serves a FRESH cache entry from disk with no TAP fetch and no stale flag', async () => {
    await writeCache(TOI_FILE, [TOI_ROW], 1 * HOUR) // 1h old ≪ 24h TTL
    const res = await toiGET()
    const body = await res.json()
    assert.equal(body.source, 'cached')
    assert.equal(body.stale, undefined)
    assert.equal(fetchStub.called, 0)
  })

  it('serves a STALE entry immediately with stale:true and fires a background refresh', async () => {
    await writeCache(TOI_FILE, [TOI_ROW], 2 * DAY) // 2d old > 24h TTL
    const res = await toiGET()
    const body = await res.json()
    assert.equal(body.source, 'cached')
    assert.equal(body.stale, true)
    await settle()
    assert.equal(fetchStub.called, 1)
  })
})

describe('the two routes honor DIFFERENT TTLs (7 days vs 24 hours)', () => {
  it('an entry aged 3 days is FRESH for KOI (7-day TTL) but STALE for TOI (24h TTL)', async () => {
    // Write BOTH caches at the same 3-day age.
    await writeCache(KOI_FILE, [KOI_ROW], 3 * DAY)
    await writeCache(TOI_FILE, [TOI_ROW], 3 * DAY)

    const koiBody = await (await koiGET()).json()
    assert.equal(koiBody.stale, undefined, 'KOI: 3 days < 7-day TTL → fresh')

    const toiBody = await (await toiGET()).json()
    assert.equal(toiBody.stale, true, 'TOI: 3 days > 24h TTL → stale')
  })
})
