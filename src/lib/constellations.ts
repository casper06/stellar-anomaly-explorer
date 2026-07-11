/**
 * @description Celestial orientation: which constellation a J2000 RA/Dec
 * falls in, plus hemisphere-visibility geometry and a best-viewing-month
 * estimate. Constellation identification uses the IAU boundary zone
 * table from VizieR VI/42 (Roman 1987, "Identification of a
 * Constellation From a Position") bundled statically at
 * `src/data/constellationZones.ts` — 357 rows of
 * `[RA_low_h, RA_up_h, Dec_low_deg, abbr]` in B1875 coordinates,
 * precedence-ordered. The boundaries were fixed by the IAU in 1930 and
 * never change, so unlike every other dataset in this app the table is
 * a build-time static import: no fetch, no cache, no health check.
 *
 * Because the zone table is defined at equinox B1875, inputs are
 * precessed J2000 → B1875 with the IAU-1976 (Lieske) three-angle
 * rotation. Arcsecond-level accuracy — far beyond what a boundary
 * lookup needs — and verified against known-star ground truth in
 * `__tests__/constellations.unit.test.ts`.
 */
import { CONSTELLATION_ZONES as ZONES } from '../data/constellationZones'

/** @description IAU 3-letter abbreviation → full constellation name (all 88). */
const CONSTELLATION_NAMES: Record<string, string> = {
  And: 'Andromeda', Ant: 'Antlia', Aps: 'Apus', Aqr: 'Aquarius',
  Aql: 'Aquila', Ara: 'Ara', Ari: 'Aries', Aur: 'Auriga',
  Boo: 'Boötes', Cae: 'Caelum', Cam: 'Camelopardalis', Cnc: 'Cancer',
  CVn: 'Canes Venatici', CMa: 'Canis Major', CMi: 'Canis Minor',
  Cap: 'Capricornus', Car: 'Carina', Cas: 'Cassiopeia', Cen: 'Centaurus',
  Cep: 'Cepheus', Cet: 'Cetus', Cha: 'Chamaeleon', Cir: 'Circinus',
  Col: 'Columba', Com: 'Coma Berenices', CrA: 'Corona Australis',
  CrB: 'Corona Borealis', Crv: 'Corvus', Crt: 'Crater', Cru: 'Crux',
  Cyg: 'Cygnus', Del: 'Delphinus', Dor: 'Dorado', Dra: 'Draco',
  Equ: 'Equuleus', Eri: 'Eridanus', For: 'Fornax', Gem: 'Gemini',
  Gru: 'Grus', Her: 'Hercules', Hor: 'Horologium', Hya: 'Hydra',
  Hyi: 'Hydrus', Ind: 'Indus', Lac: 'Lacerta', Leo: 'Leo',
  LMi: 'Leo Minor', Lep: 'Lepus', Lib: 'Libra', Lup: 'Lupus',
  Lyn: 'Lynx', Lyr: 'Lyra', Men: 'Mensa', Mic: 'Microscopium',
  Mon: 'Monoceros', Mus: 'Musca', Nor: 'Norma', Oct: 'Octans',
  Oph: 'Ophiuchus', Ori: 'Orion', Pav: 'Pavo', Peg: 'Pegasus',
  Per: 'Perseus', Phe: 'Phoenix', Pic: 'Pictor', Psc: 'Pisces',
  PsA: 'Piscis Austrinus', Pup: 'Puppis', Pyx: 'Pyxis', Ret: 'Reticulum',
  Sge: 'Sagitta', Sgr: 'Sagittarius', Sco: 'Scorpius', Scl: 'Sculptor',
  Sct: 'Scutum', Ser: 'Serpens', Sex: 'Sextans', Tau: 'Taurus',
  Tel: 'Telescopium', Tri: 'Triangulum', TrA: 'Triangulum Australe',
  Tuc: 'Tucana', UMa: 'Ursa Major', UMi: 'Ursa Minor', Vel: 'Vela',
  Vir: 'Virgo', Vol: 'Volans', Vul: 'Vulpecula',
}

const DEG = Math.PI / 180

/**
 * @description IAU-1976 (Lieske) precession angles from J2000.0 to
 * B1875.0, computed once at module load. T is the target epoch in
 * Julian centuries from J2000: B1875.0 = JD 2405889.25855 (Besselian
 * year definition), J2000.0 = JD 2451545.0.
 */
const T = (2405889.25855 - 2451545.0) / 36525
const S = DEG / 3600 // arcsec → radians
const ZETA = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * S
const Z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * S
const THETA = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * S

/**
 * @description Precesses J2000 equatorial coordinates to equinox B1875
 * (the zone table's frame) via the standard three-angle rotation.
 * @param raDeg Right ascension, J2000, degrees.
 * @param decDeg Declination, J2000, degrees.
 * @returns B1875 position: RA in HOURS in [0, 24), Dec in degrees.
 */
