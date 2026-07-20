/**
 * @description Unit tests for the 6×6 Kepler-field quadrant grid
 * (`lib/quadrants.ts`). Pure geometry, no I/O.
 *
 * The property worth protecting here is the Dec FLIP: rows run
 * north→south (row 1 is the northernmost) so the grid reads like a sky
 * map with north up, while the underlying Dec bins run south→north.
 * That inversion is easy to "simplify" incorrectly, so it is asserted
 * from both directions plus a round-trip.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  quadrantFor,
  quadrantCenter,
  ALL_QUADRANT_IDS,
  QUADRANT_RA_MIN,
  QUADRANT_RA_MAX,
  QUADRANT_DEC_MIN,
  QUADRANT_DEC_MAX,
  QUADRANT_RA_STEP,
  QUADRANT_DEC_STEP,
  QUADRANT_COLS,
  QUADRANT_ROWS,
} from '../quadrants.ts'

describe('quadrantFor — inside the grid', () => {
  it('maps the south-west origin corner to A6', () => {
    // RA at the minimum = column A; Dec at the minimum = SOUTHERNMOST
    // = the LAST row, not the first. This is the flip.
    assert.equal(quadrantFor(QUADRANT_RA_MIN, QUADRANT_DEC_MIN), 'A6')
  })

  it('maps the north-west corner to A1', () => {
    assert.equal(quadrantFor(QUADRANT_RA_MIN, QUADRANT_DEC_MAX - 1e-9), 'A1')
  })

  it('maps the north-east corner to F1', () => {
    assert.equal(quadrantFor(QUADRANT_RA_MAX - 1e-9, QUADRANT_DEC_MAX - 1e-9), 'F1')
  })

  it('maps the south-east corner to F6', () => {
    assert.equal(quadrantFor(QUADRANT_RA_MAX - 1e-9, QUADRANT_DEC_MIN), 'F6')
  })

  it('places Tabby\'s Star (301.5642, 44.4567) in the expected cell', () => {
    // Hand-computed: RA bin = floor((301.5642-290)/2.5) = 4 -> 'E';
    // Dec bin = floor((44.4567-36)/2.6667) = 3 -> row 6-1-3+1 = 3.
    assert.equal(quadrantFor(301.5642, 44.4567), 'E3')
  })

  it('increases the column letter as RA increases', () => {
    const dec = QUADRANT_DEC_MIN + QUADRANT_DEC_STEP / 2
    const cols = [0, 1, 2, 3, 4, 5].map(
      i => quadrantFor(QUADRANT_RA_MIN + (i + 0.5) * QUADRANT_RA_STEP, dec)?.[0],
    )
    assert.deepEqual(cols, ['A', 'B', 'C', 'D', 'E', 'F'])
  })

  it('DECREASES the row number as Dec increases (north = row 1)', () => {
    const ra = QUADRANT_RA_MIN + QUADRANT_RA_STEP / 2
    const rows = [0, 1, 2, 3, 4, 5].map(i =>
      quadrantFor(ra, QUADRANT_DEC_MIN + (i + 0.5) * QUADRANT_DEC_STEP)?.slice(1),
    )
    assert.deepEqual(rows, ['6', '5', '4', '3', '2', '1'])
  })
})

describe('quadrantFor — boundaries', () => {
  it('treats each bin as half-open [min, max): a gridline belongs to the higher bin', () => {
    const dec = QUADRANT_DEC_MIN + QUADRANT_DEC_STEP / 2
    // Exactly on the A|B gridline -> B, not A.
    assert.equal(quadrantFor(QUADRANT_RA_MIN + QUADRANT_RA_STEP, dec), 'B6')
    // A hair below stays in A.
    assert.equal(quadrantFor(QUADRANT_RA_MIN + QUADRANT_RA_STEP - 1e-9, dec), 'A6')
  })

  it('applies the same half-open rule to Dec gridlines (through the flip)', () => {
    const ra = QUADRANT_RA_MIN + QUADRANT_RA_STEP / 2
    // NOTE on the epsilon: QUADRANT_DEC_STEP is 8/3 = 2.666…, which has
    // no exact binary representation, so `DEC_MIN + DEC_STEP` actually
    // lands a hair BELOW the true gridline and still reads as row 6.
    // That is correct float behavior, not an off-by-one — so the
    // "crossed the line" probe is nudged up by an epsilon rather than
    // sitting exactly on the computed sum.
    assert.equal(quadrantFor(ra, QUADRANT_DEC_MIN + QUADRANT_DEC_STEP + 1e-9), 'A5')
    assert.equal(quadrantFor(ra, QUADRANT_DEC_MIN + QUADRANT_DEC_STEP - 1e-9), 'A6')
  })

  it('includes the lower bound and EXCLUDES the upper bound', () => {
    const dec = QUADRANT_DEC_MIN + QUADRANT_DEC_STEP / 2
    assert.ok(quadrantFor(QUADRANT_RA_MIN, dec), 'RA_MIN is inside')
    assert.equal(quadrantFor(QUADRANT_RA_MAX, dec), null, 'RA_MAX is outside')
    const ra = QUADRANT_RA_MIN + QUADRANT_RA_STEP / 2
    assert.ok(quadrantFor(ra, QUADRANT_DEC_MIN), 'DEC_MIN is inside')
    assert.equal(quadrantFor(ra, QUADRANT_DEC_MAX), null, 'DEC_MAX is outside')
  })
})

describe('quadrantFor — outside the grid', () => {
  it('returns null beyond every edge', () => {
    const midRa = (QUADRANT_RA_MIN + QUADRANT_RA_MAX) / 2
    const midDec = (QUADRANT_DEC_MIN + QUADRANT_DEC_MAX) / 2
    assert.equal(quadrantFor(QUADRANT_RA_MIN - 0.01, midDec), null, 'west')
    assert.equal(quadrantFor(QUADRANT_RA_MAX + 0.01, midDec), null, 'east')
    assert.equal(quadrantFor(midRa, QUADRANT_DEC_MIN - 0.01), null, 'south')
    assert.equal(quadrantFor(midRa, QUADRANT_DEC_MAX + 0.01), null, 'north')
  })

  it('returns null for real off-field positions', () => {
    // EPIC 201637175 (K2-22) — a seed that genuinely sits off the
    // Kepler prime field, so it must carry no quadrant tag.
    assert.equal(quadrantFor(174.32, -4.67), null)
    // Sirius, nowhere near Cygnus.
    assert.equal(quadrantFor(101.287, -16.716), null)
  })

  it('returns null for ±Infinity', () => {
    // Infinity is caught by the existing range comparisons.
    assert.equal(quadrantFor(Infinity, 44), null)
    assert.equal(quadrantFor(-Infinity, 44), null)
    assert.equal(quadrantFor(300, Infinity), null)
  })

  it('CURRENT BEHAVIOR (defect, pinned deliberately): NaN yields a malformed id, not null', () => {
    // ⚠ This test documents a REAL DEFECT rather than intended
    // behavior, and is written to fail loudly if the defect is fixed —
    // at which point it should be REPLACED with the `null` assertions
    // commented below, not deleted.
    //
    // Why it happens: every range comparison against NaN is false, so
    // the two early-return guards never fire; the arithmetic then makes
    // `colIdx`/`rowIdx` NaN and template interpolation stringifies the
    // undefined lookups.
    //
    // Why it is NOT currently reachable in production: both catalog
    // parsers reject a row whose ra/dec is not a number, and NASA TAP
    // sends JSON `null` (not NaN) for missing coordinates, so the guard
    // catches it. It is latent, not firing — note though that those
    // guards use `typeof x !== 'number'`, and `typeof NaN === 'number'`,
    // so a NaN arriving from any future caller would slip through.
    assert.equal(quadrantFor(NaN, 44), 'undefined3')
    assert.equal(quadrantFor(300, NaN), 'ENaN')
    assert.equal(quadrantFor(NaN, NaN), 'undefinedNaN')

    // Desired behavior once fixed (one `Number.isFinite` guard):
    //   assert.equal(quadrantFor(NaN, 44), null)
    //   assert.equal(quadrantFor(300, NaN), null)
    //   assert.equal(quadrantFor(NaN, NaN), null)

    // Containment: a malformed id does NOT round-trip, so it cannot
    // silently become a real cell downstream.
    assert.equal(quadrantCenter('undefined3'), null)
    assert.equal(quadrantCenter('ENaN'), null)
  })
})

describe('quadrantCenter', () => {
  it('returns the geometric center of a valid quadrant', () => {
    const c = quadrantCenter('A6')
    assert.ok(c)
    assert.equal(c.ra, QUADRANT_RA_MIN + 0.5 * QUADRANT_RA_STEP)
    assert.equal(c.dec, QUADRANT_DEC_MIN + 0.5 * QUADRANT_DEC_STEP)
  })

  it('puts row 1 at the NORTH end of the grid', () => {
    const north = quadrantCenter('A1')
    const south = quadrantCenter('A6')
    assert.ok(north && south)
    assert.ok(north.dec > south.dec, 'row 1 is north of row 6')
  })

  it('round-trips: the center of a cell maps back to that cell', () => {
    for (const id of ALL_QUADRANT_IDS) {
      const c = quadrantCenter(id)
      assert.ok(c, `center for ${id}`)
      assert.equal(quadrantFor(c.ra, c.dec), id, `${id} round-trips`)
    }
  })

  it('returns null for malformed ids', () => {
    assert.equal(quadrantCenter(''), null, 'empty')
    assert.equal(quadrantCenter('A'), null, 'no row')
    assert.equal(quadrantCenter('4'), null, 'no column')
    assert.equal(quadrantCenter('G1'), null, 'column past F')
    assert.equal(quadrantCenter('A0'), null, 'row below 1')
    assert.equal(quadrantCenter('A7'), null, 'row past 6')
    assert.equal(quadrantCenter('AA'), null, 'non-numeric row')
    assert.equal(quadrantCenter('a1'), null, 'lowercase column is not accepted')
  })
})

describe('ALL_QUADRANT_IDS', () => {
  it('enumerates every cell exactly once, in row-major north-to-south order', () => {
    assert.equal(ALL_QUADRANT_IDS.length, QUADRANT_COLS * QUADRANT_ROWS)
    assert.equal(new Set(ALL_QUADRANT_IDS).size, ALL_QUADRANT_IDS.length, 'no duplicates')
    assert.equal(ALL_QUADRANT_IDS[0], 'A1')
    assert.equal(ALL_QUADRANT_IDS[ALL_QUADRANT_IDS.length - 1], 'F6')
    assert.deepEqual(ALL_QUADRANT_IDS.slice(0, 6), ['A1', 'B1', 'C1', 'D1', 'E1', 'F1'])
  })
})
