/**
 * @description Unit tests for the external URL builders
 * (`lib/externalEndpoints.ts`) — pure string-in/string-out, no network.
 *
 * These matter more than typical URL-building tests because this module
 * is the app's no-drift seam: the API routes AND the live health check
 * import the same builders, so a silent change here changes what
 * production sends. The assertions therefore check the SEMANTICS of each
 * query (which collection, which table, which columns, which predicate)
 * rather than a frozen string blob, which would break on any harmless
 * reordering while catching nothing meaningful.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAST_TAP_BASE,
  SIMBAD_TAP_SYNC_URL,
  mastTapQueryUrl,
  mastConeSearchUrl,
  resolveSegmentDownloadUrl,
  deriveTessTpfUrl,
  simbadIdsQueryUrl,
} from '../externalEndpoints.ts'

/**
 * @description Pulls a decoded query parameter out of a built URL.
 * Using `URL`/`URLSearchParams` (rather than regexing the raw string)
 * means the test reads the value the SERVER will read, so an encoding
 * bug shows up as a wrong value instead of being masked.
 * @param url Full URL string.
 * @param param Parameter name.
 * @returns Decoded parameter value.
 */
function param(url: string, param: string): string {
  const v = new URL(url).searchParams.get(param)
  assert.ok(v !== null, `expected a '${param}' parameter in ${url}`)
  return v
}

describe('mastTapQueryUrl', () => {
  it('builds a Kepler obscore query for the given target', () => {
    const url = mastTapQueryUrl('Kepler', 'kplr008462852')
    assert.ok(url.startsWith(MAST_TAP_BASE), 'points at the MAST TAP base')
    assert.equal(param(url, 'LANG'), 'ADQL')
    assert.equal(param(url, 'FORMAT'), 'json')
    assert.equal(param(url, 'REQUEST'), 'doQuery')

    const q = param(url, 'QUERY')
    assert.match(q, /FROM ivoa\.obscore/)
    assert.match(q, /obs_collection='Kepler'/)
    assert.match(q, /dataproduct_type='timeseries'/)
    assert.match(q, /target_name='kplr008462852'/)
    // The columns the route's parser reads by name.
    for (const col of ['obs_id', 'access_url', 'access_format']) {
      assert.ok(q.includes(col), `selects ${col}`)
    }
  })

  it('builds a TESS query differing only in the collection', () => {
    const kepler = mastTapQueryUrl('Kepler', 'X')
    const tess = mastTapQueryUrl('TESS', 'X')
    assert.notEqual(kepler, tess)
    assert.match(param(tess, 'QUERY'), /obs_collection='TESS'/)
    // Same target, same everything else: the mission is the only axis.
    assert.equal(
      param(kepler, 'QUERY').replace("'Kepler'", "'M'"),
      param(tess, 'QUERY').replace("'TESS'", "'M'"),
    )
  })

  it('percent-encodes the query so spaces and quotes survive transport', () => {
    const url = mastTapQueryUrl('TESS', '185336364')
    // The RAW url must not contain literal spaces or apostrophes.
    const rawQuery = url.split('QUERY=')[1]
    assert.ok(!rawQuery.includes(' '), 'no raw spaces in the encoded query')
    assert.ok(!rawQuery.includes("'"), 'no raw apostrophes in the encoded query')
    // …but the decoded value must.
    assert.match(param(url, 'QUERY'), /target_name='185336364'/)
  })

  it('round-trips a target name containing characters that need encoding', () => {
    // Not a real target form, but it proves the builder does not
    // hand-roll escaping: whatever goes in comes back out intact.
    const odd = 'kplr 00846+2852'
    assert.match(param(mastTapQueryUrl('Kepler', odd), 'QUERY'), /target_name='kplr 00846\+2852'/)
  })
})

describe('mastConeSearchUrl', () => {
  it('defaults to a 0.001° radius and queries BOTH collections', () => {
    const q = param(mastConeSearchUrl(301.5642, 44.4567), 'QUERY')
    assert.match(q, /obs_collection IN \('Kepler','TESS'\)/)
    assert.match(q, /CONTAINS\(POINT\('ICRS', s_ra, s_dec\), CIRCLE\('ICRS', 301\.5642, 44\.4567, 0\.001\)\)=1/)
    assert.match(q, /dataproduct_type='timeseries'/)
    // The cone path needs obs_collection + target_name back to continue
    // through the normal fetch pipeline.
    assert.ok(q.includes('obs_collection'), 'selects obs_collection')
    assert.ok(q.includes('target_name'), 'selects target_name')
  })

  it('honors an explicit radius', () => {
    const q = param(mastConeSearchUrl(10, -20, 0.05), 'QUERY')
    assert.match(q, /CIRCLE\('ICRS', 10, -20, 0\.05\)/)
  })

  it('handles negative declinations without mangling the sign', () => {
    const q = param(mastConeSearchUrl(174.32, -4.67), 'QUERY')
    assert.match(q, /CIRCLE\('ICRS', 174\.32, -4\.67, 0\.001\)/)
  })
})

