import { useStore, type Star } from './store'
import { fetchLightcurve, detectDips } from './anomalyDetector'
import { classifyCurve } from './curveClassifier'

/**
 * @description Monotonic generation counter for selection requests. Each
 * `selectStarAndFetchCurve` call claims the next value; after its fetch
 * resolves, a call only writes lightcurve/anomaly state if it is STILL
 * the latest generation. Two racing selections (e.g. an explicit pick
 * immediately followed by an auto-select, or rapid clicks while the
 * MAST cold path takes ~60s) otherwise interleave: whichever fetch
 * resolves LAST wins the store, which can pair star A's panel header
 * with star B's light curve.
 */
let selectionGeneration = 0

/**
 * @description Selects a star: switches the UI to analyze mode, fetches its
 * light curve, detects dips, classifies the curve, and pushes everything
 * into the store so the AnomalyPanel can render. Also records the star as
 * visited (persisted) and lazily fills the shared server-side pattern
 * cache when a valid profile is produced.
 *
 * Pulled out of StarField.tsx so non-canvas call sites (HUD search bar,
 * flagged panel row click, etc.) can drive the exact same flow as a
 * direct sky click — otherwise those alternative entry points would only
 * update `selectedStar` without fetching, leaving the AnomalyPanel
 * showing stale light-curve data from whichever star was picked
 * previously.
 *
 * The helper reads and writes the store via `useStore.getState()` rather
 * than accepting setters as parameters, which keeps call sites concise —
 * any component can `await selectStarById(...)` without threading a
 * dozen setter refs through props.
 * @param star The star the user just picked (from click, search, etc.).
 */
export async function selectStarAndFetchCurve(star: Star): Promise<void> {
  const {
    setSelectedStar,
    setMode,
    setLightcurve,
    setAnomalies,
    setLightcurveLoading,
    markVisited,
    setClassifiedPattern,
  } = useStore.getState()

  // Claim this call's generation. The synchronous writes below are safe
  // without a check (the latest call always runs them last); the check
  // guards the post-await writes.
  const generation = ++selectionGeneration

  setSelectedStar(star)
  setMode('analyze')
  // Persisted visited set. We mark BEFORE the fetch so a failed MAST
  // round-trip still records "the user tried this star" — prevents
  // re-nagging on subsequent sessions. Mirrors the existing on-click
  // behavior in StarField.tsx.
  markVisited(star.id)
  setLightcurve(null)
  setLightcurveLoading(true)
  try {
    // Catalog stars (KIC*/TIC*/EPIC*) get the default behavior:
    // synthetic-in-dev fallback if MAST is down. Anything else is
    // treated as on-demand — pass ra/dec so the route can cone-search,
    // AND set onDemand=1 so a MAST miss returns 'unavailable' rather
    // than fake data.
    const isCatalogStar = /^(KIC|TIC|EPIC)\d+$/.test(star.id)
    const { times, flux, source, provenance, mission, gapDays } =
      await fetchLightcurve(star.id, {
        ra: star.ra,
        dec: star.dec,
        onDemand: !isCatalogStar,
      })
    // A newer selection superseded this one while the fetch was in
    // flight. Discard everything — the newer call owns all selection
    // state, and writing here would pair its star with our curve.
    if (generation !== selectionGeneration) return
    const dips = detectDips(flux, times)
    const anomalyDips = dips.map(d => ({
      starId: star.id,
      score: d.score,
      depth: d.depth,
      duration: d.duration,
      asymmetry: d.asymmetry,
      peakTime: d.peakTime,
      label: d.label,
    }))
    const profile =
      source === 'unavailable' || times.length === 0
        ? null
        : classifyCurve(times, flux, dips)
    setLightcurve({
      times,
      flux,
      dips: anomalyDips,
      source,
      provenance,
      profile,
      mission: mission ?? null,
      gapDays: gapDays ?? 5,
    })
    setAnomalies(anomalyDips.filter(d => d.label !== 'NORMAL'))
    // Lazy fill-in for the sky-radar pattern cache. Mirrors the sky-click
    // path — locally, then async POST to converge with the batch job's
    // shared server cache.
    if (profile) {
      setClassifiedPattern(star.id, profile.pattern)
      const pattern = profile.pattern
      void fetch('/api/pattern-cache', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ starId: star.id, pattern }),
      }).catch(() => { /* best-effort */ })
    }
  } finally {
    // Only the latest generation may clear the loading flag — a stale
    // call resolving late must not hide the spinner while the newer
    // call's fetch is still in flight.
    if (generation === selectionGeneration) setLightcurveLoading(false)
  }
}
