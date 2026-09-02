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
 * - TESS stars: ephemeris from the `toi` table, plus — where SPOC ran a
 *   Data Validation report — the `msTicCentroidOffsets` values parsed from
 *   the target's `_dvr.xml` (issue #27). That is real, TIC-referenced
 *   arcsec ground truth in the same convention as Kepler's dikco, so the
 *   older "no TESS ground truth exists" framing no longer holds for
 *   targets with a DV report. Two caveats it does NOT remove:
 *     * SPOC aggregates its multi-sector `ms*` values with an
 *       inverse-variance weighted mean over a DIFFERENT sector set than
 *       the 4 this capture freezes, so the comparison is verdict-level,
 *       not numeric (see tessGroundTruth.test.ts).
 *     * WASP-126 keeps its drift-pin role — its SPOC offset is a
 *       non-detection, which pins the quiet end but calibrates nothing.
 *   TESS sectors are ~47 MB each, so TESS fixtures keep only the first
 *   MAX_TESS_CYCLES_PER_SECTOR transit windows per sector.
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
 * @description TESS stars to freeze.
 *
 * WASP-126 is the original DRIFT PIN (confirmed hot Jupiter, southern
 * continuous-viewing zone): SPOC reports a non-detection there, so it pins
 * the quiet end but calibrates nothing.
 *
 * TOI 409.01 and TOI 274.01 are TFOPWG FALSE POSITIVES whose ExoFOP
 * comments cite a centroid offset — the TESS analogue of K02606.01's role
 * in the Kepler calibration (issue #27). Both clear the Tmag 6.8
 * saturation gate comfortably (9.15 and 10.49).
 */
const TESS_STARS = [
  {
    tic: 25155310,
    name: 'WASP-126 b',
    sectors: 4,
    note: 'TESS drift pin (confirmed planet) — SPOC reports a NON-detection; pins our TESS path against silent drift',
  },
  {
    tic: 167754523,
    name: 'TOI 409.01',
    sectors: 4,
    note: 'TFOPWG FALSE POSITIVE — ExoFOP: "centroid offset on 167754526"; SPOC ms* 63.78″ ± 2.51 (25.5σ). The TESS offset ANCHOR (K02606.01 analogue)',
  },
  {
    tic: 281979481,
    name: 'TOI 274.01',
    sectors: 4,
    note: 'TFOPWG FALSE POSITIVE — ExoFOP: centroid offset onto a star a pixel away, "also apparent in SPOC multisector"; SPOC ms* 13.60″ ± 3.64 (3.7σ). Independent human+pipeline cross-check; only 1.34× the ~10.2″ TESS floor, so a NO_SIGNIFICANT_OFFSET here is a floor-sensitivity finding, not a failure',
  },
]

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
 * @description Fetches SPOC's own centroid ground truth for a TESS target:
 * the `msTicCentroidOffsets` block from its Data Validation report
 * (`_dvr.xml`), discovered through the same obscore query used for
 * light curves (issue #27).
 *
 * Units are NOT declared in the XML and the file mixes two systems: the
 * row/column/focalPlane triple is PIXELS, the ra/dec/sky triple is
 * ARCSEC (verified: skyOffset/focalPlaneOffset ≈ 20.3, the TESS pixel
 * scale). We take the arcsec triple. `meanSkyOffset` is the sign-free
 * magnitude — exactly `hypot(meanRaOffset, meanDecOffset)` — matching the
 * magnitude our own engine reports.
 *
 * Prefers a MULTI-sector report (SPOC's `ms*` aggregate) and records the
 * sector span, because SPOC's sector set differs from the 4 this capture
 * freezes; the consuming test compares verdicts, not numbers.
 *
 * @param tic TIC integer.
 * @returns SPOC centroid ground truth, or null when no DV report exists.
 */
async function spocCentroidGroundTruth(tic) {
  const adql = `SELECT TOP 500 access_url FROM ivoa.obscore WHERE obs_collection='TESS' AND target_name='${tic}'`
  const params = new URLSearchParams({ LANG: 'ADQL', FORMAT: 'json', REQUEST: 'doQuery', QUERY: adql })
  const res = await fetch(`https://mast.stsci.edu/vo-tap/api/v0.1/caom/sync?${params}`)
  const j = await res.json()
  const dv = [...new Set((j.data ?? []).map(r => String(r[0])).filter(u => /_dvr\.xml$/.test(u)))].sort()
  if (dv.length === 0) return null

  // Prefer the widest multi-sector span (sSSSS-sEEEE with start !== end).
  const spans = dv
    .map(u => ({ url: u, m: u.match(/-s(\d{4})-s(\d{4})-/) }))
    .filter(x => x.m)
    .map(x => ({ url: x.url, first: +x.m[1], last: +x.m[2], width: +x.m[2] - +x.m[1] }))
  const multi = spans.filter(s => s.width > 0).sort((a, b) => b.width - a.width)
  const chosen = multi[0] ?? spans[spans.length - 1]
  if (!chosen) return null

  const xml = await (await fetch(chosen.url)).text()
  const block = xml.match(/<dv:msTicCentroidOffsets>[\s\S]*?<\/dv:msTicCentroidOffsets>/)
  if (!block) return null
  const read = tag => {
    const m = block[0].match(new RegExp(`<dv:${tag} value="([^"]+)" uncertainty="([^"]+)"`))
    return m ? { value: Number(m[1]), uncertainty: Number(m[2]) } : null
  }
  const sky = read('meanSkyOffset')
  if (!sky) return null
  const ra = read('meanRaOffset')
  const dec = read('meanDecOffset')
  // Sectors SPOC actually observed, from the report's own bitstring.
  const observed = xml.match(/sectorsObserved="([01]+)"/)
  const spocSectors = observed
    ? observed[1].split('').reduce((a, c, i) => (c === '1' ? [...a, i] : a), [])
    : null

  return {
    spocMeanSkyOffsetArcsec: sky.value,
    spocMeanSkyOffsetErrArcsec: sky.uncertainty,
    spocMeanRaOffsetArcsec: ra ? ra.value : null,
    spocMeanDecOffsetArcsec: dec ? dec.value : null,
    spocDvrFile: decodeURIComponent(chosen.url).split('/').pop(),
    spocSectorSpan: `s${String(chosen.first).padStart(4, '0')}-s${String(chosen.last).padStart(4, '0')}`,
    spocSectorsObserved: spocSectors,
    spocDvrCount: dv.length,
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
  // Pass 1: which cycles actually contain CLEAN in-transit cadences? A
  // short-period target can have its first cycles entirely quality-flagged
  // (observed on TOI 274.01, P=0.54 d: sectors with ~50 cycles where the
  // first 3 were all flagged), which would freeze a segment the engine
  // then discards for having zero usable in-transit points.
  const usableCycles = new Set()
  for (let r = 0; r < tpf.times.length; r++) {
    const t = tpf.times[r]
    if (!Number.isFinite(t) || tpf.quality[r] !== 0) continue
    const n = Math.round((t - t0) / P)
    if (Math.abs(t - (t0 + n * P)) < halfDur) usableCycles.add(n)
  }
  for (let r = 0; r < tpf.times.length; r++) {
    const t = tpf.times[r]
    if (!Number.isFinite(t)) continue
    const n = Math.round((t - t0) / P)
    const dt = Math.abs(t - (t0 + n * P))
    if (dt > halfDur * TRIM_HALFDUR_MULT) continue
    // Only spend the cycle budget on cycles with clean in-transit data.
    if (usableCycles.size > 0 && !usableCycles.has(n)) continue
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

  // Which segments WE froze. Recorded because SPOC's ms* ground truth
  // aggregates a different sector set, so any comparison must be able to
  // say which inputs each side actually used (issue #27).
  const capturedSegments = quarters.map(q => q.segment)
  const fixture = { ...meta, mission, capturedAt: new Date().toISOString(), magHeader, capturedSegments, quarters }
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

// TESS stars: ephemeris from the TOI table + SPOC DV ground truth where a
// Data Validation report exists (see module doc and issue #27).
for (const star of TESS_STARS) {
  const eph = await toiEphemeris(star.tic)
  console.log(
    `TESS ${star.name} → TOI ${eph.toi} (${eph.disp}), P=${eph.periodDays}d t0(TJD)=${eph.epochTjd.toFixed(3)} dur=${eph.durationHours}h Tmag=${eph.tmag}`,
  )
  const spoc = await spocCentroidGroundTruth(star.tic)
  if (spoc) {
    const sig = spoc.spocMeanSkyOffsetArcsec / spoc.spocMeanSkyOffsetErrArcsec
    console.log(
      `  SPOC DV: meanSkyOffset ${spoc.spocMeanSkyOffsetArcsec.toFixed(3)}″ ± ${spoc.spocMeanSkyOffsetErrArcsec.toFixed(3)} (${sig.toFixed(2)}σ) from ${spoc.spocDvrFile} [${spoc.spocSectorSpan}]`,
    )
  } else {
    console.log('  SPOC DV: none found')
  }
  await capture({
    fileKey: star.tic,
    mission: 'TESS',
    pixels: true,
    count: star.sectors,
    P: eph.periodDays,
    t0: eph.epochTjd,
    durHours: eph.durationHours,
    maxCycles: MAX_TESS_CYCLES_PER_SECTOR,
    meta: {
      label: `${star.name} TIC${star.tic}`,
      tic: star.tic,
      note: star.note,
      nasa: {
        disposition: eph.disp,
        toi: eph.toi,
        periodDays: eph.periodDays,
        epochBkjd: eph.epochTjd,
        durationHours: eph.durationHours,
        tmag: eph.tmag,
        // Kepler-only columns; kept null so the fixture shape stays uniform.
        diccoArcsec: null,
        diccoErrArcsec: null,
        dikcoArcsec: null,
        dikcoErrArcsec: null,
        // SPOC DV ground truth (issue #27). Null when no DV report exists.
        ...(spoc ?? {
          spocMeanSkyOffsetArcsec: null,
          spocMeanSkyOffsetErrArcsec: null,
          spocMeanRaOffsetArcsec: null,
          spocMeanDecOffsetArcsec: null,
          spocDvrFile: null,
          spocSectorSpan: null,
          spocSectorsObserved: null,
          spocDvrCount: 0,
        }),
      },
    },
  })
}
console.log('done')
