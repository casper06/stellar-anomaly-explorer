/**
 * @description Direct unit tests for the low-level FITS primitives
 * (`src/fitsCore.ts`): header parsing, HDU walking, data-size
 * arithmetic, and BINTABLE column layout.
 *
 * These were previously exercised only INDIRECTLY, through
 * `fitsReader` and `tpfReader`. That left the malformed-input paths
 * untested: those readers reject bad files with their own errors before
 * the core's behavior is observable, so a core-level regression could
 * hide behind a reader-level guard. Everything here calls the
 * primitives directly and focuses on inputs the readers never produce —
 * truncated buffers, missing END cards, absent BINTABLE extensions,
 * unsupported TFORM letters, TDIM/TFORM disagreement.
 *
 * Synthetic buffers come from the shared `./syntheticFits.ts` builders,
 * the same ones `fitsReader.unit.test.ts` uses, so both suites agree
 * byte-for-byte on what a well-formed file looks like.
 *
 * Run via `npm run test:unit` inside the package (or root `npm test`).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FITS_BLOCK,
  FITS_TYPE_INFO,
  parseFitsHeader,
  hduDataBytes,
  enumerateHdus,
  bintableColumnLayout,
} from '../src/fitsCore.ts'
import { BLOCK, card, headerBlocks, padData, primaryHdu, bintableHdu, standardFile } from './syntheticFits.ts'

describe('FITS_BLOCK', () => {
  it('is the 2880-byte FITS block size the builders assume', () => {
    assert.equal(FITS_BLOCK, 2880)
    assert.equal(FITS_BLOCK, BLOCK, 'test builders and the engine agree')
  })
})

describe('parseFitsHeader', () => {
  it('parses keyword/value pairs and reports where the data starts', () => {
    const buf = headerBlocks([card('SIMPLE', 'T'), card('BITPIX', '8'), card('NAXIS', '0')])
    const { header, dataStart } = parseFitsHeader(buf, 0)
    assert.equal(header['SIMPLE'], 'T')
    assert.equal(header['BITPIX'], '8')
    assert.equal(dataStart, FITS_BLOCK, 'data begins after the single header block')
  })

  it('strips quotes from string values', () => {
    const buf = headerBlocks([card('XTENSION', "'BINTABLE'"), card('TTYPE1', "'TIME'")])
    const { header } = parseFitsHeader(buf, 0)
    assert.equal(header['XTENSION'], 'BINTABLE')
    assert.equal(header['TTYPE1'], 'TIME')
  })

  it('strips trailing comments from unquoted values', () => {
    const buf = headerBlocks([card('NAXIS1', '12 / bytes per row')])
    assert.equal(parseFitsHeader(buf, 0).header['NAXIS1'], '12')
  })

  it('does NOT treat a slash inside a quoted string as a comment', () => {
    const buf = headerBlocks([card('TELESCOP', "'Kepler/K2'")])
    assert.equal(parseFitsHeader(buf, 0).header['TELESCOP'], 'Kepler/K2')
  })

  it('spans multiple header blocks when there are more than 36 cards', () => {
    // 36 cards fill one 2880-byte block; the END must be found in the next.
    const many = Array.from({ length: 40 }, (_, i) => card(`KEY${i}`, String(i)))
    const buf = headerBlocks(many)
    const { header, dataStart } = parseFitsHeader(buf, 0)
    assert.equal(header['KEY39'], '39', 'a card in the second block is parsed')
    assert.equal(dataStart, 2 * FITS_BLOCK, 'data starts after BOTH header blocks')
  })

  it('ignores blank cards and cards without the "=" in column 9', () => {
    const buf = headerBlocks([
      card('SIMPLE', 'T'),
      'COMMENT this is free text, no equals sign'.padEnd(80),
      ' '.repeat(80),
      card('BITPIX', '8'),
    ])
    const { header } = parseFitsHeader(buf, 0)
    assert.equal(header['SIMPLE'], 'T')
    assert.equal(header['BITPIX'], '8')
    assert.ok(!('COMMENT' in header), 'comment card contributes no key')
  })

  it('stops at the buffer end when the END card is MISSING (no infinite loop)', () => {
    // A truncated/corrupt file must terminate rather than spin. The
    // reader would reject this later; the core just must not hang.
    const text = card('SIMPLE', 'T').padEnd(FITS_BLOCK)
    const buf = Buffer.from(text, 'ascii')
    const { header, dataStart } = parseFitsHeader(buf, 0)
    assert.equal(header['SIMPLE'], 'T')
    assert.ok(dataStart >= buf.length, 'cursor advanced to the end of the buffer')
  })

  it('returns an empty header for an empty buffer without throwing', () => {
    const { header } = parseFitsHeader(Buffer.alloc(0), 0)
    assert.deepEqual(header, {})
  })

  it('parses a header at a non-zero offset (second HDU)', () => {
    const buf = Buffer.concat([primaryHdu(), headerBlocks([card('XTENSION', "'BINTABLE'")])])
    assert.equal(parseFitsHeader(buf, FITS_BLOCK).header['XTENSION'], 'BINTABLE')
  })
})

describe('hduDataBytes', () => {
  it('returns 0 for a header-only HDU (NAXIS = 0)', () => {
    assert.equal(hduDataBytes({ NAXIS: '0', BITPIX: '8' }), 0)
  })

  it('computes |BITPIX|/8 × ΠNAXISi for a 2-D table', () => {
    // 12 bytes/row × 100 rows.
    assert.equal(hduDataBytes({ NAXIS: '2', BITPIX: '8', NAXIS1: '12', NAXIS2: '100' }), 1200)
  })

  it('uses the ABSOLUTE value of a negative BITPIX (float images)', () => {
    // BITPIX -32 = 32-bit float = 4 bytes/element.
    assert.equal(hduDataBytes({ NAXIS: '2', BITPIX: '-32', NAXIS1: '10', NAXIS2: '10' }), 400)
  })

  it('adds PCOUNT and multiplies by GCOUNT', () => {
    assert.equal(
      hduDataBytes({ NAXIS: '2', BITPIX: '8', NAXIS1: '10', NAXIS2: '10', PCOUNT: '50', GCOUNT: '2' }),
      (100 + 50) * 2,
    )
  })

  it('defaults GCOUNT to 1 and PCOUNT to 0 when absent', () => {
    assert.equal(hduDataBytes({ NAXIS: '1', BITPIX: '8', NAXIS1: '7' }), 7)
  })

  it('treats a missing NAXIS as a header-only HDU', () => {
    assert.equal(hduDataBytes({}), 0)
  })
})

describe('enumerateHdus', () => {
  it('walks primary + BINTABLE and reports each data section', () => {
    const buf = standardFile([1, 2, 3], [1, 0.99, 1])
    const hdus = enumerateHdus(buf)
    assert.equal(hdus.length, 2)
    assert.equal(hdus[0].dataBytes, 0, 'primary is header-only')
    assert.equal(hdus[1].header['XTENSION'], 'BINTABLE')
    assert.equal(hdus[1].dataBytes, 3 * 12, '3 rows × 12 bytes')
    assert.equal(hdus[1].dataStart % FITS_BLOCK, 0, 'data sections are block-aligned')
  })

  it('walks THREE HDUs, skipping the first extension\'s data correctly', () => {
    // Proves the block arithmetic advances past a data section rather
    // than mistaking payload bytes for the next header.
    const first = bintableHdu(
      [{ name: 'A', tform: '1D', write: (b, o) => { b.writeDoubleBE(1, o); return 8 } }],
      2,
      8,
    )
    const second = bintableHdu(
      [{ name: 'B', tform: '1E', write: (b, o) => { b.writeFloatBE(2, o); return 4 } }],
      2,
      4,
    )
    const hdus = enumerateHdus(Buffer.concat([primaryHdu(), first, second]))
    assert.equal(hdus.length, 3)
    assert.equal(hdus[1].header['TTYPE1'], 'A')
    assert.equal(hdus[2].header['TTYPE1'], 'B', 'second extension found after the first HDU\'s data')
  })

  it('returns ONLY the primary HDU when there is no BINTABLE extension', () => {
    // The "missing BINTABLE" case: the core reports what is there, and
    // it is the caller's job to error — verified here so a future
    // change cannot start inventing an extension.
    const hdus = enumerateHdus(primaryHdu())
    assert.equal(hdus.length, 1)
    assert.ok(!hdus.some(h => h.header['XTENSION'] === 'BINTABLE'))
  })

  it('returns an empty array for an empty buffer', () => {
    assert.deepEqual(enumerateHdus(Buffer.alloc(0)), [])
  })

  it('terminates on a truncated file whose declared data exceeds the buffer', () => {
    // NAXIS2 claims 10,000 rows but almost no data follows. The walk
    // must terminate (the loop advances past the buffer end) rather
    // than spin or throw.
    const header = headerBlocks([
      card('XTENSION', "'BINTABLE'"),
      card('BITPIX', '8'),
      card('NAXIS', '2'),
      card('NAXIS1', '12'),
      card('NAXIS2', '10000'),
      card('TFIELDS', '1'),
      card('TTYPE1', "'TIME'"),
      card('TFORM1', "'1D'"),
    ])
    const hdus = enumerateHdus(Buffer.concat([primaryHdu(), header]))
    assert.ok(hdus.length >= 2, 'the declared HDU is still reported')
    assert.equal(hdus[1].dataBytes, 120000, 'size is taken from the header as declared')
  })

  it('never yields a non-advancing entry (no infinite walk) on garbage input', () => {
    const garbage = Buffer.alloc(FITS_BLOCK * 3, 0x20) // all spaces, no END
    const hdus = enumerateHdus(garbage)
    assert.ok(hdus.length < 10, `walk terminated (${hdus.length} entries)`)
  })
})

describe('bintableColumnLayout', () => {
  it('maps column names to offsets, repeat counts and types', () => {
    const { header } = parseFitsHeader(standardFile([1], [1]), FITS_BLOCK)
    const { cols, rowBytes, nRows } = bintableColumnLayout(header)
    assert.equal(rowBytes, 12)
    assert.equal(nRows, 1)
    assert.deepEqual(cols['TIME'], { offsetInRow: 0, repeat: 1, type: 'D', tdim: null })
    assert.deepEqual(cols['PDCSAP_FLUX'], { offsetInRow: 8, repeat: 1, type: 'E', tdim: null })
  })

  it('accumulates offsets across repeat counts (array columns)', () => {
    const hdu = bintableHdu(
      [
        { name: 'FLUX', tform: '64E', write: () => 256 },
        { name: 'TIME', tform: '1D', write: () => 8 },
      ],
      1,
      264,
    )
    const { header } = parseFitsHeader(hdu, 0)
    const { cols } = bintableColumnLayout(header)
    assert.equal(cols['FLUX'].repeat, 64)
    assert.equal(cols['TIME'].offsetInRow, 64 * 4, 'TIME starts after 64 float32s')
  })

  it('captures TDIM when the header declares one', () => {
    const hdu = bintableHdu(
      [{ name: 'FLUX', tform: '64E', write: () => 256 }],
      1,
      256,
      [card('TDIM1', "'(8,8)'")],
    )
    const { header } = parseFitsHeader(hdu, 0)
    assert.equal(bintableColumnLayout(header).cols['FLUX'].tdim, '(8,8)')
  })

  it('reports TDIM VERBATIM even when it disagrees with the TFORM repeat', () => {
    // TFORM says 64 elements, TDIM claims a 10×10 = 100-element image.
    // The core is a parser, not a validator: it must surface both
    // values so the CALLER can detect the mismatch. Silently
    // "correcting" either one would hide a corrupt product.
    const hdu = bintableHdu(
      [{ name: 'FLUX', tform: '64E', write: () => 256 }],
      1,
      256,
      [card('TDIM1', "'(10,10)'")],
    )
    const { header } = parseFitsHeader(hdu, 0)
    const meta = bintableColumnLayout(header).cols['FLUX']
    assert.equal(meta.repeat, 64, 'TFORM repeat reported as declared')
    assert.equal(meta.tdim, '(10,10)', 'TDIM reported as declared — mismatch is visible, not hidden')
  })

  it('treats an UNSUPPORTED TFORM letter as zero-width without throwing', () => {
    // 'A' (character) is not in FITS_TYPE_INFO. The scan must continue
    // so the caller can raise a useful "unsupported type" error rather
    // than crashing mid-parse.
    const hdu = bintableHdu(
      [
        { name: 'LABEL', tform: '8A', write: () => 8 },
        { name: 'TIME', tform: '1D', write: () => 8 },
      ],
      1,
      16,
    )
    const { header } = parseFitsHeader(hdu, 0)
    const { cols } = bintableColumnLayout(header)
    assert.equal(cols['LABEL'].type, 'A')
    assert.equal(cols['TIME'].offsetInRow, 0, 'unsupported column contributes 0 bytes to the offset')
  })

  it('defaults a bare TFORM letter (no digits) to repeat 1', () => {
    const hdu = bintableHdu([{ name: 'X', tform: 'D', write: () => 8 }], 1, 8)
    const { header } = parseFitsHeader(hdu, 0)
    assert.equal(bintableColumnLayout(header).cols['X'].repeat, 1)
  })

  it('returns an empty column map when TFIELDS is absent', () => {
    const { cols, rowBytes, nRows } = bintableColumnLayout({})
    assert.deepEqual(cols, {})
    assert.equal(rowBytes, 0)
    assert.equal(nRows, 0)
  })
})

describe('FITS_TYPE_INFO', () => {
  it('supports exactly the four types Kepler/TESS products use', () => {
    assert.deepEqual(Object.keys(FITS_TYPE_INFO).sort(), ['D', 'E', 'I', 'J'])
    assert.equal(FITS_TYPE_INFO['D'].size, 8)
    assert.equal(FITS_TYPE_INFO['E'].size, 4)
    assert.equal(FITS_TYPE_INFO['J'].size, 4)
    assert.equal(FITS_TYPE_INFO['I'].size, 2)
  })

  it('reads each type BIG-ENDIAN, as the FITS spec requires', () => {
    const b = Buffer.alloc(8)
    b.writeDoubleBE(1234.5, 0)
    assert.equal(FITS_TYPE_INFO['D'].read(b, 0), 1234.5)
    b.writeFloatBE(-2.5, 0)
    assert.equal(FITS_TYPE_INFO['E'].read(b, 0), -2.5)
    b.writeInt32BE(-70000, 0)
    assert.equal(FITS_TYPE_INFO['J'].read(b, 0), -70000)
    b.writeInt16BE(-1234, 0)
    assert.equal(FITS_TYPE_INFO['I'].read(b, 0), -1234)
  })
})

describe('padData (builder sanity)', () => {
  it('pads to a whole number of blocks so HDU offsets stay aligned', () => {
    assert.equal(padData(Buffer.alloc(1)).length, BLOCK)
    assert.equal(padData(Buffer.alloc(BLOCK)).length, BLOCK)
    assert.equal(padData(Buffer.alloc(BLOCK + 1)).length, 2 * BLOCK)
  })
})
