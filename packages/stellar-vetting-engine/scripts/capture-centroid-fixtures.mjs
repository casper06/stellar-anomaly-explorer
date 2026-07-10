/**
 * @description Captures the frozen ground-truth fixtures for the centroid
 * regression test (`src/lib/__tests__/centroidRegression.test.ts`). Live
 * network: downloads each star's TPF segments from MAST (the same
 * evenly-spread selection the /api/centroid route uses), parses them with
 * the real `tpfReader` (including the FLUX-column WCS the engine measures
 * against), TRIMS cadences to the transit-window neighborhood the engine
 * consumes (|dt from nearest transit center| ≤ 6 × duration/2 — the
 * engine's outer flank is 5×, so the margin survives window tweaks),
 * rounds flux to 3 decimals (e-/s; far below noise) and writes one
 * gzipped JSON fixture per star.
 *
 * Ground truth:
 * - Kepler stars: ephemerides + DR25 centroid columns (koi_fpflag_co,
 *   koi_dicco_msky, koi_dikco_msky — the engine's reference convention
 *   matches dikco: offset from the catalog position) from the NASA
 *   `cumulative` table, fetched live and embedded in the fixture.
 * - The TESS star has NO public centroid ground truth (that's the
 *   documented reason TESS results are labeled qualitative); its fixture
 *   is a DRIFT PIN only — expected values are our own measured output,
 *   frozen so the TESS path can't change silently. Ephemeris from the
 *   `toi` table. TESS sectors are ~47 MB each, so the TESS fixture keeps
 *   only the first MAX_TESS_CYCLES_PER_SECTOR transit windows per sector.
 *
 * Run (from the package dir): `node --import ./scripts/register-ts-resolver.mjs scripts/capture-centroid-fixtures.mjs`
 * Re-run only when refreezing fixtures (engine changes that alter
 * expected values still only need `--print` in the regression test; a
 * re-CAPTURE is needed only if the required window multipliers grow past
 * the trim margin, fixture fields are added — like the phase-2 WCS — or
 * new stars are added).
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { readTpf } from '../src/tpfReader.ts'
// The TESS TPF URL derivation lives in the APP's endpoint registry (it is
// an app/external-service concern, not engine math); this capture tool is
// repo-internal and never ships in the npm tarball, so reaching into the
// app source is acceptable here.
import { deriveTessTpfUrl } from '../../../src/lib/externalEndpoints.ts'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures')

/** @description Stars to freeze. `pixels: false` = header-only (saturation refusal case). */
const STARS = [
  { kepoi: 'K02606.01', kic: 5991936, pixels: true, note: 'DR25 centroid-offset FALSE POSITIVE (resolved; dikco 6.889")' },
  { kepoi: 'K01075.01', kic: 10232123, pixels: true, note: 'DR25 centroid-offset FP with SUB-PIXEL offset (dikco 0.787") — pins the sensitivity floor (must NOT fire)' },
  { kepoi: 'K01800.01', kic: 11017901, pixels: true, note: 'clean CONFIRMED planet (dikco 0.443") — negative control; also anchors why the 2" floor stays' },
  { kepoi: 'K00003.01', kic: 10748390, pixels: false, note: 'saturated star (Kp 9.2) — must be REFUSED, not measured' },
]

/**
 * @description TESS drift-pin star: WASP-126 (TIC 25155310), a confirmed
 * hot Jupiter in the southern continuous-viewing zone (many sectors).
 * NOT ground truth — no public TESS centroid values exist; frozen output
 * pins our own TESS path against silent drift.
 */
const TESS_STAR = { tic: 25155310, name: 'WASP-126 b', sectors: 4 }

/** @description Kepler quarters to keep per star (mirrors the route's TPF_QUARTERS_TO_FETCH). */
const QUARTERS = 6

/** @description Trim margin around each transit center, in half-durations. */
const TRIM_HALFDUR_MULT = 6

/** @description TESS: max transit windows kept per sector (fixture size control). */
const MAX_TESS_CYCLES_PER_SECTOR = 3

/**
 * @description Fetches the NASA cumulative-table ground-truth row for one KOI.
 * @param kepoi KOI name (e.g. "K02606.01").
 * @returns Ground-truth fields for the fixture header.
 */
