/**
 * @description Shared low-level FITS primitives used by BOTH readers in
 * this codebase: the scalar light-curve reader (`fitsReader.ts`, Kepler
 * `_llc.fits` / TESS `_lc.fits` PDC files) and the target-pixel-file
 * image-cube reader (`tpfReader.ts`, Kepler `_lpd-targ.fits.gz`).
 * Extracted from `fitsReader.ts` when TPF support landed — the TPF reader
 * needed the header parser, HDU walker, and column-layout scan verbatim,
 * which is the definition of a shared core.
 *
 * FITS spec summary used here:
 * - File is a stream of 2880-byte blocks.
 * - Each HDU = header block(s) + data block(s).
 * - Header lines are 80 chars: `KEYWORD = value / comment`.
 * - Header ends with an `END` line; data starts at the next 2880-byte
 *   boundary.
 * - Data size = |BITPIX|/8 × ΠNAXISi (+ PCOUNT) × GCOUNT, padded to 2880.
 * - BINTABLE columns are described by TFORM`n` (`D` = float64, `E` =
 *   float32, `J` = int32, `I` = int16; leading digits = repeat count) and
 *   optionally TDIM`n` (array shape for repeat > 1 columns).
 *
 * Server-side only (uses Node `Buffer`); no dependencies. DO NOT import
 * from client code.
 */

/** @description FITS block size in bytes — headers and data both pad to this. */
export const FITS_BLOCK = 2880

/**
 * @description Parses one FITS header into a {key → value} map.
 * @param buf Full file buffer.
 * @param offset Byte offset where this HDU's header starts.
 * @returns Header map and the offset of the first byte after the header.
 */
export function parseFitsHeader(
  buf: Buffer,
  offset: number,
): { header: Record<string, string>; dataStart: number } {
  const header: Record<string, string> = {}
  let cursor = offset
  while (true) {
    const block = buf.slice(cursor, cursor + FITS_BLOCK).toString('ascii')
    for (let i = 0; i < FITS_BLOCK; i += 80) {
      const line = block.slice(i, i + 80)
      const key = line.slice(0, 8).trim()
      if (key === 'END') {
        return { header, dataStart: cursor + FITS_BLOCK }
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
    cursor += FITS_BLOCK
    if (cursor >= buf.length) break
  }
  return { header, dataStart: cursor }
}

/**
 * @description Computes the size in bytes of an HDU's data section (before
 * block padding) from its parsed header: |BITPIX|/8 × ΠNAXISi, plus PCOUNT,
 * times GCOUNT. Returns 0 for header-only HDUs (NAXIS = 0).
 * @param header Parsed header map for the HDU.
 * @returns Unpadded data byte count.
 */
export function hduDataBytes(header: Record<string, string>): number {
  const naxis = parseInt(header['NAXIS'] ?? '0', 10)
  if (naxis <= 0) return 0
  const bitpix = Math.abs(parseInt(header['BITPIX'] ?? '0', 10))
  let n = bitpix / 8
  for (let i = 1; i <= naxis; i++) n *= parseInt(header[`NAXIS${i}`] ?? '0', 10)
  const pcount = parseInt(header['PCOUNT'] ?? '0', 10)
  const gcount = parseInt(header['GCOUNT'] ?? '1', 10)
  return (n + pcount) * gcount
}

/** @description One walked HDU: parsed header + where its data starts/how big it is. */
export interface FitsHdu {
  header: Record<string, string>
  /** Byte offset of the HDU's (block-aligned) data section. */
  dataStart: number
  /** Unpadded data byte count (0 for header-only HDUs). */
  dataBytes: number
}

/**
 * @description Walks every HDU in a FITS buffer in file order. Each yielded
 * entry carries the parsed header plus the data section's offset and
 * unpadded size, so callers can locate an HDU by XTENSION/EXTNAME and read
 * its data without re-deriving the block arithmetic.
 * @param buf FITS file contents.
 * @returns Array of HDUs in file order.
 */
export function enumerateHdus(buf: Buffer): FitsHdu[] {
  const hdus: FitsHdu[] = []
  let offset = 0
  while (offset < buf.length) {
    const { header, dataStart } = parseFitsHeader(buf, offset)
    const dataBytes = hduDataBytes(header)
    hdus.push({ header, dataStart, dataBytes })
    // `parseFitsHeader` always advances the cursor past at least one block
    // (or to the end of a truncated buffer), so this strictly increases.
    offset = dataStart + Math.ceil(dataBytes / FITS_BLOCK) * FITS_BLOCK
  }
  return hdus
}

/**
 * @description Maps FITS BINTABLE TFORM type letters to {bytes-per-element,
 * reader}. Only the types Kepler/TESS PDC and TPF files actually use are
 * supported (`D` float64, `E` float32, `J` int32, `I` int16).
 */
export const FITS_TYPE_INFO: Record<string, { size: number; read: (b: Buffer, o: number) => number }> = {
  D: { size: 8, read: (b, o) => b.readDoubleBE(o) },
  E: { size: 4, read: (b, o) => b.readFloatBE(o) },
  J: { size: 4, read: (b, o) => b.readInt32BE(o) },
  I: { size: 2, read: (b, o) => b.readInt16BE(o) },
}

/** @description Layout of one BINTABLE column within a row. */
export interface FitsColumnMeta {
  /** Byte offset of this column's first element within a row. */
  offsetInRow: number
  /** TFORM repeat count (array columns have repeat > 1). */
  repeat: number
  /** TFORM type letter (`D`/`E`/`J`/`I`; empty when unparseable). */
  type: string
  /** Raw TDIM value (e.g. "(8,8)") when the header declares one, else null. */
  tdim: string | null
}

/**
 * @description Scans a BINTABLE header's TTYPE/TFORM/TDIM cards into a
 * per-column layout map (name → offset/repeat/type/tdim) plus the row
 * geometry. Columns with unsupported TFORM letters contribute 0 bytes to
 * the running offset — same behavior the light-curve reader always had
 * (Kepler/TESS products only use the four supported types, so this never
 * fires in practice; it exists so an unexpected column doesn't crash the
 * scan before the caller can produce a useful "unsupported type" error).
 * @param header Parsed BINTABLE extension header.
 * @returns Column map and row geometry (`rowBytes` = NAXIS1, `nRows` = NAXIS2).
 */
export function bintableColumnLayout(header: Record<string, string>): {
  cols: Record<string, FitsColumnMeta>
  rowBytes: number
  nRows: number
} {
  const nFields = parseInt(header['TFIELDS'] ?? '0', 10)
  const cols: Record<string, FitsColumnMeta> = {}
  let offsetInRow = 0
  for (let i = 1; i <= nFields; i++) {
    const name = header[`TTYPE${i}`] ?? ''
    const form = header[`TFORM${i}`] ?? ''
    // TFORM is like "1D", "1E", "768E" — leading digits = repeat count
    const match = form.match(/^(\d*)([A-Z])/)
    const repeat = match && match[1] ? parseInt(match[1], 10) : 1
    const type = match ? match[2] : ''
    const info = FITS_TYPE_INFO[type]
    const size = info ? info.size * repeat : 0
    cols[name] = { offsetInRow, repeat, type, tdim: header[`TDIM${i}`] ?? null }
    offsetInRow += size
  }
  return {
    cols,
    rowBytes: parseInt(header['NAXIS1'] ?? '0', 10),
    nRows: parseInt(header['NAXIS2'] ?? '0', 10),
  }
}
