/**
 * @description Pure parsing + descriptive interpretation of Gaia DR3
 * `gaia_source` rows (plus the optional `vari_classifier_result` bonus
 * row). No network, no Node built-ins — deliberately app-side plumbing,
 * exactly like `simbadIds.ts`: this module interprets another archive's
 * ALREADY-COMPUTED summary columns (RUWE, the RV chi-square indices,
 * `phot_variable_flag`, the ML class) by applying published thresholds.
 * It computes no science from raw photometry/pixels the way the MIT
 * engine's `bls`/`oddEven`/`secondaryEclipse`/`centroidVet` do, so it
 * stays OUT of that package — it is catalog-metadata description, not
 * vetting science. (C2.0 decision; see docs/C1_GAIA_DR3_RESEARCH.md.)
 *
 * Input contract (measured live 2026-07-21, frozen in
 * `__tests__/fixtures/gaia/*.json`): the Gaia Archive TAP body is a
 * VOTable served as `votable_plain` (`<FIELD name="…">` column headers
 * then `<TABLEDATA><TR><TD>…</TD></TR>`). Columns are located BY NAME
 * from the `<FIELD>` list (the VizieR lesson — positional parsing turns a
 * silent column change into garbage; name lookup turns it into a loud
 * error). Booleans serialize as `T`/`F`; a null/absent value is an empty
 * `<TD></TD>`.
 *
 * Vocabulary rule (project-wide, enforced here): DESCRIPTIVE, never
 * diagnostic. No string produced by this module asserts a physical cause —
 * no "binary", no "planet", no "variable star" as a verdict. RUWE is
 * "elevated, consistent with a possible unresolved companion", never "this
 * is a binary". `phot_variable_flag = NOT_AVAILABLE` is "not flagged as
 * variable in this release", NEVER inverted into "constant"/"not variable"
 * (the C1 semantic trap: DR3 has no CONSTANT value, so NOT_AVAILABLE makes
 * no constancy claim).
 */

/* ─────────────────────────── VOTable parsing ─────────────────────────── */

/**
 * @description One parsed Gaia `gaia_source` row: the columns the
 * descriptive engine consumes, already coerced from VOTable text. Nullable
 * fields are null when Gaia returned an empty `<TD>` (e.g. all RV columns
 * for a source too faint for the RVS spectrograph). Strings that are
 * genuinely categorical (`phot_variable_flag`) are kept as-is.
 */
export interface GaiaSourceRow {
  /** Gaia DR3 source_id, kept as a STRING — the 19-digit id overflows JS number precision. */
  sourceId: string
  ra: number | null
  dec: number | null
  photGMeanMag: number | null
  photBpMeanMag: number | null
  photRpMeanMag: number | null
  bpRp: number | null
  /** `VARIABLE` or `NOT_AVAILABLE` (DR3 has no `CONSTANT`). Raw, never inverted. */
  photVariableFlag: string | null
  ruwe: number | null
  astrometricExcessNoise: number | null
  ipdFracMultiPeak: number | null
  /** 0 = no dedicated non-single-star solution; >0 flags an NSS table entry. */
  nonSingleStar: number | null
  radialVelocity: number | null
  radialVelocityError: number | null
  rvNbTransits: number | null
  rvTemplateTeff: number | null
  rvChisqPvalue: number | null
  rvRenormalisedGof: number | null
  hasRvs: boolean | null
  hasEpochPhotometry: boolean | null
}

/**
 * @description One parsed `vari_classifier_result` row — Gaia's ML
 * variable-star classification. The BONUS layer: present for only a
 * fraction of sources, absent (the whole result is null) for most.
 */
export interface GaiaClassifierRow {
  sourceId: string
  /** e.g. `nTransits:5+` — which classifier variant produced the class. */
  classifierName: string | null
  /** e.g. `EP` (eclipsing/planetary-transit), `RR`, `CEP`, … — the ~24-type label. */
  bestClassName: string | null
  bestClassScore: number | null
}

/**
 * @description Extracts the `<FIELD name="…">` column list, in order, from
 * a VOTable body. Used to locate columns by name.
 * @param votable Raw VOTable XML text.
 * @returns Column names in SELECT/serialization order.
 */
function votableFieldNames(votable: string): string[] {
  const names: string[] = []
  const re = /<FIELD\b[^>]*\bname\s*=\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(votable)) !== null) names.push(m[1])
  return names
}