export function precessJ2000ToB1875(raDeg: number, decDeg: number): { raHours: number; decDeg: number } {
  const ra = raDeg * DEG
  const dec = decDeg * DEG
  const a = Math.cos(dec) * Math.sin(ra + ZETA)
  const b = Math.cos(THETA) * Math.cos(dec) * Math.cos(ra + ZETA) - Math.sin(THETA) * Math.sin(dec)
  const c = Math.sin(THETA) * Math.cos(dec) * Math.cos(ra + ZETA) + Math.cos(THETA) * Math.sin(dec)
  let ra1875 = (Math.atan2(a, b) + Z) / DEG
  ra1875 = ((ra1875 % 360) + 360) % 360
  return { raHours: ra1875 / 15, decDeg: Math.asin(Math.max(-1, Math.min(1, c))) / DEG }
}

/**
 * @description Identifies the constellation containing a J2000 position.
 * Roman's algorithm: precess to B1875, then return the first zone (in
 * the table's precedence order — sorted by declination descending) with
 * `Dec_low ≤ dec` and `RA_low ≤ ra < RA_up`. The final Octans row spans
 * the whole sky at Dec ≥ −90, so a match always exists.
 * @param raDeg Right ascension, J2000, degrees.
 * @param decDeg Declination, J2000, degrees.
 * @returns 3-letter IAU abbreviation and full name.
 */
export function constellationAt(raDeg: number, decDeg: number): { abbr: string; name: string } {
  const p = precessJ2000ToB1875(raDeg, decDeg)
  for (const [raLow, raUp, decLow, abbr] of ZONES) {
    if (p.decDeg >= decLow && p.raHours >= raLow && p.raHours < raUp) {
      return { abbr, name: CONSTELLATION_NAMES[abbr] ?? abbr }
    }
  }
  // Unreachable given the Octans catch-all row, but never throw from a
  // render path.
  return { abbr: '???', name: 'Unknown' }
}

/**
 * @description Hemisphere-visibility geometry for a declination. Pure
 * spherical trig, no external data: a star at declination δ rises above
 * the horizon for observer latitudes φ ∈ (δ−90°, δ+90°) and is
 * circumpolar (never sets) where |φ+δ| > 90° with φ and δ on the same
 * side. Ignores refraction and horizon terrain (~0.5°) — this is an
 * orientation aid, not an ephemeris.
 */
export interface Visibility {
  /** Southernmost observer latitude that ever sees the star, degrees (−90 when unbounded). */
  minLatDeg: number
  /** Northernmost observer latitude that ever sees the star, degrees (+90 when unbounded). */
  maxLatDeg: number
  /**
   * Latitude beyond which the star is circumpolar (positive = "north
   * of", negative = "south of"), or null when no latitude sees it
   * circumpolar (only exactly at the poles).
   */
  circumpolarFromDeg: number | null
}

/**
 * @description Computes the visibility window for a declination.
 * @param decDeg Declination, degrees (J2000 vs B1875 is irrelevant at
 * this precision).
 * @returns Visibility latitudes; see the interface docs.
 */
export function visibilityFor(decDeg: number): Visibility {
  const minLat = Math.max(-90, decDeg - 90)
  const maxLat = Math.min(90, decDeg + 90)
  let circ: number | null = null
  if (decDeg > 0) circ = 90 - decDeg
  else if (decDeg < 0) circ = -(90 + decDeg)
  if (circ !== null && Math.abs(circ) >= 90) circ = null
  return { minLatDeg: minLat, maxLatDeg: maxLat, circumpolarFromDeg: circ }
}

/** @description Month names for bestViewingMonth. */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * @description Approximate month in which a right ascension culminates
 * around local midnight — when the Sun sits opposite the star (solar
 * RA ≈ star RA − 180°). The Sun's RA is ~0° at the March equinox
 * (~Mar 20) and advances ~360°/365.25 d, so the offset in days maps the
 * RA to a calendar date; accuracy is ±2 weeks, hence "around ⟨month⟩".
 * @param raDeg Right ascension, J2000, degrees.
 * @returns Month name, e.g. "December" for Orion.
 */
export function bestViewingMonth(raDeg: number): string {
  const daysAfterEquinox = ((((raDeg - 180) % 360) + 360) % 360) / 360 * 365.25
  // March 20 is day-of-year ~79 in a non-leap year.
  const dayOfYear = (79 + daysAfterEquinox) % 365.25
  const date = new Date(Date.UTC(2001, 0, 1 + Math.floor(dayOfYear)))
  return MONTHS[date.getUTCMonth()]
}

