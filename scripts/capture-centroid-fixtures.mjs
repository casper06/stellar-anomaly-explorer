/**
 * @description Captures the frozen ground-truth fixtures for the centroid
 * regression test (`src/lib/__tests__/centroidRegression.test.ts`). Live
 * network: downloads each star's Kepler TPF quarters from MAST (the same
 * evenly-spread selection the /api/centroid route uses), parses them with
 * the real `tpfReader`, TRIMS cadences to the transit-window neighborhood
 * the engine consumes (|dt from nearest transit center| ≤ 6 × duration/2 —
 * the engine's outer flank is 5×, so the margin survives window tweaks),
 * rounds flux to 3 decimals (e-/s; far below noise) and writes one gzipped
 * JSON fixture per star.
 *
 * Ground-truth ephemerides and centroid offsets come from the NASA
 * Exoplanet Archive `cumulative` table (DR25 vetting columns:
 * koi_fpflag_co, koi_dicco_msky) — fetched live at capture time and
 * embedded in the fixture so the test file documents its provenance.
 *
 * Run: `node --import ./scripts/register-ts-resolver.mjs scripts/capture-centroid-fixtures.mjs`
 * Re-run only when refreezing fixtures (engine changes that alter
 * expected values still only need `--print` in the regression test; a
 * re-CAPTURE is needed only if the required window multipliers grow past
 * the trim margin or new stars are added).
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { readKeplerTpf } from '../src/lib/tpfReader.ts'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', '__tests__', 'fixtures')

/** @description Stars to freeze. `pixels: false` = header-only (saturation refusal case). */
const STARS = [
  { kepoi: 'K02606.01', kic: 5991936, pixels: true, note: 'DR25 centroid-offset FALSE POSITIVE (resolved, 7.07")' },
  { kepoi: 'K01075.01', kic: 10232123, pixels: true, note: 'DR25 centroid-offset FP with SUB-PIXEL offset (1.02") — pins the sensitivity floor (must NOT fire)' },
  { kepoi: 'K01800.01', kic: 11017901, pixels: true, note: 'clean CONFIRMED planet (0.008") — negative control' },
  { kepoi: 'K00003.01', kic: 10748390, pixels: false, note: 'saturated star (Kp 9.2) — must be REFUSED, not measured' },
]

/** @description Quarters to keep per star (mirrors the route's TPF_QUARTERS_TO_FETCH). */
const QUARTERS = 6

/** @description Trim margin around each transit center, in half-durations. */
const TRIM_HALFDUR_MULT = 6

/**
 * @description Fetches the NASA ground-truth row for one KOI.
 * @param kepoi KOI name (e.g. "K02606.01").
 * @returns Ground-truth fields for the fixture header.
 */
async function nasaRow(kepoi) {
  const q =
    `select kepoi_name,kepid,koi_disposition,koi_fpflag_co,koi_period,koi_time0bk,koi_duration,koi_depth,koi_kepmag,` +
    `koi_dicco_msky,koi_dicco_msky_err from cumulative where kepoi_name='${kepoi}'`
  const res = await fetch(
    'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=' + encodeURIComponent(q) + '&format=json',
  )
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`ground-truth query for ${kepoi} returned ${JSON.stringify(rows).slice(0, 200)}`)
  return rows[0]
}

/**
 * @description Lists a KIC's TPF quarter download URLs (chronological) via
 * the same obscore query the route uses.
 * @param kic KIC integer.
 * @returns Sorted archive download URLs.
 */
