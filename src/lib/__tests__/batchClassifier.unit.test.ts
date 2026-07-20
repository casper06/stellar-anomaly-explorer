/**
 * @description Unit tests for the batch sky-radar classifier
 * (`lib/batchClassifier.ts`) — orchestration only, no real MAST.
 *
 * `startBatch` launches a DETACHED worker (deliberately: the HTTP route
 * returns immediately and the job outlives the request), so every test
 * here starts it and then polls `getBatchStatus()` until `running`
 * clears. `globalThis.fetch` is stubbed to serve synthetic curves, which
 * is the only external dependency in the loop.
 *
 * What is actually pinned:
 *   - the resume skip-list (already-cached stars are not refetched),
 *   - the concurrency cap (never more than MAX_CONCURRENCY in flight),
 *   - the "only REAL, COMPLETE curves may populate the cache" rule —
 *     the guard that keeps fabricated or truncated labels out of the
 *     radar the user reads as truth,
 *   - idempotence (a second start while running is refused),
 *   - cancellation,
 *   - per-star error isolation.
 *
 * The pattern cache writes to one shared temp file, so the suite backs
 * it up and restores it (a dev server's real radar cache lives there).
 *
 * Run via `npm run test:unit`.
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { startBatch, stopBatch, getBatchStatus, type BatchStarSpec } from '../batchClassifier.ts'
import { snapshotCache, setEntry } from '../patternCache.ts'

const CACHE_FILE = path.join(os.tmpdir(), 'stellar-cache', 'pattern-cache.json')
const realFetch = globalThis.fetch
const realConsoleError = console.error
const realConsoleLog = console.log
let saved: string | null = null

/** @description Star ids requested by the stubbed fetch, in order. */
let requested: string[] = []
/** @description Peak simultaneous in-flight fetches observed. */
let peakInFlight = 0
let inFlight = 0

/**
 * @description Builds a light curve with a clear repeating dip so
 * `detectDips` + `classifyCurve` produce a stable, real pattern.
 * @returns Parallel times/flux arrays.
 */
function curve(): { times: number[]; flux: number[] } {
  const times: number[] = []
  const flux: number[] = []
  for (let i = 0; i < 400; i++) {
    times.push(i * 0.02)
    flux.push(i % 40 < 3 ? 0.97 : 1)
  }
  return { times, flux }
}

/**
 * @description Stubs fetch for the batch's `/api/lightcurve/<id>` calls.
 * @param bodyFor Maps a star id to the route body (or 'throw' / a status).
 */
