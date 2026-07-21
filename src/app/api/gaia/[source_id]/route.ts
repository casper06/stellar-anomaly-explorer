import { NextResponse } from 'next/server'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  gaiaSourceQueryUrl,
  gaiaClassifierQueryUrl,
  GAIA_AIP_TAP_SYNC_URL,
} from '@/lib/externalEndpoints'
import {
  parseGaiaSourceVotable,
  parseGaiaClassifierVotable,
  describeGaiaSource,
  isGaiaErrorEnvelope,
  type GaiaDescription,
} from '@/lib/gaiaSource'

/**
 * @description GET /api/gaia/[source_id] — resolves one Gaia DR3 source's
 * descriptive profile (RUWE band + RV-variability + phot-variable reading +
 * supplementary astrometric context, plus the bonus ML classifier when the
 * source is in `vari_classifier_result`). Proxies the ESA Gaia Archive TAP
 * service (CORS + the engine-never-networks rule) through the shared
 * `gaiaSourceQueryUrl` / `gaiaClassifierQueryUrl` builders, with a
 * schema-versioned disk cache. Closest precedent: /api/identity.
 *
 * `[source_id]` is a Gaia DR3 source_id — a bare integer, 18–19 digits. It
 * is validated digits-only before any network/disk touch. The upstream
 * source of this id is the SIMBAD identity chain (C1.4): KIC/TIC/EPIC →
 * SIMBAD → `gaiaDr3` → here. This route does NOT resolve names; it takes a
 * source_id already resolved.
 *
 * Freshness policy: 30-day TTL, matching /api/identity. Gaia DR3 is a
 * FROZEN historical release (unlike KOI/TOI, which are living catalogs), so
 * the data literally does not change — the TTL is not about staleness of
 * content but a bound on how long a cache entry lives before we re-verify
 * the pipeline still works, and a lever to recover from an entry written
 * during a transient outage. A confirmed miss (`description: null` — no such
 * source_id in DR3) is cached too, same as identity's null-caching, so a
 * repeat click on an unlisted source doesn't re-query.
 *
 * Failure modes handled (all found in C1 research, see
 * docs/C1_GAIA_DR3_RESEARCH.md):
 *   - VOTable-not-JSON: we request `votable_plain` and parse VOTable; a
 *     JSON assumption would break.
 *   - Error envelope (`QUERY_STATUS=ERROR`) on a bad query: detected and
 *     reported as a query error, distinct from an outage.
 *   - HTTP-200-with-HTML outage: the body doesn't parse as VOTable with our
 *     columns → treated as a failure, NOT trusted because the status was
 *     200. This is the load-bearing body-sniff.
 *   - AIP mirror fallback: on ESAC failure we try the AIP partner mirror
 *     (C1 found it byte-identical). The served endpoint is LABELED in the
 *     response (`servedBy`) — never a silent substitution, same principle
 *     as the synthetic-data rule.
 *
 * Rate posture: one query pair per user click. Gaia has no CDS-style hard
 * blacklist, but any future batch use must still throttle.
 */

/**
 * @description Cache entry schema version. Bump whenever the query columns,
 * the parsing, the descriptive-engine output shape, or the cache key
 * derivation change in a way that alters stored entries — mismatched
 * entries are treated as a MISS and refetched, never served (the lightcurve
 * cache's rule).
 */
const CACHE_SCHEMA_VERSION = 1

/** @description Freshness bound: 30 days (frozen release; see policy note). */
const DISK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

const CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')

/**
 * @description Accepted source_id shape: a bare integer of 1–19 digits.
 * Gaia DR3 source_ids are up to 19 digits; digits-only both validates the
 * input and guarantees filename safety (no path separators possible), so
 * unlike the identity route there is no separate key-normalization step —
 * the id IS the safe key.
 */
const SAFE_SOURCE_ID = /^[0-9]{1,19}$/

/** @description Which archive front served a live response. Labeled, never silent. */
type ServedBy = 'esac' | 'aip'

/** @description On-disk cache entry. `description: null` = source_id not in DR3. */
interface GaiaCacheEntry {
  schemaVersion: number
  /** Epoch ms of the upstream Gaia fetch that produced this entry. */
  fetchedAt: number
  description: GaiaDescription | null
  /** Which archive front produced this entry (audit trail for the mirror). */
  servedBy: ServedBy
}

/**
 * @description Response shape. `description: null` with source `real`/`cached`
 * means Gaia was successfully consulted and has no such source_id — distinct
 * from `unavailable` (we could not ask). `stale: true` marks an expired entry
 * served because the live refetch failed. `servedBy` names the archive front.
 */