async function tpfUrls(kic) {
  const target = `kplr${String(kic).padStart(9, '0')}`
  const adql = `SELECT TOP 500 access_url FROM ivoa.obscore WHERE obs_collection='Kepler' AND dataproduct_type='timeseries' AND target_name='${target}'`
  const params = new URLSearchParams({ LANG: 'ADQL', FORMAT: 'json', REQUEST: 'doQuery', QUERY: adql })
  const res = await fetch(`https://mast.stsci.edu/vo-tap/api/v0.1/caom/sync?${params}`)
  const j = await res.json()
  return (j.data ?? [])
    .map(r => String(r[0]))
    .filter(u => u.includes('_lpd-targ.fits'))
    .map(u => {
      const m = u.match(/[?&]uri=(.+)$/)
      return (m ? decodeURIComponent(m[1]) : u).replace(/^http:\/\//, 'https://')
    })
    .sort()
}

/**
 * @description Picks `count` evenly-spread entries (mirrors the route's spreadQuarters).
 * @param urls Sorted URLs.
 * @param count How many.
 * @returns Subset.
 */
function spread(urls, count) {
  if (urls.length <= count) return urls
  const picks = []
  for (let i = 0; i < count; i++) picks.push(urls[Math.floor(((i + 0.5) / count) * urls.length)])
  return [...new Set(picks)]
}

/**
 * @description Trims one parsed quarter to the cadences the engine can use
 * at the given ephemeris, rounding flux for fixture size.
 * @param tpf Parsed TpfQuarter.
 * @param label Archive filename.
 * @param P Period (days).
 * @param t0 Epoch (BKJD).
 * @param durHours Duration (hours).
 * @returns Fixture-ready quarter object.
 */
function trimQuarter(tpf, label, P, t0, durHours) {
  const halfDur = durHours / 24 / 2
  const nPx = tpf.nx * tpf.ny
  const keep = []
  for (let r = 0; r < tpf.times.length; r++) {
    const t = tpf.times[r]
    if (!Number.isFinite(t)) continue
    const n = Math.round((t - t0) / P)
    const dt = Math.abs(t - (t0 + n * P))
    if (dt <= halfDur * TRIM_HALFDUR_MULT) keep.push(r)
  }
  const times = keep.map(r => tpf.times[r])
  const quality = keep.map(r => tpf.quality[r])
  const flux = []
  for (const r of keep) {
    for (let p = 0; p < nPx; p++) {
      const f = tpf.flux[r * nPx + p]
      // NaN → null so JSON round-trips it; test rehydrates null → NaN.
      flux.push(Number.isFinite(f) ? Math.round(f * 1000) / 1000 : null)
    }
  }
  return { label, quarter: tpf.quarter, nx: tpf.nx, ny: tpf.ny, times, quality, flux }
}

for (const star of STARS) {
  const nasa = await nasaRow(star.kepoi)
  const urls = await tpfUrls(star.kic)
  console.log(`${star.kepoi} KIC${star.kic}: ${urls.length} TPF quarters at MAST; ${star.pixels ? `freezing ${QUARTERS}` : 'freezing header only'}`)
  const picks = spread(urls, star.pixels ? QUARTERS : 1)

  const quarters = []
  let kepmagHeader = null
  for (const u of picks) {
    const res = await fetch(u)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`)
    const tpf = readKeplerTpf(Buffer.from(await res.arrayBuffer()))
    if (kepmagHeader === null) kepmagHeader = tpf.kepmag
    if (star.pixels) {
      quarters.push(trimQuarter(tpf, u.split('/').pop(), nasa.koi_period, nasa.koi_time0bk, nasa.koi_duration))
    }
    console.log(`  ${u.split('/').pop()} → Q${tpf.quarter}, kept ${star.pixels ? quarters[quarters.length - 1].times.length : 0} cadences (Kp ${tpf.kepmag})`)
  }

  const fixture = {
    kepoi: star.kepoi,
    kic: star.kic,
    note: star.note,
    capturedAt: new Date().toISOString(),
    nasa: {
      disposition: nasa.koi_disposition,
      fpflagCo: nasa.koi_fpflag_co,
      periodDays: nasa.koi_period,
      epochBkjd: nasa.koi_time0bk,
      durationHours: nasa.koi_duration,
      depthPpm: nasa.koi_depth,
      kepmag: nasa.koi_kepmag,
      diccoArcsec: nasa.koi_dicco_msky,
      diccoErrArcsec: nasa.koi_dicco_msky_err,
    },
    kepmagHeader,
    quarters,
  }
  const out = path.join(FIXTURE_DIR, `centroid-KIC${star.kic}.json.gz`)
  await fs.writeFile(out, gzipSync(JSON.stringify(fixture)))
  const stat = await fs.stat(out)
  console.log(`  wrote ${out} (${(stat.size / 1024).toFixed(0)} KB)\n`)
}
console.log('done')
