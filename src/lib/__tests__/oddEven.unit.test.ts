/**
 * @description Unit tests for the odd/even transit depth comparison:
 * alternating-depth injection must flag MISMATCH, equal depths must stay
 * CONSISTENT (including across a simulated missing quarter — the
 * partial-curve no-false-mismatch property), too few cycles must return
 * null, and pure noise must never produce a MISMATCH. Deterministic PRNG
 * so failures reproduce exactly.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  measureOddEvenDepths,
  ODD_EVEN_SIGMA_THRESHOLD,
  MIN_CYCLES_PER_PARITY,
} from '../oddEven.ts'
import type { BlsResult } from '../bls.ts'

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
 * @description Builds a synthetic Kepler-cadence curve with box transits
 * whose depth may depend on the parity of the cycle index — the
 * eclipsing-binary-at-half-period geometry the check exists to surface.
 * @param opts Baseline length, noise, seed, and per-parity transit spec.
 * @returns Parallel times/flux arrays.
 */
function synthetic(opts: {
  baselineDays: number
  noiseSigma: number
  seed: number
  transit?: {
    periodDays: number
    epochDays: number
    durationDays: number
    evenDepth: number
    oddDepth: number
  }
}): { times: number[]; flux: number[] } {
  const rand = mulberry32(opts.seed)
  const gauss = () => {
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
      const n = Math.round((t - tr.epochDays) / tr.periodDays)
      const dt = Math.abs(t - tr.epochDays - n * tr.periodDays)
      if (dt < tr.durationDays / 2) {
        f -= Math.abs(n % 2) === 1 ? tr.oddDepth : tr.evenDepth
      }
    }
    times.push(t)
    flux.push(f)
  }
  return { times, flux }
}

/**
 * @description Fabricates the minimal BlsResult the check consumes —
 * period, epoch, duration. sde/depth are carried for shape completeness.
 * @param periodDays Fold period.
 * @param epochDays Mid-transit epoch.
 * @param durationDays Box duration in days.
 * @returns BlsResult-shaped object.
 */
function fakeBls(periodDays: number, epochDays: number, durationDays: number): BlsResult {
  return { periodDays, epochDays, depthPpm: 0, durationHours: durationDays * 24, sde: 10 }
}

describe('measureOddEvenDepths', () => {
  it('flags MISMATCH on alternating-depth transits (EB-at-half-period geometry)', () => {
    const P = 2.5
    const { times, flux } = synthetic({
      baselineDays: 200,
      noiseSigma: 0.001,
      seed: 42,
      transit: { periodDays: P, epochDays: 101.3, durationDays: 0.12, evenDepth: 0.02, oddDepth: 0.01 },
    })
    const r = measureOddEvenDepths(times, flux, fakeBls(P, 101.3, 0.12))
    assert.ok(r, 'result expected')
    assert.equal(r.verdict, 'MISMATCH')
    assert.ok(r.diffSigma >= ODD_EVEN_SIGMA_THRESHOLD, `sigma ${r.diffSigma.toFixed(1)} ≥ 3`)
    // True depths 20,000 vs 10,000 ppm → relative diff ≈ 66% of the 15,000 mean.
    assert.ok(Math.abs(r.relDiffPct - 66.7) < 8, `relDiff ${r.relDiffPct.toFixed(1)}% ≈ 66.7%`)
    assert.ok(Math.abs(r.evenDepthPpm - 20000) < 2000, `even ${r.evenDepthPpm.toFixed(0)} ppm ≈ 20,000`)
    assert.ok(Math.abs(r.oddDepthPpm - 10000) < 2000, `odd ${r.oddDepthPpm.toFixed(0)} ppm ≈ 10,000`)
  })

  it('reports CONSISTENT on equal-depth transits', () => {
    const P = 3.1
    const { times, flux } = synthetic({
      baselineDays: 250,
      noiseSigma: 0.001,
      seed: 7,
      transit: { periodDays: P, epochDays: 102.0, durationDays: 0.15, evenDepth: 0.015, oddDepth: 0.015 },
    })
    const r = measureOddEvenDepths(times, flux, fakeBls(P, 102.0, 0.15))
    assert.ok(r, 'result expected')
    assert.equal(r.verdict, 'CONSISTENT')
    assert.ok(r.relDiffPct < 5, `relDiff ${r.relDiffPct.toFixed(1)}% small`)
  })

  it('a missing quarter-sized block does not fake a mismatch (partial-curve property)', () => {
    const P = 3.1
    const full = synthetic({
      baselineDays: 400,
      noiseSigma: 0.001,
      seed: 11,
      transit: { periodDays: P, epochDays: 102.0, durationDays: 0.15, evenDepth: 0.015, oddDepth: 0.015 },
    })
    // Drop a ~90-day contiguous block, the shape a lost quarter leaves.
    const times: number[] = []
    const flux: number[] = []
    for (let i = 0; i < full.times.length; i++) {
      const t = full.times[i]
      if (t >= 180 && t < 270) continue
      times.push(t)
      flux.push(full.flux[i])
    }
    const r = measureOddEvenDepths(times, flux, fakeBls(P, 102.0, 0.15))
    assert.ok(r, 'result expected')
    assert.equal(r.verdict, 'CONSISTENT')
    // The block removes odd and even cycles in near-equal numbers.
    assert.ok(
      Math.abs(r.oddCycles - r.evenCycles) <= 2,
      `parity counts stay balanced (${r.oddCycles} odd / ${r.evenCycles} even)`,
    )
  })

  it('returns null when either parity has too few usable cycles', () => {
    const P = 50 // 200-day baseline → ~4 cycles → 2 per parity < MIN_CYCLES_PER_PARITY
    const { times, flux } = synthetic({
      baselineDays: 200,
      noiseSigma: 0.001,
      seed: 3,
      transit: { periodDays: P, epochDays: 110, durationDays: 0.3, evenDepth: 0.02, oddDepth: 0.02 },
    })
    assert.ok(MIN_CYCLES_PER_PARITY >= 3, 'test assumes the documented gate')
    assert.equal(measureOddEvenDepths(times, flux, fakeBls(P, 110, 0.3)), null)
  })

  it('pure noise never produces a MISMATCH', () => {
    const { times, flux } = synthetic({ baselineDays: 300, noiseSigma: 0.001, seed: 1234 })
    const r = measureOddEvenDepths(times, flux, fakeBls(2.9, 101.0, 0.12))
    // Depending on the noise draw the folded "box" may not even be a
    // dimming (null); if it is, the difference must read as noise.
    if (r !== null) assert.equal(r.verdict, 'CONSISTENT')
  })
})
