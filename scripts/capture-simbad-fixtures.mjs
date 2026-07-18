/**
 * @description Captures the frozen SIMBAD identity fixtures used by
 * `src/lib/__tests__/simbadIds.unit.test.ts`. Queries the LIVE SIMBAD TAP
 * service through the exact `simbadIdsQueryUrl` builder /api/identity uses
 * in production (no-drift rule) and writes each raw JSON response, wrapped
 * with capture provenance, to `src/lib/__tests__/fixtures/simbad/<id>.json`.
 *
 * Run only when refreezing fixtures after an INTENTIONAL contract change:
 *   node --import ./scripts/register-ts-resolver.mjs scripts/capture-simbad-fixtures.mjs
 *
 * Then re-verify the new expected values by hand before updating the unit
 * test's assertions. Queries run sequentially with a 1 s pause — CDS
 * blacklists IPs above ~5–10 queries/second.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { simbadIdsQueryUrl } from '../src/lib/externalEndpoints.ts'

/** @description The four frozen identity targets, in the app's un-spaced id form. */
const TARGETS = ['KIC8462852', 'KIC10666592', 'TIC25155310', 'EPIC201637175']

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'lib', '__tests__', 'fixtures', 'simbad',
)

/**
 * @description Fetches one identifier's SIMBAD record and writes the
 * fixture file (capture metadata + verbatim parsed response).
 * @param id App-form star identifier.
 */
async function captureOne(id) {
  const url = simbadIdsQueryUrl(id)
  const started = Date.now()
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status} — ${text.slice(0, 200)}`)
  let response
  try {
    response = JSON.parse(text)
  } catch {
    throw new Error(`${id}: response was not JSON (VOTable error envelope?): ${text.slice(0, 200)}`)
  }
  const rows = Array.isArray(response.data) ? response.data.length : 'malformed'
  const fixture = {
    capturedAt: new Date().toISOString(),
    identifier: id,
    url,
    response,
  }
  const file = path.join(OUT_DIR, `${id}.json`)
  await fs.writeFile(file, JSON.stringify(fixture, null, 2) + '\n', 'utf8')
  console.log(`  ${id}: ${rows} row(s), ${Date.now() - started}ms → ${path.basename(file)}`)
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })
  console.log(`Capturing ${TARGETS.length} SIMBAD identity fixtures → ${OUT_DIR}`)
  for (const id of TARGETS) {
    await captureOne(id)
    await new Promise(r => setTimeout(r, 1000))
  }
  console.log('Done. Hand-verify the values before updating unit-test expectations.')
}

main().catch(e => {
  console.error('capture failed:', e)
  process.exit(1)
})
