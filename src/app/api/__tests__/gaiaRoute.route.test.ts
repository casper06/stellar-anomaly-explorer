/**
 * @description Route-level tests for the Gaia DR3 handler
 * (`/api/gaia/[source_id]`) — exercising the ACTUAL `GET` to pin the
 * cache/TTL/mirror/body-sniff wiring end to end:
 *   - a FRESH entry (< 30-day TTL) is served from disk with no Gaia fetch;
 *   - an EXPIRED entry triggers a live refetch; success rewrites the cache
 *     and serves `real`;
 *   - an EXPIRED entry + fetch FAILURE serves the expired entry `stale:true`;
 *   - no cache + fetch failure → `unavailable`;
 *   - a MISS (Gaia empty TABLEDATA) is cached as `description: null`;
 *   - the HTTP-200-HTML OUTAGE page is treated as a failure, not trusted
 *     because the status was 200 (the load-bearing body-sniff);
 *   - the AIP mirror is used when ESAC fails, and the response is LABELED
 *     `servedBy: 'aip'` (no silent substitution);
 *   - a classifier fetch failure does NOT sink the profile (bonus layer);
 *   - a schema-version mismatch is refetched even when fresh, never served
 *     as the stale fallback;
 *   - a non-digit source_id is rejected 400 before any network/disk touch.
 *
 * The stubbed `globalThis.fetch` dispatches by URL: `gaia_source` vs
 * `vari_classifier_result`, and ESAC host vs AIP host, so both the
 * two-query profile and the mirror fallback are exercised from real request
 * URLs. VOTable bodies are the FROZEN real fixtures where possible.
 *
 * Run via `npm run test:routes`.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GET } from '@/app/api/gaia/[source_id]/route'

const CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')

/**
 * @description A SYNTHETIC source_id these tests own on disk — never a real
 * one, so a concurrent dev server / E2E run resolving a real source can't
 * clobber the exact cache file we back up and restore (the isolation lesson
 * from the identity route tests). Still 19 digits so it passes SAFE_SOURCE_ID.
 */
const SID = '9999999999999999998'
const CACHE_FILE = path.join(CACHE_DIR, `gaia-${SID}.json`)
const SCHEMA_VERSION = 1
const DAY = 24 * 3600 * 1000

const FIXDIR = path.join(import.meta.dirname, '..', '..', '..', 'lib', '__tests__', 'fixtures', 'gaia')

/** @description Loads a frozen fixture's two VOTable bodies. */
function fixture(realSourceId: string): { source: string; classifier: string } {
  const d = JSON.parse(readFileSync(path.join(FIXDIR, `${realSourceId}.json`), 'utf8'))
  return { source: d.gaiaSource.votable, classifier: d.variClassifier.votable }
}

const TABBY = fixture('2081900940499099136') // NOT_AVAILABLE, RV-variable, no classifier
const HATP7 = fixture('2129256395211984000') // VARIABLE, classifier EP

/** @description An empty (no <TR>) gaia_source VOTable — a "no such source" miss. */
const EMPTY_SOURCE = TABBY.source.replace(/<TR>[\s\S]*?<\/TR>/, '')
/** @description The HTTP-200 HTML outage page C1 observed. */
const OUTAGE_HTML =
  '<html class="ltr" dir="ltr" lang="en-GB"><head><title>ESDC Archives downtime</title></head>' +
  '<body>Maintenance ongoing!</body></html>'

/** @description Invokes the route handler for one source_id. */
async function call(sourceId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET(new Request('http://localhost/api/gaia/' + sourceId), {
    params: Promise.resolve({ source_id: sourceId }),
  })
  return { status: res.status, body: await res.json() }
}

/** @description Writes the route's cache file with a controlled age/version/servedBy. */
async function writeCache(
  description: unknown,
  ageMs: number,
  schemaVersion = SCHEMA_VERSION,
  servedBy = 'esac',
): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true })
  await fs.writeFile(
    CACHE_FILE,
    JSON.stringify({ schemaVersion, fetchedAt: Date.now() - ageMs, description, servedBy }),
    'utf8',
  )
}

/**
 * @description URL-dispatching fetch stub. Routes each request to a VOTable
 * body based on host (ESAC vs AIP) and table (gaia_source vs classifier).
 * A `null` mapping for a host means "that host is down" → throws.
 */
