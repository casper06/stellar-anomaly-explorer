/**
 * @description 6×6 grid covering the Kepler prime-mission field of view.
 * Columns A–F map to RA bins (low→high) and rows 1–6 map to Dec bins
 * (high→low, so row 1 is the northernmost). Bounds chosen to enclose
 * the Kepler PDC field where the ~6,000 KOI catalog is concentrated;
 * stars outside this region get no quadrant tag.
 */
export const QUADRANT_RA_MIN = 290
export const QUADRANT_RA_MAX = 305
export const QUADRANT_DEC_MIN = 36
export const QUADRANT_DEC_MAX = 52
export const QUADRANT_COLS = 6
export const QUADRANT_ROWS = 6

const COL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const

/** @description Width of one quadrant in degrees of RA. */
export const QUADRANT_RA_STEP =
  (QUADRANT_RA_MAX - QUADRANT_RA_MIN) / QUADRANT_COLS

/** @description Height of one quadrant in degrees of Dec. */
export const QUADRANT_DEC_STEP =
  (QUADRANT_DEC_MAX - QUADRANT_DEC_MIN) / QUADRANT_ROWS

/**
 * @description Returns the quadrant id (e.g. "A3") for a celestial position,
 * or null if the position falls outside the Kepler field grid. Column letter
 * comes from the RA bin (A = westernmost); row number comes from the Dec
 * bin (1 = northernmost) so the visual layout matches looking at the sky
 * with north up.
 * @param ra Right ascension in degrees.
 * @param dec Declination in degrees.
 * @returns Quadrant id like "C4", or null if outside the grid.
 */
export function quadrantFor(ra: number, dec: number): string | null {
  // Number.isFinite (not a range comparison) is what rejects NaN: every
  // comparison against NaN is false, so the bounds checks below would let
  // it through and the template interpolation would emit a malformed id
  // like "undefined3". Callers are not guaranteed to reject NaN upstream.
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null
  if (ra < QUADRANT_RA_MIN || ra >= QUADRANT_RA_MAX) return null
  if (dec < QUADRANT_DEC_MIN || dec >= QUADRANT_DEC_MAX) return null
  const colIdx = Math.floor((ra - QUADRANT_RA_MIN) / QUADRANT_RA_STEP)
  // Dec runs north → south as row 1 → 6, so we flip the bin index.
  const decBin = Math.floor((dec - QUADRANT_DEC_MIN) / QUADRANT_DEC_STEP)
  const rowIdx = QUADRANT_ROWS - 1 - decBin
  return `${COL_LETTERS[colIdx]}${rowIdx + 1}`
}

/**
 * @description Inverse of `quadrantFor` — returns the RA/Dec at the center
 * of a quadrant, suitable for camera fly-to. Returns null if the id can't
 * be parsed.
 * @param quadrantId Quadrant label like "C4".
 * @returns `{ ra, dec }` at the quadrant center, or null.
 */
export function quadrantCenter(quadrantId: string): { ra: number; dec: number } | null {
  if (quadrantId.length < 2) return null
  const col = COL_LETTERS.indexOf(quadrantId[0] as (typeof COL_LETTERS)[number])
  const row = parseInt(quadrantId.slice(1), 10)
  if (col < 0 || !Number.isFinite(row) || row < 1 || row > QUADRANT_ROWS) return null
  const ra = QUADRANT_RA_MIN + (col + 0.5) * QUADRANT_RA_STEP
  // Flip row back: row 1 is the highest Dec.
  const dec = QUADRANT_DEC_MIN + (QUADRANT_ROWS - row + 0.5) * QUADRANT_DEC_STEP
  return { ra, dec }
}

/**
 * @description All quadrant ids in row-major north-to-south order
 * (A1, B1, …, F1, A2, …, F6). Useful for iterating all 36 cells when
 * computing per-quadrant statistics or rendering the grid overlay.
 */
export const ALL_QUADRANT_IDS: readonly string[] = (() => {
  const out: string[] = []
  for (let r = 1; r <= QUADRANT_ROWS; r++) {
    for (let c = 0; c < QUADRANT_COLS; c++) {
      out.push(`${COL_LETTERS[c]}${r}`)
    }
  }
  return out
})()
