import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CLASSIFIER_VERSION, type CurvePattern } from './curveClassifier'

/**
 * @description One classified star entry in the pattern cache. `pattern` is
 * the label from `classifyCurve`; `computedAt` is when it landed in the
 * cache (ms since epoch); `classifierVersion` records which algorithm
 * version computed it (see CLASSIFIER_VERSION — pre-versioning entries
 * have the field undefined). A star's data is stable so there's no TTL,
 * but the ALGORITHM isn't: the batch classifier treats entries from a
 * different classifier version as missing and re-classifies them.
 */
export interface PatternCacheEntry {
  pattern: CurvePattern
  computedAt: number
  classifierVersion?: number
}

/**
 * @description Whole-cache shape written to disk as JSON. Keyed by the same
 * star id used everywhere else (KIC{N} / TIC{N}). One flat map so a
 * ~9k-star catalog fits in ~500 KB — trivial to read and rewrite on
 * every update.
 */
export interface PatternCache {
  entries: Record<string, PatternCacheEntry>
}

const CACHE_DIR = path.join(os.tmpdir(), 'stellar-cache')
const CACHE_FILE = path.join(CACHE_DIR, 'pattern-cache.json')

/**
 * @description In-memory copy of the cache. Loaded lazily on the first
 * `getCache` call and kept in sync with disk on every `setEntry`.
 * Server-process lifetime; a restart re-reads from disk.
 */
let memoryCache: PatternCache | null = null

/**
 * @description Serializes concurrent writers so two async setEntry calls
 * can't race a load/save pair and lose an entry. Chain-of-promises
 * pattern: each write awaits the previous.
 */
let writeChain: Promise<void> = Promise.resolve()

/**
 * @description Loads the on-disk cache into memory. Returns the cached
 * object directly (not a copy) — callers must not mutate. Idempotent:
 * subsequent calls return the same object. Missing/corrupt cache files
 * are treated as empty rather than throwing, so a fresh install starts
 * with a blank cache instead of crashing.
 * @returns The whole cache object, loaded once per process.
 */
export async function getCache(): Promise<PatternCache> {
  if (memoryCache) return memoryCache
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as PatternCache
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      memoryCache = parsed
      return memoryCache
    }
    console.error(`[patternCache] cache file at ${CACHE_FILE} was malformed; starting fresh`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[patternCache] load error:`, e)
    }
  }
  memoryCache = { entries: {} }
  return memoryCache
}

/**
 * @description Writes the whole in-memory cache back to disk atomically
 * (temp file + rename). Called from `setEntry` after each mutation; the
 * writeChain guarantees serialized execution.
 */
async function persist(): Promise<void> {
  if (!memoryCache) return
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(memoryCache), 'utf8')
    await fs.rename(tmp, CACHE_FILE)
  } catch (e) {
    console.error('[patternCache] persist error:', e)
    try { await fs.unlink(tmp) } catch { /* ignore */ }
  }
}

/**
 * @description Records a star's classification result. Overwrites any
 * prior entry for the same id. Writes are serialized via `writeChain`
 * so concurrent callers can't corrupt the file. When `onlyIfMissing`
 * is true, existing entries are preserved — used by the lazy fill-in
 * path so an organic user click doesn't stomp a batch-computed entry.
 * @param starId Catalog id.
 * @param pattern Pattern label from `classifyCurve`.
 * @param opts `onlyIfMissing`: skip when entry already exists.
 */
export async function setEntry(
  starId: string,
  pattern: CurvePattern,
  opts: { onlyIfMissing?: boolean } = {},
): Promise<void> {
  const cache = await getCache()
  // An entry from an OLDER classifier version never blocks a write —
  // current-version output always wins over stale-algorithm output.
  const existing = cache.entries[starId]
  if (opts.onlyIfMissing && existing && existing.classifierVersion === CLASSIFIER_VERSION) return
  cache.entries[starId] = { pattern, computedAt: Date.now(), classifierVersion: CLASSIFIER_VERSION }
  writeChain = writeChain.then(persist).catch(() => { /* logged in persist */ })
  await writeChain
}

/**
 * @description Returns the set of ids whose cached entry was computed by
 * the CURRENT classifier version. Used by the batch job to skip
 * already-classified stars when resuming — entries from older versions
 * are deliberately excluded so a version bump makes the next batch run
 * re-classify the whole catalog instead of serving mixed-provenance
 * labels.
 * @returns Set of current-version cached star ids.
 */
export async function getCachedIds(): Promise<Set<string>> {
  const cache = await getCache()
  return new Set(
    Object.keys(cache.entries).filter(
      id => cache.entries[id].classifierVersion === CLASSIFIER_VERSION,
    ),
  )
}

/**
 * @description Returns a plain snapshot of the cache suitable for
 * shipping to the client. Freshly-copied so downstream code can freely
 * enumerate without touching the live memory cache.
 * @returns Snapshot of every cached entry.
 */
export async function snapshotCache(): Promise<Record<string, PatternCacheEntry>> {
  const cache = await getCache()
  return { ...cache.entries }
}