async function nasaRow(kepoi) {
  const q =
    `select kepoi_name,kepid,koi_disposition,koi_fpflag_co,koi_period,koi_time0bk,koi_duration,koi_depth,koi_kepmag,` +
    `koi_dicco_msky,koi_dicco_msky_err,koi_dikco_msky,koi_dikco_msky_err from cumulative where kepoi_name='${kepoi}'`
  const res = await fetch(
    'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=' + encodeURIComponent(q) + '&format=json',
  )
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`ground-truth query for ${kepoi} returned ${JSON.stringify(rows).slice(0, 200)}`)
  return rows[0]
}

/**
 * @description Fetches the TOI-table ephemeris for the TESS drift star.
 * `pl_tranmid` is BJD; the TPF TIME column is TJD = BJD − 2457000.
 * @param tic TIC integer.
 * @returns {periodDays, epochTjd, durationHours, tmag, disp}.
 */
async function toiEphemeris(tic) {
  const q = `select toi,tfopwg_disp,pl_orbper,pl_tranmid,pl_trandurh,st_tmag from toi where tid=${tic}`
  const res = await fetch(
    'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=' + encodeURIComponent(q) + '&format=json',
  )
  const rows = await res.json()
  const row = (Array.isArray(rows) ? rows : []).find(
    r => r.pl_orbper > 0 && r.pl_tranmid > 0 && r.pl_trandurh > 0,
  )
  if (!row) throw new Error(`no usable TOI ephemeris for TIC ${tic}: ${JSON.stringify(rows).slice(0, 200)}`)
  return {
    toi: row.toi,
    disp: row.tfopwg_disp,
    periodDays: row.pl_orbper,
    epochTjd: row.pl_tranmid - 2457000,
    durationHours: row.pl_trandurh,
    tmag: row.st_tmag,
  }
}

/**
 * @description Lists a target's TPF segment download URLs (chronological)
 * via the same obscore query + filters the route uses.
 * @param mission 'Kepler' | 'TESS'.
 * @param targetName kplrNNNNNNNNN or bare TIC integer.
 * @returns Sorted download URLs.
 */
