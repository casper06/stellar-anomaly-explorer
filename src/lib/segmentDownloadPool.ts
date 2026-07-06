/**
 * @description Bounded-concurrency download pool with per-segment retry for
 * MAST light-curve segments (Kepler quarters / TESS sectors). Extracted
 * from the /api/lightcurve route so it carries NO `next/*` or Node-only
 * imports and can be unit-tested with an injected segment fetcher.
 *
 * Why this exists: the route used to download every segment with an
 * unbounded `Promise.all`, and archive.stsci.edu / the undici connection
 * pool dropped a random subset of the simultaneous connections
 * (`TypeError: fetch failed`, connection-level). Measured: full 17-way
 * parallel recovered 2–5/17; a bounded pool of 3–4 recovered 17/17. This
 * module turns that random truncation into reliable downloads by
 * (a) capping simultaneous downloads and (b) retrying transient failures.
 */

/**
 * @description Classification of a segment-download failure. `transient`
 * (connection drop, timeout, HTTP 5xx / 429) is worth retrying;
 * `permanent` (HTTP 4xx, FITS parse error, too-few rows) will not fix
 * itself and must not be retried.
 */
export type SegmentFailureReason = 'transient' | 'permanent'

/**
 * @description Result of a single segment download+parse. Discriminated so
 * the retry loop can tell a retriable connection drop from a permanent
 * 404 / parse failure.
 */
export type SegmentResult =
  | { ok: true; times: number[]; flux: number[] }
  | { ok: false; reason: SegmentFailureReason; detail: string }

/**
 * @description A parsed segment's parallel time/flux arrays.
 */
export interface ParsedSegment {
  times: number[]
  flux: number[]
}

/**
 * @description Config for the pool. Defaults match the route's tuned
 * constants; tests override them for determinism/speed.
 */
export interface SegmentPoolConfig {
  /** Max simultaneous downloads. */
  concurrency: number
  /** Max attempts per segment (1 = no retry). */
  maxAttempts: number
  /** Base linear backoff between retries (attempt N waits N × this ms). */
  backoffMs: number
  /** Sleep function (injectable so tests don't wait real time). */
  sleep?: (ms: number) => Promise<void>
  /** Optional per-line logger. */
  log?: (line: string) => void
}

/** @description Default real sleep. */
const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * @description Downloads one segment with up to `cfg.maxAttempts` attempts,
 * retrying ONLY on transient failures (connection drop / timeout / 5xx)
 * with a linear backoff. Permanent failures (4xx / parse) return
 * immediately without retry.
 * @param fetchOne Injected function that downloads+parses one segment by
 * index, returning a discriminated `SegmentResult`.
 * @param index Segment index to fetch.
 * @param label Short label for logs (e.g. filename).
 * @param cfg Pool config.
 * @returns The parsed segment, or null after exhausting retries / on a
 * permanent failure.
 */
export async function fetchSegmentWithRetry(
  fetchOne: (index: number) => Promise<SegmentResult>,
  index: number,
  label: string,
  cfg: SegmentPoolConfig,
): Promise<ParsedSegment | null> {
  const sleep = cfg.sleep ?? realSleep
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const res = await fetchOne(index)
    if (res.ok) {
      if (attempt > 1) cfg.log?.(`segment ${label} → recovered on attempt ${attempt}`)
      return { times: res.times, flux: res.flux }
    }
    if (res.reason === 'permanent' || attempt === cfg.maxAttempts) {
      if (res.reason === 'transient') {
        cfg.log?.(`segment ${label} → gave up after ${cfg.maxAttempts} attempts (${res.detail})`)
      }
      return null
    }
    // Transient and attempts remain: linear backoff, then retry.
    await sleep(cfg.backoffMs * attempt)
  }
  return null
}

/**
 * @description Downloads + parses a list of segments through a bounded
 * worker pool (`cfg.concurrency` workers), each segment retried per
 * `fetchSegmentWithRetry`. Replaces an unbounded `Promise.all`, which let
 * archive.stsci.edu drop a random subset of the simultaneous connections.
 * Result order matches the input; a null entry means that segment failed
 * after all retries (or permanently).
 * @param count Number of segments.
 * @param labels Per-segment labels (for logs); indexed 0..count-1.
 * @param fetchOne Injected single-segment fetcher.
 * @param cfg Pool config.
 * @returns Array of parsed segments (nulls for failures), in input order.
 */
export async function downloadSegmentsBounded(
  count: number,
  labels: string[],
  fetchOne: (index: number) => Promise<SegmentResult>,
  cfg: SegmentPoolConfig,
): Promise<Array<ParsedSegment | null>> {
  const results = new Array<ParsedSegment | null>(count).fill(null)
  let next = 0
  let inFlight = 0
  let peakInFlight = 0
  const worker = async () => {
    while (next < count) {
      const i = next++
      inFlight++
      if (inFlight > peakInFlight) peakInFlight = inFlight
      results[i] = await fetchSegmentWithRetry(fetchOne, i, labels[i] ?? String(i), cfg)
      inFlight--
    }
  }
  const poolSize = Math.min(cfg.concurrency, count)
  await Promise.all(Array.from({ length: poolSize }, worker))
  // peakInFlight is exposed via the log for diagnostics; the guarantee is
  // that it never exceeds cfg.concurrency (tests assert this).
  cfg.log?.(`pool peak in-flight = ${peakInFlight} (cap ${cfg.concurrency})`)
  return results
}
