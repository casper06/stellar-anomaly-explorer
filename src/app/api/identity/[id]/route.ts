import { NextResponse } from 'next/server'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { simbadIdsQueryUrl } from '@/lib/externalEndpoints'
import { parseSimbadIdentityResponse, type SimbadIdentity } from '@/lib/simbadIds'

/**
 * @description GET /api/identity/[id] — resolves a SIMBAD
 * cross-identification record (KIC/TIC/EPIC/HIP/Gaia DR3/2MASS/Tycho ids
 * + common names) on demand. Proxies the CDS SIMBAD TAP service (CORS +
 * the engine-never-networks rule) through the shared `simbadIdsQueryUrl`
 * builder, with a schema-versioned disk cache.
 *
 * The `[id]` segment is any SIMBAD lookup key — an app star id
 * (`KIC8462852`, the phase-B3-mechanism-(a) panel path) OR a free-text
 * name (`Boyajian's Star`, the mechanism-(b) search path). One route
 * serves both because the underlying ADQL joins SIMBAD's `ident`
 * table, which matches ANY alias: upstream, an id and a name are the
 * same query. Callers differ only in how they interpret the result —
 * the panel wants the names, the search box wants the cross-ids.
 *
 * Freshness policy (design 2026-07-17, phase B1): 30-day TTL. SIMBAD is
 * a living compilation but IDENTIFIER data is nearly append-only (ids
 * arrive with major catalog releases, essentially never change or
 * leave), so monthly matches the Hipparcos/centroid cache tier. Two
 * deliberate behaviors on top:
 *   - An EXPIRED cache entry is served (flagged `stale: true`) when the
 *     live refetch fails — graceful degradation, the KOI-outage lesson.
 *   - Empty results (“not in SIMBAD”, the common case for faint KOI
 *     hosts) are cached too, as `identity: null` with the same TTL —
 *     otherwise every click on an unlisted star would re-query.
 *
 * Rate posture: one query per user click (~0.3–2.4 s measured), orders
 * of magnitude under CDS's ~5–10 queries/second blacklist threshold.
 * Never batch through this route without throttling.
 */

/**
 * @description Cache entry schema version. Bump whenever the ADQL query,
 * the `SimbadIdentity` shape, or the parsing/normalization rules change
 * in a way that alters stored entries — mismatched entries are treated
 * as a MISS and refetched, never served (same rationale as the
 * lightcurve cache's versioning).
 *
 * v2 (2026-07-18, phase B3 mechanism (b)): cache keys are now
 * normalized (lowercased, whitespace-collapsed) by `cacheKeyFor`, so
 * v1 files sit under different names — `identity-KIC8462852.json`
 * became `identity-kic8462852.json`. The version bump is what makes
 * that a clean one-time refetch instead of a silent orphan: v1 files
 * are simply never read again. They age out with the tmpdir; nothing
 * reads or serves them in the meantime.
 */
const CACHE_SCHEMA_VERSION = 2

/** @description Identifier freshness bound: 30 days (see policy note above). */
const DISK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

const CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')

/**
 * @description Lookup keys accepted by this route. Deliberately WIDER
 * than the app's id alphabet: phase B3 mechanism (b) resolves free-text
 * NAMES through this same route (SIMBAD's `ident` join matches any
 * alias, so a name and an id are the same kind of query upstream), and
 * real names carry spaces, apostrophes, and plus signs — "Boyajian's
 * Star", "BD+47 2846", "alf Ori".
 *
 * This is an input-shape guard, NOT the filename guard: cache
 * filenames are derived separately by `cacheKeyFor`, so widening the
 * accepted alphabet cannot widen what reaches the filesystem. The
 * character class stays a conservative allowlist (letters, digits, and
 * a handful of punctuation that occurs in real designations) rather
 * than accepting anything, so obviously-junk input is still rejected
 * before it costs a SIMBAD query. ADQL injection is separately
 * neutralized by the quote-escaping in `simbadIdsQueryUrl`.
 */
