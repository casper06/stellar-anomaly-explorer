/**
 * @description Unit tests for the Kepler Target Pixel File reader. Each
 * test constructs a minimal synthetic TPF FITS buffer to the real product
 * spec (verified against live MAST downloads: PRIMARY with KEPMAG/QUARTER,
 * TARGETTABLES BINTABLE with a TDIM-shaped FLUX array column, APERTURE
 * int32 image) and asserts extraction behavior: cube pixel ordering, TDIM
 * parsing, NaN preservation, header metadata, the aperture bitmask, the
 * gzip path, and the documented error paths.
 *
 * Run via `npm run test:unit` (plain Node ≥ 22.6, node:test + native
 * type stripping — no framework).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { readKeplerTpf } from '../tpfReader.ts'

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
 * @description Pads a data payload to a whole number of 2880-byte blocks.
 * @param data Raw data bytes.
 * @returns Block-padded copy.
 */
function padData(data: Buffer): Buffer {
  const blocks = Math.ceil(data.length / BLOCK)
  return Buffer.concat([data, Buffer.alloc(blocks * BLOCK - data.length)])
}

/**
 * @description Primary HDU carrying the identity keywords a real Kepler
 * TPF has (KEPMAG drives the saturation gate).
 * @param overrides Cards to add/replace (e.g. omit KEPMAG).
 * @returns Header-only primary HDU bytes.
 */
function tpfPrimaryHdu(extra: string[] = []): Buffer {
  return headerBlocks([
    card('SIMPLE', 'T'),
    card('BITPIX', '8'),
    card('NAXIS', '0'),
    card('KEPLERID', '5991936'),
    card('QUARTER', '9'),
    card('KEPMAG', '13.424'),
    ...extra,
  ])
}

/**
 * @description Builds the TARGETTABLES BINTABLE HDU with the three columns
 * the reader needs (TIME 1D, FLUX nE + TDIM, QUALITY 1J) for a 2×2 stamp.
 * @param times Per-cadence timestamps (NaN allowed).
 * @param cubes Per-cadence 4-pixel stamps in (x + y*2) order.
 * @param quality Per-cadence quality flags.
 * @param opts Optional TDIM override / omission for error-path tests.
 * @returns Full HDU bytes.
 */
function targetTablesHdu(
  times: number[],
  cubes: number[][],
  quality: number[],
  opts: { tdim?: string | null } = {},
): Buffer {
  const nRows = times.length
  const rowBytes = 8 + 16 + 4 // 1D + 4E + 1J
  const tdim = opts.tdim === undefined ? "'(2,2)  '" : opts.tdim
  const cards = [
    card('XTENSION', "'BINTABLE'"),
    card('BITPIX', '8'),
    card('NAXIS', '2'),
    card('NAXIS1', String(rowBytes)),
    card('NAXIS2', String(nRows)),
    card('PCOUNT', '0'),
    card('GCOUNT', '1'),
    card('TFIELDS', '3'),
    card('EXTNAME', "'TARGETTABLES'"),
    card('TTYPE1', "'TIME'"),
    card('TFORM1', "'1D'"),
    card('TTYPE2', "'FLUX'"),
    card('TFORM2', "'4E'"),
    ...(tdim !== null ? [card('TDIM2', tdim)] : []),
    card('TTYPE3', "'QUALITY'"),
    card('TFORM3', "'1J'"),
    card('1CRV5P', '230'),
    card('2CRV5P', '125'),
  ]
  const data = Buffer.alloc(nRows * rowBytes)
  for (let r = 0; r < nRows; r++) {
    let o = r * rowBytes
    data.writeDoubleBE(times[r], o)
    o += 8
    for (let p = 0; p < 4; p++) {
      data.writeFloatBE(cubes[r][p], o)
      o += 4
    }
    data.writeInt32BE(quality[r], o)
  }
  return Buffer.concat([headerBlocks(cards), padData(data)])
}

/**
 * @description Builds the APERTURE int32 image HDU for the 2×2 stamp.
 * @param mask Bitmask values in (x + y*2) order.
 * @returns Full HDU bytes.
 */
function apertureHdu(mask: number[]): Buffer {
  const cards = [
    card('XTENSION', "'IMAGE'"),
    card('BITPIX', '32'),
    card('NAXIS', '2'),
    card('NAXIS1', '2'),
    card('NAXIS2', '2'),
    card('PCOUNT', '0'),
    card('GCOUNT', '1'),
    card('EXTNAME', "'APERTURE'"),
  ]
  const data = Buffer.alloc(16)
  mask.forEach((v, i) => data.writeInt32BE(v, i * 4))
  return Buffer.concat([headerBlocks(cards), padData(data)])
}

