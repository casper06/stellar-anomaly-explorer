import { classifyCurve, type CurveProfile } from './curveClassifier'
import type { Dip } from './anomalyDetector'

/**
 * @description Wall-clock ceiling for the Web Worker classification before
 * it is abandoned. `classifyCurve` is dominated by the BLS period search,
 * which completes in ~1–2 s on a full-mission curve; 15 s is a generous
 * ceiling, NOT a tight budget — it fires only when the worker has genuinely
 * hung (a pathological/corrupted curve driving BLS into a non-terminating
 * state). Reaching it means neither `onmessage` nor `onerror` ever fired,
 * so `worker.terminate()` was never reachable — this timeout is the only
 * thing that can free the pinned worker thread.
 */
export const CLASSIFY_WORKER_TIMEOUT_MS = 15000

/**
 * @description Result of {@link classifyCurveAsync}. Deliberately a
 * discriminated union rather than `CurveProfile | null` so the caller can
 * tell three outcomes apart:
 *   - `ok`: a profile was produced — whether by the worker, or inline when
 *     no `Worker` exists (Node) / the worker failed cleanly. All of these
 *     are successful classifications; the thread they ran on is not the
 *     caller's concern.
 *   - `timeout`: the worker hung past `CLASSIFY_WORKER_TIMEOUT_MS` and was
 *     terminated. We deliberately do NOT fall back to an inline
 *     `classifyCurve` here: the no-Worker fallback runs the SAME
 *     computation synchronously on the main thread, so if the hang is
 *     caused by the data (not something worker-specific) falling back
 *     inline would freeze the tab instead of just abandoning a background
 *     thread — strictly worse than the bug being fixed. The caller
 *     surfaces "could not classify" instead.
 */
export type ClassifyResult =
  | { status: 'ok'; profile: CurveProfile }
  | { status: 'timeout' }

/**
 * @description Runs `classifyCurve` off the main thread when possible.
 * In the browser the work (dominated by the ~1–2 s BLS period search)
 * runs in a one-shot Web Worker so the star field stays responsive; in
 * environments without `Worker` (Node: the batch classifier, unit
 * tests) it falls back to a direct synchronous call. A clean worker
 * failure (bundler quirk, CSP, spawn error) also falls back inline —
 * those still produce a profile, only the thread differs, so they
 * resolve `{ status: 'ok' }`.
 *
 * The one outcome that does NOT fall back inline is a worker HANG: if
 * the worker never posts a message or error within
 * `CLASSIFY_WORKER_TIMEOUT_MS`, it is terminated and the promise
 * resolves `{ status: 'timeout' }`. See {@link ClassifyResult} for why
 * an inline retry on timeout would be worse than the hang.
 * @param times Time samples, parallel to `flux`.
 * @param flux Normalized flux samples.
 * @param dips Detected dips from `detectDips`.
 * @returns The classification outcome (`ok` with a profile, or `timeout`).
 */
export function classifyCurveAsync(
  times: number[],
  flux: number[],
  dips: Dip[],
): Promise<ClassifyResult> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve({ status: 'ok', profile: classifyCurve(times, flux, dips) })
  }
  return new Promise((resolve) => {
    let settled = false
    // Held so every settling path (message, error, timeout) can clear the
    // other pending mechanisms — a fast success must never leave the 15 s
    // timer dangling, and a timeout must not later be overwritten by a
    // late message from a worker we already gave up on.
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (result: ClassifyResult) => {
      if (settled) return
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      resolve(result)
    }
    try {
      const worker = new Worker(new URL('../workers/classify.worker.ts', import.meta.url))
      worker.onmessage = (event) => {
        worker.terminate()
        finish({ status: 'ok', profile: event.data as CurveProfile })
      }
      worker.onerror = () => {
        // A clean error (spawn/CSP/bundler) → the inline result is still a
        // valid classification, so this is `ok`, not `timeout`.
        worker.terminate()
        finish({ status: 'ok', profile: classifyCurve(times, flux, dips) })
      }
      timer = setTimeout(() => {
        // Neither onmessage nor onerror fired — the worker is hung. Kill it
        // and report a distinct timeout; do NOT re-run inline (see above).
        worker.terminate()
        finish({ status: 'timeout' })
      }, CLASSIFY_WORKER_TIMEOUT_MS)
      worker.postMessage({ times, flux, dips })
    } catch {
      finish({ status: 'ok', profile: classifyCurve(times, flux, dips) })
    }
  })
}
