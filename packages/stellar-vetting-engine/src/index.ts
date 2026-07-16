// SPDX-License-Identifier: MIT
/**
 * @description Public API of stellar-vetting-engine — portable,
 * dependency-free transit-photometry measurement and vetting tools
 * calibrated against NASA Kepler DR25 ground truth. See README.md for
 * the full API reference and calibration notes.
 */

export {
  detectDips,
  robustFluxSigma,
  DIP_NOISE_SIGMA_K,
  DIP_NOISE_GATE_SIGMA,
  DIP_MERGE_GAP_DAYS,
  MIN_DIP_DURATION_DAYS,
  type Dip,
} from './dipDetector'

export { runBls, BLS_SDE_THRESHOLD, type BlsResult } from './bls'

export {
  classifyCurve,
  pickPattern,
  CLASSIFIER_VERSION,
  type CurveProfile,
  type CurvePattern,
  type DipShape,
} from './curveClassifier'

export {
  measureOddEvenDepths,
  ODD_EVEN_SIGMA_THRESHOLD,
  ODD_EVEN_MIN_REL_DIFF_PCT,
  MIN_CYCLES_PER_PARITY,
  type OddEvenResult,
} from './oddEven'

export { measureSecondaryEclipse, type SecondaryEclipseResult } from './secondaryEclipse'

export {
  FITS_BLOCK,
  parseFitsHeader,
  hduDataBytes,
  enumerateHdus,
  bintableColumnLayout,
  FITS_TYPE_INFO,
  type FitsHdu,
  type FitsColumnMeta,
} from './fitsCore'

export { readMastLightcurveColumns } from './fitsReader'

export { readTpf, type TpfQuarter, type TpfWcs } from './tpfReader'

export {
  runCentroidVet,
  isSaturatedMag,
  KEPLER_ARCSEC_PER_PX,
  KEPLER_SATURATION_KEPMAG,
  TESS_SATURATION_TMAG,
  CENTROID_SIGMA_THRESHOLD,
  CENTROID_FLOOR_PX,
  CENTROID_MIN_FLOOR_ARCSEC,
  MIN_QUARTERS_FOR_MEASUREMENT,
  type CentroidQuarterInput,
  type CentroidVetResult,
  type CentroidStamp,
  type CentroidWcs,
  type QuarterCentroidOffset,
} from './centroidVet'
