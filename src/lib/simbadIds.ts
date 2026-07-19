/**
 * @description Pure parsing/normalization of SIMBAD TAP identity responses
 * into a clean cross-identifier structure. No network, no Node built-ins —
 * deliberately app-side plumbing (catalog-identifier string munging, not
 * vetting science), so it lives here and NOT in the MIT engine package.
 *
 * Input contract (measured live 2026-07-17, frozen in
 * `__tests__/fixtures/simbad/*.json`): the SIMBAD TAP JSON body is
 * `{ metadata: [{ name, ... }], data: [[...]] }` — note the column list
 * lives under `metadata`, NOT `info` as MAST's TAP uses. Columns are
 * located BY NAME from the metadata array (the VizieR lesson: positional
 * parsing turns a silent column change into garbage; name lookup turns it
 * into a loud error). The `ids` column carries every identifier of the
 * object pipe-concatenated, with catalog-native padding runs
 * (`NSVS   5711291`, `BD+47  2846`) that are collapsed during
 * normalization.
 */

/**
 * @description Normalized cross-identification record for one star.
 * Catalog fields hold the BARE catalog value (no prefix) so consumers
 * can rebuild either display form; null = SIMBAD lists no id in that
 * catalog. `commonNames` holds human-meaningful designations: `NAME …`
 * entries (SIMBAD's colloquial-name convention, e.g. "Boyajian's Star")
 * plus proper-name survey designations (HAT-P-7, Kepler-2, KOI-2,
 * TOI-1265, WASP-126, K2-22).
 */
export interface SimbadIdentity {
  /** SIMBAD's canonical designation — often NOT the queried id (Tabby's is `TYC 3162-665-1`). */
  mainId: string
  /** SIMBAD object-type code (e.g. `*`, `PM*`, `Em*`, `LM*`), null when absent. */
  otype: string | null
  /** ICRS position from SIMBAD's `basic` table, degrees; null when absent. */
  ra: number | null
  dec: number | null
  kic: string | null
  tic: string | null
  epic: string | null
  hip: string | null
  gaiaDr3: string | null
  /** 2MASS designation without the catalog prefix, e.g. `J20061546+4427248`. */
  twoMass: string | null
  /** Tycho designation without the prefix, e.g. `3162-665-1`. */
  tycho: string | null
  commonNames: string[]
  /** Every identifier, whitespace-normalized, in SIMBAD's order — the raw material for “also known as” displays. */
  allIds: string[]
}

/**
 * @description Collapses internal whitespace runs to single spaces and
 * trims — SIMBAD pads identifiers to catalog-native column widths
 * (`NSVS   5711291`, `PPM  58383`), which is noise for display and
 * matching.
 * @param raw One raw identifier from the pipe-joined `ids` string.
 * @returns Normalized identifier.
 */