interface GaiaResponse {
  source: 'real' | 'cached' | 'unavailable'
  description: GaiaDescription | null
  fetchedAt: number
  servedBy?: ServedBy
  stale?: boolean
  error?: string
}

/** @description Cache file path for one source_id. */
function cacheFileFor(sourceId: string): string {
  return path.join(CACHE_DIR, `gaia-${sourceId}.json`)
}

/**
 * @description Reads a source's cache entry with its age (freshness is the
 * caller's decision); null on missing/malformed/version-mismatched files.
 * @param sourceId Gaia DR3 source_id.
 * @param tag Log prefix.
 * @returns Entry + age, or null.
 */
async function readGaiaCache(
  sourceId: string,
  tag: string,
): Promise<{ entry: GaiaCacheEntry; ageMs: number } | null> {
  try {
    const raw = await fs.readFile(cacheFileFor(sourceId), 'utf8')
    const parsed = JSON.parse(raw) as Partial<GaiaCacheEntry>
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      console.error(`${tag} cache schema v${parsed.schemaVersion} ≠ v${CACHE_SCHEMA_VERSION}; treating as miss`)
      return null
    }
    if (typeof parsed.fetchedAt !== 'number' || !(parsed.fetchedAt > 0) || parsed.description === undefined) {
      console.error(`${tag} cache entry malformed; treating as miss`)
      return null
    }
    return { entry: parsed as GaiaCacheEntry, ageMs: Date.now() - parsed.fetchedAt }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`${tag} cache read error:`, e)
    return null
  }
}

/**
 * @description Atomically writes a source's cache entry (temp + rename).
 * @param sourceId Gaia DR3 source_id.
 * @param description Descriptive profile, or null for a confirmed miss.
 * @param servedBy Which archive front produced it.
 * @param tag Log prefix.
 * @returns The recorded fetchedAt timestamp.
 */
async function writeGaiaCache(
  sourceId: string,
  description: GaiaDescription | null,
  servedBy: ServedBy,
  tag: string,
): Promise<number> {
  const entry: GaiaCacheEntry = { schemaVersion: CACHE_SCHEMA_VERSION, fetchedAt: Date.now(), description, servedBy }
  const file = cacheFileFor(sourceId)
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
 * @description Fetches one VOTable body from a Gaia TAP URL and body-sniffs
 * it. A non-2xx OR a body that isn't parseable VOTable (the HTTP-200-HTML
 * outage) is a failure; an error envelope is surfaced with its own message.
 * @param url TAP query URL.
 * @param tag Log prefix.
 * @returns The raw VOTable text on success, or an error tag.
 */
async function fetchVotable(url: string, tag: string): Promise<{ votable: string } | { error: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      // A 4xx with an error envelope is a query error; anything else is transport.
      if (isGaiaErrorEnvelope(text)) return { error: `Gaia rejected the query (HTTP ${res.status}, error envelope)` }
      return { error: `Gaia returned HTTP ${res.status}` }
    }
    // HTTP 200 does NOT imply a usable body — Gaia serves outages as 200 +
    // HTML. Sniff for the VOTable shape before trusting it.
    if (isGaiaErrorEnvelope(text)) return { error: 'Gaia returned an error envelope (QUERY_STATUS=ERROR)' }
    if (!/<VOTABLE|<FIELD\b/i.test(text)) {
      console.error(`${tag} HTTP 200 but body is not VOTable (outage HTML?): ${text.slice(0, 160)}`)
      return { error: 'Gaia returned a non-VOTable body (likely an outage page)' }
    }
    return { votable: text }
  } catch (e) {
    return { error: (e as Error).message ?? 'unknown error' }
  }
}

/**
 * @description Fetches + parses one source's full profile from ONE archive
 * front. The classifier query is best-effort: an empty result is the normal
 * silent "not in the table" case, and even a classifier FETCH failure must
 * not sink the whole profile (the backbone is `gaia_source`). Only a
 * `gaia_source` failure fails the profile.
 * @param sourceId Gaia DR3 source_id.
 * @param mirror When set, query the AIP mirror base instead of ESAC.
 * @param tag Log prefix.
 * @returns The description (null = no such source) or an error tag.
 */
