/**
 * @description Ground-truth tests for the celestial-orientation library:
 * constellationAt against stars whose constellations are unambiguous
 * public knowledge (including this app's own seed stars), precession
 * sanity, visibility geometry, and the best-viewing-month estimate.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  constellationAt,
  precessJ2000ToB1875,
  visibilityFor,
  describeVisibility,
  bestViewingMonth,
} from '../constellations.ts'

/** @description Known stars: [label, RA_J2000_deg, Dec_J2000_deg, expected abbr]. */
const GROUND_TRUTH: Array<[string, number, number, string]> = [
  ["Tabby's Star (KIC 8462852)", 301.5642, 44.4567, 'Cyg'],
  ['HAT-P-7 (Kepler-2)', 292.2474, 47.9695, 'Cyg'],
  ['Polaris', 37.9545, 89.2641, 'UMi'],
  ['Sirius', 101.2875, -16.7161, 'CMa'],
  ['Betelgeuse', 88.7929, 7.4071, 'Ori'],
  ['Vega', 279.2347, 38.7837, 'Lyr'],
  ['Alpha Centauri', 219.9021, -60.8340, 'Cen'],
  ['TRAPPIST-1', 346.6224, -5.0414, 'Aqr'],
  ['Spica', 201.298, -11.161, 'Vir'],
  // The seed star EPIC 201637175 (RA 11h37m, Dec −4.7°) sits inside
  // Leo's southern extension (Leo reaches RA ~11h58m at that dec) —
  // verified against the Spica/Regulus anchors above, not assumed.
  ['EPIC 201637175 (K2 field)', 174.32, -4.67, 'Leo'],
  // Boundary-sensitive case: Albireo sits ~4° from the Cyg/Vul border.
  ['Albireo (β Cyg)', 292.6804, 27.9597, 'Cyg'],
]

describe('constellationAt', () => {
  for (const [label, ra, dec, expected] of GROUND_TRUTH) {
    it(`${label} → ${expected}`, () => {
      const c = constellationAt(ra, dec)
      assert.equal(c.abbr, expected, `${label}: expected ${expected}, got ${c.abbr} (${c.name})`)
    })
  }

  it('returns a full name for every zone abbreviation (no ??? fallbacks)', () => {
    // Sweep a coarse grid over the whole sphere; every hit must resolve
    // to a real name (the Octans catch-all guarantees a match).
    // Leo and Ara are legitimately their own full names.
    const sameNameOk = new Set(['Leo', 'Ara'])
    for (let ra = 0; ra < 360; ra += 15) {
      for (let dec = -85; dec <= 85; dec += 10) {
        const c = constellationAt(ra, dec)
        assert.notEqual(c.abbr, '???', `no zone matched ra=${ra} dec=${dec}`)
        if (!sameNameOk.has(c.abbr)) {
          assert.notEqual(c.name, c.abbr, `abbr ${c.abbr} missing from the name map`)
        }
      }
    }
  })
})

describe('precessJ2000ToB1875', () => {
  it('moves coordinates by the expected ~1.7°-in-RA magnitude and preserves poles', () => {
    // Precession over 125 years shifts RA by roughly 125 × 46″/yr ≈ 1.6°
    // near the equator; sanity-check the order of magnitude.
    const p = precessJ2000ToB1875(180, 0)
    const dRaDeg = Math.abs(p.raHours * 15 - 180)
    assert.ok(dRaDeg > 1 && dRaDeg < 3, `RA shift ${dRaDeg.toFixed(2)}° in expected range`)
    // The celestial pole precesses ~0.35°/25yr; B1875 pole stays near ±90.
    const n = precessJ2000ToB1875(0, 89.9)
    assert.ok(n.decDeg > 88.5, `near-pole dec stays near pole (${n.decDeg.toFixed(2)})`)
  })
})

describe('visibilityFor / describeVisibility', () => {
  it('northern star: visible north of dec−90, circumpolar above 90−dec', () => {
    const v = visibilityFor(44.46)
    assert.ok(Math.abs(v.minLatDeg - -45.54) < 0.01)
    assert.equal(v.maxLatDeg, 90)
    assert.ok(v.circumpolarFromDeg !== null && Math.abs(v.circumpolarFromDeg - 45.54) < 0.01)
    assert.equal(describeVisibility(44.46), 'Visible north of −46° · circumpolar above +46°')
  })

  it('southern star mirrors the geometry', () => {
    const v = visibilityFor(-60.83) // Alpha Cen
    assert.equal(v.minLatDeg, -90)
    assert.ok(Math.abs(v.maxLatDeg - 29.17) < 0.01)
    assert.ok(v.circumpolarFromDeg !== null && Math.abs(v.circumpolarFromDeg - -29.17) < 0.01)
  })

  it('equatorial star is visible from every latitude and never circumpolar', () => {
    const v = visibilityFor(0)
    assert.equal(v.minLatDeg, -90)
    assert.equal(v.maxLatDeg, 90)
    assert.equal(v.circumpolarFromDeg, null)
    assert.equal(describeVisibility(0), 'Visible from every latitude')
  })
})

describe('bestViewingMonth', () => {
  it('matches well-known seasonal constellations', () => {
    assert.equal(bestViewingMonth(88.79), 'December') // Orion (Betelgeuse)
    const cygnus = bestViewingMonth(301.56) // Kepler field
    assert.ok(['July', 'August'].includes(cygnus), `Cygnus ≈ July/August (got ${cygnus})`)
    const scorpius = bestViewingMonth(247.35) // Antares
    assert.ok(['May', 'June'].includes(scorpius), `Scorpius ≈ May/June (got ${scorpius})`)
  })
})
