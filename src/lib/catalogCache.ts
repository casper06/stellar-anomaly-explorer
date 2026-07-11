/**
 * @description Disk-cache read/write + freshness helpers shared by the
 * KOI and TOI catalog routes. Exists to give catalog CONTENT an explicit
 * freshness policy — a different staleness risk than the lightcurve /
 * pattern-cache SCHEMA versioning (which guards against our own pipeline
 * changing): NASA's KOI/TOI tables are living data whose rows revise
 * under our feet (dispositions get demoted after refutations; TESS adds
 * TOIs continuously), so this is about how old a faithful copy is
 * allowed to get, not about whether the copy was written by compatible
 * code.
 *
 * Design (2026-07-08):
 * - The cache file persists `fetchedAt` alongside the rows (previously
 *   only `{rows}` was stored and the routes reported `fetchedAt:
 *   Date.now()` even for day-old cached data — the age was invisible
 *   and the response actively misleading). Legacy files without
 *   `fetchedAt` read as a cache miss; the one-time refetch after
 *   deploy is the migration.
 * - Stale-while-revalidate, not hard TTL: `readCatalogCache` returns
 *   whatever exists regardless of age and reports the age; the route
 *   serves it immediately and triggers a background refresh when it's
 *   past TTL. Two reasons: (1) a hard TTL turns every expiry into a
 *   5–15 s blocking TAP fetch for whoever loads the app next, and
 *   (2) under the old code an expired cache was DISCARDED, so
 *   TTL-expiry + NASA outage = "CATALOG UNAVAILABLE" despite a
 *   perfectly usable copy on disk. Stale-but-labeled beats absent:
 *   the response carries the true `fetchedAt` so staleness is
 *   queryable, never silent.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** @description Parsed cache file: rows plus when they were fetched. */
export interface CatalogCacheEntry<Row> {
  rows: Row[]
  /** Epoch ms of the upstream TAP fetch that produced these rows. */
  fetchedAt: number
  /** Age at read time, ms. */
  ageMs: number
}

/**
 * @description Reads a catalog cache file. Returns the entry REGARDLESS
 * of age (freshness is the caller's policy decision — see the SWR note
 * above); null when the file is missing, malformed, empty, or a legacy
 * pre-`fetchedAt` write.
 * @param file Absolute path of the cache file.
 * @param tag Log prefix, e.g. "[koi]".
 * @returns Entry with rows, fetchedAt, and computed age — or null.
 */
export async function readCatalogCache<Row>(
  file: string,
  tag: string,
): Promise<CatalogCacheEntry<Row> | null> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as { rows?: Row[]; fetchedAt?: number }
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
      console.error(`${tag} disk cache malformed; ignoring`)
      return null
    }
    if (typeof parsed.fetchedAt !== 'number' || !(parsed.fetchedAt > 0)) {
      console.error(`${tag} disk cache is a legacy pre-fetchedAt write; treating as miss`)
      return null
    }
    const ageMs = Date.now() - parsed.fetchedAt
    return { rows: parsed.rows, fetchedAt: parsed.fetchedAt, ageMs }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${tag} disk cache read error:`, e)
    }
    return null
  }
}

/**
 * @description Atomically writes rows + fetchedAt to the cache file
 * (temp + rename, same pattern as every other disk cache in the app).
 * @param file Absolute path of the cache file.
 * @param rows Catalog rows to persist.
 * @param tag Log prefix.
 * @returns The fetchedAt timestamp recorded in the file.
 */
export async function writeCatalogCache<Row>(
  file: string,
  rows: Row[],
  tag: string,
): Promise<number> {
  const fetchedAt = Date.now()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify({ fetchedAt, rows }), 'utf8')
    await fs.rename(tmp, file)
    console.error(`${tag} disk cache WROTE ${rows.length} rows → ${file}`)
  } catch (e) {
    console.error(`${tag} disk cache write error:`, e)
    try { await fs.unlink(tmp) } catch { /* ignore */ }
  }
  return fetchedAt
}
