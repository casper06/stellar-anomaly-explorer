# Design: MAST segment-download concurrency fix (NOT YET IMPLEMENTED)

**Status:** proposed, awaiting review. Do not implement until reviewed —
this touches the core fetch path that both classification and rendering
depend on.

**Problem (confirmed in the 2026-07-05 investigation):**
`tryFetchRealLightcurve` in
[`src/app/api/lightcurve/[id]/route.ts`](../src/app/api/lightcurve/[id]/route.ts)
downloads every quarter/sector FITS with **unbounded** `Promise.all`
(line ~404: `Promise.all(lcUrls.map(fetchAndParseSegment))`).
`archive.stsci.edu` / the undici connection pool drops a **random
subset** of simultaneous connections (`TypeError: fetch failed`,
connection-level, no HTTP status). The route silently drops failed
segments and only bails if **all** fail, so it caches a **random partial
curve** as if it were complete. Measured on kplr009166862 (17 quarters
available at MAST):

| Download strategy        | Recovered |
|--------------------------|-----------|
| Sequential               | 17/17 (every trial) |
| Bounded pool, conc. 3    | 17/17 (this design) |
| Bounded pool, conc. 4    | 17/17 (this design) |
| Full parallel (17)       | 2–5/17 (random) |

This is what caused K00931.01 to show SPARSE (1 dip from 2 recovered
quarters) instead of PERIODIC_UNIFORM. Widespread: sampled
PERIODIC_UNIFORM stars have cached segment counts from 2 to 18.

---

## Design

Three coordinated changes, all inside the lightcurve route's fetch path.

### 1. Bounded-concurrency download pool with per-segment retry

Replace the single `Promise.all` over all segments with a small worker
pool. Each worker pulls the next segment index, downloads+parses it, and
on failure **retries that individual segment** (not "bail if all fail").

- **Pool size `SEGMENT_DOWNLOAD_CONCURRENCY = 4`.** Empirically 3 and 4
  both recovered 17/17; 4 is faster (see timing below) while still well
  below the burst that triggers drops. Keep it a named constant so it's
  tunable in one place.
- **Per-segment retry `SEGMENT_MAX_ATTEMPTS = 3`** with a short backoff
  (`SEGMENT_RETRY_BACKOFF_MS = 300`, optionally linear: 300ms, 600ms).
  Retry ONLY on the connection-level failure class (`TypeError: fetch
  failed`, `AbortError`/timeout) and transient HTTP (429, 500, 502, 503,
  504). Do NOT retry a clean 404 or a FITS-parse error — those won't fix
  themselves and would just waste time.
- Keep the existing per-segment logging (filename + reason) so a
  genuinely dead segment after all retries is still named in the log.

Sketch (pseudocode — real impl lives in `tryFetchRealLightcurve`):

```ts
async function downloadSegmentsBounded(
  lcUrls: string[], lcFilenames: string[], tag: string,
): Promise<{ ok: OkSegment[]; failed: string[] }> {
  const results = new Array(lcUrls.length).fill(null)
  let next = 0
  async function worker() {
    while (next < lcUrls.length) {
      const i = next++
      for (let attempt = 1; attempt <= SEGMENT_MAX_ATTEMPTS; attempt++) {
        const seg = await fetchAndParseSegment(lcUrls[i]) // returns null on fail
        if (seg) { results[i] = { ...seg, file: lcFilenames[i] }; break }
        if (attempt < SEGMENT_MAX_ATTEMPTS &&
            isRetriable(lastError))            // connection / 5xx / timeout
          await sleep(SEGMENT_RETRY_BACKOFF_MS * attempt)
        else break
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SEGMENT_DOWNLOAD_CONCURRENCY, lcUrls.length) }, worker),
  )
  const ok = results.filter(Boolean)
  const failed = lcFilenames.filter((_, i) => !results[i])
  return { ok, failed }
}
```

`fetchAndParseSegment` needs a small change to communicate WHY it failed
(so `isRetriable` can decide) — either return a discriminated result
`{ ok: true, ... } | { ok: false, reason: 'conn' | 'http4xx' | 'http5xx' | 'parse' | 'timeout' }`
instead of `null`, or set a side-channel. The discriminated-result form
is cleaner and keeps the retry logic honest.

### 2. Quarter-count sanity check against MAST's own listing

