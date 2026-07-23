import type { GaiaDescription } from './gaiaSource'
import { fetchIdentity } from './identityClient'

/**
 * @description Browser fetch wrapper for the Gaia DR3 descriptive engine,
 * plus the identity-chain glue that turns an app star id into a Gaia
 * source_id first. Mirrors `identityClient.ts`: thin, no retries, and it
 * NEVER throws. Gaia data is BONUS context in the panel (a future UI task),
 * not a core feature — exactly like SIMBAD's "also known as" — so every
 * failure mode collapses to the same benign answer, `null`, which the UI
 * renders as nothing at all rather than as an error state.
 *
 * The chain (C1.4, verified end-to-end there): app star id →
 * `fetchIdentity` (SIMBAD) → `identity.gaiaDr3` → `/api/gaia/[source_id]`.
 * If SIMBAD doesn't resolve the star, or resolves it but SIMBAD lists no
 * Gaia DR3 id (common for faint KOI hosts), there is no source_id to query
 * and the result is silently `null` — never a stuck spinner, never an
 * error. That absence is the normal answer for most faint hosts, per C1.4.
 */

/** @description Client-side result. `null` = nothing to display, for any reason. */
export type GaiaResult = GaiaDescription | null

/**
 * @description Fetches one Gaia source's descriptive profile by its DR3
 * source_id, through the app's own route (never ESAC/AIP directly — CORS,
 * and the route owns the cache, the mirror fallback, and the body-sniff).
 *
 * Use this when the source_id is ALREADY known. To go from an app star id,
 * use `fetchGaiaForStar`, which resolves the identity first.
 * @param sourceId Gaia DR3 source_id (bare digits).
 * @returns The descriptive profile, or null on a miss/outage/any error.
 */
export async function fetchGaiaBySourceId(sourceId: string): Promise<GaiaResult> {
  try {
    const res = await fetch(`/api/gaia/${encodeURIComponent(sourceId)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { description?: GaiaDescription | null }
    return data.description ?? null
  } catch {
    // Deliberately silent: an unreachable Gaia route must not log noise on
    // every selection, and the panel shows nothing either way.
    return null
  }
}

/**
 * @description Runs the full identity chain for one app star id and returns
 * its Gaia descriptive profile, or null when any link is missing.
 *
 * Resolves SIMBAD identity first (reusing Bloque B's `fetchIdentity`, which
 * is itself never-throwing and cached), reads the `gaiaDr3` cross-id, and
 * only then queries Gaia. Three benign null outcomes, none an error:
 *   - SIMBAD doesn't know the star (faint KOI host) → null.
 *   - SIMBAD knows it but lists no Gaia DR3 id → null.
 *   - Gaia has no such source_id, or is unavailable → null.
 * @param starId App-form star id (e.g. `KIC8462852`).
 * @returns The Gaia descriptive profile, or null.
 */
export async function fetchGaiaForStar(starId: string): Promise<GaiaResult> {
  const identity = await fetchIdentity(starId)
  const sourceId = identity?.gaiaDr3
  if (!sourceId) return null // no SIMBAD record, or no Gaia DR3 cross-id — silently absent
  return fetchGaiaBySourceId(sourceId)
}
