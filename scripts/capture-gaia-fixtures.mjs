/**
 * @description Captures the frozen Gaia DR3 fixtures used by
 * `src/lib/__tests__/gaiaSource.unit.test.ts` and the Gaia route test.
 * Queries the LIVE Gaia Archive TAP service through the exact
 * `gaiaSourceQueryUrl` / `gaiaClassifierQueryUrl` builders /api/gaia uses
 * in production (no-drift rule) and writes each raw VOTable response,
 * wrapped with capture provenance, to
 * `src/lib/__tests__/fixtures/gaia/<source_id>.json`.
 *
 * Two responses are frozen per object: the `gaia_source` row (the
 * backbone: RUWE, RV columns, phot_variable_flag) and the
 * `vari_classifier_result` row (the bonus ML-classifier layer, present
 * for only some objects — HAT-P-7 in our set).
 *
 * Run only when refreezing fixtures after an INTENTIONAL contract change:
 *   node --import ./scripts/register-ts-resolver.mjs scripts/capture-gaia-fixtures.mjs
 *
 * Then re-verify the new expected values by hand before updating the unit
 * test's assertions. Gaia has no documented per-IP rate limit as strict
 * as CDS's, but queries run sequentially with a 1 s pause anyway (be a
 * good citizen; see C1 research notes).
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gaiaSourceQueryUrl, gaiaClassifierQueryUrl } from '../src/lib/externalEndpoints.ts'

/**
 * @description The frozen Gaia targets, keyed by app-facing label →
 * Gaia DR3 source_id. These are the four C1 validated against; their
 * source_ids came from the frozen SIMBAD fixtures (C1.4 chain). Each
 * pins a distinct behavior:
 *   - Tabby      : RV-variable per the 4-part criterion, phot_variable_flag
 *                  NOT_AVAILABLE (the critical "NOT_AVAILABLE ≠ constant" case),
 *                  NOT in the classifier table (bonus layer absent).
 *   - HAT-P-7    : RV-constant, phot_variable_flag VARIABLE, IN the
 *                  classifier table (bonus layer present — class EP).
 *   - WASP-126   : RV-constant (has_rvs true), classifier absent.
 *   - K2-22      : faint, has_rvs false → all RV columns null (the
 *                  null-RV path).
 */
const TARGETS = {
  KIC8462852_Tabby: '2081900940499099136',
  KIC10666592_HATP7: '2129256395211984000',
  TIC25155310_WASP126: '4666498154837086208',
  EPIC201637175_K2_22: '3811002791880297600',
}

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'lib', '__tests__', 'fixtures', 'gaia',
)

/**
 * @description Fetches one URL and returns the raw text body plus HTTP
 * status, throwing on network failure only (a non-2xx body is still
 * captured — an error VOTable envelope is itself a contract sample).
 * @param url Fully-formed TAP query URL.
 * @returns Raw response text and status.
 */
async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  const text = await res.text()
  return { status: res.status, text }
}

/**
 * @description Captures both frozen responses for one object.
 * @param label App-facing fixture label.
 * @param sourceId Gaia DR3 source_id.
 */
async function captureOne(label, sourceId) {
  const srcUrl = gaiaSourceQueryUrl(sourceId)
  const clsUrl = gaiaClassifierQueryUrl(sourceId)

  const started = Date.now()
  const source = await fetchText(srcUrl)
  await new Promise(r => setTimeout(r, 1000))
  const classifier = await fetchText(clsUrl)
  const elapsed = Date.now() - started

  const fixture = {
    capturedAt: new Date().toISOString(),
    label,
    sourceId,
    gaiaSource: { url: srcUrl, status: source.status, votable: source.text },
    variClassifier: { url: clsUrl, status: classifier.status, votable: classifier.text },
  }

  const file = path.join(OUT_DIR, `${sourceId}.json`)
  await fs.writeFile(file, JSON.stringify(fixture, null, 1), 'utf8')
  const srcOk = source.text.includes('<TABLEDATA>')
  const clsRows = (classifier.text.match(/<TR>/g) ?? []).length
  console.log(
    `  ${label.padEnd(24)} → ${sourceId}  (source ${source.status}${srcOk ? ' TABLEDATA' : ''}, ` +
      `classifier ${classifier.status} ${clsRows} row(s), ${elapsed}ms)`,
  )
}

async function main() {
  console.log(`Capturing ${Object.keys(TARGETS).length} Gaia DR3 fixtures → ${OUT_DIR}\n`)
  await fs.mkdir(OUT_DIR, { recursive: true })
  for (const [label, sourceId] of Object.entries(TARGETS)) {
    await captureOne(label, sourceId)
    await new Promise(r => setTimeout(r, 1000))
  }
  console.log('\nDone. Re-verify expected values by hand before updating tests.')
}

main().catch(e => {
  console.error('capture failed:', e)
  process.exit(1)
})
