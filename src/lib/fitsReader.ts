/**
 * @description Minimal FITS reader scoped to MAST PDC light-curve files (both
 * Kepler and TESS — they share the same HDU layout, the same BINTABLE
 * structure, and the same `TIME` / `PDCSAP_FLUX` column names). The reader
 * walks the Header Data Units (HDUs), finds the first BINTABLE extension
 * (the time-series), and pulls two specific columns by name.
 *
 * Verified against:
 * - Kepler `_llc.fits` (BJD - 2454833 = BKJD; ~30-min cadence quarters)
 * - TESS `_lc.fits` (BJD - 2457000 = TJD; ~2-min cadence sectors)
 *
 * The TIME axis offsets differ (BKJD vs TJD), but our consumer treats time
 * as opaque days from `times[0]` for gap detection and from a per-sample
 * relative axis for dip detection, so the mission-specific epoch doesn't
 * matter inside this code.
 *
 * The low-level primitives (block/header parsing, HDU walking, column
 * layout, TFORM type table) live in `fitsCore.ts`, shared with the
 * target-pixel-file reader (`tpfReader.ts`). This module keeps only the
 * scalar-column extraction specific to light-curve files.
 *
 * DO NOT import this from client code (uses Node Buffer).
 */
import { enumerateHdus, bintableColumnLayout, FITS_TYPE_INFO } from './fitsCore'

/**
 * @description Extracts two named columns from the first BINTABLE extension
 * found in a MAST PDC FITS file (Kepler `_llc.fits` or TESS `_lc.fits`).
 * Returns parallel arrays of `number | null` (null preserved for NaN entries
 * so dip detection can skip them).
 * @param buf FITS file contents as a Buffer.
 * @param colNames Pair of column names to extract, e.g. ['TIME', 'PDCSAP_FLUX'].
 * @returns Parallel arrays for the two columns, in row order.
 * @throws Error if the file has no BINTABLE or a requested column isn't found.
 */
export function readMastLightcurveColumns(
  buf: Buffer,
  colNames: [string, string],
): { col1: (number | null)[]; col2: (number | null)[] } {
  // Walk HDUs until we hit a BINTABLE extension.
  const bintable = enumerateHdus(buf).find(h => h.header['XTENSION'] === 'BINTABLE')
  if (!bintable) throw new Error('No BINTABLE extension found in FITS file')

  const { header, dataStart } = bintable
  const { cols, rowBytes, nRows } = bintableColumnLayout(header)

  const meta1 = cols[colNames[0]]
  const meta2 = cols[colNames[1]]
  if (!meta1 || !meta2) {
    throw new Error(`Columns not found: have ${Object.keys(cols).join(', ')}`)
  }
  const reader1 = FITS_TYPE_INFO[meta1.type]
  const reader2 = FITS_TYPE_INFO[meta2.type]
  if (!reader1 || !reader2) {
    throw new Error(`Unsupported TFORM types: ${meta1.type}, ${meta2.type}`)
  }

  const col1: (number | null)[] = new Array(nRows)
  const col2: (number | null)[] = new Array(nRows)

  for (let row = 0; row < nRows; row++) {
    const rowStart = dataStart + row * rowBytes
    const v1 = reader1.read(buf, rowStart + meta1.offsetInRow)
    const v2 = reader2.read(buf, rowStart + meta2.offsetInRow)
    col1[row] = Number.isFinite(v1) ? v1 : null
    col2[row] = Number.isFinite(v2) ? v2 : null
  }

  return { col1, col2 }
}