interface StubPlan {
  esac?: { source?: string | 'fail'; classifier?: string | 'fail'; status?: number } | 'down'
  aip?: { source?: string | 'fail'; classifier?: string | 'fail'; status?: number } | 'down'
}
class FetchStub {
  calls: string[] = []
  private original = globalThis.fetch
  install(plan: StubPlan): void {
    this.calls = []
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      this.calls.push(url)
      const isAip = url.includes('gaia.aip.de')
      const host = isAip ? plan.aip : plan.esac
      if (host === undefined || host === 'down') throw new Error(`simulated ${isAip ? 'AIP' : 'ESAC'} outage`)
      const isClassifier = /vari_classifier_result/.test(decodeURIComponent(url))
      const body = isClassifier ? host.classifier : host.source
      if (body === undefined || body === 'fail') throw new Error('simulated query failure')
      return new Response(body, { status: host.status ?? 200 })
    }) as typeof fetch
  }
  restore(): void {
    globalThis.fetch = this.original
  }
  get sourceCalls(): number {
    return this.calls.filter(u => /gaia_source/.test(decodeURIComponent(u))).length
  }
}

const fetchStub = new FetchStub()
let saved: string | null = null

before(async () => {
  try { saved = await fs.readFile(CACHE_FILE, 'utf8') } catch { saved = null }
})
after(async () => {
  if (saved === null) await fs.rm(CACHE_FILE, { force: true })
  else await fs.writeFile(CACHE_FILE, saved, 'utf8')
})
afterEach(async () => {
  fetchStub.restore()
  await fs.rm(CACHE_FILE, { force: true })
})

