/**
 * @description Reader for Kepler Target Pixel Files (`_lpd-targ.fits.gz`,
 * the long-cadence per-quarter pixel product). Built on the shared FITS
 * primitives in `fitsCore.ts`. Extracts the per-cadence image cube plus
 * the metadata the centroid engine and the saturation gate need.
 *
 * Real file structure (verified against live MAST downloads, 2026-07-10;
 * see docs/DESIGN_tpf-centroid-analysis.md §1.3):
 * - HDU 0 PRIMARY: identity keywords — KEPLERID, QUARTER, KEPMAG (the
 *   saturation-gate input), MODULE/OUTPUT, RA_OBJ/DEC_OBJ. No data.
 * - HDU 1 BINTABLE `TARGETTABLES`: one row per cadence. Columns used:
 *   `TIME` (1D, BKJD), `QUALITY` (1J), `FLUX` (nE with TDIM=(nx,ny) —
 *   calibrated, background-subtracted e-/s image stamp, row-major with
 *   the first TDIM axis varying fastest).
 * - HDU 2 IMAGE `APERTURE`: int32 bitmask image, same stamp shape.
 *   Bit 1 (value 1) = pixel was collected; bit 2 (value 2) = pixel is in
 *   the optimal photometric aperture.
 *
 * Kepler-only by design: TESS `_tp.fits` support is explicitly deferred
 * (its TPF discovery URL is a derived naming pattern, not a documented
 * MAST contract, and TESS has no queryable per-TOI centroid ground truth
 * to calibrate against). The structure is near-identical, so the TESS
 * reader would be a thin variant when/if that decision changes.
 *
 * Server-side only (Node Buffer + zlib). DO NOT import from client code.
 */
import { gunzipSync } from 'node:zlib'
import { enumerateHdus, bintableColumnLayout, FITS_TYPE_INFO } from './fitsCore'

/**
 * @description Parsed contents of one Kepler TPF quarter — everything the
 * centroid engine consumes, in engine-ready layout.
 */
export interface TpfQuarter {
  /** Kepler magnitude (Kp) from the primary header; null when absent. */
  kepmag: number | null
  /** KIC id from the primary header; null when absent. */
  keplerId: number | null
  /** Mission quarter number from the primary header; null when absent. */
  quarter: number | null
  /** Stamp width in pixels (first TDIM axis, varies fastest in the cube). */
  nx: number
  /** Stamp height in pixels (second TDIM axis). */
  ny: number
  /** Per-cadence timestamps (BKJD). NaN preserved for gap cadences. */
  times: number[]
  /** Per-cadence pipeline quality flags (0 = clean). */
  quality: number[]
  /**
   * Flux cube, `times.length × (nx*ny)` in cadence-major order; within a
   * cadence the pixel at (x, y) sits at index `x + y*nx`. NaN preserved
   * for uncollected / missing pixels.
   */
  flux: Float32Array
  /** Physical CCD column of the stamp corner (1CRV5P); null when absent. */
  refCol: number | null
  /** Physical CCD row of the stamp corner (2CRV5P); null when absent. */
  refRow: number | null
  /**
   * Aperture bitmask image (`nx*ny`, same pixel order as `flux`); bit 2
   * marks the optimal photometric aperture. Null when the APERTURE HDU
   * is missing.
   */
  apertureMask: Int32Array | null
}

/** @description Gzip magic bytes — Kepler TPFs are served `.gz`. */
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
 * @description Reads a Kepler long-cadence Target Pixel File into the
 * engine-ready `TpfQuarter` shape. Accepts gzipped or raw FITS bytes
 * (MAST serves `_lpd-targ.fits.gz`; the fixture-capture path may hand in
 * already-unpacked buffers).
 * @param raw File contents (gzipped or plain FITS).
 * @returns Parsed quarter.
 * @throws Error when no BINTABLE exists, a required column (TIME / FLUX /
 * QUALITY) is missing or has an unsupported type, or FLUX carries no
 * parseable TDIM shape.
 */
export function readKeplerTpf(raw: Buffer): TpfQuarter {
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

  return {
    kepmag: headerNumber(primary, 'KEPMAG'),
    keplerId: headerNumber(primary, 'KEPLERID'),
    quarter: headerNumber(primary, 'QUARTER'),
    nx,
    ny,
    times,
    quality,
    flux,
    refCol: headerNumber(bintable.header, '1CRV5P'),
    refRow: headerNumber(bintable.header, '2CRV5P'),
    apertureMask,
  }
}
