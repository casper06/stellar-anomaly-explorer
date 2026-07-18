/**
 * @description Single source of truth for every EXTERNAL data endpoint the
 * app depends on. Both the API routes and the external-health check
 * (`npm run test:external-health`) import from here, so the health check
 * exercises the EXACT URLs and query strings production hits — it cannot
 * drift from what the routes actually send.
 *
 * This module is deliberately dependency-free (no `next/*`, no Node-only
 * built-ins beyond `URLSearchParams`, which exists in every runtime) so
 * the plain-Node health-check harness can import it without pulling in the
 * Next.js server bundle.
 *
 * Seven external contracts are represented, matching the seven health
 * checks:
 *   1. VizieR (Hipparcos catalog)                → `VIZIER_HIP_URL`
 *   2. NASA Exoplanet Archive KOI (Kepler)       → `KOI_TAP_URL`
 *   3. NASA Exoplanet Archive TOI (TESS)         → `TOI_TAP_URL`
 *   4. MAST VO-TAP obscore (segment discovery)   → `mastTapQueryUrl()`
 *   5. MAST archive FITS download (segment data) → resolved from a TAP row
 *   6. TESS TPF URL derivation                   → `deriveTessTpfUrl()`
 *      — used by /api/centroid's TESS path (obscore doesn't list TESS
 *      `_tp.fits`; the URL is derived from the `-s_lc.fits` listing).
 *      Monitored since BEFORE the TESS path shipped, per the
 *      never-build-on-an-unwatched-assumption rule.
 *   7. SIMBAD TAP identity resolution            → `simbadIdsQueryUrl()`
 *      — used by /api/identity's cross-identifier lookup.
 */

/**
 * @description VizieR query for the Hipparcos main catalog (I/239/hip_main).
 * Uses `/viz-bin/asu-tsv` (the older `/viz-bin/TSV` path 404s as of
 * 2026-07). Position columns are the catalog-native ICRS degrees
 * (`RAICRS`/`DEICRS`). This is the FULL-catalog variant: no `Vmag`
 * ceiling, so all ~118,000 Hipparcos entries are requested. `-out.max`
 * is set well above the catalog size so VizieR doesn't truncate.
 */
export const VIZIER_HIP_URL =
  'https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=I/239/hip_main&-out=HIP,RAICRS,DEICRS,Vmag,B-V&-out.max=130000&-oc.form=dec'

/**
 * @description A cheap VizieR probe URL used ONLY by the health check —
 * same endpoint, same source, but capped to a handful of rows so the
 * check is fast and doesn't pull the whole 118k catalog. If this returns
 * a well-formed TSV with the required columns, the full query will too.
 */
export const VIZIER_HIP_PROBE_URL =
  'https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=I/239/hip_main&-out=HIP,RAICRS,DEICRS,Vmag,B-V&-out.max=5&-oc.form=dec'

/** @description Columns the Hipparcos TSV parser requires, by VizieR name. */
export const VIZIER_REQUIRED_COLUMNS = ['HIP', 'RAICRS', 'DEICRS', 'Vmag'] as const

/**
 * @description NASA Exoplanet Archive TAP URL for the KOI cumulative
 * table (CONFIRMED + CANDIDATE dispositions). Selects only the columns
 * the app renders or scores against.
 */
export const KOI_TAP_URL =
  'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' +
  'query=' +
  encodeURIComponent(
    'select kepid,kepoi_name,koi_disposition,koi_period,koi_depth,koi_duration,koi_score,ra,dec ' +
      'from cumulative ' +
      "where koi_disposition in ('CONFIRMED','CANDIDATE')",
  ) +
  '&format=json'

/**
 * @description A 1-row KOI probe used by the health check — same TAP
 * endpoint and table, `select top 1`, so a schema/endpoint change surfaces
 * without downloading ~9,500 rows.
 */
export const KOI_TAP_PROBE_URL =
  'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' +
  'query=' +
  encodeURIComponent(
    'select top 1 kepid,kepoi_name,koi_disposition,koi_period,koi_depth,koi_duration,koi_score,ra,dec ' +
      'from cumulative',
  ) +
  '&format=json'

/**
 * @description NASA Exoplanet Archive TAP URL for the TOI (TESS Object of
 * Interest) table. The TIC id column is `tid` (NOT `tic_id`, which returns
 * `ORA-00904: invalid identifier`).
 */
