/**
 * @description External-dependency health check. Probes the FIVE external
 * services the app relies on, using the EXACT endpoint constants and
 * URL builders the production API routes use (imported from
 * `src/lib/externalEndpoints.ts`), so a contract change at any provider —
 * an endpoint move, a renamed column, a schema change — surfaces here
 * instead of silently degrading the app to a fallback.
 *
 * Run with `npm run test:external-health`. This hits the live network and
 * is intentionally NOT part of `npm test` (which must stay offline and
 * fast). Exit code 0 = all five healthy; 1 = one or more failed.
 *
 * The five checks (one per external dependency, matching the five
 * exported endpoint groups):
 *   1. VizieR (Hipparcos catalog)              — /api/stars
 *   2. NASA Exoplanet Archive KOI (Kepler)     — /api/koi
 *   3. NASA Exoplanet Archive TOI (TESS)       — /api/toi
 *   4. MAST VO-TAP obscore (segment discovery) — /api/lightcurve
 *   5. MAST archive FITS download (segment)    — /api/lightcurve
 *
 * Each check verifies not just "reachable" but "still shaped how we
 * parse it" — the Hipparcos required columns, the `tid` TOI column, an
 * `access_url` in the MAST TAP response, and a valid FITS magic number
 * on the downloaded segment. Reachability alone is what let the VizieR
 * column rename go undetected; this checks the contract.
 */
import {
  VIZIER_HIP_PROBE_URL,
  VIZIER_REQUIRED_COLUMNS,
  KOI_TAP_PROBE_URL,
  TOI_TAP_PROBE_URL,
  mastTapQueryUrl,
  resolveSegmentDownloadUrl,
  MAST_HEALTH_PROBE_TARGET,
} from '../src/lib/externalEndpoints.ts'

/** @description Per-check network timeout. Some of these services are slow cold. */
const TIMEOUT_MS = 60000

/**
 * @description Runs one named check, catching any throw so a single
 * failure doesn't abort the remaining checks. Times the call.
 * @param name Human-readable check name.
 * @param fn Async check body; should throw on failure, optionally return a
 * short detail string on success.
 * @returns Result record with pass/fail, elapsed ms, and a detail/error line.
 */
async function runCheck(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    return { name, ok: true, ms: Date.now() - started, detail: detail ?? '' }
  } catch (e) {
    return { name, ok: false, ms: Date.now() - started, detail: e instanceof Error ? e.message : String(e) }
  }
}

/** @description GETs a URL with the shared timeout, throwing on non-2xx. */
async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return res
}

/**
 * @description Check 1 — VizieR Hipparcos. Fetches a 5-row probe against
 * the same endpoint /api/stars uses, parses the TSV header, and asserts
 * every required column name is present. Catches the class of failure
 * (endpoint move → 404; column rename → missing column) that silently
 * pushed the app onto the synthetic fallback in 2026-07.
 */
