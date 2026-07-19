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

/**
 * @description Resolves a user-typed NAME (rather than an app star id)
 * through the same route — the search box's explicit "ask SIMBAD"
 * action, phase B3 mechanism (b).
 *
 * Same route, same cache, same rate posture; the only difference is
 * what goes in. That works because the route's ADQL joins SIMBAD's
 * `ident` table, which matches ANY alias of an object — so a
 * colloquial name resolves exactly like a catalog id does (measured
 * 2026-07-18: "Boyajian's Star", "BOYAJIAN'S STAR" and "boyajian's
 * star" all return the same record, 0.3–1.7 s). No new endpoint, no
 * new query builder.
 *
 * Rate posture: this is safe ONLY because it fires on an explicit
 * keypress, one query per press. It must never be wired to typing —
 * see the CDS blacklist threshold in `externalEndpoints.ts`.
 *
 * Distinct from `fetchIdentity` in one way that matters: it reports
 * FAILURE separately from a miss. The panel can treat both as "show
 * nothing", but the search box cannot — "SIMBAD doesn't know that
 * name" and "we couldn't reach SIMBAD" need different copy, and
 * showing the first when the second happened would be a lie.
 * @param name Free-text name as typed by the user.
 * @returns The identity, `null` for a confirmed miss, or `'error'`
 * when SIMBAD could not be consulted at all.
 */
export async function fetchIdentityByName(
  name: string,
): Promise<SimbadIdentity | null | 'error'> {
  const trimmed = name.trim()
  if (!trimmed) return null
  try {
    const res = await fetch(`/api/identity/${encodeURIComponent(trimmed)}`)
    if (!res.ok) return 'error'
    const data = (await res.json()) as {
      source?: string
      identity?: SimbadIdentity | null
    }
    // `unavailable` means the route could not ask (outage / bad
    // response), NOT that the object is unknown — surfacing that as
    // "no such name" would misattribute our own failure to the user.
    if (data.source === 'unavailable') return 'error'
    return data.identity ?? null
  } catch {
    return 'error'
  }
}
