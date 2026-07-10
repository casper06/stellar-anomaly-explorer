/**
 * @description Reader for Kepler and TESS Target Pixel Files (Kepler
 * `_lpd-targ.fits.gz` long-cadence quarters; TESS `-s_tp.fits` 2-min
 * sectors). Built on the shared FITS primitives in `fitsCore.ts`.
 * Extracts the per-cadence image cube plus the metadata the centroid
 * engine and the saturation gate need — including the FLUX column's
 * per-segment WCS, which the engine uses to measure offsets against the
 * target's catalog position in true sky arcseconds.
 *
 * Real file structure (verified against live MAST downloads, 2026-07-10;
 * see docs/DESIGN_tpf-centroid-analysis.md §1.3 — the two missions'
 * products are near-identical):
 * - HDU 0 PRIMARY: identity keywords — KEPLERID/TICID, QUARTER/SECTOR,
 *   KEPMAG/TESSMAG (the saturation-gate input), RA_OBJ/DEC_OBJ. No data.
 * - HDU 1 BINTABLE `TARGETTABLES` (Kepler) / `PIXELS` (TESS): one row per
 *   cadence. Columns used: `TIME` (1D, BKJD/TJD), `QUALITY` (1J), `FLUX`
 *   (nE with TDIM=(nx,ny) — calibrated, background-subtracted e-/s image
 *   stamp, row-major with the first TDIM axis varying fastest). The FLUX
 *   column carries a full per-segment WCS in the header (`1CTYPn` =
 *   RA---TAN, `1CRPXn`/`2CRPXn` reference pixel — which IS the target's
 *   catalog position per the pipeline astrometry (`1CRVLn`/`2CRVLn` equal
 *   RA_OBJ/DEC_OBJ), `1CDLTn`/`2CDLTn` pixel scale in deg, and the
 *   `11PCn`…`22PCn` rotation matrix).
 * - HDU 2 IMAGE `APERTURE`: int32 bitmask image, same stamp shape.
 *   Bit 1 (value 1) = pixel was collected; bit 2 (value 2) = pixel is in
 *   the optimal photometric aperture.
 * - HDU 3 (TESS only): `TARGET COSMIC RAY` table — ignored.
 *
 * Server-side only (Node Buffer + zlib). DO NOT import from client code.
 */
import { gunzipSync } from 'node:zlib'
import { enumerateHdus, bintableColumnLayout, FITS_TYPE_INFO } from './fitsCore'

/**
 * @description Linear WCS of the FLUX column for one TPF segment: enough
 * to convert a pixel-space offset from the reference pixel into a
 * tangent-plane sky offset (ΔRA·cosδ, ΔDec). The TAN projection's
 * curvature is negligible at the sub-pixel offsets the engine measures.
 */
export interface TpfWcs {
  /** Reference pixel along stamp x, 1-based (FITS convention). Equals the target's catalog position. */
  crpx1: number
  /** Reference pixel along stamp y, 1-based. */
  crpx2: number
  /** RA at the reference pixel (deg). */
  crval1: number
  /** Dec at the reference pixel (deg). */
  crval2: number
  /** Pixel scale along axis 1 (deg/px; negative — RA grows east). */
  cdelt1: number
  /** Pixel scale along axis 2 (deg/px). */
  cdelt2: number
  /** Rotation matrix elements (PC convention). */
  pc11: number
  pc12: number
  pc21: number
  pc22: number
}

/**
 * @description Parsed contents of one TPF segment (Kepler quarter or TESS
 * sector) — everything the centroid engine consumes, in engine-ready
 * layout.
 */
