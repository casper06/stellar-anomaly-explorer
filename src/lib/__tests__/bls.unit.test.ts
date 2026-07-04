/**
 * @description Unit tests for the budgeted BLS engine: synthetic
 * transit-injection recovery (deep/short-period and shallow/long-period),
 * a pure-noise null test, epoch/depth accuracy, and a wall-clock budget
 * on the full-mission-scale case. Deterministic PRNG so failures
 * reproduce exactly.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runBls, BLS_SDE_THRESHOLD } from '../bls.ts'

/**
 * @description Deterministic PRNG (mulberry32) so test data is stable
 * across runs and platforms.
 * @param seed 32-bit seed.
 * @returns () => float in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * @description Builds a synthetic light curve at Kepler-like 30-min
 * cadence: unit baseline + gaussian noise + optional periodic box
 * transits.
 * @param opts baselineDays/noise/injected-signal parameters.
 * @returns Parallel times/flux arrays.
 */
function synthetic(opts: {
  baselineDays: number
  noiseSigma: number
  seed: number
  transit?: { periodDays: number; epochDays: number; durationDays: number; depth: number }
}): { times: number[]; flux: number[] } {
  const rand = mulberry32(opts.seed)
  const gauss = () => {
    // Box–Muller
    const u = Math.max(rand(), 1e-12)
    const v = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const cadence = 0.020417 // ~30 min in days
  const times: number[] = []
  const flux: number[] = []
  for (let t = 100; t < 100 + opts.baselineDays; t += cadence) {
    let f = 1 + gauss() * opts.noiseSigma
    const tr = opts.transit
    if (tr) {
      const phase = ((t - tr.epochDays) % tr.periodDays + tr.periodDays) % tr.periodDays
      const fromCenter = Math.min(phase, tr.periodDays - phase)
      if (fromCenter < tr.durationDays / 2) f -= tr.depth
    }
    times.push(t)
    flux.push(f)
  }
  return { times, flux }
}

describe('runBls', () => {
  it('recovers a deep short-period signal (eclipsing-binary-like)', () => {
    const P = 2.47
    const { times, flux } = synthetic({
      baselineDays: 400,
      noiseSigma: 0.001,
      seed: 42,
      transit: { periodDays: P, epochDays: 100.9, durationDays: 0.125, depth: 0.02 },
    })
    const r = runBls(times, flux)
    assert.ok(r, 'result expected')
    assert.ok(r.sde >= BLS_SDE_THRESHOLD, `confident detection expected (sde=${r.sde.toFixed(1)})`)
    assert.ok(Math.abs(r.periodDays - P) / P < 0.005, `period ${r.periodDays.toFixed(4)} ≈ ${P}`)
    assert.ok(Math.abs(r.depthPpm - 20000) < 8000, `depth ${r.depthPpm.toFixed(0)} ppm ≈ 20,000`)
    // Epoch matches the true mid-transit modulo P, within a duration.
    const dPhase = Math.abs((((r.epochDays - 100.9) % P) + P) % P)
    const epochErr = Math.min(dPhase, P - dPhase)
    assert.ok(epochErr < 0.125, `epoch off by ${epochErr.toFixed(3)} d (< duration)`)
  })

  it('recovers a shallow long-period signal at full-mission scale within the time budget', () => {
    const P = 15.9
    const { times, flux } = synthetic({
      baselineDays: 1400,
      noiseSigma: 0.0007,
      seed: 7,
      transit: { periodDays: P, epochDays: 103.2, durationDays: 0.2, depth: 0.0005 },
    })
    assert.ok(times.length > 60000, 'full-mission sample count')
    const start = performance.now()
    const r = runBls(times, flux)
    const elapsed = performance.now() - start
    assert.ok(r, 'result expected')
    assert.ok(elapsed < 3000, `search took ${elapsed.toFixed(0)} ms (budget 3000)`)
    assert.ok(r.sde >= BLS_SDE_THRESHOLD, `confident detection expected (sde=${r.sde.toFixed(1)})`)
    assert.ok(Math.abs(r.periodDays - P) / P < 0.005, `period ${r.periodDays.toFixed(4)} ≈ ${P}`)
  })

  it('pure noise yields no confident detection (null test)', () => {
    const { times, flux } = synthetic({ baselineDays: 700, noiseSigma: 0.001, seed: 1234 })
    const r = runBls(times, flux)
    assert.ok(r, 'a result object is still returned')
    assert.ok(r.sde < BLS_SDE_THRESHOLD, `no confident detection on noise (sde=${r.sde.toFixed(1)})`)
  })

  it('a handful of APERIODIC deep dips does not produce a confident period', () => {
    // Tabby-like: 9 deep dips at irregular times.
    const rand = mulberry32(99)
    const dipTimes = Array.from({ length: 9 }, () => 100 + rand() * 1300)
    const { times, flux } = synthetic({ baselineDays: 1400, noiseSigma: 0.0013, seed: 5 })
    for (let i = 0; i < times.length; i++) {
      for (const dt of dipTimes) {
        if (Math.abs(times[i] - dt) < 1.2) flux[i] -= 0.15 * Math.exp(-((times[i] - dt) ** 2) / 0.5)
      }
    }
    const r = runBls(times, flux)
    assert.ok(r, 'result expected')
    assert.ok(r.sde < BLS_SDE_THRESHOLD, `aperiodic dips must not fold confidently (sde=${r.sde.toFixed(1)})`)
  })

  it('returns null on unusably small input', () => {
    assert.equal(runBls([1, 2, 3], [1, 1, 1]), null)
  })
})
