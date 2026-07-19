import type { SimbadIdentity } from './simbadIds'

/**
 * @description Resolves a SIMBAD identity to a star the app actually
 * RENDERS — the load-bearing half of the "ask SIMBAD" search escape
 * hatch (phase B3 mechanism (b)).
 *
 * The distinction this module exists to draw: "did SIMBAD find
 * something" and "did SIMBAD find something WE have" are different
 * questions, and only the second one can be acted on. SIMBAD indexes
 * millions of objects; the app renders the Hipparcos main catalog plus
 * the KOI/TOI merges plus 11 seeds. Flying the camera at a resolved
 * position without checking membership would point the user at empty
 * sky and call it a result.
 *
 * Why membership is tested against the LIVE in-memory catalog rather
 * than the object's SIMBAD type or the mere presence of a catalog id
 * (both measured 2026-07-18, both rejected):
 *   - Object type is not a proxy. `3C 273` is a BL Lac quasar that
 *     nonetheless carries `HIP 60936` and `EPIC 229151988`.
 *   - Carrying a KIC/TIC/EPIC/HIP id is not a proxy either. Betelgeuse
 *     and Vega both carry a TIC (TESS observed most of the bright sky);
 *     TRAPPIST-1 carries both a TIC and an EPIC. None of those are in
 *     the KOI/TOI candidate merge, so a presence test would "succeed"
 *     and then fly to a star that is not there.
 * Only the catalog the user is looking at can answer the question, so
 * the caller passes it in.
 */

/**
 * @description Outcome of resolving a typed name through SIMBAD and
 * back into the app's own catalog.
 *
 * Three outcomes, deliberately distinct because each one warrants
 * different UI copy — collapsing them would reproduce exactly the
 * "silently failing" ambiguity this feature exists to remove:
 *   - `matched`: SIMBAD knew the name AND one of its cross-ids is a
 *     star we render. Behaves like an ordinary successful search.
 *   - `not-tracked`: SIMBAD knew the name, but nothing it returned is
 *     in our catalog. An honest, informative dead end — NOT an error.
 *   - `unknown`: SIMBAD does not know the name (or we could not ask).
 */
export type NameResolution =
  | { outcome: 'matched'; starId: string; identity: SimbadIdentity; matchedVia: string }
  | { outcome: 'not-tracked'; identity: SimbadIdentity }
  | { outcome: 'unknown' }

/**
 * @description Minimal shape this module needs from a catalog star —
 * structurally satisfied by the store's `Star`. Kept local so the
 * membership test stays independently testable without importing the
 * store (and its React/Zustand dependency chain) into a pure module.
 */
export interface CatalogEntry {
  id: string
}

/**
 * @description The app's id forms, paired with the `SimbadIdentity`
 * field holding the corresponding BARE catalog value.
 *
 * Order is preference order, and it is intentional: KIC and TIC come
 * first because a hit there means the star carries real mission
 * photometry (the whole point of the app). EPIC is next (K2 seeds like
 * K2-22 → EPIC201637175). HIP is LAST — a Hipparcos hit means we can
 * point at the star, but it is a background object with no light
 * curve, so it is the weakest useful answer and must not win over a
 * mission target that is also present.
 */
const ID_FORMS: ReadonlyArray<{ prefix: string; field: keyof SimbadIdentity }> = [
  { prefix: 'KIC', field: 'kic' },
  { prefix: 'TIC', field: 'tic' },
  { prefix: 'EPIC', field: 'epic' },
  { prefix: 'HIP', field: 'hip' },
]

/**
 * @description Finds the first app-form star id from a SIMBAD identity
 * that is present in the given catalog.
 * @param identity Resolved SIMBAD identity.
 * @param catalogIds Set of ids the app currently renders.
 * @returns The matching app-form id and the SIMBAD id form it came
 * from, or null when nothing matched.
 */
function findCatalogId(
  identity: SimbadIdentity,
  catalogIds: ReadonlySet<string>,
): { starId: string; matchedVia: string } | null {
  for (const { prefix, field } of ID_FORMS) {
    const bare = identity[field]
    if (typeof bare !== 'string' || !bare) continue
    const starId = `${prefix}${bare}`
    if (catalogIds.has(starId)) return { starId, matchedVia: `${prefix} ${bare}` }
  }
  return null
}

/**
 * @description Classifies a SIMBAD identity against the app's catalog.
 * Pure — the network call is the caller's job, so this stays trivially
 * unit-testable against the frozen fixtures.
 * @param identity Resolved identity, or null when SIMBAD returned a
 * miss / could not be reached (both collapse to `unknown`: from the
 * search box's perspective "SIMBAD doesn't know it" and "SIMBAD didn't
 * answer" are the same dead end, and the route already handles the
 * caching distinction between them).
 * @param catalog Stars the app currently renders.
 * @returns The resolution outcome.
 */
export function resolveAgainstCatalog(
  identity: SimbadIdentity | null,
  catalog: readonly CatalogEntry[],
): NameResolution {
  if (!identity) return { outcome: 'unknown' }
  const catalogIds = new Set(catalog.map(s => s.id))
  const hit = findCatalogId(identity, catalogIds)
  if (!hit) return { outcome: 'not-tracked', identity }
  return { outcome: 'matched', starId: hit.starId, identity, matchedVia: hit.matchedVia }
}

/**
 * @description Picks the most recognizable label for an identity, for
 * "SIMBAD recognizes X" copy. Prefers a common name over `main_id`,
 * which is frequently an obscure catalog designation (Tabby's Star is
 * `TYC 3162-665-1`, HAT-P-7 is `BD+47 2846`) that would read as a
 * non-answer to a user who typed a colloquial name.
 * @param identity Resolved SIMBAD identity.
 * @returns A display label, never empty.
 */
export function identityLabel(identity: SimbadIdentity): string {
  return identity.commonNames[0] ?? identity.mainId
}
