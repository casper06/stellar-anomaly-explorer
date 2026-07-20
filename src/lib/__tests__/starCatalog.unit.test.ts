/**
 * @description Unit tests for the KOI/TOI → sky-catalog merges
 * (`lib/starCatalog.ts`). Pure in-memory: synthetic `CatalogStar[]` and
 * KOI/TOI rows, no network, no `/api/*`.
 *
 * WHERE THE DEDUP ACTUALLY LIVES (verified against the source, not
 * assumed — this is the thing most likely to be misremembered):
 * de-duplication of multiple planet candidates onto one host star
 * happens in `fetchKOICatalog` / `fetchTOICatalog`, which are NETWORK
 * functions and therefore out of scope for a unit test. The merges
 * below receive rows that are ALREADY deduped.
 *
 * That split is the reason `koiCount`/`toiCount` — the numbers the HUD's
 * mission counters display — are simply `rows.length`. They are
 * "unique host stars" ONLY because the fetch layer guarantees it
 * upstream. Nothing in the merge enforces that invariant, so the
 * defensive test below pins what the merge does when the guarantee is
 * violated: the STARS collapse correctly (id match), but the COUNT does
 * not. That asymmetry is documented here rather than silently trusted.
 *
 * Disposition filtering is likewise NOT in this module: `/api/koi`
 * filters to CONFIRMED/CANDIDATE in its ADQL, and `/api/toi` filters to
 * CP/KP/PC in its parser. The merge scores whatever it is handed. The
 * disposition tests below therefore assert the SCORING consequence of a
 * disposition, which is what this module actually owns.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeKoiIntoHipparcos,
  mergeToiIntoCatalog,
  KNOWN_ANOMALIES,
  type CatalogStar,
} from '../starCatalog.ts'

// `KoiClientRow` / `ToiClientRow` are internal to starCatalog.ts. They
// are derived from the exported function signatures rather than
// exported for the test's convenience — widening a module's public
// surface to make it testable would be changing production code for a
// test, and this gets the exact same type safety.
type KoiClientRow = Parameters<typeof mergeKoiIntoHipparcos>[1][number]
type ToiClientRow = Parameters<typeof mergeToiIntoCatalog>[1][number]

/**
 * @description Builds a synthetic Hipparcos-style catalog entry.
 * @param over Fields to override on the default background star.
 * @returns One `CatalogStar`.
 */
function star(over: Partial<CatalogStar> & { id: string }): CatalogStar {
  return {
    name: over.id,
    ra: 300,
    dec: 45,
    magnitude: 8,
    colorIndex: 0.5,
    hasAnomaly: false,
    anomalyScore: 0,
    ...over,
  }
}

/**
 * @description Builds a synthetic KOI row.
 * @param over Fields to override.
 * @returns One `KoiClientRow`.
 */
function koi(over: Partial<KoiClientRow> & { id: string }): KoiClientRow {
  return {
    name: over.id,
    ra: 300,
    dec: 45,
    disposition: 'CANDIDATE',
    period: 10,
    depth: 500,
    duration: 3,
    score: 0.5,
    ...over,
  }
}

/**
 * @description Builds a synthetic TOI row.
 * @param over Fields to override.
 * @returns One `ToiClientRow`.
 */
function toi(over: Partial<ToiClientRow> & { id: string }): ToiClientRow {
  return {
    name: over.id,
    ra: 300,
    dec: 45,
    disposition: 'PC',
    period: 10,
    depth: 500,
    duration: 3,
    magnitude: 11,
    ...over,
  }
}

