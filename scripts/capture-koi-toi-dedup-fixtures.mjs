/**
 * @description Captures frozen REAL NASA Exoplanet Archive TAP responses
 * used by `src/lib/__tests__/koiToiDedup.unit.test.ts` and the KOI/TOI
 * route tests, to cover the fetch-side host-star dedup
 * (`fetchKOICatalog` / `fetchTOICatalog`) and the route-side disposition
 * filter (`/api/koi`, `/api/toi`) against the exact multi-row-per-host
 * shape NASA actually returns — not a hand-built stand-in.
 *
 * Each fixture is the RAW TAP JSON array (what the route's `fetchFromTap`
 * receives, `format=json`), selecting the exact columns each route selects
 * so the frozen shape matches production. Two hosts per mission:
 *   - a MULTI-candidate host whose rows deliberately MIX kept and excluded
 *     dispositions, so one fixture exercises the disposition filter AND the
 *     dedup together, end to end;
 *   - a SINGLE-candidate host, to pin that a lone host is not accidentally
 *     merged with anything.
 *
 * Hosts (verified live 2026-07-22):
 *   KOI KIC 3832474  (K00806) — 3 CONFIRMED (.01/.02/.03) + 2 FALSE POSITIVE
 *                      (.04/.05); .03 has a NULL koi_score (route defaults 0).
 *   KOI KIC 10666592 (K00002 = HAT-P-7) — single CONFIRMED.
 *   TOI TIC 29781292 (TOI 282) — 3 CP + 1 FA (excluded).
 *   TOI TIC 25155310 (TOI 114 = WASP-126) — single KP.
 *
 * Run only to refreeze after an INTENTIONAL contract change:
 *   node --import ./scripts/register-ts-resolver.mjs scripts/capture-koi-toi-dedup-fixtures.mjs
 *
 * Then re-verify the frozen row counts/dispositions by hand before
 * updating the test expectations.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const TAP = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync'

/** @description Columns the /api/koi route selects (must match production). */
const KOI_COLS = 'kepid,kepoi_name,koi_disposition,koi_period,koi_depth,koi_duration,koi_score,ra,dec'
/** @description Columns the /api/toi route selects (must match production). */
const TOI_COLS = 'toi,tid,ra,dec,tfopwg_disp,pl_trandep,pl_trandurh,pl_orbper,st_tmag'

/**
 * @description Fixtures to capture: { file, mission, adql, note }.
 * The ADQL selects ALL dispositions for the host (no disposition WHERE
 * clause) so the excluded rows are present in the frozen data — that is
 * what lets the test exercise the route's filter.
 */
const TARGETS = [
  {
    file: 'koi-multi-KIC3832474.json',
    mission: 'KOI',
    adql: `select ${KOI_COLS} from cumulative where kepid=3832474 order by kepoi_name`,
    note: '3 CONFIRMED + 2 FALSE POSITIVE, one host',
  },
  {
    file: 'koi-single-KIC10666592.json',
    mission: 'KOI',
    adql: `select ${KOI_COLS} from cumulative where kepid=10666592 order by kepoi_name`,
    note: 'single CONFIRMED (HAT-P-7)',
  },
  {
    file: 'toi-multi-TIC29781292.json',
    mission: 'TOI',
    adql: `select ${TOI_COLS} from toi where tid=29781292 order by toi`,
    note: '3 CP + 1 FA, one host',
  },
  {
    file: 'toi-single-TIC25155310.json',
    mission: 'TOI',
    adql: `select ${TOI_COLS} from toi where tid=25155310 order by toi`,
    note: 'single KP (WASP-126)',
  },
]

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'lib', '__tests__', 'fixtures', 'koitoi',
)

/**
 * @description Fetches one TAP JSON array. Throws on network/HTTP failure —
 * a fixture capture must not silently freeze an error body.
 * @param adql ADQL query text.
 * @returns Parsed JSON array of TAP rows.
 */
async function fetchTapJson(adql) {
  const url = `${TAP}?query=${encodeURIComponent(adql)}&format=json`
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  const rows = JSON.parse(text)
  if (!Array.isArray(rows)) throw new Error(`expected a JSON array, got: ${text.slice(0, 200)}`)
  return rows
}

async function main() {
  console.log(`Capturing ${TARGETS.length} KOI/TOI dedup fixtures → ${OUT_DIR}\n`)
  await fs.mkdir(OUT_DIR, { recursive: true })
  for (const t of TARGETS) {
    const rows = await fetchTapJson(t.adql)
    const fixture = {
      capturedAt: new Date().toISOString(),
      mission: t.mission,
      note: t.note,
      adql: t.adql,
      // The raw TAP rows, verbatim — exactly what the route's fetchFromTap
      // parses. The disposition column is present for every row (including
      // the excluded ones) so tests can drive the filter + dedup together.
      rows,
    }
    await fs.writeFile(path.join(OUT_DIR, t.file), JSON.stringify(fixture, null, 1), 'utf8')
    console.log(`  ${t.file.padEnd(30)} ${rows.length} rows  (${t.note})`)
    await new Promise(r => setTimeout(r, 800))
  }
  console.log('\nDone. Re-verify row counts / dispositions by hand before updating tests.')
}

main().catch(e => {
  console.error('capture failed:', e)
  process.exit(1)
})
