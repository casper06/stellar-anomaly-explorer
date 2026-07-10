/**
 * @description Unit tests for the hand-rolled FITS BINTABLE reader. Each
 * test constructs a minimal synthetic FITS buffer to the spec the reader
 * targets (2880-byte blocks, 80-char header cards, big-endian BINTABLE
 * payload) and asserts extraction behavior: HDU walking, column lookup by
 * TTYPE, all four supported TFORM element types, repeat-count offset
 * arithmetic, NaN→null propagation, multi-block headers, and the two
 * documented error paths.
 *
 * Run via `npm run test:unit` (plain Node ≥ 22.6, node:test + native
 * type stripping — no framework).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readMastLightcurveColumns } from '../src/fitsReader.ts'

const BLOCK = 2880

/**
 * @description Formats one FITS header card: keyword padded to 8 chars,
 * `= `, then the value, padded to the 80-char card width.
 * @param key Header keyword (≤8 chars).
 * @param value Value as it should appear after `= ` (quote strings
 * yourself: `"'BINTABLE'"`).
 * @returns 80-character card string.
 */
function card(key: string, value: string): string {
  return `${key.padEnd(8)}= ${value}`.padEnd(80)
}

/**
 * @description Builds a full FITS header from cards: appends the END card
 * and pads with spaces to a whole number of 2880-byte blocks.
 * @param cards Pre-formatted 80-char cards (see `card`).
 * @returns Header bytes ready to concatenate into a file buffer.
 */