describe('mergeKoiIntoHipparcos — matching an existing entry', () => {
  it('matches by ID and marks in place without adding a duplicate', () => {
    const hip = [star({ id: 'KIC111', ra: 300, dec: 45 })]
    const out = mergeKoiIntoHipparcos(hip, [koi({ id: 'KIC111' })])
    assert.equal(out.stars.length, 1, 'no duplicate entry')
    assert.equal(out.stars[0].hasAnomaly, true)
    assert.equal(out.stars[0].source, 'Kepler')
  })

  it('matches by POSITION when the ids differ but the sky position agrees', () => {
    // A Hipparcos star ~7 arcsec away (0.002° < the 0.01° threshold).
    const hip = [star({ id: 'HIP42', ra: 300.002, dec: 45.001 })]
    const out = mergeKoiIntoHipparcos(hip, [koi({ id: 'KIC111', ra: 300, dec: 45 })])
    assert.equal(out.stars.length, 1, 'position match must not add a second entry')
    assert.equal(out.stars[0].id, 'HIP42', 'the existing entry survives, keeping its id')
    assert.equal(out.stars[0].hasAnomaly, true)
  })

  it('does NOT position-match beyond the 0.01° threshold', () => {
    const hip = [star({ id: 'HIP42', ra: 300.05, dec: 45 })]
    const out = mergeKoiIntoHipparcos(hip, [koi({ id: 'KIC111', ra: 300, dec: 45 })])
    assert.equal(out.stars.length, 2, 'too far apart — added as its own entry')
  })

  it('raises anomalyScore but never lowers an existing higher one', () => {
    const hip = [star({ id: 'KIC111', anomalyScore: 0.9 })]
    // score 0.1 * 0.5 + small depth term ⇒ well below 0.9.
    const out = mergeKoiIntoHipparcos(hip, [koi({ id: 'KIC111', score: 0.1, depth: 10 })])
    assert.equal(out.stars[0].anomalyScore, 0.9, 'existing higher score is preserved')

    const hip2 = [star({ id: 'KIC222', anomalyScore: 0.1 })]
    const out2 = mergeKoiIntoHipparcos(hip2, [koi({ id: 'KIC222', score: 1, disposition: 'CONFIRMED', depth: 20000 })])
    assert.ok(out2.stars[0].anomalyScore > 0.1, 'a stronger KOI raises the score')
  })
})

describe('mergeKoiIntoHipparcos — adding new entries', () => {
  it('adds an unmatched KOI as a new sky point with catalog defaults', () => {
    const out = mergeKoiIntoHipparcos([], [koi({ id: 'KIC999', name: 'K00999.01', ra: 291, dec: 44 })])
    assert.equal(out.stars.length, 1)
    const s = out.stars[0]
    assert.equal(s.id, 'KIC999')
    assert.equal(s.name, 'K00999.01')
    assert.equal(s.hasAnomaly, true)
    assert.equal(s.source, 'Kepler')
    // TAP carries no photometry, so the merge substitutes documented
    // defaults rather than leaving the point invisible.
    assert.equal(s.magnitude, 13.5, 'default magnitude (mag 11–17 midpoint)')
    assert.equal(s.colorIndex, 0.65, 'default solar-yellow color index')
  })

  it('tags in-field stars with a quadrant and leaves off-field ones untagged', () => {
    const out = mergeKoiIntoHipparcos([], [
      koi({ id: 'KIC-in', ra: 301.5642, dec: 44.4567 }),
      koi({ id: 'KIC-out', ra: 10, dec: -30 }),
    ])
    const inField = out.stars.find(s => s.id === 'KIC-in')
    const outField = out.stars.find(s => s.id === 'KIC-out')
    assert.equal(inField?.quadrant, 'E3', 'inside the Kepler field grid')
    assert.equal(outField?.quadrant, undefined, 'outside the grid carries no tag')
  })

  it('returns a NEW array reference so React state updates detect the change', () => {
    const hip = [star({ id: 'HIP1' })]
    const out = mergeKoiIntoHipparcos(hip, [])
    assert.notEqual(out.stars, hip, 'new array reference')
    assert.deepEqual(out.stars, hip, 'same contents when there is nothing to merge')
  })
})

