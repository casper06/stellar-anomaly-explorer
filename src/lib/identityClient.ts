import type { SimbadIdentity } from './simbadIds'

/**
 * @description Browser fetch wrapper for `/api/identity/[id]` — the SIMBAD
 * cross-identifier resolver. Mirrors `centroidClient.ts`: thin, no
 * retries, and it NEVER throws. Identity is bonus context in the panel
 * ("also known as"), not a core feature, so every failure mode collapses
 * to the same benign answer — `null`, which the UI renders as nothing at
 * all rather than as an error state.
 *
 * The route already distinguishes `identity: null` (SIMBAD consulted, the
 * object is genuinely unknown to it — the common case for faint KOI
 * hosts) from `source: 'unavailable'` (we could not ask). That
 * distinction matters server-side for CACHING — a confirmed miss is
 * cached, an outage is not — but it does not matter to the panel: both
 * mean "no alternate names to show", and both must stay silent. So this
 * wrapper deliberately flattens them.
 */

/** @description Client-side result. `null` = nothing to display, for any reason. */
export type IdentityResult = SimbadIdentity | null

/**
 * @description Resolves one star's SIMBAD identity through the app's own
 * route (never CDS directly — CORS, and the route owns the cache and the
 * rate posture).
 *
 * Rate posture inherited from the route: one query per user selection is
 * orders of magnitude below CDS's ~5–10 queries/second blacklist
 * threshold. Do NOT call this in a loop or per-keystroke — that is
 * exactly the pattern the B1 investigation warned against, and it is why
 * search-by-common-name folds in identities already resolved by
 * selection instead of querying as the user types.
 * @param starId App-form star id (e.g. `KIC8462852`).
 * @returns The identity, or null on a miss, an outage, or any error.
 */
export async function fetchIdentity(starId: string): Promise<IdentityResult> {
  try {
    const res = await fetch(`/api/identity/${encodeURIComponent(starId)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { identity?: SimbadIdentity | null }
    return data.identity ?? null
  } catch {
    // Deliberately silent: an unreachable identity route must not log
    // noise on every selection, and the panel shows nothing either way.
    return null
  }
}
