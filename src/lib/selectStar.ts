import { useStore, type Star } from './store'
import { fetchLightcurve, detectDips } from './anomalyDetector'
import { classifyCurveAsync } from './classifyAsync'
import { fetchIdentity } from './identityClient'
import { fetchGaiaForStar } from './gaiaClient'

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
 * @description Resolves the star's SIMBAD identity and pushes it into the
 * store, guarded by the same generation counter as the light curve.
 *
 * Deliberately NOT awaited inside the light-curve path: SIMBAD answers in
 * ~0.3–2.4 s while a cold MAST fetch can take ~60 s, so serializing them
 * would hide the alternate names behind the slowest thing on screen. The
 * two run concurrently and land independently.
 *
 * `fetchIdentity` never throws and never rejects, so there is no catch
 * here — a miss and an outage both arrive as `null`, which clears the
 * slot and renders as nothing.
 * @param star The star being selected.
 * @param generation The caller's claimed selection generation.
 */
async function resolveIdentityFor(star: Star, generation: number): Promise<void> {
  const { setIdentity, indexIdentity, setIdentityLoading } = useStore.getState()
  try {
    const identity = await fetchIdentity(star.id)
    if (generation !== selectionGeneration) {
      // A newer selection owns the PANEL slot, so this result must not be
      // shown. It is still a legitimate resolution of `star.id` though —
      // and the search index is keyed by id, so recording it cannot
      // mislabel anything. Indexing here keeps the SIMBAD query we
      // already spent (and the alias it bought) instead of discarding it
      // just because the user moved on before it landed.
      if (identity) indexIdentity(star.id, identity)
      return
    }
    setIdentity(star.id, identity)
  } finally {
    if (generation === selectionGeneration) setIdentityLoading(false)
  }
}

/**
 * @description Resolves the star's Gaia DR3 descriptive profile and pushes
 * it into the store, guarded by the same generation counter as the light
 * curve and identity. Runs the full identity chain internally
 * (`fetchGaiaForStar`: star id → SIMBAD → gaiaDr3 → Gaia), so it is a
 * SUPERSET of the SIMBAD round-trip that `resolveIdentityFor` also does —
 * but that SIMBAD leg hits the shared 30-day identity disk cache the other
 * resolver just warmed, so in practice it is one cheap cache hit plus the
 * Gaia query, not two SIMBAD calls.
 *
 * Deliberately NOT awaited inside the light-curve path, same reasoning as
 * `resolveIdentityFor`: Gaia answers in ~1–3 s while a cold MAST fetch can
 * take ~60 s. `fetchGaiaForStar` never throws (a miss, a missing Gaia
 * cross-id, and an outage all arrive as `null`), so there is no catch —
 * `null` clears the slot and the panel's Gaia section renders nothing.
 *
 * Unlike identity there is no session index to preserve on a superseded
 * result: a stale Gaia profile is simply dropped, because nothing else
 * consumes it (no search-by-Gaia feature). Keeps the guard trivial.
 *
 * Defense-in-depth: `fetchGaiaForStar` is documented never-throws, but that
 * contract lives in a NEIGHBORING module (`gaiaClient.ts`) this path does
 * not own. A local try/catch backstops a future regression there (or any
 * unforeseen edge) — a throw is logged and treated identically to a null
 * result (clear the slot), so it can never propagate into the
 * star-selection flow and break the light-curve/identity paths. Same
 * posture the project applies elsewhere: never trust a neighbor's contract
 * to hold forever without a local net.
 * @param star The star being selected.
 * @param generation The caller's claimed selection generation.
 */
async function resolveGaiaFor(star: Star, generation: number): Promise<void> {
  const { setGaia, setGaiaLoading } = useStore.getState()
  try {
    const gaia = await fetchGaiaForStar(star.id)
    if (generation !== selectionGeneration) return
    setGaia(gaia)
  } catch (err) {
    // Should be unreachable (fetchGaiaForStar swallows its own failures),
    // but if that contract ever regresses, degrade to the same benign
    // outcome as a miss: clear the slot, stay silent in the panel.
    console.error(`[selectStar] Gaia resolution threw unexpectedly for ${star.id}:`, err)
    if (generation === selectionGeneration) setGaia(null)
  } finally {
    if (generation === selectionGeneration) setGaiaLoading(false)
  }
}

/**
 * @description Selects a star: switches the UI to analyze mode, fetches its
 * light curve, detects dips, classifies the curve, and pushes everything
 * into the store so the AnomalyPanel can render. Concurrently resolves the
 * star's SIMBAD identity for the panel's "ALSO KNOWN AS" block. Also
 * records the star as visited (persisted) and lazily fills the shared
 * server-side pattern cache when a valid profile is produced.
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
    setIdentity,
    setIdentityLoading,
    setGaia,
    setGaiaLoading,
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
  // Clear the previous star's names immediately so the panel can never
  // pair this star's header with the last star's aliases, then resolve
  // concurrently with the light curve (see resolveIdentityFor).
  setIdentity(star.id, null)
  setIdentityLoading(true)
  void resolveIdentityFor(star, generation)
  // Gaia DR3 descriptive profile — same concurrent, generation-guarded
  // pattern as identity. Cleared synchronously so this star's panel can
  // never show the previous star's Gaia reading.
  setGaia(null)
  setGaiaLoading(true)
  void resolveGaiaFor(star, generation)
  try {
    // Catalog stars (KIC*/TIC*/EPIC*) get the default behavior:
    // synthetic-in-dev fallback if MAST is down. Anything else is
    // treated as on-demand — pass ra/dec so the route can cone-search,
    // AND set onDemand=1 so a MAST miss returns 'unavailable' rather
    // than fake data.
    const isCatalogStar = /^(KIC|TIC|EPIC)\d+$/.test(star.id)
    const { times, flux, source, provenance, mission, gapDays, partial, segments } =
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
    // Classification includes the ~1–2 s BLS search; in the browser it
    // runs in a Web Worker (classifyCurveAsync) so the sky stays
    // responsive. Because it awaits, a NEWER selection can supersede
    // this one mid-classify — re-check the generation afterwards, same
    // rule as the fetch above.
    const profile =
      source === 'unavailable' || times.length === 0
        ? null
        : await classifyCurveAsync(times, flux, dips)
    if (generation !== selectionGeneration) return
    setLightcurve({
      times,
      flux,
      dips: anomalyDips,
      source,
      provenance,
      profile,
      mission: mission ?? null,
      gapDays: gapDays ?? 5,
      partial: partial ?? false,
      segments,
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
