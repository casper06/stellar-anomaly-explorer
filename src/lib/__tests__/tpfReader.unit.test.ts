/**
 * @description Unit tests for the Target Pixel File reader (Kepler +
 * TESS). Each test constructs a minimal synthetic TPF FITS buffer to the
 * real product spec (verified against live MAST downloads: PRIMARY with
 * KEPMAG/TESSMAG + QUARTER/SECTOR, pixel BINTABLE with a TDIM-shaped
 * FLUX array column carrying per-column WCS keywords, APERTURE int32
 * image) and asserts extraction behavior: cube pixel ordering, TDIM
 * parsing, NaN preservation, header metadata for both missions, the
 * FLUX-column WCS, the aperture bitmask, the gzip path, and the
 * documented error paths.
 *
 * Run via `npm run test:unit` (plain Node ≥ 22.6, node:test + native
 * type stripping — no framework).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { readTpf } from '../tpfReader.ts'

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
 * @param extra Cards to append (e.g. TESS variants).
 * @returns Header-only primary HDU bytes.
 */
function keplerPrimaryHdu(): Buffer {
  return headerBlocks([
    card('SIMPLE', 'T'),
    card('BITPIX', '8'),
    card('NAXIS', '0'),
    card('TELESCOP', "'Kepler'"),
    card('KEPLERID', '5991936'),
    card('QUARTER', '9'),
    card('KEPMAG', '13.424'),
  ])
}

/** @description Primary HDU with the TESS identity keywords. */
function tessPrimaryHdu(): Buffer {
  return headerBlocks([
    card('SIMPLE', 'T'),
    card('BITPIX', '8'),
    card('NAXIS', '0'),
    card('TELESCOP', "'TESS'"),
    card('TICID', '185336364'),
    card('SECTOR', '41'),
    card('TESSMAG', '11.352'),
  ])
}

/** @description WCS cards for the FLUX column (column 2 in the synthetic table). */
function fluxWcsCards(): string[] {
  return [
    card('1CRPX2', '1.5'),
    card('2CRPX2', '1.25'),
    card('1CRVL2', '301.5'),
    card('2CRVL2', '44.4'),
    card('1CDLT2', '-0.0011'),
    card('2CDLT2', '0.0011'),
    card('11PC2', '0.6'),
    card('12PC2', '0.8'),
    card('21PC2', '0.8'),
    card('22PC2', '-0.6'),
  ]
}

/**
 * @description Builds the pixel BINTABLE HDU with the three columns the
 * reader needs (TIME 1D, FLUX nE + TDIM, QUALITY 1J) for a 2×2 stamp.
 * @param times Per-cadence timestamps (NaN allowed).
 * @param cubes Per-cadence 4-pixel stamps in (x + y*2) order.
 * @param quality Per-cadence quality flags.
 * @param opts TDIM override/omission and WCS inclusion for error-path tests.
 * @returns Full HDU bytes.
 */
