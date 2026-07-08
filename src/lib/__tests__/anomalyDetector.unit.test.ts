/**
 * @description Unit tests for the dip detector's high-noise calibration
 * guard (the TOI 5523.02 fix): the sigma-relative threshold floor must
 * activate only beyond the noise gate, high-noise curves must not
 * fragment into thousands of noise "dips", real deep events must survive
 * the floor, fragmentation must merge, and the min-duration guard must be
 * cadence-aware (a no-op at Kepler's 30-min sampling, active at TESS's
 * 2-min). Deterministic PRNG so failures reproduce exactly.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectDips,
  robustFluxSigma,
  DIP_NOISE_GATE_SIGMA,
} from '../anomalyDetector.ts'

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
 * @description Builds a noise curve at a given cadence with optional box
 * dips injected at fixed times.
 * @param opts Baseline length, cadence, noise sigma, seed, injected dips.
 * @returns Parallel times/flux arrays.
 */
function synthetic(opts: {
  baselineDays: number
  cadenceDays: number
  noiseSigma: number
  seed: number
  dips?: Array<{ atDay: number; durationDays: number; depth: number }>
}): { times: number[]; flux: number[] } {
  const rand = mulberry32(opts.seed)
  const gauss = () => {
    const u = Math.max(rand(), 1e-12)
    const v = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const times: number[] = []
  const flux: number[] = []
  for (let t = 100; t < 100 + opts.baselineDays; t += opts.cadenceDays) {
    let f = 1 + gauss() * opts.noiseSigma
    for (const d of opts.dips ?? []) {
      if (Math.abs(t - (100 + d.atDay)) < d.durationDays / 2) f -= d.depth
    }
    times.push(t)
    flux.push(f)
  }
  return { times, flux }
}

const KEPLER_CADENCE = 0.020417 // ~30 min
const TESS_CADENCE = 0.0014 // ~2 min

describe('detectDips high-noise calibration', () => {
  it('legacy Kepler domain is untouched: quiet noise + injected 2% dips detects exactly the injections', () => {
    const { times, flux } = synthetic({
      baselineDays: 90,
      cadenceDays: KEPLER_CADENCE,
      noiseSigma: 0.001,
      seed: 42,
      dips: [
        { atDay: 20, durationDays: 0.2, depth: 0.02 },
        { atDay: 45, durationDays: 0.2, depth: 0.02 },
        { atDay: 70, durationDays: 0.2, depth: 0.02 },
      ],
    })
    assert.ok(robustFluxSigma(flux) < DIP_NOISE_GATE_SIGMA, 'below the gate — fixed threshold domain')
    const dips = detectDips(flux, times)
    assert.equal(dips.length, 3)
    assert.ok(Math.abs(dips[0].depth - 0.02) < 0.005, `depth ${dips[0].depth.toFixed(4)} ≈ 2%`)
  })

  it('high-noise TESS curve yields a sane count instead of thousands of noise fragments', () => {
    // σ = 1.5% at 2-min cadence — the TOI 5523.02 regime. Under the old
    // fixed threshold ~25% of samples were "in a dip".
    const { times, flux } = synthetic({
      baselineDays: 100,
      cadenceDays: TESS_CADENCE,
      noiseSigma: 0.015,
      seed: 7,
    })
    assert.ok(robustFluxSigma(flux) > DIP_NOISE_GATE_SIGMA, 'above the gate — sigma floor active')
    const dips = detectDips(flux, times)
    assert.ok(dips.length < 20, `noise must not fragment (got ${dips.length})`)
  })

  it('a real deep eclipse still surfaces through the sigma floor on a high-noise curve', () => {
    const { times, flux } = synthetic({
      baselineDays: 50,
      cadenceDays: TESS_CADENCE,
      noiseSigma: 0.015,
      seed: 11,
      dips: [
        { atDay: 10, durationDays: 0.15, depth: 0.08 },
        { atDay: 25, durationDays: 0.15, depth: 0.08 },
        { atDay: 40, durationDays: 0.15, depth: 0.08 },
      ],
    })
    const dips = detectDips(flux, times)
    // The three 8% eclipses must be among the detections (noise may add
    // a small number of ≥3σ excursions — that's honest).
    assert.ok(dips.length >= 3 && dips.length < 15, `expected the 3 eclipses ± a few (got ${dips.length})`)
    const deep = dips.filter(d => d.depth > 0.05)
    assert.equal(deep.length, 3, `all three 8% eclipses detected (got ${deep.length})`)
  })

  it('merges noise-fragmented runs: single-sample recoveries inside one event do not split it', () => {
    // Hand-built 2-min-cadence curve: one 3-hour 5% dip with two
    // single-sample returns to baseline inside it.
    const times: number[] = []
    const flux: number[] = []
    for (let i = 0; i < 3000; i++) {
      const t = 100 + i * TESS_CADENCE
      times.push(t)
      const inDip = t > 101 && t < 101.125
      flux.push(inDip ? 0.95 : 1.0)
    }
    const iMid = times.findIndex(t => t > 101.05)
    flux[iMid] = 1.0
    flux[iMid + 20] = 1.0
    const dips = detectDips(flux, times)
    assert.equal(dips.length, 1, `fragmented event must merge to one dip (got ${dips.length})`)
    assert.ok(Math.abs(dips[0].depth - 0.05) < 0.01, `depth ${dips[0].depth.toFixed(3)} ≈ 5%`)
  })

  it('min-duration is cadence-aware: a single-sample blip drops at 2-min cadence, survives at 30-min', () => {
    for (const [cadence, expected] of [
      [TESS_CADENCE, 0],
      [KEPLER_CADENCE, 1],
    ] as const) {
      const times: number[] = []
      const flux: number[] = []
      for (let i = 0; i < 2000; i++) {
        times.push(100 + i * cadence)
        flux.push(1.0)
      }
      flux[1000] = 0.95 // one isolated below-threshold sample
      const dips = detectDips(flux, times)
      assert.equal(
        dips.length,
        expected,
        `single-sample blip at cadence ${cadence}: expected ${expected} dips, got ${dips.length}`,
      )
    }
  })
})
