import { NextResponse } from 'next/server'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { simbadIdsQueryUrl } from '@/lib/externalEndpoints'
import { parseSimbadIdentityResponse, type SimbadIdentity } from '@/lib/simbadIds'

/**
 * @description GET /api/identity/[id] — resolves a star's SIMBAD
 * cross-identification record (KIC/TIC/EPIC/HIP/Gaia DR3/2MASS/Tycho ids
 * + common names) on demand. Proxies the CDS SIMBAD TAP service (CORS +
 * the engine-never-networks rule) through the shared `simbadIdsQueryUrl`
 * builder, with a per-star schema-versioned disk cache.
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
 */
const CACHE_SCHEMA_VERSION = 1

/** @description Identifier freshness bound: 30 days (see policy note above). */
const DISK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

const CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')

/**
 * @description Star ids accepted by this route — the app's id alphabet
 * (KIC…/TIC…/EPIC…/HIP…/SYN…), also the safe-filename alphabet for the
 * per-star cache file. Anything else is a 400, not a SIMBAD query.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/

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
 * @description Cache file path for one star id (id is pre-validated
 * against `SAFE_ID`, so it is filename-safe by construction).
 * @param id App-form star id.
 * @returns Absolute cache file path.
 */
function cacheFileFor(id: string): string {
  return path.join(CACHE_DIR, `identity-${id}.json`)
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

  if (!SAFE_ID.test(id)) {
    return NextResponse.json<IdentityResponse>(
      { source: 'unavailable', identity: null, fetchedAt: 0, error: 'invalid star id' },
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