export const TOI_TAP_URL =
  'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' +
  'query=' +
  encodeURIComponent(
    'select toi,tid,ra,dec,tfopwg_disp,pl_trandep,pl_trandurh,pl_orbper,st_tmag ' +
      'from toi',
  ) +
  '&format=json'

/**
 * @description A 1-row TOI probe used by the health check. Exercises the
 * same table and the `tid` column so the historical `tic_id` mistake can
 * never silently reappear.
 */
export const TOI_TAP_PROBE_URL =
  'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' +
  'query=' +
  encodeURIComponent('select top 1 toi,tid,ra,dec,tfopwg_disp,pl_trandep,pl_trandurh,pl_orbper,st_tmag from toi') +
  '&format=json'

/** @description Base of the MAST VO-TAP CAOM synchronous query service. */
export const MAST_TAP_BASE = 'https://mast.stsci.edu/vo-tap/api/v0.1/caom/sync'

/**
 * @description Builds the MAST VO-TAP query URL for one mission's
 * timeseries products for a single target. Shared by the lightcurve
 * route (production) and the health check (probe against a known target).
 * @param mission Which mission collection to query.
 * @param targetName Archive target name (mission-specific format).
 * @returns Fully-formed GET URL against `MAST_TAP_BASE`.
 */
export function mastTapQueryUrl(mission: 'Kepler' | 'TESS', targetName: string): string {
  const adql = `SELECT TOP 100 obs_id, access_url, access_format FROM ivoa.obscore WHERE obs_collection='${mission}' AND dataproduct_type='timeseries' AND target_name='${targetName}'`
  const params = new URLSearchParams({
    LANG: 'ADQL',
    FORMAT: 'json',
    REQUEST: 'doQuery',
    QUERY: adql,
  })
  return `${MAST_TAP_BASE}?${params.toString()}`
}

/**
 * @description Builds the MAST cone-search VO-TAP URL used by the on-demand
 * lightcurve path (stars with no KIC/TIC id). Queries both Kepler and TESS
 * collections at a position.
 * @param ra Right ascension in degrees.
 * @param dec Declination in degrees.
 * @param radiusDeg Search radius in degrees (default 0.001° ≈ 3.6 arcsec).
 * @returns Fully-formed GET URL against `MAST_TAP_BASE`.
 */
export function mastConeSearchUrl(ra: number, dec: number, radiusDeg = 0.001): string {
  const adql =
    `SELECT TOP 20 obs_id, obs_collection, target_name, access_url, access_format ` +
    `FROM ivoa.obscore ` +
    `WHERE obs_collection IN ('Kepler','TESS') ` +
    `AND dataproduct_type='timeseries' ` +
    `AND CONTAINS(POINT('ICRS', s_ra, s_dec), CIRCLE('ICRS', ${ra}, ${dec}, ${radiusDeg}))=1`
  const params = new URLSearchParams({
    LANG: 'ADQL',
    FORMAT: 'json',
    REQUEST: 'doQuery',
    QUERY: adql,
  })
  return `${MAST_TAP_BASE}?${params.toString()}`
}

/**
 * @description Rewrites a TAP `access_url` into a directly-downloadable
 * archive URL. Shared by the lightcurve route's segment fetcher and the
 * health check's MAST-download probe so both resolve URLs identically.
 * TESS `mast:TESS/...` URIs route through the MAST Download API; Kepler
 * `http://archive...` URLs are upgraded to HTTPS.
 * @param accessUrl TAP-provided access_url.
 * @returns Downloadable HTTPS URL.
 */