function headerBlocks(cards: string[]): Buffer {
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
function padData(data: Buffer): Buffer {
  const blocks = Math.ceil(data.length / BLOCK)
  return Buffer.concat([data, Buffer.alloc(blocks * BLOCK - data.length)])
}

/** @description Minimal primary HDU (header only, no data). */
function primaryHdu(): Buffer {
  return headerBlocks([card('SIMPLE', 'T'), card('BITPIX', '8'), card('NAXIS', '0')])
}

/**
 * @description One column spec for `bintableHdu`: TTYPE name, TFORM string
 * (e.g. "1D", "3E"), and a per-row writer that appends this column's bytes.
 */
interface ColSpec {
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
 * @returns Full HDU bytes.
 */
function bintableHdu(colSpecs: ColSpec[], nRows: number, rowBytes: number): Buffer {
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
  ]
  const data = Buffer.alloc(nRows * rowBytes)
  for (let r = 0; r < nRows; r++) {
    let offset = r * rowBytes
    for (const c of colSpecs) offset += c.write(data, offset, r)
  }
  return Buffer.concat([headerBlocks(cards), padData(data)])
}

/** @description Standard two-column (TIME 1D + PDCSAP_FLUX 1E) table with given values. */
function standardFile(times: number[], flux: number[]): Buffer {
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

describe('readMastLightcurveColumns', () => {
  it('extracts D and E columns from a standard TIME/PDCSAP_FLUX table', () => {
    // Float32-exact values so the E column compares with strict equality.
    const buf = standardFile([100.5, 101.25, 102.0], [1.5, 0.75, 1.25])
    const { col1, col2 } = readMastLightcurveColumns(buf, ['TIME', 'PDCSAP_FLUX'])
    assert.deepEqual(col1, [100.5, 101.25, 102.0])
    assert.deepEqual(col2, [1.5, 0.75, 1.25])
  })

  it('preserves NaN entries as null (gap rows must not become numbers)', () => {
    const buf = standardFile([100.5, NaN, 102.0], [1.5, NaN, 1.25])
    const { col1, col2 } = readMastLightcurveColumns(buf, ['TIME', 'PDCSAP_FLUX'])
    assert.deepEqual(col1, [100.5, null, 102.0])
    assert.deepEqual(col2, [1.5, null, 1.25])
  })

  it('reads J (int32) and I (int16) columns', () => {
    const hdu = bintableHdu(
      [
        { name: 'TIME', tform: '1D', write: (b, o, r) => { b.writeDoubleBE(100 + r, o); return 8 } },
        { name: 'CADENCENO', tform: '1J', write: (b, o, r) => { b.writeInt32BE(50000 + r, o); return 4 } },
        { name: 'SAP_QUALITY', tform: '1I', write: (b, o, r) => { b.writeInt16BE(r === 1 ? -8 : 0, o); return 2 } },
      ],
      2,
      14,
    )
    const buf = Buffer.concat([primaryHdu(), hdu])
    const j = readMastLightcurveColumns(buf, ['TIME', 'CADENCENO'])
    assert.deepEqual(j.col2, [50000, 50001])
    const i = readMastLightcurveColumns(buf, ['TIME', 'SAP_QUALITY'])
    assert.deepEqual(i.col2, [0, -8])
  })

  it('honors TFORM repeat counts when computing column offsets', () => {
    // Leading 3E column (12 bytes) shifts TIME's offset within the row;
    // reading TIME must skip past all three floats.
    const hdu = bintableHdu(
      [
        { name: 'PADDING', tform: '3E', write: (b, o) => { b.writeFloatBE(9, o); b.writeFloatBE(9, o + 4); b.writeFloatBE(9, o + 8); return 12 } },
        { name: 'TIME', tform: '1D', write: (b, o, r) => { b.writeDoubleBE(200 + r, o); return 8 } },
        { name: 'PDCSAP_FLUX', tform: '1E', write: (b, o, r) => { b.writeFloatBE(r + 0.5, o); return 4 } },
      ],
      2,
      24,
    )
    const buf = Buffer.concat([primaryHdu(), hdu])
    const { col1, col2 } = readMastLightcurveColumns(buf, ['TIME', 'PDCSAP_FLUX'])
    assert.deepEqual(col1, [200, 201])
    assert.deepEqual(col2, [0.5, 1.5])
  })

  it('walks past a non-BINTABLE extension (with data) to reach the table', () => {
    // IMAGE extension carrying 100 bytes of 8-bit data — the walker must
    // advance past its block-padded data section, not parse it as a header.
    const imageHeader = headerBlocks([
      card('XTENSION', "'IMAGE'"),
      card('BITPIX', '8'),
      card('NAXIS', '2'),
      card('NAXIS1', '10'),
      card('NAXIS2', '10'),
      card('PCOUNT', '0'),
      card('GCOUNT', '1'),
    ])
    const imageData = padData(Buffer.alloc(100, 0xff))
    const table = standardFile([300.5], [1.0]) // primary + bintable
    const buf = Buffer.concat([primaryHdu(), imageHeader, imageData, table.slice(BLOCK)])
    const { col1, col2 } = readMastLightcurveColumns(buf, ['TIME', 'PDCSAP_FLUX'])
    assert.deepEqual(col1, [300.5])
    assert.deepEqual(col2, [1.0])
  })

  it('parses headers spanning multiple 2880-byte blocks (>36 cards)', () => {
    // 40 filler cards force the BINTABLE header into a second block.
    const filler = Array.from({ length: 40 }, (_, k) => card(`DUMMY${k}`, String(k)))
    const cards = [
      card('XTENSION', "'BINTABLE'"),
      card('BITPIX', '8'),
      card('NAXIS', '2'),
      card('NAXIS1', '12'),
      card('NAXIS2', '1'),
      card('PCOUNT', '0'),
      card('GCOUNT', '1'),
      card('TFIELDS', '2'),
      ...filler,
      card('TTYPE1', "'TIME'"),
      card('TFORM1', "'1D'"),
      card('TTYPE2', "'PDCSAP_FLUX'"),
      card('TFORM2', "'1E'"),
    ]
    const data = Buffer.alloc(12)
    data.writeDoubleBE(400.5, 0)
    data.writeFloatBE(2.5, 8)
    const buf = Buffer.concat([primaryHdu(), headerBlocks(cards), padData(data)])
    const { col1, col2 } = readMastLightcurveColumns(buf, ['TIME', 'PDCSAP_FLUX'])
    assert.deepEqual(col1, [400.5])
    assert.deepEqual(col2, [2.5])
  })

  it('throws when no BINTABLE extension exists', () => {
    assert.throws(
      () => readMastLightcurveColumns(primaryHdu(), ['TIME', 'PDCSAP_FLUX']),
      /No BINTABLE/,
    )
  })

  it('throws (naming available columns) when a requested column is missing', () => {
    const buf = standardFile([1], [1])
    assert.throws(
      () => readMastLightcurveColumns(buf, ['TIME', 'SAP_FLUX']),
      /Columns not found: have TIME, PDCSAP_FLUX/,
    )
  })
})