export interface TpfQuarter {
  /** Which mission produced the file (from TELESCOP); null when absent. */
  mission: 'Kepler' | 'TESS' | null
  /**
   * Target brightness from the primary header — KEPMAG (Kp) for Kepler,
   * TESSMAG (Tmag) for TESS. Drives the saturation gate. Null when absent.
   */
  mag: number | null
  /** KIC/TIC id from the primary header; null when absent. */
  targetId: number | null
  /** Mission segment number (QUARTER or SECTOR); null when absent. */
  segment: number | null
  /** Stamp width in pixels (first TDIM axis, varies fastest in the cube). */
  nx: number
  /** Stamp height in pixels (second TDIM axis). */
  ny: number
  /** Per-cadence timestamps (BKJD/TJD). NaN preserved for gap cadences. */
  times: number[]
  /** Per-cadence pipeline quality flags (0 = clean). */
  quality: number[]
  /**
   * Flux cube, `times.length × (nx*ny)` in cadence-major order; within a
   * cadence the pixel at (x, y) sits at index `x + y*nx`. NaN preserved
   * for uncollected / missing pixels.
   */
  flux: Float32Array
  /** FLUX-column WCS for this segment; null when the keywords are absent. */
  wcs: TpfWcs | null
  /**
   * Aperture bitmask image (`nx*ny`, same pixel order as `flux`); bit 2
   * marks the optimal photometric aperture. Null when the APERTURE HDU
   * is missing.
   */
  apertureMask: Int32Array | null
}

/** @description Gzip magic bytes — Kepler TPFs are served `.gz`; TESS raw. */
const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b

/**
 * @description Parses a header value as a finite number, or null.
 * @param header Parsed FITS header map.
 * @param key Keyword to read.
 * @returns The numeric value, or null when missing/non-numeric.
 */