export function resolveSegmentDownloadUrl(accessUrl: string): string {
  const uriMatch = accessUrl.match(/[?&]uri=([^&]+)/)
  if (uriMatch) {
    const inner = decodeURIComponent(uriMatch[1])
    if (inner.startsWith('mast:TESS/')) {
      return `https://mast.stsci.edu/api/v0.1/Download/file?uri=${encodeURIComponent(inner)}`
    }
    return inner.replace(/^http:\/\//, 'https://')
  }
  return accessUrl
}

/**
 * @description A well-known Kepler target used by the health check to probe
 * both MAST TAP discovery AND a single-segment FITS download. Tabby's Star
 * (KIC 8462852) is guaranteed to have Kepler coverage.
 */
export const MAST_HEALTH_PROBE_TARGET = 'kplr008462852'

/**
 * @description TESS target (bare TIC integer, the obscore `target_name`
 * form) used by the health check's TPF URL-derivation probe. Tabby's Star
 * again (TIC 185336364) — it has multiple 2-min-cadence sectors, so a
 * `-s_lc.fits` row is guaranteed in the TAP listing.
 */
export const TESS_TPF_HEALTH_PROBE_TARGET = '185336364'

/**
 * @description Derives a TESS Target Pixel File download URL from a TESS
 * PDC light-curve `access_url`. MAST's obscore view does NOT list TESS
 * `_tp.fits` products (confirmed 2026-07-10 — the listing carries `_lc`,
 * `_fast-lc` and DV rows only), but the SPOC naming convention is
 * deterministic: the TPF shares the light curve's full stem with suffix
 * `-s_tp.fits` instead of `-s_lc.fits`.
 *
 * ⚠ This is a DERIVED naming pattern, not a documented MAST contract.
 * It is now load-bearing: /api/centroid's TESS path discovers TPFs
 * through it (the health check watched it before the implementation
 * landed, so a convention change surfaces in the health report, not as
 * a silent 404 in production).
 * @param accessUrl TAP-provided `access_url` of a TESS `-s_lc.fits` row.
 * @returns Downloadable TPF URL via the MAST Download API, or null when
 * the input is not a TESS 2-min PDC light-curve URL.
 */
export function deriveTessTpfUrl(accessUrl: string): string | null {
  const uriMatch = accessUrl.match(/[?&]uri=([^&]+)/)
  const inner = uriMatch ? decodeURIComponent(uriMatch[1]) : accessUrl
  if (!inner.startsWith('mast:TESS/') || !inner.endsWith('-s_lc.fits')) return null
  const tpUri = inner.replace(/-s_lc\.fits$/, '-s_tp.fits')
  return `https://mast.stsci.edu/api/v0.1/Download/file?uri=${encodeURIComponent(tpUri)}`
}

/** @description Base of the CDS SIMBAD synchronous TAP query service. */
export const SIMBAD_TAP_SYNC_URL = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync'

/**
 * @description Builds the SIMBAD TAP query URL that resolves one
 * identifier to the object's full cross-identification record: `main_id`
 * + `otype` + ICRS position from the `basic` table, and every known
 * identifier pipe-concatenated in the `ids` column. The `ident` join
 * matches ANY alias of the object, and SIMBAD's identifier matching is
 * whitespace-normalized (measured 2026-07-17: `KIC8462852` resolves
 * identically to `KIC 8462852`), so the app's un-spaced star ids are
 * passed verbatim. Shared by /api/identity (production) and the
 * external-health check (probe) so the two can never drift.
 *
 * A miss (object not in SIMBAD) is HTTP 200 with an empty `data` array.
 * A malformed query returns a VOTable XML error envelope
 * (`QUERY_STATUS=ERROR`) even with `FORMAT=json` — callers must treat a
 * JSON parse failure as an upstream/query error, not as data.
 *
 * Fair use (CDS policy, quoted in astroquery's SIMBAD docs): more than
 * ~5–10 queries/second gets the IP blacklisted for up to an hour. The
 * on-demand one-query-per-click pattern is far below this; any future
 * BATCH resolution must throttle to ≲2 concurrent with delays.
 * @param identifier Any SIMBAD-known identifier (e.g. `KIC8462852`,
 * `TIC 25155310`, `HIP 11767`). Single quotes are ADQL-escaped.
 * @returns Fully-formed GET URL against `SIMBAD_TAP_SYNC_URL`.
 */
export function simbadIdsQueryUrl(identifier: string): string {
  const escaped = identifier.replace(/'/g, "''")
  const adql =
    'SELECT b.main_id, b.otype, b.ra, b.dec, ids.ids ' +
    'FROM basic AS b ' +
    'JOIN ids ON ids.oidref = b.oid ' +
    'JOIN ident ON ident.oidref = b.oid ' +
    `WHERE ident.id = '${escaped}'`
  const params = new URLSearchParams({
    REQUEST: 'doQuery',
    LANG: 'ADQL',
    FORMAT: 'json',
    QUERY: adql,
  })
  return `${SIMBAD_TAP_SYNC_URL}?${params.toString()}`
}

/**
 * @description Identifier used by the health check's SIMBAD probe —
 * Tabby's Star in the app's own un-spaced id form, i.e. exactly what
 * /api/identity sends in production. Guaranteed present in SIMBAD with
 * a rich cross-id record (13 identifiers as of 2026-07-17).
 */
export const SIMBAD_HEALTH_PROBE_IDENTIFIER = 'KIC8462852'
