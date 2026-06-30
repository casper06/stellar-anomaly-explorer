/**
 * @description LocalStorage-backed persistence for cross-session exploration
 * state (visited stars, flagged stars). Used directly rather than wrapped
 * inside Zustand persistence so the storage shape stays explicit and
 * debuggable — open devtools, read the key, see exactly what's there.
 *
 * All reads/writes are wrapped in try/catch because localStorage throws in
 * private mode and when over quota. A throw is treated as "feature off for
 * this session" — the in-memory state still works, it just doesn't survive
 * a reload.
 */

/** @description LocalStorage key for the set of visited star ids. */
export const VISITED_KEY = 'sae_visited'

/** @description LocalStorage key for the set of flagged (bookmarked) star ids. */
export const FLAGGED_KEY = 'sae_flagged'

/**
 * @description Reads a stored JSON array of string ids from localStorage and
 * returns it as a Set. Returns an empty Set on any failure (missing key,
 * malformed JSON, private-mode throw). Caller doesn't need to handle errors.
 * @param key LocalStorage key to read.
 * @returns Set of string ids, possibly empty.
 */
export function loadIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    const out = new Set<string>()
    for (const v of parsed) {
      if (typeof v === 'string') out.add(v)
    }
    return out
  } catch {
    return new Set()
  }
}

/**
 * @description Writes a Set of ids back to localStorage as a JSON array.
 * Silently swallows quota/private-mode throws — the in-memory copy
 * remains valid for the rest of the session.
 * @param key LocalStorage key to write.
 * @param ids Set of string ids to persist.
 */
export function saveIdSet(key: string, ids: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]))
  } catch {
    // Quota / private mode — fall through.
  }
}