function headerNumber(header: Record<string, string>, key: string): number | null {
  const raw = header[key]
  if (raw === undefined) return null
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

/**
 * @description Extracts the FLUX column's per-segment WCS from the pixel
 * BINTABLE header. Returns null when any required keyword is missing —
 * the engine then falls back to its fixed-pixel-scale photocenter path.
 * @param header Pixel-table extension header.
 * @param colNum 1-based FITS column number of FLUX (keywords are per-column).
 * @returns The linear WCS, or null.
 */
function readFluxWcs(header: Record<string, string>, colNum: number): TpfWcs | null {
  const n = colNum
  const wcs = {
    crpx1: headerNumber(header, `1CRPX${n}`),
    crpx2: headerNumber(header, `2CRPX${n}`),
    crval1: headerNumber(header, `1CRVL${n}`),
    crval2: headerNumber(header, `2CRVL${n}`),
    cdelt1: headerNumber(header, `1CDLT${n}`),
    cdelt2: headerNumber(header, `2CDLT${n}`),
    pc11: headerNumber(header, `11PC${n}`),
    pc12: headerNumber(header, `12PC${n}`),
    pc21: headerNumber(header, `21PC${n}`),
    pc22: headerNumber(header, `22PC${n}`),
  }
  for (const v of Object.values(wcs)) if (v === null) return null
  return wcs as TpfWcs
}

/**
 * @description Reads a Kepler or TESS Target Pixel File into the
 * engine-ready `TpfQuarter` shape. Accepts gzipped or raw FITS bytes.
 * @param raw File contents (gzipped or plain FITS).
 * @returns Parsed segment.
 * @throws Error when no BINTABLE exists, a required column (TIME / FLUX /
 * QUALITY) is missing or has an unsupported type, or FLUX carries no
 * parseable TDIM shape.
 */
export function readTpf(raw: Buffer): TpfQuarter {
  const buf =
    raw.length >= 2 && raw[0] === GZIP_MAGIC_0 && raw[1] === GZIP_MAGIC_1 ? gunzipSync(raw) : raw

  const hdus = enumerateHdus(buf)
  if (hdus.length === 0) throw new Error('Empty FITS file')
  const primary = hdus[0].header

  const bintable = hdus.find(h => h.header['XTENSION'] === 'BINTABLE')
  if (!bintable) throw new Error('No BINTABLE extension found in FITS file')

  const { cols, rowBytes, nRows } = bintableColumnLayout(bintable.header)
  const timeMeta = cols['TIME']
  const fluxMeta = cols['FLUX']
  const qualityMeta = cols['QUALITY']
  if (!timeMeta || !fluxMeta || !qualityMeta) {
    throw new Error(`TPF columns not found (need TIME, FLUX, QUALITY): have ${Object.keys(cols).join(', ')}`)
  }
  const timeReader = FITS_TYPE_INFO[timeMeta.type]
  const qualityReader = FITS_TYPE_INFO[qualityMeta.type]
  if (!timeReader || !qualityReader || fluxMeta.type !== 'E') {
    throw new Error(
      `Unsupported TPF column types: TIME=${timeMeta.type}, FLUX=${fluxMeta.type}, QUALITY=${qualityMeta.type}`,
    )
  }

  // Stamp shape from FLUX's TDIM, e.g. "(8,8)". The first axis varies
  // fastest in the stored cube (FITS array convention).
  const tdimMatch = fluxMeta.tdim?.match(/^\((\d+)\s*,\s*(\d+)\)$/)
  if (!tdimMatch) {
    throw new Error(`FLUX column has no parseable TDIM shape (got ${JSON.stringify(fluxMeta.tdim)})`)
  }
  const nx = parseInt(tdimMatch[1], 10)
  const ny = parseInt(tdimMatch[2], 10)
  const nPx = nx * ny
  if (nPx !== fluxMeta.repeat) {
    throw new Error(`FLUX TDIM (${nx}×${ny}) disagrees with repeat count ${fluxMeta.repeat}`)
  }

  // FLUX's 1-based column number (per-column WCS keywords are indexed by it).
  const fluxColNum = Object.keys(cols).indexOf('FLUX') + 1

  const dataStart = bintable.dataStart
  const times = new Array<number>(nRows)
  const quality = new Array<number>(nRows)
  const flux = new Float32Array(nRows * nPx)
  for (let row = 0; row < nRows; row++) {
    const rowStart = dataStart + row * rowBytes
    times[row] = timeReader.read(buf, rowStart + timeMeta.offsetInRow)
    quality[row] = qualityReader.read(buf, rowStart + qualityMeta.offsetInRow)
    const fluxStart = rowStart + fluxMeta.offsetInRow
    for (let p = 0; p < nPx; p++) {
      flux[row * nPx + p] = buf.readFloatBE(fluxStart + 4 * p)
    }
  }

  // APERTURE image HDU (int32 bitmask). Optional — the engine centroids
  // the full stamp; the mask only drives UI aperture outlines.
  let apertureMask: Int32Array | null = null
  const aperture = hdus.find(h => h.header['EXTNAME'] === 'APERTURE')
  if (aperture) {
    const aw = parseInt(aperture.header['NAXIS1'] ?? '0', 10)
    const ah = parseInt(aperture.header['NAXIS2'] ?? '0', 10)
    if (aw === nx && ah === ny && Math.abs(parseInt(aperture.header['BITPIX'] ?? '0', 10)) === 32) {
      apertureMask = new Int32Array(nPx)
      for (let p = 0; p < nPx; p++) {
        apertureMask[p] = buf.readInt32BE(aperture.dataStart + 4 * p)
      }
    }
  }

  const telescop = primary['TELESCOP'] ?? ''
  const mission = telescop === 'Kepler' ? 'Kepler' : telescop === 'TESS' ? 'TESS' : null
  return {
    mission,
    mag: headerNumber(primary, 'KEPMAG') ?? headerNumber(primary, 'TESSMAG'),
    targetId: headerNumber(primary, 'KEPLERID') ?? headerNumber(primary, 'TICID'),
    segment: headerNumber(primary, 'QUARTER') ?? headerNumber(primary, 'SECTOR'),
    nx,
    ny,
    times,
    quality,
    flux,
    wcs: readFluxWcs(bintable.header, fluxColNum),
    apertureMask,
  }
}
