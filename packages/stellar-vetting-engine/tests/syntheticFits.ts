/**
 * @description Shared builders for synthetic FITS buffers used by the
 * reader test suites (`fitsReader`, `fitsCore`). Extracted from
 * `fitsReader.unit.test.ts` when `fitsCore.unit.test.ts` was added so
 * the two suites construct byte-identical fixtures from ONE definition
 * — a divergence between them would silently weaken whichever suite
 * drifted.
 *
 * Everything here builds spec-shaped bytes by hand (80-char cards,
 * 2880-byte blocks, big-endian payloads); nothing reads a real file, so
 * the suites stay offline and deterministic.
 *
 * Test-only: NOT part of the published engine surface, and not imported
 * by anything under `src/`.
 */

/** @description FITS block size in bytes — headers and data are padded to a multiple of this. */
export const BLOCK = 2880

/**
 * @description Formats one FITS header card: keyword padded to 8 chars,
 * `= `, then the value, padded to the 80-char card width.
 * @param key Header keyword (≤8 chars).
 * @param value Value as it should appear after `= ` (quote strings
 * yourself: `"'BINTABLE'"`).
 * @returns 80-character card string.
 */
export function card(key: string, value: string): string {
  return `${key.padEnd(8)}= ${value}`.padEnd(80)
}

/**
 * @description Builds a full FITS header from cards: appends the END card
 * and pads with spaces to a whole number of 2880-byte blocks.
 * @param cards Pre-formatted 80-char cards (see `card`).
 * @returns Header bytes ready to concatenate into a file buffer.
 */
export function headerBlocks(cards: string[]): Buffer {
  let text = cards.join('') + 'END'.padEnd(80)
  const blocks = Math.ceil(text.length / BLOCK)
  text = text.padEnd(blocks * BLOCK)
  return Buffer.from(text, 'ascii')
}

/**
 * @description Pads a data payload to a whole number of 2880-byte blocks
 * (FITS requires block-aligned data sections).
 * @param data Raw data bytes.
 * @returns Block-padded copy.
 */
export function padData(data: Buffer): Buffer {
  const blocks = Math.ceil(data.length / BLOCK)
  return Buffer.concat([data, Buffer.alloc(blocks * BLOCK - data.length)])
}

/**
 * @description Minimal primary HDU (header only, no data).
 * @returns Primary HDU bytes.
 */
export function primaryHdu(): Buffer {
  return headerBlocks([card('SIMPLE', 'T'), card('BITPIX', '8'), card('NAXIS', '0')])
}

/**
 * @description One column spec for `bintableHdu`: TTYPE name, TFORM string
 * (e.g. "1D", "3E"), and a per-row writer that appends this column's bytes.
 */
export interface ColSpec {
  name: string
  tform: string
  /** Writes this column's bytes for row `r` into `buf` at `offset`; returns bytes written. */
  write: (buf: Buffer, offset: number, r: number) => number
}

/**
 * @description Builds a BINTABLE extension HDU (header + block-padded data)
 * from column specs and a row count.
 * @param colSpecs Column definitions in physical order.
 * @param nRows Number of table rows.
 * @param rowBytes Total bytes per row (must match the sum of column widths).
 * @param extraCards Additional header cards (e.g. TDIM, TNULL) appended
 * after the generated ones — used by the fitsCore edge-case suite.
 * @returns Full HDU bytes.
 */
export function bintableHdu(
  colSpecs: ColSpec[],
  nRows: number,
  rowBytes: number,
  extraCards: string[] = [],
): Buffer {
  const cards = [
    card('XTENSION', "'BINTABLE'"),
    card('BITPIX', '8'),
    card('NAXIS', '2'),
    card('NAXIS1', String(rowBytes)),
    card('NAXIS2', String(nRows)),
    card('PCOUNT', '0'),
    card('GCOUNT', '1'),
    card('TFIELDS', String(colSpecs.length)),
    ...colSpecs.flatMap((c, i) => [
      card(`TTYPE${i + 1}`, `'${c.name}'`),
      card(`TFORM${i + 1}`, `'${c.tform}'`),
    ]),
    ...extraCards,
  ]
  const data = Buffer.alloc(nRows * rowBytes)
  for (let r = 0; r < nRows; r++) {
    let offset = r * rowBytes
    for (const c of colSpecs) offset += c.write(data, offset, r)
  }
  return Buffer.concat([headerBlocks(cards), padData(data)])
}

/**
 * @description Standard two-column (TIME 1D + PDCSAP_FLUX 1E) light-curve
 * file: primary HDU + one BINTABLE, matching the real MAST product layout.
 * @param times TIME column values.
 * @param flux PDCSAP_FLUX column values.
 * @returns Full file bytes.
 */
export function standardFile(times: number[], flux: number[]): Buffer {
  const hdu = bintableHdu(
    [
      { name: 'TIME', tform: '1D', write: (b, o, r) => { b.writeDoubleBE(times[r], o); return 8 } },
      { name: 'PDCSAP_FLUX', tform: '1E', write: (b, o, r) => { b.writeFloatBE(flux[r], o); return 4 } },
    ],
    times.length,
    12,
  )
  return Buffer.concat([primaryHdu(), hdu])
}
