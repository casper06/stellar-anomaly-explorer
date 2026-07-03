'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  fetchHipparcosCatalog,
  fetchKOICatalog,
  fetchTOICatalog,
  mergeKoiIntoHipparcos,
  mergeToiIntoCatalog,
  CatalogStar,
} from '@/lib/starCatalog'
import HUD from '@/components/HUD'
import AnomalyPanel from '@/components/AnomalyPanel'
import { useStore } from '@/lib/store'
import type { CurvePattern } from '@/lib/curveClassifier'

const StarField = dynamic(() => import('@/components/StarField'), { ssr: false })

type LoadState = 'pending' | 'ready' | 'failed'

/**
 * @description Orchestrates the three parallel catalog fetches (Hipparcos
 * stars + KOI Kepler anomalies + TOI TESS anomalies). Each has its own
 * load status so the loading screen can show their independent
 * progress; the sky renders once Hipparcos is ready, and the merged
 * KOI + TOI overlay slots in when both mission catalogs arrive (or
 * either is skipped silently if it failed — Hipparcos alone is still
 * usable).
 *
 * Merge order matters: KOI is applied first, then TOI on top. Stars
 * that appear in both mission catalogs end up tagged as `'TESS'`
 * because the TOI merge runs last (overwrites the source tag). This
 * is a tiny minority of stars (Kepler/TESS overlap is small relative
 * to per-mission catalog size) and is documented in
 * `mergeToiIntoCatalog`.
 */
