// SPDX-License-Identifier: MIT
/**
 * @description Unit tests for `pickPattern` in isolation — the pure
 * label-selection branch of the classifier, independent of the frozen
 * real-data fixtures. One case per branch of the documented priority:
 *   1. HIGH_VARIABILITY overrides everything (even a confident BLS hit).
 *   2. PERIODIC_UNIFORM when BLS is confident and the baseline is quiet.
 *   3. UNCERTAIN when the raw interval scalars look periodic but BLS
 *      found nothing confident (the dip detector locking onto flicker).
 *   4. IRREGULAR as the default.
 * Plus the threshold boundaries (RMS gate, periodicity/consistency gate)
 * so a future retuning that shifts a cutoff trips a test.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickPattern } from '../src/curveClassifier.ts'

/** @description The HIGH_VARIABILITY_RMS constant, mirrored from the module. */
const HIGH_VARIABILITY_RMS = 0.01
/** @description The PERIODIC/DEPTH_CONSISTENCY threshold, mirrored from the module. */
const RAW_PERIODIC_THRESHOLD = 0.5

describe('pickPattern — label priority branches', () => {
  it('1. HIGH_VARIABILITY overrides everything, even a confident BLS detection', () => {
    // Noisy baseline AND a confident periodic signal AND periodic-looking
    // scalars: the noise gate wins regardless.
    assert.equal(
      pickPattern({
        periodicity: 0.99,
        depthConsistency: 0.99,
        baselineRMS: 0.02, // > HIGH_VARIABILITY_RMS
        blsConfident: true,
      }),
      'HIGH_VARIABILITY',
    )
  })

  it('2. PERIODIC_UNIFORM when BLS is confident and the baseline is quiet', () => {
    // BLS confident, quiet baseline. Raw scalars deliberately LOW to prove
    // it's the BLS flag driving the call, not the interval heuristic.
    assert.equal(
      pickPattern({
        periodicity: 0.1,
        depthConsistency: 0.1,
        baselineRMS: 0.002,
        blsConfident: true,
      }),
      'PERIODIC_UNIFORM',
    )
  })

  it('3. UNCERTAIN when raw scalars look periodic but BLS is not confident', () => {
    assert.equal(
      pickPattern({
        periodicity: 0.8, // ≥ threshold
        depthConsistency: 0.8, // ≥ threshold
        baselineRMS: 0.002, // quiet
        blsConfident: false,
      }),
      'UNCERTAIN',
    )
  })

  it('4. IRREGULAR as the default: no BLS, scalars below the periodic bar', () => {
    assert.equal(
      pickPattern({
        periodicity: 0.3, // < threshold
        depthConsistency: 0.9,
        baselineRMS: 0.002,
        blsConfident: false,
      }),
      'IRREGULAR',
    )
    // Also IRREGULAR when only ONE of the two scalars clears the bar.
    assert.equal(
      pickPattern({
        periodicity: 0.9,
        depthConsistency: 0.3, // < threshold
        baselineRMS: 0.002,
        blsConfident: false,
      }),
      'IRREGULAR',
    )
  })

  it('RMS gate boundary: exactly at HIGH_VARIABILITY_RMS trips HIGH_VARIABILITY (>=)', () => {
    assert.equal(
      pickPattern({
        periodicity: 0,
        depthConsistency: 0,
        baselineRMS: HIGH_VARIABILITY_RMS, // exactly at the gate
        blsConfident: false,
      }),
      'HIGH_VARIABILITY',
    )
    // A hair below the gate falls through (default IRREGULAR here).
    assert.equal(
      pickPattern({
        periodicity: 0,
        depthConsistency: 0,
        baselineRMS: HIGH_VARIABILITY_RMS - 1e-6,
        blsConfident: false,
      }),
      'IRREGULAR',
    )
  })

  it('raw-periodic gate boundary: both scalars exactly at threshold → UNCERTAIN (>=)', () => {
    assert.equal(
      pickPattern({
        periodicity: RAW_PERIODIC_THRESHOLD,
        depthConsistency: RAW_PERIODIC_THRESHOLD,
        baselineRMS: 0.002,
        blsConfident: false,
      }),
      'UNCERTAIN',
    )
  })

  it('BLS confidence beats a low-but-present raw-periodic signature (order of checks)', () => {
    // Confident BLS + quiet baseline → PERIODIC_UNIFORM regardless of the
    // raw scalars also qualifying for UNCERTAIN. Confirms check 2 precedes 3.
    assert.equal(
      pickPattern({
        periodicity: 0.9,
        depthConsistency: 0.9,
        baselineRMS: 0.002,
        blsConfident: true,
      }),
      'PERIODIC_UNIFORM',
    )
  })
})