async function fetchProfile(
  sourceId: string,
  mirror: boolean,
  tag: string,
): Promise<{ description: GaiaDescription | null } | { error: string }> {
  const rebase = (url: string): string =>
    mirror ? url.replace('https://gea.esac.esa.int/tap-server/tap/sync', GAIA_AIP_TAP_SYNC_URL) : url

  const srcRes = await fetchVotable(rebase(gaiaSourceQueryUrl(sourceId)), tag)
  if ('error' in srcRes) return { error: srcRes.error }

  let sourceRow
  try {
    sourceRow = parseGaiaSourceVotable(srcRes.votable)
  } catch (e) {
    return { error: (e as Error).message }
  }
  if (sourceRow === null) return { description: null } // no such source_id in DR3

  // Bonus layer — never fatal. A fetch/parse failure here degrades to "no
  // classifier", exactly like a source genuinely absent from the table.
  let classifierRow = null
  const clsRes = await fetchVotable(rebase(gaiaClassifierQueryUrl(sourceId)), tag)
  if ('votable' in clsRes) {
    try {
      classifierRow = parseGaiaClassifierVotable(clsRes.votable)
    } catch (e) {
      console.error(`${tag} classifier parse failed (treated as absent):`, (e as Error).message)
    }
  } else {
    console.error(`${tag} classifier fetch failed (treated as absent): ${clsRes.error}`)
  }

  return { description: describeGaiaSource(sourceRow, classifierRow) }
}

/**
 * @description Fetches from ESAC, falling back to the AIP mirror on ESAC
 * failure. Returns which front served it so the caller can LABEL the
 * response — no silent substitution.
 * @param sourceId Gaia DR3 source_id.
 * @param tag Log prefix.
 * @returns Description + servedBy, or an error tag.
 */
async function fetchWithMirrorFallback(
  sourceId: string,
  tag: string,
): Promise<{ description: GaiaDescription | null; servedBy: ServedBy } | { error: string }> {
  const primary = await fetchProfile(sourceId, false, tag)
  if ('description' in primary) return { description: primary.description, servedBy: 'esac' }

  console.error(`${tag} ESAC failed (${primary.error}); trying AIP mirror`)
  const mirror = await fetchProfile(sourceId, true, tag)
  if ('description' in mirror) {
    console.error(`${tag} served by AIP mirror`)
    return { description: mirror.description, servedBy: 'aip' }
  }
  // Both fronts down — report the ESAC (primary) error as the headline.
  return { error: `ESAC: ${primary.error}; AIP: ${mirror.error}` }
}

/**
 * @description Route handler. Fresh cache → served as `cached`. Missing/
 * expired/version-mismatched cache → live fetch (ESAC then AIP); success is
 * written back and served as `real`; failure falls back to an expired
 * same-version entry (`stale: true`) when one exists, else `unavailable`.
 * @param _req Request (unused).
 * @param ctx Route context carrying the dynamic `source_id` segment.
 * @returns JSON `GaiaResponse`.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ source_id: string }> }) {
  const { source_id: sourceId } = await ctx.params
  const tag = `[gaia ${sourceId}]`

  if (!SAFE_SOURCE_ID.test(sourceId)) {
    return NextResponse.json<GaiaResponse>(
      { source: 'unavailable', description: null, fetchedAt: 0, error: 'invalid source_id (expected 1–19 digits)' },
      { status: 400 },
    )
  }

  const cached = await readGaiaCache(sourceId, tag)
  if (cached && cached.ageMs <= DISK_CACHE_TTL_MS) {
    console.error(`${tag} cache HIT (age ${Math.round(cached.ageMs / 3600000)}h, servedBy ${cached.entry.servedBy})`)
    return NextResponse.json<GaiaResponse>({
      source: 'cached',
      description: cached.entry.description,
      fetchedAt: cached.entry.fetchedAt,
      servedBy: cached.entry.servedBy,
    })
  }

  const result = await fetchWithMirrorFallback(sourceId, tag)
  if ('description' in result) {
    const fetchedAt = await writeGaiaCache(sourceId, result.description, result.servedBy, tag)
    return NextResponse.json<GaiaResponse>({
      source: 'real',
      description: result.description,
      fetchedAt,
      servedBy: result.servedBy,
    })
  }

  // Live fetch failed (both fronts) — an expired same-version entry beats nothing.
  if (cached) {
    console.error(`${tag} serving EXPIRED cache (age ${Math.round(cached.ageMs / 86400000)}d) after fetch failure`)
    return NextResponse.json<GaiaResponse>({
      source: 'cached',
      description: cached.entry.description,
      fetchedAt: cached.entry.fetchedAt,
      servedBy: cached.entry.servedBy,
      stale: true,
      error: result.error,
    })
  }

  return NextResponse.json<GaiaResponse>({
    source: 'unavailable',
    description: null,
    fetchedAt: 0,
    error: result.error,
  })
}
