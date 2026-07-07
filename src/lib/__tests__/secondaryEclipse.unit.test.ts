/**
 * @description Unit tests for the secondary-eclipse (phase-0.5 dimming)
 * check: an EB-like injection with a secondary at phase 0.5 must be
 * DETECTED with the right depth and ratio, a lone-transit injection must
 * stay NOT_DETECTED, a hot-Jupiter-scale shallow occultation must still
 * be recoverable from cycle pooling, a simulated missing quarter must
 * not fake a detection, too few cycles must return null, and pure noise
 * must never read DETECTED. Deterministic PRNG so failures reproduce
 * exactly.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  measureSecondaryEclipse,
  SECONDARY_SIGMA_THRESHOLD,
  MIN_CYCLES,
} from '../secondaryEclipse.ts'
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
 * @description Builds a synthetic Kepler-cadence curve with a primary
 * box transit at phase 0 and an optional secondary box at phase 0.5 —
 * the eclipsing-binary-at-true-period geometry this check surfaces.
 * @param opts Baseline length, noise, seed, and transit spec.
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
    primaryDepth: number
    secondaryDepth: number
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
      const nP = Math.round((t - tr.epochDays) / tr.periodDays)
      const dtP = Math.abs(t - tr.epochDays - nP * tr.periodDays)
      if (dtP < tr.durationDays / 2) f -= tr.primaryDepth
      const secEpoch = tr.epochDays + tr.periodDays / 2
      const nS = Math.round((t - secEpoch) / tr.periodDays)
      const dtS = Math.abs(t - secEpoch - nS * tr.periodDays)
      if (dtS < tr.durationDays / 2) f -= tr.secondaryDepth
    }
    times.push(t)
    flux.push(f)
  }
  return { times, flux }
}

/**
 * @description Fabricates the minimal BlsResult the check consumes —
 * period, epoch, duration, and the primary depth used for the ratio.
 * @param periodDays Fold period.
 * @param epochDays Mid-transit epoch of the PRIMARY.
 * @param durationDays Box duration in days.
 * @param depthPpm Primary depth in ppm (ratio denominator).
 * @returns BlsResult-shaped object.
 */
function fakeBls(
  periodDays: number,
  epochDays: number,
  durationDays: number,
  depthPpm: number,
): BlsResult {
  return { periodDays, epochDays, depthPpm, durationHours: durationDays * 24, sde: 10 }
}

describe('measureSecondaryEclipse', () => {
  it('detects an EB-like secondary at phase 0.5 with the right depth and ratio', () => {
    const P = 2.7
    const { times, flux } = synthetic({
      baselineDays: 300,
      noiseSigma: 0.001,
      seed: 42,
      transit: { periodDays: P, epochDays: 101.1, durationDays: 0.13, primaryDepth: 0.02, secondaryDepth: 0.008 },
    })
    const r = measureSecondaryEclipse(times, flux, fakeBls(P, 101.1, 0.13, 20000))
    assert.ok(r, 'result expected')
    assert.equal(r.verdict, 'DETECTED')
    assert.ok(r.sigma >= SECONDARY_SIGMA_THRESHOLD, `sigma ${r.sigma.toFixed(1)} ≥ 3`)
    assert.ok(Math.abs(r.depthPpm - 8000) < 1000, `depth ${r.depthPpm.toFixed(0)} ppm ≈ 8,000`)
    assert.ok(r.ratioToPrimaryPct !== null && Math.abs(r.ratioToPrimaryPct - 40) < 6, `ratio ${r.ratioToPrimaryPct?.toFixed(1)}% ≈ 40%`)
  })

  it('reports NOT_DETECTED when only a primary transit exists', () => {
    const P = 3.2
    const { times, flux } = synthetic({
      baselineDays: 300,
      noiseSigma: 0.001,
      seed: 7,
      transit: { periodDays: P, epochDays: 102.4, durationDays: 0.15, primaryDepth: 0.015, secondaryDepth: 0 },
    })
    const r = measureSecondaryEclipse(times, flux, fakeBls(P, 102.4, 0.15, 15000))
    assert.ok(r, 'result expected')
    assert.equal(r.verdict, 'NOT_DETECTED')
  })

  it('recovers a hot-Jupiter-scale shallow occultation by pooling many cycles', () => {
    const P = 2.2
    const { times, flux } = synthetic({
      baselineDays: 1200,
      noiseSigma: 0.0003,
      seed: 11,
      transit: { periodDays: P, epochDays: 100.7, durationDays: 0.16, primaryDepth: 0.005, secondaryDepth: 0.0001 },
    })
    const r = measureSecondaryEclipse(times, flux, fakeBls(P, 100.7, 0.16, 5000))
    assert.ok(r, 'result expected')
    assert.equal(r.verdict, 'DETECTED')
    assert.ok(Math.abs(r.depthPpm - 100) < 40, `depth ${r.depthPpm.toFixed(0)} ppm ≈ 100`)
    assert.ok(r.ratioToPrimaryPct !== null && r.ratioToPrimaryPct < 5, `small ratio (${r.ratioToPrimaryPct?.toFixed(1)}%)`)
  })

  it('a missing quarter-sized block does not fake a detection (partial-curve property)', () => {
    const P = 3.2
    const full = synthetic({
      baselineDays: 400,
      noiseSigma: 0.001,
      seed: 13,
      transit: { periodDays: P, epochDays: 102.4, durationDays: 0.15, primaryDepth: 0.015, secondaryDepth: 0 },
    })
    const times: number[] = []
    const flux: number[] = []
    for (let i = 0; i < full.times.length; i++) {
      const t = full.times[i]
      if (t >= 180 && t < 270) continue
      times.push(t)
      flux.push(full.flux[i])
    }
    const r = measureSecondaryEclipse(times, flux, fakeBls(P, 102.4, 0.15, 15000))
    assert.ok(r, 'result expected')
    assert.equal(r.verdict, 'NOT_DETECTED')
  })

  it('returns null when too few cycles have usable phase-0.5 coverage', () => {
    const P = 50 // 200-day baseline → ~4 secondary windows < MIN_CYCLES usable after gating
    const { times, flux } = synthetic({
      baselineDays: 120,
      noiseSigma: 0.001,
      seed: 3,
      transit: { periodDays: P, epochDays: 110, durationDays: 0.3, primaryDepth: 0.02, secondaryDepth: 0.01 },
    })
    assert.ok(MIN_CYCLES >= 3, 'test assumes the documented gate')
    assert.equal(measureSecondaryEclipse(times, flux, fakeBls(P, 110, 0.3, 20000)), null)
  })

  it('pure noise never reads DETECTED', () => {
    const { times, flux } = synthetic({ baselineDays: 300, noiseSigma: 0.001, seed: 1234 })
    const r = measureSecondaryEclipse(times, flux, fakeBls(2.9, 101.0, 0.12, 10000))
    if (r !== null) assert.equal(r.verdict, 'NOT_DETECTED')
  })
})