/**
 * @description One-line visibility description for UI use, e.g.
 * "Visible north of −46° · circumpolar above +46°" for a northern star
 * or "Visible south of +85° · circumpolar below −85°" for a southern
 * one. Equatorial targets (visible from every latitude) say so.
 * @param decDeg Declination, degrees.
 * @returns Compact English description.
 */
export function describeVisibility(decDeg: number): string {
  const v = visibilityFor(decDeg)
  const fmt = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x))}°`
  const parts: string[] = []
  if (v.minLatDeg <= -89.5 && v.maxLatDeg >= 89.5) parts.push('Visible from every latitude')
  else if (decDeg >= 0) parts.push(`Visible north of ${fmt(v.minLatDeg)}`)
  else parts.push(`Visible south of ${fmt(v.maxLatDeg)}`)
  if (v.circumpolarFromDeg !== null) {
    parts.push(
      decDeg > 0
        ? `circumpolar above ${fmt(v.circumpolarFromDeg)}`
        : `circumpolar below ${fmt(v.circumpolarFromDeg)}`,
    )
  }
  return parts.join(' · ')
}

/**
 * @description The season an all-night culmination month falls in, for a
 * given hemisphere. Purely the calendar-vs-hemisphere mapping (the same
 * month is opposite seasons north vs south), used to phrase the
 * story-framed visibility copy. Astronomical seasons by culmination
 * month: Dec–Feb = northern winter / southern summer, and so on.
 * @param month Month name as returned by {@link bestViewingMonth}.
 * @param hemisphere 'north' or 'south'.
 * @returns Season word ('summer' | 'autumn' | 'winter' | 'spring').
 */
function seasonForMonth(month: string, hemisphere: 'north' | 'south'): string {
  const northSeasonByMonth: Record<string, string> = {
    December: 'winter', January: 'winter', February: 'winter',
    March: 'spring', April: 'spring', May: 'spring',
    June: 'summer', July: 'summer', August: 'summer',
    September: 'autumn', October: 'autumn', November: 'autumn',
  }
  const north = northSeasonByMonth[month] ?? 'summer'
  if (hemisphere === 'north') return north
  // Southern hemisphere seasons are offset by six months (opposite).
  const opposite: Record<string, string> = {
    winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring',
  }
  return opposite[north]
}

/**
 * @description Story-framed celestial-visibility copy for the UI. Unlike
 * {@link describeVisibility} (a compact latitude readout), this separates
 * the two DIFFERENT facts that a naive one-liner conflates:
 *
 *  1. WHEN it is up all night, worldwide — derived from RA (the
 *     culmination month), phrased as the observer's season.
 *  2. WHETHER / HOW it climbs the sky depending on the observer's
 *     hemisphere — derived purely from Dec geometry (unchanged math via
 *     {@link visibilityFor}).
 *
 * A northern-declination target is framed for a northern observer ("high
 * overhead … in summer"); a southern-declination target for a southern
 * observer; equatorial targets say they suit both. The declination
 * geometry is reported exactly as {@link visibilityFor} computes it — no
 * new claims the math doesn't support.
 * @param raDeg Right ascension, J2000, degrees.
 * @param decDeg Declination, J2000, degrees.
 * @returns One or two short English sentences.
 */
export function describeVisibilityStory(raDeg: number, decDeg: number): string {
  const month = bestViewingMonth(raDeg)
  const v = visibilityFor(decDeg)
  const fmt = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x))}°`

  // Sentence 1 — WHEN, worldwide, framed by the relevant hemisphere's season.
  const homeHemi: 'north' | 'south' = decDeg >= 0 ? 'north' : 'south'
  const season = seasonForMonth(month, homeHemi)
  const when = `Around ${month}, it climbs highest at midnight — the heart of ${homeHemi}ern-hemisphere ${season}.`

  // Sentence 2 — WHO can see it, purely from declination geometry.
  let who: string
  if (v.minLatDeg <= -89.5 && v.maxLatDeg >= 89.5) {
    who = 'It rides the celestial equator, so it rises for observers in both hemispheres.'
  } else if (decDeg >= 0) {
    who =
      `From the northern hemisphere it stands high overhead; it still rises for anyone north of ${fmt(v.minLatDeg)} latitude, sinking lower the farther south you travel` +
      (v.circumpolarFromDeg !== null ? `, and never sets above ${fmt(v.circumpolarFromDeg)}.` : '.')
  } else {
    who =
      `From the southern hemisphere it stands high overhead; it still rises for anyone south of ${fmt(v.maxLatDeg)} latitude, sinking lower the farther north you travel` +
      (v.circumpolarFromDeg !== null ? `, and never sets below ${fmt(v.circumpolarFromDeg)}.` : '.')
  }

  return `${when} ${who}`
}
