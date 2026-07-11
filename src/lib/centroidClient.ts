/**
 * @description Client-side wrapper for the on-demand pixel-level centroid
 * vetting endpoint (`/api/centroid/[id]`). Browser-safe: talks only to our
 * own API route; all MAST traffic happens server-side. The result type is
 * shared with the engine (`lib/centroidVet.ts` is dependency-free, so the
 * type import carries no Node baggage into the bundle).
 */
import type { CentroidVetResult } from './centroidVet'
import type { BlsResult } from './bls'

/** @description Route payload on success. */
export interface CentroidVetPayload {
  status: 'ok'
  result: CentroidVetResult
  /** Which mission's pixel data was measured (drives the UI's validation labeling). */
  mission: 'Kepler' | 'TESS'
  provenance: { sourceName: string; mission: string; dataType: string }
}

/** @description Route payload on any refusal/failure. */
export interface CentroidVetFailure {
  status: 'unsupported' | 'bad-request' | 'error'
  message: string
}

/**
 * @description Requests the centroid vetting measurement for one star at
 * the given confident BLS ephemeris. Resolves to the discriminated route
 * payload; network-level failures resolve to an `error` payload rather
 * than throwing so the caller has one rendering path.
 * @param starId Catalog id — must be a `KIC{N}` id (Kepler-only feature).
 * @param bls Confident BLS detection supplying period / epoch / duration.
 * @returns Route payload (success or failure shape).
 */
export async function fetchCentroidVet(
  starId: string,
  bls: BlsResult,
): Promise<CentroidVetPayload | CentroidVetFailure> {
  try {
    const params = new URLSearchParams({
      period: String(bls.periodDays),
      epoch: String(bls.epochDays),
      duration: String(bls.durationHours),
    })
    const res = await fetch(`/api/centroid/${encodeURIComponent(starId)}?${params}`)
    const json = (await res.json()) as CentroidVetPayload | CentroidVetFailure
    if (!json || typeof json !== 'object' || !('status' in json)) {
      return { status: 'error', message: 'Malformed response from the vetting endpoint.' }
    }
    return json
  } catch {
    return { status: 'error', message: 'Network error while requesting pixel-level vetting.' }
  }
}