/**
 * @description Extracts the first data row's cells from a VOTable body.
 * Returns null when there is no `<TR>` (an empty result — a legitimate
 * "not in this table" answer, the common case for `vari_classifier_result`).
 * A cell that was `<TD></TD>` comes back as an empty string, which the
 * field coercers map to null.
 * @param votable Raw VOTable XML text.
 * @returns Cell strings for the first row, or null when there are no rows.
 */
function votableFirstRowCells(votable: string): string[] | null {
  const tr = /<TR>([\s\S]*?)<\/TR>/.exec(votable)
  if (!tr) return null
  const cells: string[] = []
  const re = /<TD>([\s\S]*?)<\/TD>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tr[1])) !== null) cells.push(decodeXmlText(m[1]))
  return cells
}

/**
 * @description Decodes the handful of XML entities that appear in Gaia
 * VOTable cell text and trims. (Cells are numbers, ids, and short flag
 * strings — no CDATA, no markup — so a small entity table suffices.)
 * @param raw Raw inner text of a `<TD>`.
 * @returns Decoded, trimmed cell value.
 */
function decodeXmlText(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * @description Sentinel thrown/returned discriminator: whether a VOTable
 * body is a Gaia ERROR envelope (`QUERY_STATUS="ERROR"`) rather than a
 * results table. Gaia returns this for a rejected query even when a
 * tabular format was requested — the caller distinguishes it from a genuine
 * parse failure so the log line is actionable (the SIMBAD/VizieR lesson).
 * @param votable Raw VOTable XML text.
 * @returns True when the body is an error envelope.
 */
export function isGaiaErrorEnvelope(votable: string): boolean {
  // The real envelope is `<INFO name="QUERY_STATUS" value="ERROR">` (400)
  // — `QUERY_STATUS` and `ERROR` are separated by ` value=`, so match
  // across the intervening attribute text (same shape as the SIMBAD route's
  // `/QUERY_STATUS[^>]*ERROR/`). Measured live 2026-07-21.
  return /QUERY_STATUS[^>]*ERROR/i.test(votable)
}

/** @description Coerces a VOTable cell to a finite number, or null when empty/non-numeric. */
function num(cell: string | undefined): number | null {
  if (cell === undefined) return null
  const t = cell.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** @description Coerces a VOTable boolean cell (`T`/`F`, tolerant of `true`/`false`/`1`/`0`) to bool or null. */
function bool(cell: string | undefined): boolean | null {
  if (cell === undefined) return null
  const t = cell.trim().toLowerCase()
  if (t === '') return null
  if (t === 't' || t === 'true' || t === '1') return true
  if (t === 'f' || t === 'false' || t === '0') return false
  return null
}

/** @description Coerces a VOTable cell to a non-empty trimmed string, or null when empty. */
function str(cell: string | undefined): string | null {
  if (cell === undefined) return null
  const t = cell.trim()
  return t === '' ? null : t
}

/**
 * @description Parses a Gaia `gaia_source` VOTable response into a
 * `GaiaSourceRow`. Locates columns BY NAME and throws on a missing
 * required column or an error/malformed envelope (contract-change
 * detection); returns null when the query was well-formed but matched no
 * source (empty `<TABLEDATA>`) — a legitimate "no such source_id" answer.
 * @param votable Raw VOTable XML text from the Gaia TAP sync endpoint.
 * @returns The parsed row, or null for a legitimate empty result.
 * @throws Error when the body is an error envelope or violates the
 * measured column contract.
 */
export function parseGaiaSourceVotable(votable: string): GaiaSourceRow | null {
  if (typeof votable !== 'string' || votable.length === 0) {
    throw new Error('Gaia gaia_source response was empty')
  }
  if (isGaiaErrorEnvelope(votable)) {
    throw new Error('Gaia gaia_source response is an error envelope (QUERY_STATUS=ERROR)')
  }
  const fields = votableFieldNames(votable)
  if (fields.length === 0) {
    // No FIELD headers and no error envelope: this is not VOTable at all —
    // the HTTP-200-HTML outage page, or some other non-VOTable body.
    throw new Error('Gaia gaia_source response has no VOTable FIELDs (outage HTML or non-VOTable body?)')
  }
  const idx = (name: string): number => {
    const i = fields.indexOf(name)
    if (i < 0) throw new Error(`Gaia gaia_source response missing '${name}' column; columns: [${fields.join(', ')}]`)
    return i
  }
  // Require the columns the descriptive engine actually reads. Locating
  // them all up front turns a schema change into one loud error rather
  // than silent nulls scattered through the output.
  const iSource = idx('source_id')
  const iRa = idx('ra')
  const iDec = idx('dec')
  const iG = idx('phot_g_mean_mag')
  const iBp = idx('phot_bp_mean_mag')
  const iRp = idx('phot_rp_mean_mag')
  const iBpRp = idx('bp_rp')
  const iVarFlag = idx('phot_variable_flag')
  const iRuwe = idx('ruwe')
  const iAen = idx('astrometric_excess_noise')
  const iIpd = idx('ipd_frac_multi_peak')
  const iNss = idx('non_single_star')
  const iRv = idx('radial_velocity')
  const iRvErr = idx('radial_velocity_error')
  const iRvN = idx('rv_nb_transits')
  const iRvTeff = idx('rv_template_teff')
  const iRvP = idx('rv_chisq_pvalue')
  const iRvGof = idx('rv_renormalised_gof')
  const iHasRvs = idx('has_rvs')
  const iHasEpoch = idx('has_epoch_photometry')

  const cells = votableFirstRowCells(votable)
  if (cells === null) return null // well-formed query, no matching source

  const sourceId = str(cells[iSource])
  if (!sourceId) throw new Error('Gaia gaia_source row has an empty source_id')

  return {
    sourceId,
    ra: num(cells[iRa]),
    dec: num(cells[iDec]),
    photGMeanMag: num(cells[iG]),
    photBpMeanMag: num(cells[iBp]),
    photRpMeanMag: num(cells[iRp]),
    bpRp: num(cells[iBpRp]),
    photVariableFlag: str(cells[iVarFlag]),
    ruwe: num(cells[iRuwe]),
    astrometricExcessNoise: num(cells[iAen]),
    ipdFracMultiPeak: num(cells[iIpd]),
    nonSingleStar: num(cells[iNss]),
    radialVelocity: num(cells[iRv]),
    radialVelocityError: num(cells[iRvErr]),
    rvNbTransits: num(cells[iRvN]),
    rvTemplateTeff: num(cells[iRvTeff]),
    rvChisqPvalue: num(cells[iRvP]),
    rvRenormalisedGof: num(cells[iRvGof]),
    hasRvs: bool(cells[iHasRvs]),
    hasEpochPhotometry: bool(cells[iHasEpoch]),
  }
}

/**
 * @description Parses a `vari_classifier_result` VOTable response. Returns
 * null when there is no row — the NORMAL, silent "this source is not in the
 * classifier table" answer (most sources, per C1.2), which must never be
 * treated as an error. Throws only on an actual error envelope, so a
 * genuine upstream failure is still distinguishable from an empty result.
 * @param votable Raw VOTable XML text.
 * @returns The parsed classifier row, or null when absent.
 * @throws Error when the body is an error envelope.
 */
export function parseGaiaClassifierVotable(votable: string): GaiaClassifierRow | null {
  if (typeof votable !== 'string' || votable.length === 0) return null
  if (isGaiaErrorEnvelope(votable)) {
    throw new Error('Gaia vari_classifier_result response is an error envelope (QUERY_STATUS=ERROR)')
  }
  const fields = votableFieldNames(votable)
  if (fields.length === 0) return null
  const cells = votableFirstRowCells(votable)
  if (cells === null) return null // not in the classifier table — the common, silent case

  const at = (name: string): string | undefined => {
    const i = fields.indexOf(name)
    return i < 0 ? undefined : cells[i]
  }
  const sourceId = str(at('source_id'))
  if (!sourceId) return null
  return {
    sourceId,
    classifierName: str(at('classifier_name')),
    bestClassName: str(at('best_class_name')),
    bestClassScore: num(at('best_class_score')),
  }
}

/* ───────────────────────── descriptive engine ───────────────────────── */

/**
 * @description Published calibration constants, sourced in
 * docs/C1_GAIA_DR3_RESEARCH.md §C1.3. Kept as named constants so the
 * thresholds are auditable against the citations rather than buried as
 * magic numbers.
 */

/** @description RV-variability criterion (Katz et al. 2023, A&A 674 A5 — all four guards). */
const RV_MIN_TRANSITS = 10
const RV_TEMPLATE_TEFF_MIN = 3900
const RV_TEMPLATE_TEFF_MAX = 8000
const RV_CHISQ_PVALUE_MAX = 0.01
const RV_RENORM_GOF_MIN = 4

/**
 * @description RUWE reference band. 1.4 = the DR2-era good-single-star-fit
 * breakpoint (Lindegren 2018; unresolved-binary selector in Belokurov et
 * al. 2020). A CONVENTION, not a hard law — surfaced descriptively, never
 * as a binarity verdict.
 */
const RUWE_REFERENCE = 1.4

/**
 * @description RV-variability determination, kept as its own tri-state so
 * "we could not evaluate it" (no RVS data — faint sources) stays distinct
 * from "evaluated: not variable". Never collapse `NOT_EVALUATED` into
 * `NOT_VARIABLE`: absence of RV data is not evidence of RV constancy.
 */
export type RvVariability = 'VARIABLE' | 'NOT_VARIABLE' | 'NOT_EVALUATED'

/**
 * @description RUWE descriptive band. `ELEVATED` means above the 1.4
 * reference; `WITHIN_REFERENCE` means at/below it. `UNKNOWN` when RUWE is
 * null. Descriptive only — `ELEVATED` is "consistent with a possible
 * unresolved companion", not "binary".
 */
export type RuweBand = 'WITHIN_REFERENCE' | 'ELEVATED' | 'UNKNOWN'

/**
 * @description Photometric-variability flag reading. Mirrors Gaia's own two
 * DR3 values plus an `UNKNOWN` for a null flag. Crucially there is NO
 * "constant"/"not variable" member — `NOT_FLAGGED` is the faithful reading
 * of `NOT_AVAILABLE` and makes no constancy claim (C1 semantic trap).
 */
export type PhotVariableReading = 'FLAGGED_VARIABLE' | 'NOT_FLAGGED' | 'UNKNOWN'

/**
 * @description The bonus ML-classifier layer, present only when the source
 * is in `vari_classifier_result`. `undefined` on the parent profile means
 * "not in the table" — rendered as nothing at all, like SIMBAD's absent
 * "also known as" block, never as an error.
 */
export interface GaiaClassifierDescription {
  /** Raw Gaia class code, e.g. `EP`, `RR`, `CEP`, `LPV`. */
  className: string
  /** Classifier's confidence in [0, 1] when Gaia provided it. */
  score: number | null
  /** Which classifier variant produced it, e.g. `nTransits:5+`. */
  classifierName: string | null
}

/**
 * @description The structured descriptive output for one Gaia source — the
 * engine's product. Every field is a MEASUREMENT or a descriptive band, not
 * a diagnosis. The consuming UI phrases these; this module never emits
 * prose that asserts a physical cause.
 */
export interface GaiaDescription {
  sourceId: string

  /** RUWE value as measured, and its band against the 1.4 reference. */
  ruwe: number | null
  ruweBand: RuweBand

  /**
   * @description RV-variability per the Katz 2023 four-part criterion.
   * `NOT_EVALUATED` when any guard input is missing (no RVS data), which is
   * distinct from `NOT_VARIABLE`.
   */
  rvVariability: RvVariability
  /** The RV measurement inputs, surfaced so the readout can show the numbers. */
  radialVelocity: number | null
  radialVelocityError: number | null
  rvNbTransits: number | null

  /**
   * @description Faithful reading of `phot_variable_flag`. `NOT_FLAGGED`
   * for `NOT_AVAILABLE` — NEVER "constant".
   */
  photVariable: PhotVariableReading

  /** Supplementary astrometric-multiplicity context (C1.2 item 5). */
  astrometricExcessNoise: number | null
  ipdFracMultiPeak: number | null
  /** 0 = no dedicated non-single-star solution in Gaia's NSS tables. */
  nonSingleStar: number | null

  /** Photometry, for display context. */
  photGMeanMag: number | null
  bpRp: number | null

  /**
   * @description Bonus ML classifier — `undefined` when the source is not
   * in `vari_classifier_result` (the common case). Absence is silent.
   */
  classifier?: GaiaClassifierDescription
}

/**
 * @description Applies the Gaia DR3 four-part RV-variability criterion
 * (Katz et al. 2023). Returns `NOT_EVALUATED` when any input the criterion
 * needs is missing — a source with no RVS coverage cannot be called either
 * variable or constant. All four guards are applied; a simplified two-part
 * form would misclassify (see C1.3).
 * @param row Parsed gaia_source row.
 * @returns Tri-state RV-variability reading.
 */
export function classifyRvVariability(row: GaiaSourceRow): RvVariability {
  const { rvNbTransits, rvTemplateTeff, rvChisqPvalue, rvRenormalisedGof } = row
  // Any missing input → not evaluable. The template teff and transit count
  // are as load-bearing as the two statistics: they are the reliability
  // guards Katz 2023 puts on the indices.
  if (
    rvNbTransits === null ||
    rvTemplateTeff === null ||
    rvChisqPvalue === null ||
    rvRenormalisedGof === null
  ) {
    return 'NOT_EVALUATED'
  }
  const isVariable =
    rvNbTransits >= RV_MIN_TRANSITS &&
    rvTemplateTeff >= RV_TEMPLATE_TEFF_MIN &&
    rvTemplateTeff <= RV_TEMPLATE_TEFF_MAX &&
    rvChisqPvalue <= RV_CHISQ_PVALUE_MAX &&
    rvRenormalisedGof > RV_RENORM_GOF_MIN
  return isVariable ? 'VARIABLE' : 'NOT_VARIABLE'
}

/**
 * @description Bands RUWE against the 1.4 reference. Descriptive only.
 * @param ruwe RUWE value, or null.
 * @returns RUWE band.
 */
export function classifyRuwe(ruwe: number | null): RuweBand {
  if (ruwe === null || !Number.isFinite(ruwe)) return 'UNKNOWN'
  return ruwe > RUWE_REFERENCE ? 'ELEVATED' : 'WITHIN_REFERENCE'
}

/**
 * @description Reads `phot_variable_flag` into the faithful tri-state.
 * `VARIABLE` → `FLAGGED_VARIABLE`; `NOT_AVAILABLE` → `NOT_FLAGGED` (NOT
 * "constant"); anything else/null → `UNKNOWN`. This is the single most
 * important don't-invert point in the module (C1 semantic trap).
 * @param flag Raw `phot_variable_flag` value.
 * @returns Faithful photometric-variability reading.
 */
export function readPhotVariableFlag(flag: string | null): PhotVariableReading {
  if (flag === 'VARIABLE') return 'FLAGGED_VARIABLE'
  if (flag === 'NOT_AVAILABLE') return 'NOT_FLAGGED'
  return 'UNKNOWN'
}

/**
 * @description Builds the full descriptive profile for one Gaia source from
 * its parsed `gaia_source` row and, when present, its
 * `vari_classifier_result` row. Pure and side-effect-free; this is the
 * engine's single public entry point (the analogue of `classifyCurve`).
 * @param row Parsed gaia_source row (required — the backbone).
 * @param classifier Parsed classifier row, or null when the source is not
 * in `vari_classifier_result`. Null/undefined leaves `classifier` off the
 * result entirely — the absence-is-silent posture.
 * @returns The descriptive profile.
 */
export function describeGaiaSource(
  row: GaiaSourceRow,
  classifier?: GaiaClassifierRow | null,
): GaiaDescription {
  const description: GaiaDescription = {
    sourceId: row.sourceId,
    ruwe: row.ruwe,
    ruweBand: classifyRuwe(row.ruwe),
    rvVariability: classifyRvVariability(row),
    radialVelocity: row.radialVelocity,
    radialVelocityError: row.radialVelocityError,
    rvNbTransits: row.rvNbTransits,
    photVariable: readPhotVariableFlag(row.photVariableFlag),
    astrometricExcessNoise: row.astrometricExcessNoise,
    ipdFracMultiPeak: row.ipdFracMultiPeak,
    nonSingleStar: row.nonSingleStar,
    photGMeanMag: row.photGMeanMag,
    bpRp: row.bpRp,
  }

  // Bonus layer: only attach when the source is genuinely in the classifier
  // table with a usable class. A row that parsed to no className is treated
  // as absence, not an empty/error field.
  if (classifier && classifier.bestClassName) {
    description.classifier = {
      className: classifier.bestClassName,
      score: classifier.bestClassScore,
      classifierName: classifier.classifierName,
    }
  }

  return description
}