The authoritative baseline is **already in hand**: the TAP query returns
the full list of available PDC segments (`lcUrls.length`) BEFORE any
download. We don't need external KOI/TOI metadata (which doesn't carry
quarter counts anyway) — TAP's own listing is the ground truth for "how
many segments exist for this target right now."

After the bounded download completes, compare:

```ts
const expected = lcUrls.length            // MAST says this many PDC segments exist
const recovered = ok.length               // we successfully parsed this many
const complete = recovered === expected
const coverage = recovered / expected     // e.g. 0.71
```

Decision policy (proposed — the exact threshold is a review question):

- `recovered === 0` → return `null` (unchanged; falls through to
  unavailable/synthetic as today).
- `recovered < expected` but `recovered >= MIN_SEGMENTS_TO_SERVE` (e.g.
  a small floor, or a `coverage >= 0.5` fraction) → **serve it, tagged
  partial** (see §3). Better a labeled partial curve than nothing, and
  the retry pool makes this rare.
- `recovered === expected` → serve as fully complete (today's happy path).

Carry `expected` and `recovered` out of `tryFetchRealLightcurve`
(extend its return type from `{ times, flux, segmentFiles }` to also
include `expectedSegments: number`). This is the single most important
data-integrity signal and it costs nothing — we already have both
numbers.

**Cache interaction (important):** the disk cache must record whether
the entry is complete, so a *partial* cache entry is never treated as
authoritative and is re-attempted later. Add `expectedSegments` (and
implicitly `segmentFiles.length` = recovered) to the `DiskCacheEntry`,
and on read, **treat a partial entry as re-fetchable**: if
`segmentFiles.length < expectedSegments`, either ignore it (refetch) or
serve it but keep trying to complete it on subsequent requests. This
prevents the current failure mode where a bad partial gets frozen into
L1+L2 for the full TTL. This also means **bumping
`CACHE_SCHEMA_VERSION`** (currently 1 → 2) so existing possibly-partial
entries written by the old pipeline are invalidated and refetched with
the new bounded/retry logic — which directly re-heals the ~9k batch
cache's truncated entries on next access.

### 3. Surface "partial data" to the user (loud, not silent)

This is the data-integrity principle we've held throughout: **loud
failures over silent partial results.** When `recovered < expected`, the
response must say so, all the way to the UI.

Response shape change (`realResponse`): add a coverage block:

```ts
{
  times, flux,
  source: 'real',            // still real — it IS real data, just incomplete
  partial: recovered < expected,
  segments: { recovered, expected },   // e.g. { recovered: 12, expected: 17 }
  provenance, mission, gapDays,
}
```

Then thread it through:
- **`LightcurveData`** (store) gains `partial?: boolean` and
  `segments?: { recovered: number; expected: number }`.
- **`fetchLightcurve`** (client, `anomalyDetector.ts`) passes them
  through.
- **AnomalyPanel** shows a badge next to the existing REAL DATA badge —
  e.g. `PARTIAL 12/17 QUARTERS` in a warning color — and a one-line
  note ("MAST served 12 of 17 available quarters; the curve and any
  classification below may be incomplete"). This is consistent with the
  existing DataSourceBadge states (REAL DATA / DATA UNAVAILABLE /
  DEV/SYNTHETIC / LOADING) — `PARTIAL` is a fifth state.
- **ClassifierReadout** (fullscreen overlay) shows the same partial
  flag, so a SPARSE label on a partial curve reads as "SPARSE (from
  12/17 quarters)" rather than a confident verdict — directly addressing
  the K00931.01 confusion where a truncated fetch produced a misleading
  label with no signal that data was missing.

---

## Where it plugs in

| Location | Change |
|---|---|
| `tryFetchRealLightcurve` (route) | Replace `Promise.all` with `downloadSegmentsBounded`; return `expectedSegments` alongside times/flux/segmentFiles |
| `fetchAndParseSegment` (route) | Return a discriminated `{ ok, reason }` result so retry can classify the failure |
| `DiskCacheEntry` + `readDiskCache`/`writeDiskCache` (route) | Store `expectedSegments`; treat `segmentFiles.length < expectedSegments` as re-fetchable; bump `CACHE_SCHEMA_VERSION` 1→2 |
| `realResponse` (route) | Emit `partial` + `segments: { recovered, expected }` |
| `LightcurveData` (store) | Add `partial?`, `segments?` |
| `fetchLightcurve` (anomalyDetector) | Pass the new fields through |
| `AnomalyPanel` / `DataSourceBadge` | New `PARTIAL N/M` badge + note |
| `ClassifierReadout` | Show partial flag next to the pattern label |

### Batch path (`classifyOne`)

`classifyOne` in `batchClassifier.ts` calls the **same route**, so it
inherits the bounded-pool + retry fix automatically — no separate change.
Two small improvements worth making at the same time:
- `classifyOne` currently writes a pattern-cache entry for any
  `source: 'real'` result. With partial detection, it should **skip
  writing a pattern for a `partial` result** (or write it but flag it),
  so the sky radar isn't populated from truncated curves. Simplest:
  treat `partial === true` like `no-data` for pattern-cache purposes and
  let the next batch retry it once the segment download is more likely to
  complete. This re-heals the existing truncated batch entries.
- Because the batch runs `MAX_CONCURRENCY = 5` stars in parallel and
  each star now opens up to 4 connections, peak connections could reach
  ~20. Recommend dropping the batch's per-star download concurrency
  (pass a lower pool size on the batch path) OR lowering
  `MAX_CONCURRENCY` to 3 so total concurrent connections to
  archive.stsci.edu stay in the safe zone. This is a tuning decision to
  confirm in review.

---

## Expected impact on fetch time

Measured empirically on kplr009166862 (17 quarters), warm network:

| Strategy | Time | Segments |
|---|---|---|
| Bounded pool, concurrency 3, ≤3 attempts | **2.9s** | 17/17 |
| Bounded pool, concurrency 4, ≤3 attempts | **1.9s** | 17/17 |
| (old) full parallel | ~1–3s but **2–5/17** | broken |

Key finding: **at concurrency 3–4 the drops disappear, so retries almost
never fire** — the 17/17 runs above used exactly 17 download attempts
(zero retries). So in the common case the latency is essentially the same
as today (a few seconds cold), just *correct*. Retry latency only
materializes when a segment genuinely fails: each retry adds one download
round-trip (~0.1–0.5s for a Kepler `_llc.fits` of ~75–300 KB) plus the
300ms backoff. Worst realistic case (a couple of segments each needing
2 retries) adds ~1–2s. The disk cache means this cold cost is paid once
per star.

TESS continuous-viewing-zone stars (50+ sectors) benefit most: today a
50-way parallel burst is where drops are worst; a 4-wide pool turns that
into ~13 sequential rounds of 4, reliably.

---

## Effort estimate

**~0.5–1 day**, broken down:

- Bounded pool + retry + discriminated failure result in
  `fetchAndParseSegment`/`tryFetchRealLightcurve`: **~2–3h** (the core;
  the pseudocode above is close to final).
- Cache schema bump + partial-aware read/write: **~1h**.
- Response shape + client threading (`LightcurveData`, `fetchLightcurve`):
  **~1h**.
- UI `PARTIAL N/M` badge + ClassifierReadout flag: **~1–2h**.
- Batch `classifyOne` partial-skip + concurrency retune: **~1h**.
- Tests: extend `selectStar.unit.test.ts`-style coverage with a stubbed
  fetch that fails K of N segments and asserts (a) retry recovers them,
  (b) a genuinely-partial result is flagged `partial` and not cached as
  complete, (c) the pattern cache isn't written for a partial. A
  deterministic offline test — no live MAST. **~2h**.

**Risk:** low-to-moderate. It's the core fetch path, but the change is
localized to `tryFetchRealLightcurve` + the response/type plumbing, the
happy path is unchanged in behavior (just reliable), and the empirical
evidence for concurrency 3–4 is strong. The main review decisions are
the two thresholds (`MIN_SEGMENTS_TO_SERVE` / coverage floor, and pool
size) and whether to serve-partial-with-badge vs. refetch-until-complete.

---

## Open review questions

1. **Serve partial (badged) or refuse until complete?** Serving a
   badged partial is more available and honest; refusing is stricter.
   Recommendation: serve badged partial above a coverage floor (e.g.
   ≥50%), refetch on next request to try to complete, never freeze a
   partial as authoritative.
2. **Pool size and batch total-concurrency.** 4 per star is good in
   isolation; confirm the batch's `MAX_CONCURRENCY × pool` product stays
   safe (recommend batch uses a smaller per-star pool or `MAX_CONCURRENCY
   = 3`).
3. **Backoff shape.** Fixed 300ms vs. linear vs. exponential. Given
   retries rarely fire at conc. 3–4, fixed/linear is fine.