describe('mergeKoiIntoHipparcos — duplicate host stars (the HUD counter rule)', () => {
  it('collapses multiple candidates on one host into ONE sky entry', () => {
    // Production never sends this (fetchKOICatalog dedupes first), but
    // the merge must not create two points for one star if it does.
    const out = mergeKoiIntoHipparcos([], [
      koi({ id: 'KIC11442793', name: 'K00351.01', score: 0.9 }),
      koi({ id: 'KIC11442793', name: 'K00351.02', score: 0.5 }),
    ])
    assert.equal(out.stars.length, 1, 'one host star ⇒ one sky point')
    assert.equal(out.stars[0].name, 'K00351.01', 'first row wins the entry; later rows only update it')
  })

  it('DOCUMENTED LIMITATION: koiCount reports input ROWS, not unique stars', () => {
    // Pinning the real contract rather than the intuitive one. This is
    // correct in production ONLY because fetchKOICatalog dedupes before
    // calling this; the merge itself does not re-derive the count.
    // If dedup ever moves or is removed, this test explains why the HUD
    // counter would start over-reporting.
    const out = mergeKoiIntoHipparcos([], [
      koi({ id: 'KIC777', name: 'K00777.01' }),
      koi({ id: 'KIC777', name: 'K00777.02' }),
    ])
    assert.equal(out.stars.length, 1, 'stars collapse correctly')
    assert.equal(out.koiCount, 2, 'but the count is rows.length, NOT unique hosts')
  })
})

describe('mergeKoiIntoHipparcos — disposition scoring', () => {
  it('gives CONFIRMED a +0.2 bonus that CANDIDATE does not get', () => {
    const base = { id: 'KIC1', score: 0, depth: 0 }
    const confirmed = mergeKoiIntoHipparcos([], [koi({ ...base, disposition: 'CONFIRMED' })])
    const candidate = mergeKoiIntoHipparcos([], [koi({ ...base, disposition: 'CANDIDATE' })])
    assert.equal(confirmed.stars[0].anomalyScore, 0.2, 'CONFIRMED floors at NOTABLE (0.2)')
    assert.equal(candidate.stars[0].anomalyScore, 0, 'CANDIDATE gets no confirmation bonus')
  })

  it('caps the depth term at 0.3 for very deep transits', () => {
    const deep = mergeKoiIntoHipparcos([], [koi({ id: 'KIC1', score: 0, depth: 10_000_000 })])
    assert.equal(deep.stars[0].anomalyScore, 0.3, 'depth term saturates')
  })

  it('clamps the combined score into [0, 1]', () => {
    const max = mergeKoiIntoHipparcos([], [
      koi({ id: 'KIC1', score: 1, depth: 10_000_000, disposition: 'CONFIRMED' }),
    ])
    assert.ok(max.stars[0].anomalyScore <= 1, 'never exceeds 1')
    assert.equal(max.stars[0].anomalyScore, 1)
  })
})

describe('mergeToiIntoCatalog', () => {
  it('adds an unmatched TOI tagged as TESS, inheriting st_tmag', () => {
    const out = mergeToiIntoCatalog([], [toi({ id: 'TIC555', magnitude: 9.2 })])
    assert.equal(out.stars.length, 1)
    assert.equal(out.stars[0].source, 'TESS')
    assert.equal(out.stars[0].magnitude, 9.2, 'TESS magnitudes come from the catalog')
  })

  it('falls back to magnitude 11 when st_tmag is missing', () => {
    const out = mergeToiIntoCatalog([], [toi({ id: 'TIC556', magnitude: undefined })])
    assert.equal(out.stars[0].magnitude, 11)
  })

  it('scores CP/KP above PC (confirmation bonus), and PC on depth alone', () => {
    const cp = mergeToiIntoCatalog([], [toi({ id: 'T1', disposition: 'CP', depth: 0 })])
    const kp = mergeToiIntoCatalog([], [toi({ id: 'T2', disposition: 'KP', depth: 0 })])
    const pc = mergeToiIntoCatalog([], [toi({ id: 'T3', disposition: 'PC', depth: 0 })])
    assert.equal(cp.stars[0].anomalyScore, 0.2, 'CP confirmed ⇒ 0.2')
    assert.equal(kp.stars[0].anomalyScore, 0.2, 'KP known planet ⇒ 0.2')
    assert.equal(pc.stars[0].anomalyScore, 0, 'PC with no depth ⇒ 0')
  })

  it('TESS wins the source tag when a star is in BOTH catalogs', () => {
    // page.tsx runs the TOI merge AFTER the KOI merge, so a dual-mission
    // star renders TESS-themed. Documented, deliberate, and pinned here.
    const afterKoi = mergeKoiIntoHipparcos([], [koi({ id: 'X1' })])
    assert.equal(afterKoi.stars[0].source, 'Kepler')
    const afterToi = mergeToiIntoCatalog(afterKoi.stars, [toi({ id: 'X1' })])
    assert.equal(afterToi.stars.length, 1, 'still one entry')
    assert.equal(afterToi.stars[0].source, 'TESS', 'the later merge wins the tag')
  })

  it('collapses duplicate TIC hosts into one entry', () => {
    const out = mergeToiIntoCatalog([], [
      toi({ id: 'TIC888', name: 'TOI 888.01' }),
      toi({ id: 'TIC888', name: 'TOI 888.02' }),
    ])
    assert.equal(out.stars.length, 1)
  })
})