function pixelTableHdu(
  times: number[],
  cubes: number[][],
  quality: number[],
  opts: { tdim?: string | null; wcs?: boolean } = {},
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
    ...(opts.wcs === false ? [] : fluxWcsCards()),
    card('TTYPE3', "'QUALITY'"),
    card('TFORM3', "'1J'"),
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

/** @description A complete synthetic 2-cadence, 2×2-stamp Kepler TPF file. */
function standardTpf(): Buffer {
  return Buffer.concat([
    keplerPrimaryHdu(),
    pixelTableHdu(
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

describe('readTpf', () => {
  it('extracts the cube, times, quality, and Kepler header metadata', () => {
    const tpf = readTpf(standardTpf())
    assert.equal(tpf.nx, 2)
    assert.equal(tpf.ny, 2)
    assert.deepEqual(tpf.times, [1000.5, 1000.520434])
    assert.deepEqual(tpf.quality, [0, 8])
    assert.deepEqual(Array.from(tpf.flux), [10, 20, 30, 40, 11, 21, 31, 41])
    assert.equal(tpf.mission, 'Kepler')
    assert.equal(tpf.mag, 13.424)
    assert.equal(tpf.targetId, 5991936)
    assert.equal(tpf.segment, 9)
  })

  it('extracts the FLUX-column WCS (per-segment sky reference)', () => {
    const tpf = readTpf(standardTpf())
    assert.ok(tpf.wcs)
    assert.equal(tpf.wcs!.crpx1, 1.5)
    assert.equal(tpf.wcs!.crpx2, 1.25)
    assert.equal(tpf.wcs!.crval1, 301.5)
    assert.equal(tpf.wcs!.cdelt1, -0.0011)
    assert.equal(tpf.wcs!.pc12, 0.8)
    assert.equal(tpf.wcs!.pc22, -0.6)
  })

  it('reads TESS identity keywords (TESSMAG / TICID / SECTOR)', () => {
    const buf = Buffer.concat([tessPrimaryHdu(), pixelTableHdu([2000.5], [[1, 2, 3, 4]], [0])])
    const tpf = readTpf(buf)
    assert.equal(tpf.mission, 'TESS')
    assert.equal(tpf.mag, 11.352)
    assert.equal(tpf.targetId, 185336364)
    assert.equal(tpf.segment, 41)
  })

  it('returns null WCS when the keywords are absent (fallback path signal)', () => {
    const buf = Buffer.concat([keplerPrimaryHdu(), pixelTableHdu([1.5], [[1, 2, 3, 4]], [0], { wcs: false })])
    const tpf = readTpf(buf)
    assert.equal(tpf.wcs, null)
  })

  it('reads the APERTURE bitmask in the same pixel order as the cube', () => {
    const tpf = readTpf(standardTpf())
    assert.ok(tpf.apertureMask)
    assert.deepEqual(Array.from(tpf.apertureMask!), [1, 3, 3, 1])
  })

  it('accepts gzipped input (MAST serves Kepler TPFs as .gz)', () => {
    const tpf = readTpf(gzipSync(standardTpf()))
    assert.deepEqual(Array.from(tpf.flux), [10, 20, 30, 40, 11, 21, 31, 41])
    assert.equal(tpf.mag, 13.424)
  })

  it('preserves NaN in times and flux (gap cadences / uncollected pixels)', () => {
    const buf = Buffer.concat([keplerPrimaryHdu(), pixelTableHdu([NaN], [[NaN, 5, NaN, 7]], [0])])
    const tpf = readTpf(buf)
    assert.ok(Number.isNaN(tpf.times[0]))
    assert.ok(Number.isNaN(tpf.flux[0]))
    assert.equal(tpf.flux[1], 5)
    assert.ok(Number.isNaN(tpf.flux[2]))
    assert.equal(tpf.flux[3], 7)
  })

  it('returns null aperture/mag when those parts are absent', () => {
    const noMag = headerBlocks([card('SIMPLE', 'T'), card('BITPIX', '8'), card('NAXIS', '0')])
    const buf = Buffer.concat([noMag, pixelTableHdu([1.5], [[1, 2, 3, 4]], [0])])
    const tpf = readTpf(buf)
    assert.equal(tpf.mag, null)
    assert.equal(tpf.mission, null)
    assert.equal(tpf.apertureMask, null)
  })

  it('throws when no BINTABLE extension exists', () => {
    assert.throws(() => readTpf(keplerPrimaryHdu()), /No BINTABLE/)
  })

  it('throws (naming available columns) when a required column is missing', () => {
    // Rename FLUX so the reader can't find it.
    const hdu = pixelTableHdu([1.5], [[1, 2, 3, 4]], [0])
    const broken = Buffer.from(hdu)
    const idx = broken.indexOf(Buffer.from("TTYPE2  = 'FLUX'", 'ascii'))
    broken.write("TTYPE2  = 'FLOX'", idx, 'ascii')
    assert.throws(
      () => readTpf(Buffer.concat([keplerPrimaryHdu(), broken])),
      /TPF columns not found.*have TIME, FLOX, QUALITY/,
    )
  })

  it('throws when FLUX has no parseable TDIM shape', () => {
    const buf = Buffer.concat([keplerPrimaryHdu(), pixelTableHdu([1.5], [[1, 2, 3, 4]], [0], { tdim: null })])
    assert.throws(() => readTpf(buf), /no parseable TDIM/)
  })

  it('throws when TDIM disagrees with the TFORM repeat count', () => {
    const buf = Buffer.concat([
      keplerPrimaryHdu(),
      pixelTableHdu([1.5], [[1, 2, 3, 4]], [0], { tdim: "'(3,2)  '" }),
    ])
    assert.throws(() => readTpf(buf), /disagrees with repeat count/)
  })
})