export function normalizeSimbadId(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** @description Matches proper-name survey designations treated as common names. */
const COMMON_NAME_SURVEY = /^(?:HAT-P|WASP|Kepler|KOI|K2|TOI)-\d+$/

/**
 * @description Extracts one `PREFIX value` catalog id from a normalized
 * identifier list.
 * @param ids Normalized identifiers.
 * @param re Anchored regex with the bare value as capture group 1.
 * @returns The bare value, or null when no identifier matches.
 */
function extract(ids: string[], re: RegExp): string | null {
  for (const id of ids) {
    const m = id.match(re)
    if (m) return m[1]
  }
  return null
}

/**
 * @description Parses SIMBAD's pipe-joined `ids` string into the
 * normalized identifier fields. Exposed separately from the full
 * response parser so it can be unit-tested on raw strings.
 * @param idsString Pipe-concatenated identifiers as SIMBAD returns them.
 * @returns Catalog fields + common names + the full normalized list.
 */
export function parseSimbadIdsString(
  idsString: string,
): Pick<SimbadIdentity, 'kic' | 'tic' | 'epic' | 'hip' | 'gaiaDr3' | 'twoMass' | 'tycho' | 'commonNames' | 'allIds'> {
  const allIds = idsString
    .split('|')
    .map(normalizeSimbadId)
    .filter(id => id.length > 0)

  const commonNames: string[] = []
  for (const id of allIds) {
    const name = id.startsWith('NAME ') ? id.slice(5) : COMMON_NAME_SURVEY.test(id) ? id : null
    if (name && !commonNames.includes(name)) commonNames.push(name)
  }

  return {
    kic: extract(allIds, /^KIC (\d+)$/),
    tic: extract(allIds, /^TIC (\d+)$/),
    epic: extract(allIds, /^EPIC (\d+)$/),
    hip: extract(allIds, /^HIP (\d+)$/),
    gaiaDr3: extract(allIds, /^Gaia DR3 (\d+)$/),
    twoMass: extract(allIds, /^2MASS (J\S+)$/),
    tycho: extract(allIds, /^TYC (\S+)$/),
    commonNames,
    allIds,
  }
}

/**
 * @description Alternate designations worth showing the user for one
 * star, already filtered against what the UI is displaying elsewhere.
 * Empty `names` means there is nothing to show — the caller renders
 * nothing at all rather than an empty block.
 */
export interface IdentityDisplayNames {
  /** Common names in SIMBAD order, minus anything the panel already shows. */
  names: string[]
  /**
   * @description SIMBAD's canonical designation, or null when it would be
   * redundant. Included only when it adds information: `main_id` is often
   * an obscure catalog entry (Tabby's Star is `TYC 3162-665-1`), which is
   * genuinely useful cross-reference context, but repeating a name
   * already in `names` or already in the panel header would be noise.
   */
  mainId: string | null
}

/**
 * @description Picks the alternate designations to display for a star,
 * suppressing anything the panel already shows under a different label.
 *
 * Pure and offline-testable, and deliberately here rather than in the
 * component: it is identifier string munging (this module's stated
 * scope), and the "is this name redundant?" comparison is exactly the
 * whitespace/case-insensitive matching the rest of this file owns.
 *
 * Matching is case- and whitespace-insensitive so `Boyajian's star`,
 * `BOYAJIAN'S STAR`, and `Boyajian's  Star` all count as the same name
 * as the displayed one.
 * @param identity Resolved SIMBAD identity.
 * @param displayed Strings the panel already shows for this star (its
 * catalog name and id) — these are filtered out of the result.
 * @returns Names + optional mainId to render; `names: []` and
 * `mainId: null` when everything was redundant.
 */
export function selectDisplayNames(
  identity: SimbadIdentity,
  displayed: string[],
): IdentityDisplayNames {
  const key = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const taken = new Set(displayed.map(key))

  const names: string[] = []
  for (const name of identity.commonNames) {
    const k = key(name)
    if (taken.has(k)) continue
    taken.add(k)
    names.push(name)
  }

  // mainId earns its row only if it is not already shown and is not one
  // of the common names we are about to list.
  const mainId = taken.has(key(identity.mainId)) ? null : identity.mainId

  return { names, mainId }
}

/**
 * @description Parses a full SIMBAD TAP JSON response body into a
 * `SimbadIdentity`. Locates columns by NAME from `metadata` and throws
 * on a missing column or malformed envelope (contract-change detection,
 * mirroring the Hipparcos parser); returns null when `data` is empty —
 * the object is simply not in SIMBAD, a valid answer worth caching.
 * @param body Parsed JSON body from the SIMBAD TAP sync endpoint.
 * @returns The normalized identity, or null for a legitimate miss.
 * @throws Error when the response shape violates the measured contract.
 */
export function parseSimbadIdentityResponse(body: unknown): SimbadIdentity | null {
  const obj = body as { metadata?: unknown; data?: unknown }
  if (!obj || !Array.isArray(obj.metadata) || !Array.isArray(obj.data)) {
    throw new Error('SIMBAD response missing metadata/data arrays (contract change or error envelope)')
  }
  const cols = (obj.metadata as Array<{ name?: unknown }>).map(m => String(m?.name ?? ''))
  const col = (name: string): number => {
    const i = cols.indexOf(name)
    if (i < 0) throw new Error(`SIMBAD response missing '${name}' column; columns: [${cols.join(', ')}]`)
    return i
  }
  const iMain = col('main_id')
  const iOtype = col('otype')
  const iRa = col('ra')
  const iDec = col('dec')
  const iIds = col('ids')

  if (obj.data.length === 0) return null

  const row = obj.data[0] as unknown[]
  const mainId = normalizeSimbadId(String(row[iMain] ?? ''))
  if (!mainId) throw new Error('SIMBAD row has an empty main_id')
  const otypeRaw = row[iOtype]
  const raRaw = row[iRa]
  const decRaw = row[iDec]

  return {
    mainId,
    otype: typeof otypeRaw === 'string' && otypeRaw.trim() ? otypeRaw.trim() : null,
    ra: typeof raRaw === 'number' && Number.isFinite(raRaw) ? raRaw : null,
    dec: typeof decRaw === 'number' && Number.isFinite(decRaw) ? decRaw : null,
    ...parseSimbadIdsString(String(row[iIds] ?? '')),
  }
}