describe('KNOWN_ANOMALIES seeds through the merges', () => {
  /** @description Fresh copies so tests never mutate the module constant. */
  const seeds = (): CatalogStar[] => KNOWN_ANOMALIES.map(s => ({ ...s }))

  it('still ships exactly 11 curated seeds', () => {
    assert.equal(KNOWN_ANOMALIES.length, 11)
    assert.ok(KNOWN_ANOMALIES.some(s => s.id === 'KIC8462852'), "Tabby's Star is seeded")
  })

  it('matches a seed by id — never duplicating it into a second sky point', () => {
    const copy = seeds()
    const out = mergeKoiIntoHipparcos(copy, [koi({ id: 'KIC8462852', ra: 301.5642, dec: 44.4567 })])
    assert.equal(out.stars.length, KNOWN_ANOMALIES.length, 'no new entry created')
    assert.equal(out.stars.filter(s => s.id === 'KIC8462852').length, 1)
  })

  it("preserves a seed's curated score and name when the KOI scores lower", () => {
    const copy = seeds()
    const before = copy.find(s => s.id === 'KIC8462852')!
    const out = mergeKoiIntoHipparcos(copy, [
      koi({ id: 'KIC8462852', name: 'K99999.01', ra: 301.5642, dec: 44.4567, score: 0.1, depth: 10 }),
    ])
    const after = out.stars.find(s => s.id === 'KIC8462852')!
    assert.equal(after.anomalyScore, before.anomalyScore, 'curated 0.94 not lowered')
    assert.equal(after.name, "Tabby's Star", 'curated name kept over the KOI designation')
  })

  it('DOES enrich a matched seed with source and quadrant tags', () => {
    // Seeds ship without these; the merge is what supplies them, which
    // is why a seed renders mission-themed and appears in quadrant
    // counts after the catalogs load.
    const copy = seeds()
    const before = copy.find(s => s.id === 'KIC8462852')!
    assert.equal(before.source, undefined)
    assert.equal(before.quadrant, undefined)

    const out = mergeKoiIntoHipparcos(copy, [koi({ id: 'KIC8462852', ra: 301.5642, dec: 44.4567 })])
    const after = out.stars.find(s => s.id === 'KIC8462852')!
    assert.equal(after.source, 'Kepler')
    assert.equal(after.quadrant, 'E3')
  })

  it('leaves seeds entirely untouched when no KOI/TOI references them', () => {
    const copy = seeds()
    const out = mergeKoiIntoHipparcos(copy, [koi({ id: 'KIC-unrelated', ra: 10, dec: 10 })])
    for (const original of KNOWN_ANOMALIES) {
      const found = out.stars.find(s => s.id === original.id)!
      assert.equal(found.anomalyScore, original.anomalyScore, `${original.id} score untouched`)
      assert.equal(found.source, undefined, `${original.id} gains no mission tag`)
    }
  })
})