const SAFE_LOOKUP = /^[A-Za-z0-9 ._'+*-]{1,64}$/

/** @description On-disk cache entry. `identity: null` = confirmed not in SIMBAD. */
interface IdentityCacheEntry {
  schemaVersion: number
  /** Epoch ms of the upstream SIMBAD fetch that produced this entry. */
  fetchedAt: number
  identity: SimbadIdentity | null
}

/**
 * @description Response shape. `identity: null` with source
 * `real`/`cached` means SIMBAD was successfully consulted and does not
 * know the object — distinct from `unavailable` (we could not ask).
 * `stale: true` marks an expired cache entry served because the live
 * refetch failed.
 */
interface IdentityResponse {
  source: 'real' | 'cached' | 'unavailable'
  identity: SimbadIdentity | null
  /** Epoch ms of the upstream fetch that produced `identity` (0 for unavailable). */
  fetchedAt: number
  stale?: boolean
  error?: string
}

/**
 * @description Derives a filename-safe, case-insensitive cache key
 * from a lookup key.
 *
 * Two jobs, both load-bearing since names joined the id alphabet:
 *   1. SAFETY. `SAFE_LOOKUP` now admits spaces, apostrophes and `+`,
 *      none of which belong in a filename. Every character outside
 *      `[A-Za-z0-9._-]` is replaced, so the key is filename-safe by
 *      construction rather than by trusting the input guard. (Path
 *      traversal was already impossible — `.` and `-` are allowed but
 *      `/` and `\` never were — and this keeps it that way
 *      independently of the input regex.)
 *   2. CACHE HIT RATE. SIMBAD's matching is case- and
 *      whitespace-insensitive (measured: "Boyajian's Star",
 *      "BOYAJIAN'S STAR" and "boyajian's star" return one record), so
 *      those must share one cache entry instead of three. Lowercasing
 *      and collapsing whitespace makes the key agree with upstream
 *      semantics.
 * @param lookup Pre-validated lookup key (app star id or free-text name).
 * @returns Filename-safe cache key.
 */
function cacheKeyFor(lookup: string): string {
  return lookup.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_')
}

/**
 * @description Cache file path for one lookup key.
 * @param lookup Pre-validated lookup key.
 * @returns Absolute cache file path.
 */
function cacheFileFor(lookup: string): string {
  return path.join(CACHE_DIR, `identity-${cacheKeyFor(lookup)}.json`)
}

/**
 * @description Reads a star's identity cache entry. Returns the entry
 * with its age regardless of TTL (freshness is the caller's decision);
 * null on missing/malformed/legacy files or a schema-version mismatch
 * (mismatched entries are never served — they were written by different
 * parsing rules).
 * @param id App-form star id.
 * @param tag Log prefix.
 * @returns Entry + age, or null.
 */
async function readIdentityCache(
  id: string,
  tag: string,
): Promise<{ entry: IdentityCacheEntry; ageMs: number } | null> {
  try {
    const raw = await fs.readFile(cacheFileFor(id), 'utf8')
    const parsed = JSON.parse(raw) as Partial<IdentityCacheEntry>
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      console.error(`${tag} cache schema v${parsed.schemaVersion} ≠ v${CACHE_SCHEMA_VERSION}; treating as miss`)
      return null
    }
    if (typeof parsed.fetchedAt !== 'number' || !(parsed.fetchedAt > 0) || parsed.identity === undefined) {
      console.error(`${tag} cache entry malformed; treating as miss`)
      return null
    }
    return {
      entry: parsed as IdentityCacheEntry,
      ageMs: Date.now() - parsed.fetchedAt,
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${tag} cache read error:`, e)
    }
    return null
  }
}

/**
 * @description Atomically writes a star's identity cache entry
 * (temp + rename, the app-wide pattern).
 * @param id App-form star id.
 * @param identity Parsed identity, or null for a confirmed miss.
 * @param tag Log prefix.
 * @returns The recorded fetchedAt timestamp.
 */
async function writeIdentityCache(id: string, identity: SimbadIdentity | null, tag: string): Promise<number> {
  const entry: IdentityCacheEntry = { schemaVersion: CACHE_SCHEMA_VERSION, fetchedAt: Date.now(), identity }
  const file = cacheFileFor(id)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(entry), 'utf8')
    await fs.rename(tmp, file)
  } catch (e) {
    console.error(`${tag} cache write error:`, e)
    try { await fs.unlink(tmp) } catch { /* ignore */ }
  }
  return entry.fetchedAt
}

/**
 * @description Fetches and parses one star's identity from the live
 * SIMBAD TAP service. Distinguishes the VOTable XML error envelope
 * (SIMBAD returns it for query errors even with `FORMAT=json`) from a
 * JSON contract violation so the log line is actionable.
 * @param id App-form star id (passed verbatim — SIMBAD's identifier
 * matching is whitespace-normalized, measured 2026-07-17).
 * @param tag Log prefix.
 * @returns The identity (null = not in SIMBAD) or a short error tag.
 */
async function fetchFromSimbad(
  id: string,
  tag: string,
): Promise<{ identity: SimbadIdentity | null } | { error: string }> {
  try {
    console.error(`${tag} querying SIMBAD TAP…`)
    const res = await fetch(simbadIdsQueryUrl(id), { signal: AbortSignal.timeout(20000) })
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>')
      console.error(`${tag} SIMBAD HTTP ${res.status}; body (first 300): ${body.slice(0, 300)}`)
      return { error: `SIMBAD returned HTTP ${res.status}` }
    }
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      // Query errors arrive as a VOTable XML envelope even with FORMAT=json.
      const votableError = /QUERY_STATUS[^>]*ERROR/.test(text)
      console.error(`${tag} SIMBAD non-JSON response${votableError ? ' (VOTable error envelope)' : ''}: ${text.slice(0, 300)}`)
      return { error: votableError ? 'SIMBAD rejected the query (VOTable error envelope)' : 'SIMBAD response was not JSON' }
    }
    const identity = parseSimbadIdentityResponse(body)
    console.error(`${tag} SIMBAD ${identity ? `resolved: ${identity.mainId} (${identity.allIds.length} ids)` : 'has no record (miss — cached)'}`)
    return { identity }
  } catch (e) {
    console.error(`${tag} SIMBAD fetch failed:`, e)
    return { error: (e as Error).message ?? 'unknown error' }
  }
}

/**
 * @description Route handler. Fresh cache → served as `cached`. Missing/
 * expired/version-mismatched cache → live fetch; success is written back
 * and served as `real`; failure falls back to an expired same-version
 * entry (`stale: true`) when one exists, else `unavailable`.
 * @param _req Request (unused).
 * @param ctx Route context carrying the dynamic `id` segment.
 * @returns JSON `IdentityResponse`.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const tag = `[identity ${id}]`

  if (!SAFE_LOOKUP.test(id)) {
    return NextResponse.json<IdentityResponse>(
      { source: 'unavailable', identity: null, fetchedAt: 0, error: 'invalid lookup key' },
      { status: 400 },
    )
  }

  const cached = await readIdentityCache(id, tag)
  if (cached && cached.ageMs <= DISK_CACHE_TTL_MS) {
    console.error(`${tag} cache HIT (age ${Math.round(cached.ageMs / 3600000)}h)`)
    return NextResponse.json<IdentityResponse>({
      source: 'cached',
      identity: cached.entry.identity,
      fetchedAt: cached.entry.fetchedAt,
    })
  }

  const result = await fetchFromSimbad(id, tag)
  if ('identity' in result) {
    const fetchedAt = await writeIdentityCache(id, result.identity, tag)
    return NextResponse.json<IdentityResponse>({
      source: 'real',
      identity: result.identity,
      fetchedAt,
    })
  }

  // Live fetch failed — an expired same-version entry beats nothing.
  if (cached) {
    console.error(`${tag} serving EXPIRED cache (age ${Math.round(cached.ageMs / 86400000)}d) after fetch failure`)
    return NextResponse.json<IdentityResponse>({
      source: 'cached',
      identity: cached.entry.identity,
      fetchedAt: cached.entry.fetchedAt,
      stale: true,
      error: result.error,
    })
  }

  return NextResponse.json<IdentityResponse>({
    source: 'unavailable',
    identity: null,
    fetchedAt: 0,
    error: result.error,
  })
}
