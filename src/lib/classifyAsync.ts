import { classifyCurve, type CurveProfile } from './curveClassifier'
import type { Dip } from './anomalyDetector'

/**
 * @description Runs `classifyCurve` off the main thread when possible.
 * In the browser the work (dominated by the ~1–2 s BLS period search)
 * runs in a one-shot Web Worker so the star field stays responsive; in
 * environments without `Worker` (Node: the batch classifier, unit
 * tests) it falls back to a direct synchronous call. Any worker
 * failure (bundler quirk, CSP, spawn error) also falls back inline —
 * the result is always produced, only the thread differs.
 * @param times Time samples, parallel to `flux`.
 * @param flux Normalized flux samples.
 * @param dips Detected dips from `detectDips`.
 * @returns The measured curve profile.
 */
export function classifyCurveAsync(
  times: number[],
  flux: number[],
  dips: Dip[],
): Promise<CurveProfile> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(classifyCurve(times, flux, dips))
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (profile: CurveProfile) => {
      if (!settled) {
        settled = true
        resolve(profile)
      }
    }
    try {
      const worker = new Worker(new URL('../workers/classify.worker.ts', import.meta.url))
      worker.onmessage = (event) => {
        worker.terminate()
        finish(event.data as CurveProfile)
      }
      worker.onerror = () => {
        worker.terminate()
        finish(classifyCurve(times, flux, dips))
      }
      worker.postMessage({ times, flux, dips })
    } catch {
      finish(classifyCurve(times, flux, dips))
    }
  })
}
