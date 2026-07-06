/**
 * @description Unit tests for the bounded-concurrency segment download pool
 * (`lib/segmentDownloadPool.ts`) — the fix for archive.stsci.edu dropping
 * random connections under an unbounded `Promise.all`. The single-segment
 * fetcher is injected, so a "download" is a deterministic in-memory
 * function that can be scripted to fail K of N segments, distinguish
 * transient vs permanent failures, and count concurrent in-flight calls.
 * No network, no next/*, no timers (sleep is stubbed).
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  downloadSegmentsBounded,
  fetchSegmentWithRetry,
  type SegmentResult,
  type SegmentPoolConfig,
} from '../segmentDownloadPool.ts'

/** @description No-op sleep so retries don't wait real wall-clock time. */
const noSleep = async () => {}

/** @description A parsed-segment success value tagged by index so order is checkable. */
function okSeg(i: number): SegmentResult {
  return { ok: true, times: [i, i + 0.1], flux: [1, 1] }
}

/** @description Base config: pool of 4, up to 3 attempts, zero-wait backoff. */
function cfg(over: Partial<SegmentPoolConfig> = {}): SegmentPoolConfig {
  return { concurrency: 4, maxAttempts: 3, backoffMs: 0, sleep: noSleep, ...over }
}

describe('fetchSegmentWithRetry', () => {
  it('recovers a transient failure on a later attempt', async () => {
    let calls = 0
    const fetchOne = async (): Promise<SegmentResult> => {
      calls++
      // Fail transiently twice, then succeed on the 3rd attempt.
      return calls < 3 ? { ok: false, reason: 'transient', detail: 'conn' } : okSeg(0)
    }
    const res = await fetchSegmentWithRetry(fetchOne, 0, 'seg0', cfg())
    assert.ok(res, 'should recover before exhausting attempts')
    assert.equal(calls, 3, 'took all 3 attempts')
  })

  it('does NOT retry a permanent failure (404 / parse error)', async () => {
    let calls = 0
    const fetchOne = async (): Promise<SegmentResult> => {
      calls++
      return { ok: false, reason: 'permanent', detail: 'HTTP 404' }
    }
    const res = await fetchSegmentWithRetry(fetchOne, 0, 'seg0', cfg())
    assert.equal(res, null, 'permanent failure yields null')
    assert.equal(calls, 1, 'permanent failure is NOT retried')
  })

  it('gives up after maxAttempts on persistent transient failure', async () => {
    let calls = 0
    const fetchOne = async (): Promise<SegmentResult> => {
      calls++
      return { ok: false, reason: 'transient', detail: 'conn' }
    }
    const res = await fetchSegmentWithRetry(fetchOne, 0, 'seg0', cfg({ maxAttempts: 3 }))
    assert.equal(res, null, 'exhausted transient yields null')
    assert.equal(calls, 3, 'tried exactly maxAttempts times')
  })

  it('succeeds first try with no retries', async () => {
    let calls = 0
    const fetchOne = async (): Promise<SegmentResult> => {
      calls++
      return okSeg(0)
    }
    const res = await fetchSegmentWithRetry(fetchOne, 0, 'seg0', cfg())
    assert.ok(res)
    assert.equal(calls, 1, 'no wasted retries on immediate success')
  })
})

describe('downloadSegmentsBounded', () => {
  it('recovers K-of-N transiently-failing segments and preserves order', async () => {
    const N = 17
    const labels = Array.from({ length: N }, (_, i) => `seg${i}`)
    // Segments 3, 7, 11 fail transiently once, then succeed — simulating the
    // random under-concurrency drops the pool exists to absorb.
    const failOnce = new Set([3, 7, 11])
    const attemptsByIndex = new Map<number, number>()
    const fetchOne = async (i: number): Promise<SegmentResult> => {
      const n = (attemptsByIndex.get(i) ?? 0) + 1
      attemptsByIndex.set(i, n)
      if (failOnce.has(i) && n === 1) return { ok: false, reason: 'transient', detail: 'conn' }
      return okSeg(i)
    }
    const results = await downloadSegmentsBounded(N, labels, fetchOne, cfg())
    assert.equal(results.length, N)
    // All recovered — this is the "17/17" guarantee.
    assert.equal(results.filter(Boolean).length, N, 'all segments recovered')
    // Order preserved: result[i].times[0] === i.
    for (let i = 0; i < N; i++) {
      assert.ok(results[i], `segment ${i} present`)
      assert.equal(results[i]!.times[0], i, `segment ${i} in correct slot`)
    }
  })

  it('leaves permanently-failed segments null (partial), rest succeed', async () => {
    const N = 10
    const labels = Array.from({ length: N }, (_, i) => `seg${i}`)
    const permanentlyDead = new Set([2, 5])
    const fetchOne = async (i: number): Promise<SegmentResult> =>
      permanentlyDead.has(i) ? { ok: false, reason: 'permanent', detail: 'HTTP 404' } : okSeg(i)
    const results = await downloadSegmentsBounded(N, labels, fetchOne, cfg())
    assert.equal(results[2], null)
    assert.equal(results[5], null)
    assert.equal(results.filter(Boolean).length, N - 2, 'exactly the two dead segments are missing')
  })

  it('never exceeds the configured concurrency cap', async () => {
    const N = 20
    const labels = Array.from({ length: N }, (_, i) => `seg${i}`)
    let inFlight = 0
    let peak = 0
    const fetchOne = async (i: number): Promise<SegmentResult> => {
      inFlight++
      if (inFlight > peak) peak = inFlight
      // Yield to the event loop so overlapping calls actually overlap.
      await new Promise(r => setTimeout(r, 0))
      inFlight--
      return okSeg(i)
    }
    await downloadSegmentsBounded(N, labels, fetchOne, cfg({ concurrency: 4 }))
    assert.ok(peak <= 4, `peak in-flight ${peak} must not exceed cap 4`)
    assert.ok(peak >= 2, `pool should actually parallelize (peak was ${peak})`)
  })

  it('coverage math: recovered vs expected identifies a PARTIAL curve', async () => {
    // Mirror how the route computes partial: recovered = non-null results,
    // expected = N. A segment that stays transient past maxAttempts drops.
    const N = 8
    const labels = Array.from({ length: N }, (_, i) => `seg${i}`)
    const alwaysDead = new Set([4])
    const fetchOne = async (i: number): Promise<SegmentResult> =>
      alwaysDead.has(i) ? { ok: false, reason: 'transient', detail: 'conn' } : okSeg(i)
    const results = await downloadSegmentsBounded(N, labels, fetchOne, cfg())
    const recovered = results.filter(Boolean).length
    const expected = N
    assert.equal(recovered, 7)
    assert.equal(expected, 8)
    assert.ok(recovered < expected, 'recovered < expected → PARTIAL')
  })
})