async function checkVizier() {
  const res = await get(VIZIER_HIP_PROBE_URL)
  const tsv = await res.text()
  // VizieR signals a server-side outage (backend DB down, etc.) with
  // `#INFO Error=...` / `#INFO QUERY_STATUS=ERROR` comment lines and an
  // error VOTable envelope. Distinguish that (upstream availability) from
  // a real contract change (missing column) so the report is actionable.
  if (/QUERY_STATUS=ERROR/.test(tsv) || /#INFO\s+Error=/.test(tsv)) {
    const errLine = tsv.split(/\r?\n/).find(l => /#INFO\s+Error=/.test(l)) ?? ''
    throw new Error(`VizieR upstream error (service degraded): ${errLine.replace(/^#INFO\s+Error=/, '').trim()}`)
  }
  const lines = tsv.split(/\r?\n/).filter(l => l && !l.startsWith('#') && !l.startsWith('Content-') && !l.startsWith('DocumentRef'))
  const header = lines[0]?.split('\t').map(c => c.trim()) ?? []
  const missing = VIZIER_REQUIRED_COLUMNS.filter(c => !header.includes(c))
  if (missing.length > 0) {
    throw new Error(`missing required column(s) [${missing.join(', ')}]; header was [${header.join(', ')}]`)
  }
  return `columns OK: ${VIZIER_REQUIRED_COLUMNS.join(', ')}`
}

/**
 * @description Check 2 — NASA Exoplanet Archive KOI. One-row TAP probe
 * against the `cumulative` table; asserts a JSON array with the `kepid`
 * and `koi_disposition` fields the parser depends on.
 */
async function checkKoi() {
  const res = await get(KOI_TAP_PROBE_URL)
  const json = await res.json()
  if (!Array.isArray(json)) throw new Error('response was not a JSON array')
  if (json.length === 0) throw new Error('probe returned 0 rows')
  const row = json[0]
  for (const field of ['kepid', 'koi_disposition', 'koi_depth', 'ra', 'dec']) {
    if (!(field in row)) throw new Error(`row missing field '${field}'; keys: [${Object.keys(row).join(', ')}]`)
  }
  return `schema OK (${Object.keys(row).length} columns)`
}

/**
 * @description Check 3 — NASA Exoplanet Archive TOI. One-row TAP probe
 * against the `toi` table; asserts the `tid` column specifically, since
 * the historical `tic_id` mistake returns ORA-00904 and would break the
 * TOI merge. A malformed query returns an error object, not an array.
 */
async function checkToi() {
  const res = await get(TOI_TAP_PROBE_URL)
  const json = await res.json()
  if (!Array.isArray(json)) throw new Error(`response was not a JSON array (got ${JSON.stringify(json).slice(0, 120)})`)
  if (json.length === 0) throw new Error('probe returned 0 rows')
  const row = json[0]
  if (!('tid' in row)) throw new Error(`row missing 'tid' column; keys: [${Object.keys(row).join(', ')}]`)
  for (const field of ['toi', 'ra', 'dec', 'tfopwg_disp']) {
    if (!(field in row)) throw new Error(`row missing field '${field}'; keys: [${Object.keys(row).join(', ')}]`)
  }
  return `schema OK, 'tid' present`
}

/**
 * @description Check 4 — MAST VO-TAP obscore discovery. Queries the
 * obscore view for a known Kepler target (Tabby's Star) using the exact
 * `mastTapQueryUrl` builder /api/lightcurve uses, and asserts the
 * response carries an `access_url` column with at least one PDC
 * `_llc.fits` row. Returns the first access_url so check 5 can reuse it.
 * @returns The resolved download URL of the first PDC segment (side data
 * for check 5), embedded in the detail string via a module-level stash.
 */
async function checkMastTap() {
  const res = await get(mastTapQueryUrl('Kepler', MAST_HEALTH_PROBE_TARGET))
  const json = await res.json()
  const info = json.info ?? json.metadata ?? []
  const cols = info.map(c => c.name)
  const iurl = cols.indexOf('access_url')
  if (iurl < 0) throw new Error(`response missing 'access_url' column; columns: [${cols.join(', ')}]`)
  const rows = json.data ?? []
  const llc = rows.map(r => String(r[iurl] ?? '')).filter(u => u.includes('_llc.fits'))
  if (llc.length === 0) throw new Error(`no _llc.fits PDC rows for ${MAST_HEALTH_PROBE_TARGET} (got ${rows.length} rows)`)
  // Stash the first segment URL for check 5.
  firstSegmentAccessUrl = llc[0]
  return `${llc.length} PDC quarters discoverable`
}

/** @description Cross-check state: first PDC access_url found by check 4. */
let firstSegmentAccessUrl = null

/**
 * @description Check 5 — MAST archive FITS download. Resolves the segment
 * URL discovered by check 4 (via the shared `resolveSegmentDownloadUrl`)
 * and downloads it, asserting the payload starts with the FITS magic
 * bytes `SIMPLE  =` — i.e. we can actually retrieve and would parse real
 * FITS, not an HTML error page. Skips (as a failure) if check 4 didn't
 * find a segment.
 */
async function checkMastDownload() {
  if (!firstSegmentAccessUrl) throw new Error('no segment URL from check 4 (MAST TAP check must pass first)')
  const dl = resolveSegmentDownloadUrl(firstSegmentAccessUrl)
  const res = await get(dl)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 2880) throw new Error(`downloaded only ${buf.length} bytes (FITS blocks are 2880)`)
  const magic = buf.subarray(0, 9).toString('ascii')
  if (magic !== 'SIMPLE  =') throw new Error(`payload is not FITS (first 9 bytes: ${JSON.stringify(magic)})`)
  return `FITS OK (${(buf.length / 1024).toFixed(0)} KB, valid header)`
}

/**
 * @description Runs all five checks in order (checks 4→5 are dependent,
 * the rest independent), prints an aligned report, and exits non-zero if
 * any failed.
 */
async function main() {
  console.log('External dependency health check — probing 5 live services\n')
  const results = []
  // Independent checks first, in parallel.
  const [vizier, koi, toi] = await Promise.all([
    runCheck('VizieR (Hipparcos)', checkVizier),
    runCheck('NASA KOI (Kepler)', checkKoi),
    runCheck('NASA TOI (TESS)', checkToi),
  ])
  results.push(vizier, koi, toi)
  // MAST TAP must run before MAST download (download reuses TAP's segment URL).
  const mastTap = await runCheck('MAST VO-TAP (discovery)', checkMastTap)
  results.push(mastTap)
  results.push(await runCheck('MAST FITS download', checkMastDownload))

  const nameW = Math.max(...results.map(r => r.name.length))
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL'
    console.log(`  [${status}] ${r.name.padEnd(nameW)}  ${String(r.ms).padStart(6)}ms  ${r.detail}`)
  }
  const failed = results.filter(r => !r.ok)
  console.log('')
  if (failed.length === 0) {
    console.log(`All ${results.length} external dependencies healthy.`)
    process.exit(0)
  } else {
    console.log(`${failed.length}/${results.length} checks FAILED: ${failed.map(f => f.name).join(', ')}`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error('health check harness crashed:', e)
  process.exit(1)
})