describe('gaia route — cache + TTL + fallback wiring', () => {
  it('serves a FRESH entry from disk with no Gaia fetch', async () => {
    await writeCache({ sourceId: SID, ruwe: 0.8, ruweBand: 'WITHIN_REFERENCE', rvVariability: 'VARIABLE', photVariable: 'NOT_FLAGGED' }, 1 * DAY)
    fetchStub.install({ esac: { source: TABBY.source, classifier: TABBY.classifier } })
    const { body } = await call(SID)
    assert.equal(body.source, 'cached')
    assert.equal((body.description as Record<string, unknown>).rvVariability, 'VARIABLE')
    assert.equal(body.stale, undefined)
    assert.equal(fetchStub.calls.length, 0, 'fresh cache → no network')
  })

  it('refetches an EXPIRED entry, rewrites the cache, serves real (servedBy esac)', async () => {
    await writeCache(null, 40 * DAY) // > 30-day TTL
    fetchStub.install({ esac: { source: TABBY.source, classifier: TABBY.classifier } })
    const { body } = await call(SID)
    assert.equal(body.source, 'real')
    assert.equal(body.servedBy, 'esac')
    const d = body.description as Record<string, unknown>
    assert.equal(d.rvVariability, 'VARIABLE', 'Tabby is RV-variable per the 4-part criterion')
    assert.equal(d.photVariable, 'NOT_FLAGGED', 'NOT_AVAILABLE must not become "constant"')
    assert.equal(d.classifier, undefined, 'Tabby has no classifier row')
    const onDisk = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))
    assert.ok(Date.now() - onDisk.fetchedAt < 60_000, 'cache fetchedAt is fresh')
    assert.equal(onDisk.servedBy, 'esac')
  })

  it('attaches the bonus classifier when present (HAT-P-7 → EP)', async () => {
    fetchStub.install({ esac: { source: HATP7.source, classifier: HATP7.classifier } })
    const { body } = await call(SID)
    assert.equal(body.source, 'real')
    const d = body.description as Record<string, Record<string, unknown>>
    assert.equal((d.classifier as Record<string, unknown>).className, 'EP')
    assert.equal(d.photVariable as unknown, 'FLAGGED_VARIABLE')
  })

  it('caches a MISS (empty TABLEDATA → description:null) and serves the 2nd request from disk', async () => {
    fetchStub.install({ esac: { source: EMPTY_SOURCE, classifier: EMPTY_SOURCE } })
    const first = await call(SID)
    assert.equal(first.body.source, 'real')
    assert.equal(first.body.description, null, 'no such source_id in DR3')
    const callsAfterFirst = fetchStub.calls.length
    const second = await call(SID)
    assert.equal(second.body.source, 'cached')
    assert.equal(second.body.description, null)
    assert.equal(fetchStub.calls.length, callsAfterFirst, 'miss served from cache, no re-query')
  })

  it('treats an HTTP-200 HTML outage page as a FAILURE (body-sniff, not status-trust)', async () => {
    // ESAC serves the outage HTML at 200; AIP also down → unavailable.
    fetchStub.install({ esac: { source: OUTAGE_HTML, status: 200 }, aip: 'down' })
    const { body } = await call(SID)
    assert.equal(body.source, 'unavailable', 'a 200 with a non-VOTable body must not be trusted')
    assert.ok(body.description === null)
    assert.ok(body.error)
  })

  it('falls back to the AIP mirror when ESAC fails, and LABELS servedBy:aip', async () => {
    fetchStub.install({
      esac: 'down',
      aip: { source: TABBY.source, classifier: TABBY.classifier },
    })
    const { body } = await call(SID)
    assert.equal(body.source, 'real')
    assert.equal(body.servedBy, 'aip', 'mirror substitution is labeled, never silent')
    assert.equal((body.description as Record<string, unknown>).rvVariability, 'VARIABLE')
    assert.ok(fetchStub.calls.some(u => u.includes('gaia.aip.de')), 'AIP was actually queried')
    const onDisk = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))
    assert.equal(onDisk.servedBy, 'aip', 'served-by is persisted for the audit trail')
  })

  it('a classifier fetch failure does NOT sink the profile (bonus layer is best-effort)', async () => {
    // gaia_source succeeds; classifier query fails on BOTH fronts.
    fetchStub.install({
      esac: { source: HATP7.source, classifier: 'fail' },
      aip: { source: HATP7.source, classifier: 'fail' },
    })
    const { body } = await call(SID)
    assert.equal(body.source, 'real', 'the backbone succeeded, so the profile succeeds')
    const d = body.description as Record<string, unknown>
    assert.equal(d.photVariable, 'FLAGGED_VARIABLE')
    assert.equal(d.classifier, undefined, 'classifier degraded to absent, not an error')
  })

  it('serves an EXPIRED entry stale:true when BOTH fronts fail', async () => {
    await writeCache({ sourceId: SID, ruweBand: 'WITHIN_REFERENCE', rvVariability: 'NOT_EVALUATED', photVariable: 'UNKNOWN' }, 40 * DAY)
    fetchStub.install({ esac: 'down', aip: 'down' })
    const { body } = await call(SID)
    assert.equal(body.source, 'cached')
    assert.equal(body.stale, true)
    assert.ok(body.error)
    assert.match(String(body.error), /ESAC.*AIP/, 'both fronts named in the error')
  })

  it('returns unavailable when there is no cache and both fronts fail', async () => {
    fetchStub.install({ esac: 'down', aip: 'down' })
    const { body } = await call(SID)
    assert.equal(body.source, 'unavailable')
    assert.equal(body.description, null)
    assert.ok(body.error)
  })

  it('treats a schema-version mismatch as a miss (refetch even when fresh, never stale fallback)', async () => {
    await writeCache({ sourceId: SID }, 1 * DAY, 0) // fresh but v0
    fetchStub.install({ esac: { source: TABBY.source, classifier: TABBY.classifier } })
    const { body } = await call(SID)
    assert.equal(body.source, 'real', 'mismatched entry refetched despite being fresh')

    await writeCache({ sourceId: SID }, 1 * DAY, 0)
    fetchStub.install({ esac: 'down', aip: 'down' })
    const failed = await call(SID)
    assert.equal(failed.body.source, 'unavailable', 'v0 entry is not a usable fallback')
  })

  it('rejects a non-digit source_id with 400 before any fetch', async () => {
    fetchStub.install({ esac: { source: TABBY.source, classifier: TABBY.classifier } })
    for (const bad of ['KIC8462852', '123/../evil', 'abc', '', '1'.repeat(20)]) {
      const { status } = await call(bad)
      assert.equal(status, 400, `${JSON.stringify(bad)} must be rejected`)
    }
    assert.equal(fetchStub.calls.length, 0, 'no rejected input reached the network')
  })
})