async function tpfUrls(mission, targetName) {
  const adql = `SELECT TOP 500 access_url FROM ivoa.obscore WHERE obs_collection='${mission}' AND dataproduct_type='timeseries' AND target_name='${targetName}'`
  const params = new URLSearchParams({ LANG: 'ADQL', FORMAT: 'json', REQUEST: 'doQuery', QUERY: adql })
  const res = await fetch(`https://mast.stsci.edu/vo-tap/api/v0.1/caom/sync?${params}`)
  const j = await res.json()
  const urls = new Set()
  for (const r of j.data ?? []) {
    const u = String(r[0])
    if (mission === 'Kepler') {
      if (!u.includes('_lpd-targ.fits')) continue
      const m = u.match(/[?&]uri=(.+)$/)
      urls.add((m ? decodeURIComponent(m[1]) : u).replace(/^http:\/\//, 'https://'))
    } else {
      const derived = deriveTessTpfUrl(u)
      if (derived) urls.add(derived)
    }
  }
  return [...urls].sort()
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
 * @description Trims one parsed segment to the cadences the engine can use
 * at the given ephemeris, rounding flux for fixture size.
 * @param tpf Parsed TpfQuarter.
 * @param label Archive filename.
 * @param P Period (days).
 * @param t0 Epoch (BKJD/TJD).
 * @param durHours Duration (hours).
 * @param maxCycles Cap on distinct transit windows kept (Infinity = all).
 * @returns Fixture-ready segment object (includes the WCS).
 */
function trimSegment(tpf, label, P, t0, durHours, maxCycles = Infinity) {
  const halfDur = durHours / 24 / 2
  const nPx = tpf.nx * tpf.ny
  const keep = []
  const cycles = new Set()
  for (let r = 0; r < tpf.times.length; r++) {
    const t = tpf.times[r]
    if (!Number.isFinite(t)) continue
    const n = Math.round((t - t0) / P)
    const dt = Math.abs(t - (t0 + n * P))
    if (dt > halfDur * TRIM_HALFDUR_MULT) continue
    if (!cycles.has(n)) {
      if (cycles.size >= maxCycles) continue
      cycles.add(n)
    }
    keep.push(r)
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
  return { label, segment: tpf.segment, nx: tpf.nx, ny: tpf.ny, wcs: tpf.wcs, times, quality, flux }
}

/**
 * @description Downloads + trims one star's segments and writes its fixture.
 * @param opts Fixture spec (see call sites).
 */
async function capture({ fileKey, mission, pixels, count, P, t0, durHours, maxCycles, meta }) {
  const targetName = mission === 'Kepler' ? `kplr${String(fileKey).padStart(9, '0')}` : String(fileKey)
  const urls = await tpfUrls(mission, targetName)
  console.log(`${meta.label}: ${urls.length} TPF segments at MAST; ${pixels ? `freezing ${count}` : 'freezing header only'}`)
  const picks = spread(urls, pixels ? count : 1)

  const quarters = []
  let magHeader = null
  for (const u of picks) {
    const res = await fetch(u)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`)
    const tpf = readTpf(Buffer.from(await res.arrayBuffer()))
    if (magHeader === null) magHeader = tpf.mag
    if (pixels) {
      const fname = decodeURIComponent(u).split('/').pop()
      quarters.push(trimSegment(tpf, fname, P, t0, durHours, maxCycles))
      console.log(`  ${fname} → seg ${tpf.segment}, kept ${quarters[quarters.length - 1].times.length} cadences (mag ${tpf.mag}, wcs ${tpf.wcs ? 'ok' : 'MISSING'})`)
    } else {
      console.log(`  header-only → seg ${tpf.segment} (mag ${tpf.mag})`)
    }
  }

  const fixture = { ...meta, mission, capturedAt: new Date().toISOString(), magHeader, quarters }
  const out = path.join(FIXTURE_DIR, `centroid-${mission === 'Kepler' ? 'KIC' : 'TIC'}${fileKey}.json.gz`)
  await fs.writeFile(out, gzipSync(JSON.stringify(fixture)))
  const stat = await fs.stat(out)
  console.log(`  wrote ${out} (${(stat.size / 1024).toFixed(0)} KB)\n`)
}

for (const star of STARS) {
  const nasa = await nasaRow(star.kepoi)
  await capture({
    fileKey: star.kic,
    mission: 'Kepler',
    pixels: star.pixels,
    count: QUARTERS,
    P: nasa.koi_period,
    t0: nasa.koi_time0bk,
    durHours: nasa.koi_duration,
    maxCycles: Infinity,
    meta: {
      label: `${star.kepoi} KIC${star.kic}`,
      kepoi: star.kepoi,
      kic: star.kic,
      note: star.note,
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
        dikcoArcsec: nasa.koi_dikco_msky,
        dikcoErrArcsec: nasa.koi_dikco_msky_err,
      },
    },
  })
}

// TESS drift pin (no ground truth — see module doc).
const eph = await toiEphemeris(TESS_STAR.tic)
console.log(`TESS ${TESS_STAR.name} → TOI ${eph.toi} (${eph.disp}), P=${eph.periodDays}d t0(TJD)=${eph.epochTjd.toFixed(3)} dur=${eph.durationHours}h Tmag=${eph.tmag}`)
await capture({
  fileKey: TESS_STAR.tic,
  mission: 'TESS',
  pixels: true,
  count: TESS_STAR.sectors,
  P: eph.periodDays,
  t0: eph.epochTjd,
  durHours: eph.durationHours,
  maxCycles: MAX_TESS_CYCLES_PER_SECTOR,
  meta: {
    label: `${TESS_STAR.name} TIC${TESS_STAR.tic}`,
    tic: TESS_STAR.tic,
    note: `TESS drift pin (${TESS_STAR.name}, confirmed planet) — NO ground truth exists for TESS centroids; expected values are our own frozen output`,
    nasa: {
      disposition: eph.disp,
      periodDays: eph.periodDays,
      epochBkjd: eph.epochTjd,
      durationHours: eph.durationHours,
      tmag: eph.tmag,
      diccoArcsec: null,
      diccoErrArcsec: null,
      dikcoArcsec: null,
      dikcoErrArcsec: null,
    },
  },
})
console.log('done')
