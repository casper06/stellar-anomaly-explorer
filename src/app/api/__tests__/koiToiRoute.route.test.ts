/**
 * @description Route-level tests for the KOI and TOI catalog handlers —
 * exercising the ACTUAL `GET` route functions (not just the
 * `catalogCache.ts` helper) to pin two things end to end:
 *
 * 1. TTL + stale-while-revalidate wiring:
 *   - a FRESH cache entry is served straight from disk with no TAP fetch
 *     and no `stale` flag;
 *   - a STALE entry (past the route's TTL) is served immediately WITH
 *     `stale: true` while a background TAP refresh fires (deduped);
 *   - the two routes' different TTLs are each respected — an entry aged
 *     between 24 h and 7 days is STALE for TOI (24 h TTL) but still FRESH
 *     for KOI (7-day TTL).
 *
 * 2. Host-star DEDUP, against the real multi-row-per-host shape NASA
 *    returns (frozen in `src/lib/__tests__/fixtures/koitoi/`) — the debt
 *    tracked since the 2026-07-20 sprint, i.e. the coverage the merge-side
 *    `assertUniqueByHostStar()` mitigation was built around but never had.
 *    Two layers are exercised together so they are proven to agree:
 *    the ROUTE's disposition filter (`parseTapRow` drops FALSE POSITIVE /
 *    FA etc. and stamps `KIC{kepid}` / `TIC{tid}`) and the FETCH-side dedup
 *    in `fetchKOICatalog` / `fetchTOICatalog` (collapse to one row per host
 *    id). Deduped rows are then run through the real merge functions and
 *    their `assertUniqueByHostStar()` is asserted NOT to fire.
 *    DEDUP KEY (verified in code, C-DEDUP.3): both the fetch dedup and the
 *    merge assertion key on `row.id` = `KIC{kepid}` / `TIC{tid}`, the
 *    host-star catalog id — not the per-candidate name.
 *
 * These live in ONE file (not two) on purpose: the routes hardcode fixed
 * cache filenames (`koi-catalog.json` / `toi-catalog.json`), and
 * `node --test` runs separate files CONCURRENTLY — so a second file
 * touching those same fixed paths races this one on disk (observed: the
 * fresh-cache test intermittently failed). Same-file tests run
 * sequentially, sharing the one backup/restore, which removes the race.
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
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GET as koiGET } from '@/app/api/koi/route'
import { GET as toiGET } from '@/app/api/toi/route'
import { fetchKOICatalog, fetchTOICatalog, mergeKoiIntoHipparcos, mergeToiIntoCatalog } from '@/lib/starCatalog'

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

/* ────────────────────────── host-star dedup ────────────────────────── */

const FIXDIR = path.join(import.meta.dirname, '..', '..', '..', 'lib', '__tests__', 'fixtures', 'koitoi')

/** @description Loads a frozen fixture's raw TAP rows array. */
function tapRows(file: string): unknown[] {
  return JSON.parse(readFileSync(path.join(FIXDIR, file), 'utf8')).rows
}

const KOI_MULTI = tapRows('koi-multi-KIC3832474.json') // 3 CONFIRMED + 2 FALSE POSITIVE
const KOI_SINGLE = tapRows('koi-single-KIC10666592.json') // single CONFIRMED (HAT-P-7)
const TOI_MULTI = tapRows('toi-multi-TIC29781292.json') // 3 CP + 1 FA
const TOI_SINGLE = tapRows('toi-single-TIC25155310.json') // single KP (WASP-126)

/**
 * @description Installs a `globalThis.fetch` stub returning `body` as a
 * JSON response. Used two ways: to feed the route a raw TAP JSON array,
 * and to feed `fetchKOICatalog`/`fetchTOICatalog` a route-shaped
 * `{source, rows}` body. Restored by the file-wide `afterEach`.
 * @param body The JSON payload to serve for any fetch.
 */
