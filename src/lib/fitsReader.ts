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
 * FITS spec summary used here:
 * - File is a stream of 2880-byte blocks.
 * - Each HDU = header block(s) + data block(s).
 * - Header lines are 80 chars: `KEYWORD = value / comment`.
 * - Header ends with an `END` line; data starts at the next 2880-byte boundary.
 * - BINTABLE data size = NAXIS1 (row bytes) × NAXIS2 (rows), padded to 2880.
 * - TFORM`n` describes column type (`D` = float64, `E` = float32, `J` = int32,
 *   `I` = int16). We support all four since Kepler/TESS PDC files use them.
 */

const BLOCK = 2880

/**
 * @description Parses one FITS header into a {key → value} map.
 * @param buf Full file buffer.
 * @param offset Byte offset where this HDU's header starts.
 * @returns Header map and the offset of the first byte after the header.
 */
function parseHeader(buf: Buffer, offset: number): { header: Record<string, string>; dataStart: number } {
  const header: Record<string, string> = {}
  let cursor = offset
  while (true) {
    const block = buf.slice(cursor, cursor + BLOCK).toString('ascii')
    for (let i = 0; i < BLOCK; i += 80) {
      const line = block.slice(i, i + 80)
      const key = line.slice(0, 8).trim()
      if (key === 'END') {
        return { header, dataStart: cursor + BLOCK }
      }
      if (key === '' || line[8] !== '=') continue
      const rest = line.slice(9).trim()
      // Strip trailing comment after the value
      let value: string
      if (rest.startsWith("'")) {
        const end = rest.indexOf("'", 1)
        value = end > 0 ? rest.slice(1, end).trim() : rest.slice(1).trim()
      } else {
        const slash = rest.indexOf('/')
        value = slash >= 0 ? rest.slice(0, slash).trim() : rest.trim()
      }
      header[key] = value
    }
    cursor += BLOCK
    if (cursor >= buf.length) break
  }
  return { header, dataStart: cursor }
}

/**
 * @description Maps FITS BINTABLE TFORM type letters to {bytes-per-element,
 * reader}. Only the types Kepler PDC files actually use are supported.
 */
const TYPE_INFO: Record<string, { size: number; read: (b: Buffer, o: number) => number }> = {
  D: { size: 8, read: (b, o) => b.readDoubleBE(o) },
  E: { size: 4, read: (b, o) => b.readFloatBE(o) },
  J: { size: 4, read: (b, o) => b.readInt32BE(o) },
  I: { size: 2, read: (b, o) => b.readInt16BE(o) },
}

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
  let offset = 0
  let header: Record<string, string> | null = null
  let dataStart = 0

  while (offset < buf.length) {
    const parsed = parseHeader(buf, offset)
    const xtension = parsed.header['XTENSION']
    const isBintable = xtension === 'BINTABLE'

    // Compute this HDU's data size to advance past it if we don't use it
    const naxis = parseInt(parsed.header['NAXIS'] ?? '0', 10)
    let dataBytes = 0
    if (naxis > 0) {
      const bitpix = Math.abs(parseInt(parsed.header['BITPIX'] ?? '0', 10))
      let n = bitpix / 8
      for (let i = 1; i <= naxis; i++) n *= parseInt(parsed.header[`NAXIS${i}`] ?? '0', 10)
      const pcount = parseInt(parsed.header['PCOUNT'] ?? '0', 10)
      const gcount = parseInt(parsed.header['GCOUNT'] ?? '1', 10)
      dataBytes = (n + pcount) * gcount
    }
    const padded = Math.ceil(dataBytes / BLOCK) * BLOCK

    if (isBintable) {
      header = parsed.header
      dataStart = parsed.dataStart
      break
    }
    offset = parsed.dataStart + padded
  }

  if (!header) throw new Error('No BINTABLE extension found in FITS file')

  const nRows = parseInt(header['NAXIS2'] ?? '0', 10)
  const rowBytes = parseInt(header['NAXIS1'] ?? '0', 10)
  const nFields = parseInt(header['TFIELDS'] ?? '0', 10)

  // Compute each column's offset within a row + its element type
  type ColMeta = { offsetInRow: number; repeat: number; type: string }
  const cols: Record<string, ColMeta> = {}
  let offsetInRow = 0
  for (let i = 1; i <= nFields; i++) {
    const name = header[`TTYPE${i}`] ?? ''
    const form = header[`TFORM${i}`] ?? ''
    // TFORM is like "1D", "1E", "768E" — leading digits = repeat count
    const match = form.match(/^(\d*)([A-Z])/)
    const repeat = match && match[1] ? parseInt(match[1], 10) : 1
    const type = match ? match[2] : ''
    const info = TYPE_INFO[type]
    const size = info ? info.size * repeat : 0
    cols[name] = { offsetInRow, repeat, type }
    offsetInRow += size
  }

  const meta1 = cols[colNames[0]]
  const meta2 = cols[colNames[1]]
  if (!meta1 || !meta2) {
    throw new Error(`Columns not found: have ${Object.keys(cols).join(', ')}`)
  }
  const reader1 = TYPE_INFO[meta1.type]
  const reader2 = TYPE_INFO[meta2.type]
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
