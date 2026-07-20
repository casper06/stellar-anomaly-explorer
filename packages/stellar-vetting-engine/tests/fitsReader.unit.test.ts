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
// Synthetic-FITS builders are shared with fitsCore.unit.test.ts so both
// suites construct byte-identical fixtures from one definition.
import {
  BLOCK,
  card,
  headerBlocks,
  padData,
  primaryHdu,
  bintableHdu,
  standardFile,
} from './syntheticFits.ts'

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