function stubFetch(bodyFor: (id: string) => Record<string, unknown> | 'throw' | number): void {
  globalThis.fetch = (async (url: string) => {
    const id = decodeURIComponent(String(url).split('/api/lightcurve/')[1].split('?')[0])
    requested.push(id)
    inFlight++
    peakInFlight = Math.max(peakInFlight, inFlight)
    // Yield so genuinely-parallel calls overlap and the peak is real.
    await new Promise(r => setTimeout(r, 5))
    inFlight--
    const body = bodyFor(id)
    if (body === 'throw') throw new Error('simulated network failure')
    if (typeof body === 'number') return new Response('down', { status: body })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

/** @description A well-formed REAL, complete route body. */
function realBody(): Record<string, unknown> {
  return { ...curve(), source: 'real', partial: false }
}

/**
 * @description Waits for the detached worker to finish.
 * @param timeoutMs Safety bound.
 */
async function waitForIdle(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (getBatchStatus().running) {
    if (Date.now() > deadline) throw new Error('batch did not finish within the timeout')
    await new Promise(r => setTimeout(r, 15))
  }
}

/**
 * @description Star specs for N synthetic targets, namespaced per test.
 *
 * The namespace is REQUIRED, not cosmetic: `patternCache` memoizes its
 * parsed cache in a module-level variable, and `batchClassifier` imports
 * it statically — so every test in this file shares ONE in-memory cache
 * instance that deleting the backing file cannot clear (there is no
 * reset seam, and adding one would mean changing production code for a
 * test's convenience). Unique ids per test give the isolation that a
 * cache reset otherwise would.
 * @param n How many stars.
 * @param ns Namespace unique to the calling test.
 * @returns Star specs.
 */
const specs = (n: number, ns: string): BatchStarSpec[] =>
  Array.from({ length: n }, (_, i) => ({ id: `KIC-${ns}-${i}`, ra: 300, dec: 45 }))

/**
 * @description Cache entries belonging to one namespace.
 * @param ns Namespace used for that test's star ids.
 * @returns Matching cache entries only.
 */
async function cacheFor(ns: string): Promise<Record<string, { pattern: string }>> {
  const all = await snapshotCache()
  return Object.fromEntries(Object.entries(all).filter(([id]) => id.startsWith(`KIC-${ns}-`)))
}

before(async () => {
  try { saved = await fs.readFile(CACHE_FILE, 'utf8') } catch { saved = null }
  console.error = () => {}
  console.log = () => {}
})
after(async () => {
  globalThis.fetch = realFetch
  console.error = realConsoleError
  console.log = realConsoleLog
  if (saved === null) await fs.rm(CACHE_FILE, { force: true })
  else await fs.writeFile(CACHE_FILE, saved, 'utf8')
})
beforeEach(async () => {
  await fs.rm(CACHE_FILE, { force: true })
  requested = []
  peakInFlight = 0
  inFlight = 0
})

describe('startBatch — happy path', () => {
  it('classifies every star and writes one pattern-cache entry each', async () => {
    stubFetch(() => realBody())
    assert.equal(await startBatch(specs(5, 'happy'), 'http://x'), true, 'start accepted')
    await waitForIdle()

    const s = getBatchStatus()
    assert.equal(s.processed, 5)
    assert.equal(s.total, 5)
    assert.equal(s.succeeded, 5)
    assert.equal(s.errored, 0)
    assert.equal(s.skippedNoData, 0)
    assert.equal(s.running, false)

    const cache = await cacheFor('happy')
    for (const spec of specs(5, 'happy')) {
      assert.ok(cache[spec.id], `${spec.id} cached`)
      assert.ok(typeof cache[spec.id].pattern === 'string', 'a real classifier label was stored')
    }
  })

  it('passes ra/dec through to the lightcurve route', async () => {
    let seenUrl = ''
    globalThis.fetch = (async (url: string) => {
      seenUrl = String(url)
      return new Response(JSON.stringify(realBody()), { status: 200 })
    }) as typeof fetch
    await startBatch([{ id: 'KIC-radec-0', ra: 301.5642, dec: 44.4567 }], 'http://base')
    await waitForIdle()
    const u = new URL(seenUrl)
    assert.equal(u.pathname, '/api/lightcurve/KIC-radec-0')
    assert.equal(u.searchParams.get('ra'), '301.5642')
    assert.equal(u.searchParams.get('dec'), '44.4567')
  })
})

describe('startBatch — concurrency cap', () => {
  it('never exceeds MAX_CONCURRENCY (3) simultaneous fetches', async () => {
    // The cap is load-bearing: each star opens its own bounded pool of
    // segment downloads, so stars × pool is the real peak against
    // archive.stsci.edu. Raising it re-risks the dropped-segment
    // partial curves the pool exists to prevent.
    stubFetch(() => realBody())
    await startBatch(specs(12, 'conc'), 'http://x')
    await waitForIdle()
    assert.ok(peakInFlight <= 3, `peak in-flight was ${peakInFlight}, cap is 3`)
    assert.ok(peakInFlight > 1, 'work is actually parallel, not serialized')
  })
})

describe('startBatch — resume skip-list', () => {
  it('skips stars already cached at the CURRENT classifier version', async () => {
    await setEntry('KIC-resume-0', 'IRREGULAR')
    stubFetch(() => realBody())
    await startBatch(specs(3, 'resume'), 'http://x')
    await waitForIdle()

    assert.ok(!requested.includes('KIC-resume-0'), 'cached star was never refetched')
    assert.deepEqual(requested.sort(), ['KIC-resume-1', 'KIC-resume-2'])
    // Already-cached stars still count as processed so the progress
    // bar reflects the FULL input, not just the pending remainder.
    const s = getBatchStatus()
    assert.equal(s.total, 3)
    assert.equal(s.processed, 3)
    assert.equal(s.succeeded, 2, 'only the freshly-classified ones count as succeeded')
  })
})

describe('startBatch — only real, complete curves populate the cache', () => {
  it('skips SYNTHETIC curves (never writes a fabricated label to the radar)', async () => {
    stubFetch(() => ({ ...curve(), source: 'synthetic' }))
    await startBatch(specs(2, 'synth'), 'http://x')
    await waitForIdle()
    assert.deepEqual(await cacheFor('synth'), {}, 'nothing cached')
    assert.equal(getBatchStatus().skippedNoData, 2)
  })

  it('skips PARTIAL curves (a truncated curve would freeze a wrong label)', async () => {
    // The K00931.01 case: 2 of 17 quarters classifies SPARSE when the
    // complete curve is PERIODIC_UNIFORM.
    stubFetch(() => ({ ...curve(), source: 'real', partial: true }))
    await startBatch(specs(2, 'partial'), 'http://x')
    await waitForIdle()
    assert.deepEqual(await cacheFor('partial'), {}, 'nothing cached')
    assert.equal(getBatchStatus().skippedNoData, 2)
  })

  it('skips unavailable and empty curves', async () => {
    stubFetch(id =>
      id.endsWith('0') ? { times: [], flux: [], source: 'unavailable' } : { times: [], flux: [], source: 'real' },
    )
    await startBatch(specs(2, 'empty'), 'http://x')
    await waitForIdle()
    assert.deepEqual(await cacheFor('empty'), {})
    assert.equal(getBatchStatus().skippedNoData, 2)
  })
})

describe('startBatch — error isolation', () => {
  it('counts a failing star as errored and keeps going', async () => {
    stubFetch(id => (id === 'KIC-err-1' ? 'throw' : realBody()))
    await startBatch(specs(3, 'err'), 'http://x')
    await waitForIdle()
    const s = getBatchStatus()
    assert.equal(s.errored, 1)
    assert.equal(s.succeeded, 2, 'the other stars still completed')
    assert.equal(s.processed, 3, 'every star was accounted for')
    assert.ok(s.lastError, 'the failure reason is surfaced for the status endpoint')
    const cache = await cacheFor('err')
    assert.ok(!cache['KIC-err-1'], 'the failed star wrote nothing')
    assert.ok(cache['KIC-err-0'] && cache['KIC-err-2'])
  })

  it('treats a non-ok HTTP status as an error, not as data', async () => {
    stubFetch(id => (id === 'KIC-http-0' ? 500 : realBody()))
    await startBatch(specs(2, 'http'), 'http://x')
    await waitForIdle()
    assert.equal(getBatchStatus().errored, 1)
    assert.ok(!(await cacheFor('http'))['KIC-http-0'])
  })
})

describe('startBatch — lifecycle', () => {
  it('refuses a second start while one is already running (idempotent)', async () => {
    stubFetch(() => realBody())
    const first = await startBatch(specs(6, 'idem'), 'http://x')
    const second = await startBatch(specs(6, 'idem'), 'http://x')
    assert.equal(first, true, 'first start accepted')
    assert.equal(second, false, 'concurrent start refused')
    await waitForIdle()
  })

  it('stopBatch cancels the run before every star is processed', async () => {
    stubFetch(() => realBody())
    await startBatch(specs(30, 'cancel'), 'http://x')
    stopBatch()
    await waitForIdle()
    const s = getBatchStatus()
    assert.equal(s.running, false, 'run ended')
    assert.ok(s.processed < 30, `cancelled early (processed ${s.processed} of 30)`)
  })

  it('stopBatch is a no-op when nothing is running', () => {
    assert.equal(getBatchStatus().running, false)
    stopBatch()
    assert.equal(getBatchStatus().running, false)
  })

  it('accepts a new run after the previous one finished', async () => {
    stubFetch(() => realBody())
    await startBatch(specs(2, 'rerun'), 'http://x')
    await waitForIdle()
    assert.equal(await startBatch([{ id: 'KIC-second-run', ra: 1, dec: 2 }], 'http://x'), true)
    await waitForIdle()
    assert.ok((await snapshotCache())['KIC-second-run'])
  })
})
