import { classifyCurve } from '@/lib/curveClassifier'
import type { Dip } from '@/lib/anomalyDetector'

/**
 * @description Web Worker entry for curve classification. The BLS period
 * search inside `classifyCurve` costs ~1–2 s of CPU on a full-mission
 * Kepler curve; running it on the main thread would freeze the star
 * field mid-interaction, so the client path ships the arrays here and
 * gets the profile back via message. One-shot: the spawner terminates
 * the worker after the reply.
 */

/** @description Message payload from `classifyCurveAsync`. */
interface ClassifyRequest {
  times: number[]
  flux: number[]
  dips: Dip[]
}

self.addEventListener('message', (event) => {
  const { times, flux, dips } = (event as MessageEvent<ClassifyRequest>).data
  const profile = classifyCurve(times, flux, dips)
  // Worker-scope postMessage takes a single argument; the dom lib types
  // `self` as Window here, so narrow it manually.
  ;(self as unknown as { postMessage: (message: unknown) => void }).postMessage(profile)
})