export default function Home() {
  const [stars, setStars] = useState<CatalogStar[]>([])
  const [hipparcosState, setHipparcosState] = useState<LoadState>('pending')
  const [koiState, setKoiState] = useState<LoadState>('pending')
  const [toiState, setToiState] = useState<LoadState>('pending')
  const setKoiCount = useStore(s => s.setKoiCount)
  const setKoiError = useStore(s => s.setKoiError)
  const setToiCount = useStore(s => s.setToiCount)
  const setToiError = useStore(s => s.setToiError)
  const setAnomalyStars = useStore(s => s.setAnomalyStars)
  const hydratePersistedSets = useStore(s => s.hydratePersistedSets)
  const setClassifiedPatterns = useStore(s => s.setClassifiedPatterns)

  // One-shot rehydration of visited/flagged sets from localStorage.
  // Runs only on the client (useEffect doesn't fire during SSR), so
  // we can safely touch `window` inside `loadIdSet`.
  useEffect(() => {
    hydratePersistedSets()
  }, [hydratePersistedSets])

  // Sky-radar hydration: pull whatever the server-side pattern cache
  // has and stash it in the store so the StarField overlay can tint
  // classified markers on first paint. Best-effort — if the endpoint
  // is down or empty the sky still renders in the un-tinted default
  // color scheme. Runs once at mount; the lazy fill-in path from
  // selectStar keeps the local map current from there.
  useEffect(() => {
    let cancelled = false
    fetch('/api/pattern-cache')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`pattern-cache HTTP ${r.status}`))))
      .then((data: { entries?: Record<string, { pattern: string }> }) => {
        if (cancelled || !data.entries) return
        const map = new Map<string, CurvePattern>()
        for (const [id, entry] of Object.entries(data.entries)) {
          if (entry && typeof entry.pattern === 'string') {
            map.set(id, entry.pattern as CurvePattern)
          }
        }
        setClassifiedPatterns(map)
      })
      .catch(err => { console.warn('[pattern-cache] hydrate failed', err) })
    return () => { cancelled = true }
  }, [setClassifiedPatterns])

  useEffect(() => {
    let cancelled = false
    const hipparcosPromise = fetchHipparcosCatalog()
    const koiPromise = fetchKOICatalog()
    const toiPromise = fetchTOICatalog()

    hipparcosPromise.then(
      catalog => {
        if (cancelled) return
        setStars(catalog)
        setHipparcosState('ready')
      },
      () => { if (!cancelled) setHipparcosState('failed') },
    )

    // We wait for all three before merging so the source-tag ordering is
    // deterministic (KOI merge first, TOI second; a star in both ends
    // up tagged TESS). This delays the moment KOI markers appear, but
    // both catalogs share the same disk-cache TTL so they typically
    // complete within milliseconds of each other after the first cold
    // load.
    Promise.all([hipparcosPromise, koiPromise, toiPromise]).then(
      ([hipparcos, koi, toi]) => {
        if (cancelled) return

        // KOI status reporting + merge
        let working: CatalogStar[] = hipparcos
        let koiCount = 0
        if (koi.source === 'unavailable') {
          setKoiState('failed')
          setKoiError(koi.error ?? 'KOI catalog unavailable')
        } else {
          const koiMerge = mergeKoiIntoHipparcos(hipparcos, koi.rows)
          working = koiMerge.stars
          koiCount = koiMerge.koiCount
          setKoiState('ready')
          setKoiError(null)
        }
        setKoiCount(koiCount)

        // TOI status reporting + merge (on top of whatever KOI produced)
        let toiCount = 0
        if (toi.source === 'unavailable') {
          setToiState('failed')
          setToiError(toi.error ?? 'TOI catalog unavailable')
        } else {
          const toiMerge = mergeToiIntoCatalog(working, toi.rows)
          working = toiMerge.stars
          toiCount = toiMerge.toiCount
          setToiState('ready')
          setToiError(null)
        }
        setToiCount(toiCount)

        setStars(working)

        // Anomaly subset for HUD nav. Pre-sorted desc by score; excludes
        // anomalyScore === 0 (unscored PCs etc) so nav cycling stays
        // meaningful. Combined Kepler + TESS — nav buttons work across
        // both missions.
        const anomaliesSorted = working
          .filter(s => s.hasAnomaly && s.anomalyScore > 0)
          .sort((a, b) => b.anomalyScore - a.anomalyScore)
        setAnomalyStars(anomaliesSorted)
      },
      () => {
        if (cancelled) return
        setKoiState('failed')
        setToiState('failed')
        setKoiCount(0)
        setToiCount(0)
        setKoiError('catalog fetch threw')
        setToiError('catalog fetch threw')
      },
    )

    return () => { cancelled = true }
  }, [setKoiCount, setKoiError, setToiCount, setToiError, setAnomalyStars])

  // Show the loader until Hipparcos is at least resolved. KOI/TOI can
  // continue loading in the background; the sky renders with just
  // Hipparcos stars first, then re-renders when the mission overlays land.
  const showLoader = hipparcosState === 'pending'

  if (showLoader) {
    return (
      <div style={{
        width: '100vw', height: '100vh', background: '#000',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'JetBrains Mono, monospace', gap: 12,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: '50%',
          background: 'radial-gradient(circle at 35% 35%, #4cc9f0, #0a2a4a)',
          boxShadow: '0 0 30px rgba(76,201,240,0.5)',
          marginBottom: 8,
        }} />
        <LoaderLine label="LOADING STAR CATALOG" state={hipparcosState} />
        <LoaderLine label="LOADING KEPLER ANOMALY CATALOG" state={koiState} />
        <LoaderLine label="LOADING TESS ANOMALY CATALOG" state={toiState} />
      </div>
    )
  }

  return (
    <main style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000' }}>
      <StarField stars={stars} />
      <HUD />
      <AnomalyPanel />
    </main>
  )
}

/**
 * @description One line of the multi-stage loader. Renders the label in
 * dimmer text once the load is `ready` or `failed` so the user can see
 * progress without having to read carefully. `failed` gets a small
 * "(unavailable)" tag rather than vanishing entirely — important for
 * mission catalogs since the sky still works without them.
 * @param label All-caps copy describing what's loading.
 * @param state Current state of this load.
 */
function LoaderLine({ label, state }: { label: string; state: LoadState }) {
  const color =
    state === 'ready' ? 'rgba(255,255,255,0.3)'
    : state === 'failed' ? 'rgba(244,162,97,0.7)'
    : 'rgba(255,255,255,0.7)'
  return (
    <div style={{ fontSize: 11, color, letterSpacing: 3, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span>{label}</span>
      {state === 'pending' && <span style={{ opacity: 0.5 }}>…</span>}
      {state === 'ready' && <span style={{ opacity: 0.5 }}>✓</span>}
      {state === 'failed' && <span style={{ opacity: 0.7, fontSize: 9 }}>(unavailable)</span>}
    </div>
  )
}
