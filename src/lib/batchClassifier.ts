import { detectDips } from './anomalyDetector'
import { classifyCurve } from './curveClassifier'
import { setEntry, getCachedIds } from './patternCache'

/**
 * @description Number of concurrent lightcurve fetches. MAST tolerates
 * modest parallelism; we cap at 5 to stay well under rate-limit
 * thresholds while making meaningful progress. Higher values may work
 * but risk 429s during long runs.
 */
const MAX_CONCURRENCY = 5

/**
 * @description Millisecond pause between batches of `MAX_CONCURRENCY`
 * fetches. Adds a small cushion so bursts don't stack up server-side.
 */
const BATCH_DELAY_MS = 250

/**
 * @description Live progress state exposed via the status endpoint.
 * All fields are populated even before the batch starts (0/0) so the
 * client always has a well-formed object to consume.
 */
export interface BatchStatus {
  running: boolean
  processed: number
  total: number
  currentStar: string | null
  startedAt: number | null
  lastUpdatedAt: number | null
  lastError: string | null
  // Rolling counts across the current run. Useful when eyeballing how
  // many stars actually landed patterns vs how many were skipped.
  succeeded: number
  skippedNoData: number
  errored: number
}

/**
 * @description Star spec accepted by the batch. Just id + optional
 * position — the batch calls the /api/lightcurve route by URL, so we
 * only need what the route consumes as query params.
 */
export interface BatchStarSpec {
  id: string
  ra?: number
  dec?: number
}

/**
 * @description Shared runtime state for the batch. Module-scope so all
 * three route handlers (start / stop / status) see the same values.
 * The batch runs as a detached async task inside the Next.js server
 * process; killing the process ends it.
 */
const state: BatchStatus = {
  running: false,
  processed: 0,
  total: 0,
  currentStar: null,
  startedAt: null,
  lastUpdatedAt: null,
  lastError: null,
  succeeded: 0,
  skippedNoData: 0,
  errored: 0,
}

/**
 * @description Cancellation flag. Set true by `stopBatch`; the worker
 * loop checks it between stars and exits cleanly. The current
 * in-flight fetch is allowed to complete so we don't leave a half-
 * parsed response in the L1 cache.
 */
let cancelRequested = false

/**
 * @description Returns a snapshot of the current batch status. Read by
 * GET /api/batch-classify/status. Snapshot is a shallow copy so the
 * caller can't mutate the shared state via the returned object.
 */
export function getBatchStatus(): BatchStatus {
  return { ...state }
}

/**
 * @description Signals the batch worker to stop after the current star.
 * No-op when nothing is running.
 */
export function stopBatch(): void {
  if (!state.running) return
  cancelRequested = true
}

/**
 * @description Fetches ONE star's light curve from the local
 * /api/lightcurve route, runs detectDips + classifyCurve on it, and
 * writes the resulting pattern to the pattern cache. Skips silently
 * when the route returned `source: 'unavailable'` (star wasn't
 * observed or MAST is currently down). Errors are caught and reported
 * to the caller via return value; the batch loop uses that to update
 * counters without unwinding.
 *
 * Reuses the existing route so both organic clicks and batch
 * processing go through the same MAST + disk-cache pipeline — the
 * batch is essentially a bulk pre-warm of that cache.
 * @param spec Star id + optional position.
 * @param baseUrl Base URL of the running server, e.g. "http://localhost:3000".
 * @returns 'ok', 'no-data', or an error string.
 */
async function classifyOne(
  spec: BatchStarSpec,
  baseUrl: string,
): Promise<'ok' | 'no-data' | string> {
  const params = new URLSearchParams()
  if (spec.ra !== undefined) params.set('ra', String(spec.ra))
  if (spec.dec !== undefined) params.set('dec', String(spec.dec))
  const qs = params.toString()
  const url = `${baseUrl}/api/lightcurve/${encodeURIComponent(spec.id)}${qs ? `?${qs}` : ''}`
  try {
    const res = await fetch(url)
    if (!res.ok) return `HTTP ${res.status}`
    const data = (await res.json()) as {
      times: number[]
      flux: number[]
      source: 'real' | 'unavailable' | 'synthetic'
    }
    if (data.source === 'unavailable' || !data.times || data.times.length === 0) return 'no-data'
    const dips = detectDips(data.flux, data.times)
    const profile = classifyCurve(data.times, data.flux, dips)
    await setEntry(spec.id, profile.pattern)
    return 'ok'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * @description Starts a batch classification pass over `stars`. No-op
 * (and returns false) when a batch is already in flight — the endpoint
 * treats repeated POSTs as idempotent so accidental double-triggers
 * don't spawn two workers.
 *
 * The batch is RESUMABLE: at start time we load the current cache and
 * skip any star already present. Restarting after an interruption
 * therefore picks up where the last run left off. Progress state is
 * initialized from the FULL input length so the client sees
 * "processed/total" reflecting the whole catalog, not just what's left.
 *
 * Runs as a detached promise (`void` return in the caller). The
 * caller kicks it off and immediately returns HTTP 202-ish to the
 * user; polling `/api/batch-classify/status` reports progress.
 * @param stars Full list of catalog stars to classify.
 * @param baseUrl Server base URL used to reach /api/lightcurve.
 * @returns true if the batch was started, false if one is already running.
 */
export async function startBatch(
  stars: BatchStarSpec[],
  baseUrl: string,
): Promise<boolean> {
  if (state.running) return false

  const alreadyCached = await getCachedIds()
  const pending = stars.filter(s => !alreadyCached.has(s.id))

  state.running = true
  state.processed = stars.length - pending.length
  state.total = stars.length
  state.currentStar = null
  state.startedAt = Date.now()
  state.lastUpdatedAt = Date.now()
  state.lastError = null
  state.succeeded = 0
  state.skippedNoData = 0
  state.errored = 0
  cancelRequested = false

  // Detached worker — never awaited by the caller. Errors that escape
  // the inner classifyOne guard get caught here and logged.
  void (async () => {
    try {
      for (let i = 0; i < pending.length; i += MAX_CONCURRENCY) {
        if (cancelRequested) break
        const chunk = pending.slice(i, i + MAX_CONCURRENCY)
        // For the currentStar display, pick the first id in the chunk;
        // it's the one most likely to be actively fetching first.
        state.currentStar = chunk[0].id
        state.lastUpdatedAt = Date.now()
        const results = await Promise.all(chunk.map(s => classifyOne(s, baseUrl)))
        for (const r of results) {
          state.processed++
          if (r === 'ok') state.succeeded++
          else if (r === 'no-data') state.skippedNoData++
          else {
            state.errored++
            state.lastError = r
          }
        }
        state.lastUpdatedAt = Date.now()
        // Small pause between batches so we don't burst-fire MAST.
        if (i + MAX_CONCURRENCY < pending.length && !cancelRequested) {
          await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
        }
      }
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e)
    } finally {
      state.running = false
      state.currentStar = null
      state.lastUpdatedAt = Date.now()
      cancelRequested = false
    }
  })()

  return true
}