/** @description A complete synthetic 2-cadence, 2×2-stamp TPF file. */
function standardTpf(): Buffer {
  return Buffer.concat([
    tpfPrimaryHdu(),
    targetTablesHdu(
      [1000.5, 1000.520434],
      [
        [10, 20, 30, 40],
        [11, 21, 31, 41],
      ],
      [0, 8],
    ),
    apertureHdu([1, 3, 3, 1]),
  ])
}

describe('readKeplerTpf', () => {
  it('extracts the cube, times, quality, and header metadata', () => {
    const tpf = readKeplerTpf(standardTpf())
    assert.equal(tpf.nx, 2)
    assert.equal(tpf.ny, 2)
    assert.deepEqual(tpf.times, [1000.5, 1000.520434])
    assert.deepEqual(tpf.quality, [0, 8])
    assert.deepEqual(Array.from(tpf.flux), [10, 20, 30, 40, 11, 21, 31, 41])
    assert.equal(tpf.kepmag, 13.424)
    assert.equal(tpf.keplerId, 5991936)
    assert.equal(tpf.quarter, 9)
    assert.equal(tpf.refCol, 230)
    assert.equal(tpf.refRow, 125)
  })

  it('reads the APERTURE bitmask in the same pixel order as the cube', () => {
    const tpf = readKeplerTpf(standardTpf())
    assert.ok(tpf.apertureMask)
    assert.deepEqual(Array.from(tpf.apertureMask!), [1, 3, 3, 1])
  })

  it('accepts gzipped input (MAST serves _lpd-targ.fits.gz)', () => {
    const tpf = readKeplerTpf(gzipSync(standardTpf()))
    assert.deepEqual(Array.from(tpf.flux), [10, 20, 30, 40, 11, 21, 31, 41])
    assert.equal(tpf.kepmag, 13.424)
  })

  it('preserves NaN in times and flux (gap cadences / uncollected pixels)', () => {
    const buf = Buffer.concat([
      tpfPrimaryHdu(),
      targetTablesHdu([NaN], [[NaN, 5, NaN, 7]], [0]),
    ])
    const tpf = readKeplerTpf(buf)
    assert.ok(Number.isNaN(tpf.times[0]))
    assert.ok(Number.isNaN(tpf.flux[0]))
    assert.equal(tpf.flux[1], 5)
    assert.ok(Number.isNaN(tpf.flux[2]))
    assert.equal(tpf.flux[3], 7)
  })

  it('returns null aperture/kepmag when those parts are absent', () => {
    const noKepmag = headerBlocks([card('SIMPLE', 'T'), card('BITPIX', '8'), card('NAXIS', '0')])
    const buf = Buffer.concat([noKepmag, targetTablesHdu([1.5], [[1, 2, 3, 4]], [0])])
    const tpf = readKeplerTpf(buf)
    assert.equal(tpf.kepmag, null)
    assert.equal(tpf.apertureMask, null)
  })

  it('throws when no BINTABLE extension exists', () => {
    assert.throws(() => readKeplerTpf(tpfPrimaryHdu()), /No BINTABLE/)
  })

  it('throws (naming available columns) when a required column is missing', () => {
    // Rename FLUX so the reader can't find it.
    const hdu = targetTablesHdu([1.5], [[1, 2, 3, 4]], [0])
    const broken = Buffer.from(hdu)
    const idx = broken.indexOf(Buffer.from("TTYPE2  = 'FLUX'", 'ascii'))
    broken.write("TTYPE2  = 'FLOX'", idx, 'ascii')
    assert.throws(
      () => readKeplerTpf(Buffer.concat([tpfPrimaryHdu(), broken])),
      /TPF columns not found.*have TIME, FLOX, QUALITY/,
    )
  })

  it('throws when FLUX has no parseable TDIM shape', () => {
    const buf = Buffer.concat([tpfPrimaryHdu(), targetTablesHdu([1.5], [[1, 2, 3, 4]], [0], { tdim: null })])
    assert.throws(() => readKeplerTpf(buf), /no parseable TDIM/)
  })

  it('throws when TDIM disagrees with the TFORM repeat count', () => {
    const buf = Buffer.concat([
      tpfPrimaryHdu(),
      targetTablesHdu([1.5], [[1, 2, 3, 4]], [0], { tdim: "'(3,2)  '" }),
    ])
    assert.throws(() => readKeplerTpf(buf), /disagrees with repeat count/)
  })
})
