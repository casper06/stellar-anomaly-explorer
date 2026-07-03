import type { CurvePattern } from './curveClassifier'

/**
 * @description Sky-radar tint palette, shared by every surface that
 * renders pattern colors: the `PatternRadarMarkers` overlay in
 * StarField, the disambiguation popover's per-row swatches, and the
 * HUD legend. Only three patterns carry a color — SPARSE and
 * UNCERTAIN intentionally have NO radar entry (the classifier is
 * admitting it can't tell), so those stars keep their plain
 * mission-color marker with no tint.
 *
 * Lives in lib/ (not StarField.tsx) so the HUD can import it without
 * pulling the Three.js scene module into its graph — StarField is
 * dynamically imported with `ssr: false` and must stay out of
 * statically-rendered component chains.
 */
export const RADAR_COLOR_HEX: Partial<Record<CurvePattern, string>> = {
  IRREGULAR: '#ff2ea6',        // bright magenta — pops as "interesting"
  PERIODIC_UNIFORM: '#4ade80', // dim green — "boring, known"
  HIGH_VARIABILITY: '#facc15', // dim yellow — "noisy backdrop"
}