describe('resolveSegmentDownloadUrl', () => {
  it('routes a TESS mast: URI through the MAST Download API', () => {
    const access =
      'https://mast.stsci.edu/portal/Download/file?uri=' +
      encodeURIComponent('mast:TESS/product/tess2022190063128-s0054-0000000185336364-0227-s_lc.fits')
    const out = resolveSegmentDownloadUrl(access)
    assert.ok(out.startsWith('https://mast.stsci.edu/api/v0.1/Download/file?uri='))
    // The inner URI must be re-encoded, not pasted raw.
    assert.equal(
      decodeURIComponent(out.split('uri=')[1]),
      'mast:TESS/product/tess2022190063128-s0054-0000000185336364-0227-s_lc.fits',
    )
  })

  it('upgrades a Kepler http: inner URI to https', () => {
    const access =
      'https://mast.stsci.edu/portal/Download/file?uri=' +
      encodeURIComponent('http://archive.stsci.edu/pub/kepler/lightcurves/kplr008462852_llc.fits')
    assert.equal(
      resolveSegmentDownloadUrl(access),
      'https://archive.stsci.edu/pub/kepler/lightcurves/kplr008462852_llc.fits',
    )
  })

  it('leaves an already-https inner URI unchanged', () => {
    const inner = 'https://archive.stsci.edu/pub/kepler/x_llc.fits'
    const access = `https://mast.stsci.edu/portal/Download/file?uri=${encodeURIComponent(inner)}`
    assert.equal(resolveSegmentDownloadUrl(access), inner)
  })

  it('passes through a plain URL that carries no uri= parameter', () => {
    const plain = 'https://archive.stsci.edu/pub/kepler/kplr008462852_llc.fits'
    assert.equal(resolveSegmentDownloadUrl(plain), plain)
  })

  it('finds uri= when it is not the first query parameter', () => {
    const access =
      'https://mast.stsci.edu/portal/Download/file?foo=1&uri=' +
      encodeURIComponent('https://archive.stsci.edu/x_llc.fits')
    assert.equal(resolveSegmentDownloadUrl(access), 'https://archive.stsci.edu/x_llc.fits')
  })
})

describe('deriveTessTpfUrl', () => {
  const LC_URI = 'mast:TESS/product/tess2022190063128-s0054-0000000185336364-0227-s_lc.fits'

  it('swaps the -s_lc.fits suffix for -s_tp.fits', () => {
    const out = deriveTessTpfUrl(`https://x/?uri=${encodeURIComponent(LC_URI)}`)
    assert.ok(out, 'derivation expected to succeed')
    assert.equal(
      decodeURIComponent(out.split('uri=')[1]),
      'mast:TESS/product/tess2022190063128-s0054-0000000185336364-0227-s_tp.fits',
    )
  })

  it('accepts a bare mast: URI with no wrapping URL', () => {
    const out = deriveTessTpfUrl(LC_URI)
    assert.ok(out)
    assert.match(decodeURIComponent(out), /-s_tp\.fits$/)
  })

  it('returns null for a KEPLER product (wrong collection prefix)', () => {
    // The null path is the load-bearing one: /api/centroid must skip a
    // segment rather than request a URL that cannot exist.
    assert.equal(deriveTessTpfUrl('mast:Kepler/product/kplr008462852-s_lc.fits'), null)
  })

  it('returns null for a TESS product that is not a -s_lc.fits row', () => {
    assert.equal(deriveTessTpfUrl('mast:TESS/product/tess2022190063128-s0054-0227-s_fast-lc.fits'), null)
    assert.equal(deriveTessTpfUrl('mast:TESS/product/tess2022190063128-s0054-0227-dvr.pdf'), null)
    // Already a TPF — deriving again is not meaningful.
    assert.equal(deriveTessTpfUrl('mast:TESS/product/tess2022190063128-s0054-0227-s_tp.fits'), null)
  })

  it('returns null for junk input rather than throwing', () => {
    assert.equal(deriveTessTpfUrl(''), null)
    assert.equal(deriveTessTpfUrl('not a url'), null)
    assert.equal(deriveTessTpfUrl('https://example.com/file.fits'), null)
  })
})

describe('simbadIdsQueryUrl', () => {
  it('builds an ADQL identifier lookup joining basic ⋈ ids ⋈ ident', () => {
    const url = simbadIdsQueryUrl('KIC8462852')
    assert.ok(url.startsWith(SIMBAD_TAP_SYNC_URL))
    assert.equal(param(url, 'REQUEST'), 'doQuery')
    assert.equal(param(url, 'LANG'), 'ADQL')
    assert.equal(param(url, 'FORMAT'), 'json')

    const q = param(url, 'QUERY')
    assert.match(q, /FROM basic AS b/)
    assert.match(q, /JOIN ids ON ids\.oidref = b\.oid/)
    // The ident join is what makes ANY alias resolve — including the
    // free-text names the search box's ask-SIMBAD action sends.
    assert.match(q, /JOIN ident ON ident\.oidref = b\.oid/)
    assert.match(q, /WHERE ident\.id = 'KIC8462852'/)
    for (const col of ['b.main_id', 'b.otype', 'b.ra', 'b.dec', 'ids.ids']) {
      assert.ok(q.includes(col), `selects ${col}`)
    }
  })

  it("doubles embedded apostrophes so a name like Boyajian's Star stays one literal", () => {
    const q = param(simbadIdsQueryUrl("Boyajian's Star"), 'QUERY')
    assert.match(q, /WHERE ident\.id = 'Boyajian''s Star'/)
  })

  it('neutralizes an ADQL injection attempt into a single quoted literal', () => {
    const q = param(simbadIdsQueryUrl("x' OR '1'='1"), 'QUERY')
    // Every injected quote is doubled, so the predicate stays one
    // string comparison instead of becoming a second condition.
    assert.match(q, /WHERE ident\.id = 'x'' OR ''1''=''1'$/)
    assert.ok(!/WHERE ident\.id = 'x' OR /.test(q), 'must not break out of the literal')
  })

  it('percent-encodes the query so spaces never reach the wire raw', () => {
    const url = simbadIdsQueryUrl("Boyajian's Star")
    assert.ok(!url.split('QUERY=')[1].includes(' '), 'no raw spaces in the encoded query')
  })
})