function installJsonFetch(body: unknown): void {
  fetchStub.restore()
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

/**
 * @description Runs a raw TAP fixture through the real KOI route GET,
 * returning the parsed body. Clears the cache FIRST because the route
 * writes a cache on success — without this a second call in one test would
 * be served the first call's cached rows instead of the new fixture.
 * @param rawTap Raw TAP rows to serve as the upstream response.
 * @returns Parsed route response (`source` + filtered/shaped `rows`).
 */
async function runKoiRoute(rawTap: unknown[]): Promise<{ source: string; rows: Array<Record<string, unknown>> }> {
  await fs.rm(KOI_FILE, { force: true })
  installJsonFetch(rawTap)
  return (await koiGET()).json()
}
/**
 * @description TOI counterpart of `runKoiRoute`.
 * @param rawTap Raw TAP rows to serve as the upstream response.
 * @returns Parsed route response.
 */
async function runToiRoute(rawTap: unknown[]): Promise<{ source: string; rows: Array<Record<string, unknown>> }> {
  await fs.rm(TOI_FILE, { force: true })
  installJsonFetch(rawTap)
  return (await toiGET()).json()
}

/** @description Captures console.error lines during `fn` — the channel `assertUniqueByHostStar` logs on. */
async function captureErrors(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')) }
  try { await fn() } finally { console.error = original }
  return lines
}

describe('KOI dedup — real multi-candidate host (KIC 3832474)', () => {
  it('route filters excluded dispositions: 3 CONFIRMED survive, 2 FALSE POSITIVE dropped', async () => {
    const body = await runKoiRoute(KOI_MULTI)
    assert.equal(body.source, 'real')
    assert.equal(body.rows.length, 3, 'only CONFIRMED/CANDIDATE rows survive the route filter')
    for (const r of body.rows) {
      assert.equal(r.disposition, 'CONFIRMED')
      assert.equal(r.id, 'KIC3832474', 'host-star id stamped as KIC{kepid}')
    }
    assert.ok(!body.rows.some(r => r.disposition === 'FALSE POSITIVE'), 'the FALSE POSITIVE rows are gone')
  })

  it('fetchKOICatalog collapses the 3 surviving rows to ONE host entry', async () => {
    const routeBody = await runKoiRoute(KOI_MULTI)
    installJsonFetch(routeBody)
    const { rows, source } = await fetchKOICatalog()
    assert.equal(source, 'real')
    assert.equal(rows.length, 1, 'three KOIs on one host → one deduped entry')
    assert.equal(rows[0].id, 'KIC3832474')
    // Highest koi_score wins: .01 = 1.0 (vs .02 0.745, .03 null→0).
    assert.equal(rows[0].score, 1, 'the highest-scoring candidate is the survivor')
  })

  it('the deduped rows do NOT trip the merge-side assertUniqueByHostStar', async () => {
    const routeBody = await runKoiRoute(KOI_MULTI)
    installJsonFetch(routeBody)
    const { rows } = await fetchKOICatalog()
    const errs = await captureErrors(() => { mergeKoiIntoHipparcos([], rows) })
    assert.deepEqual(errs, [], 'fetch-side dedup and merge-side assertion agree: no INVARIANT VIOLATED log')
  })
})

describe('KOI dedup — single-candidate host (KIC 10666592) is untouched', () => {
  it('one candidate stays one entry and does not merge with an unrelated host', async () => {
    // Route each host separately (as production does across the catalog),
    // then dedup the union — the single host must remain distinct.
    const multiBody = await runKoiRoute(KOI_MULTI)
    const singleBody = await runKoiRoute(KOI_SINGLE)
    installJsonFetch({ source: 'real', rows: [...multiBody.rows, ...singleBody.rows], fetchedAt: Date.now() })
    const { rows } = await fetchKOICatalog()
    const ids = rows.map(r => r.id).sort()
    assert.deepEqual(ids, ['KIC10666592', 'KIC3832474'], 'two distinct hosts stay two entries')
    const single = rows.find(r => r.id === 'KIC10666592')!
    assert.equal(single.name, 'K00002.01', 'the lone candidate is unchanged, not merged into the other host')
  })
})

describe('TOI dedup — real multi-candidate host (TIC 29781292)', () => {
  it('route filters the excluded FA disposition: 3 CP survive, 1 FA dropped', async () => {
    const body = await runToiRoute(TOI_MULTI)
    assert.equal(body.source, 'real')
    assert.equal(body.rows.length, 3, 'only CP/KP/PC rows survive the route filter')
    for (const r of body.rows) {
      assert.equal(r.disposition, 'CP')
      assert.equal(r.id, 'TIC29781292', 'host-star id stamped as TIC{tid}')
    }
    assert.ok(!body.rows.some(r => r.disposition === 'FA'), 'the FA row is filtered out')
  })

  it('fetchTOICatalog collapses the 3 surviving rows to ONE host entry', async () => {
    const routeBody = await runToiRoute(TOI_MULTI)
    installJsonFetch(routeBody)
    const { rows, source } = await fetchTOICatalog()
    assert.equal(source, 'real')
    assert.equal(rows.length, 1, 'three TOIs on one host → one deduped entry')
    assert.equal(rows[0].id, 'TIC29781292')
  })

  it('the deduped rows do NOT trip the merge-side assertUniqueByHostStar', async () => {
    const routeBody = await runToiRoute(TOI_MULTI)
    installJsonFetch(routeBody)
    const { rows } = await fetchTOICatalog()
    const errs = await captureErrors(() => { mergeToiIntoCatalog([], rows) })
    assert.deepEqual(errs, [], 'fetch-side dedup and merge-side assertion agree: no INVARIANT VIOLATED log')
  })
})

describe('TOI dedup — single-candidate host (TIC 25155310) is untouched', () => {
  it('one candidate stays one entry and does not merge with an unrelated host', async () => {
    const multiBody = await runToiRoute(TOI_MULTI)
    const singleBody = await runToiRoute(TOI_SINGLE)
    installJsonFetch({ source: 'real', rows: [...multiBody.rows, ...singleBody.rows], fetchedAt: Date.now() })
    const { rows } = await fetchTOICatalog()
    const ids = rows.map(r => r.id).sort()
    assert.deepEqual(ids, ['TIC25155310', 'TIC29781292'], 'two distinct hosts stay two entries')
  })
})

describe('dedup cross-check — the frozen raw fixtures actually contain excluded rows', () => {
  it('KOI multi fixture carries FALSE POSITIVE rows for the same host (else the filter test is vacuous)', () => {
    const rows = KOI_MULTI as Array<Record<string, unknown>>
    const dispositions = rows.map(r => r.koi_disposition)
    assert.ok(dispositions.includes('FALSE POSITIVE'), 'fixture must include an excluded disposition')
    assert.ok(dispositions.filter(d => d === 'CONFIRMED').length >= 2, 'and multiple kept rows')
    assert.equal(new Set(rows.map(r => r.kepid)).size, 1, 'all one host')
  })
  it('TOI multi fixture carries an excluded (FA) row for the same host', () => {
    const rows = TOI_MULTI as Array<Record<string, unknown>>
    assert.ok(rows.map(r => r.tfopwg_disp).includes('FA'), 'fixture must include an excluded disposition')
    assert.equal(new Set(rows.map(r => r.tid)).size, 1, 'all one host')
  })
})
