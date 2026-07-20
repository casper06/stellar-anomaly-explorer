/**
 * @description Unit tests for the sky-radar pattern cache
 * (`lib/patternCache.ts`): round-trip, the CLASSIFIER_VERSION staleness
 * rule, and malformed-file tolerance.
 *
 * Two things make this module awkward to test, and both are handled
 * WITHOUT changing production code:
 *
 *  1. It memoizes the parsed file in a module-level `memoryCache`, so
 *     the disk-read paths only execute on a module's FIRST call. Each
 *     scenario therefore imports the module through a cache-busting
 *     specifier (`../patternCache.ts?case=N`), which gives it a fresh
 *     module instance — a test-only technique that needs no reset hook
 *     in the module itself.
 *  2. It writes one fixed file under the OS temp dir, shared with
 *     anything else on the machine that has run the app (a dev server
 *     writes it on every organic classification). The suite backs the
 *     file up and restores it, so a developer's real radar cache
 *     survives a test run.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CLASSIFIER_VERSION, type CurvePattern } from '../curveClassifier.ts'

const CACHE_FILE = path.join(os.tmpdir(), 'stellar-cache', 'pattern-cache.json')

/** @description Backed-up contents of a pre-existing cache file, if any. */
let saved: string | null = null

/** @description Silences expected "malformed file" logging. */
const realConsoleError = console.error

/**
 * @description Imports a FRESH instance of the pattern-cache module,
 * bypassing the ESM module cache (and therefore its memoized state).
 * @param key Unique per scenario.
 * @returns The module namespace.
 */
async function freshModule(key: string): Promise<typeof import('../patternCache.ts')> {
  return (await import(`../patternCache.ts?case=${key}`)) as typeof import('../patternCache.ts')
}

/**
 * @description Writes a raw cache-file body (may be deliberately invalid).
 * @param body Exact file contents.
 */
async function writeRaw(body: string): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true })
  await fs.writeFile(CACHE_FILE, body, 'utf8')
}

/** @description A `CurvePattern` value used across the round-trip tests. */
const PATTERN: CurvePattern = 'IRREGULAR'

before(async () => {
  try { saved = await fs.readFile(CACHE_FILE, 'utf8') } catch { saved = null }
  console.error = () => {}
})
after(async () => {
  console.error = realConsoleError
  if (saved === null) await fs.rm(CACHE_FILE, { force: true })
  else await writeRaw(saved)
})
beforeEach(async () => {
  await fs.rm(CACHE_FILE, { force: true })
})

describe('patternCache — round-trip', () => {
  it('writes an entry and reads it back with the current classifier version', async () => {
    const m = await freshModule('roundtrip')
    await m.setEntry('KIC8462852', PATTERN)

    const snap = await m.snapshotCache()
    assert.equal(snap['KIC8462852'].pattern, PATTERN)
    assert.equal(snap['KIC8462852'].classifierVersion, CLASSIFIER_VERSION)
    assert.ok(snap['KIC8462852'].computedAt > 0, 'stamps a write time')

    // …and it actually reached disk, not just memory.
    const onDisk = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))
    assert.equal(onDisk.entries['KIC8462852'].pattern, PATTERN)
  })

  it('snapshotCache returns a COPY, so callers cannot corrupt live state', async () => {
    const m = await freshModule('snapshot-copy')
    await m.setEntry('KIC1', PATTERN)
    const snap = await m.snapshotCache()
    delete snap['KIC1']
    assert.ok((await m.snapshotCache())['KIC1'], 'live cache is unaffected')
  })

  it('serializes concurrent writes once the cache is warm', async () => {
    // The writeChain exists precisely so parallel setEntry calls (batch
    // job + an organic click) cannot clobber each other's file writes.
    // `getCache()` first, mirroring production: the batch job awaits
    // getCachedIds() before its concurrent chunks (see the cold-start
    // caveat pinned below).
    const m = await freshModule('concurrent-warm')
    await m.getCache()
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => m.setEntry(`KIC${i}`, PATTERN)),
    )
    const onDisk = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))
    assert.equal(Object.keys(onDisk.entries).length, 12, 'every write survived')
  })

  it('survives concurrent writes on a COLD cache too (no warm-up required)', async () => {
    // Regression guard for a cold-start race fixed 2026-07-20. Note this
    // case takes NO `await m.getCache()` warm-up — that is the point.
    //
    // Mechanism of the old bug: `getCache()` memoized the resolved value
    // into a module-level variable, not the in-flight promise. N callers
    // racing a cold cache each observed `memoryCache === null`, each
    // built their own `{ entries: {} }`, and the last assignment won — so
    // N-1 mutations were silently dropped before `persist()` (correctly
    // serialized by writeChain) ever ran. The writeChain was never at
    // fault; the un-deduped cache LOAD was. 12 concurrent writes yielded
    // 1 entry.
    //
    // Why it was never reachable in production: the only concurrent
    // writer is `batchClassifier`, and it awaits `getCachedIds()` — which
    // warms the same memoized cache — before its first `Promise.all`
    // chunk. The organic fill-in path writes one star per user click. The
    // window existed but nothing entered it; this test now holds the
    // cold path to the same guarantee as the warm and sequential ones.
    const m = await freshModule('concurrent-cold')
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => m.setEntry(`KIC${i}`, PATTERN)),
    )
    const onDisk = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))
    assert.equal(
      Object.keys(onDisk.entries).length,
      12,
      'every write survived a cold-start race',
    )
  })

  it('a later write replaces an earlier entry for the same star', async () => {
    const m = await freshModule('replace')
    await m.setEntry('KIC1', 'IRREGULAR')
    await m.setEntry('KIC1', 'PERIODIC_UNIFORM')
    assert.equal((await m.snapshotCache())['KIC1'].pattern, 'PERIODIC_UNIFORM')
  })
})

describe('patternCache — onlyIfMissing (the batch-vs-organic race rule)', () => {
  it('does NOT overwrite a current-version entry', async () => {
    const m = await freshModule('skip-current')
    await m.setEntry('KIC1', 'IRREGULAR')
    await m.setEntry('KIC1', 'PERIODIC_UNIFORM', { onlyIfMissing: true })
    assert.equal((await m.snapshotCache())['KIC1'].pattern, 'IRREGULAR', 'existing entry wins')
  })

  it('DOES overwrite an entry written by an OLDER classifier version', async () => {
    // Version bump semantics: stale-version entries are replaceable, so
    // a re-batch upgrades them instead of being skipped forever.
    await writeRaw(JSON.stringify({
      entries: { KIC1: { pattern: 'IRREGULAR', computedAt: 1, classifierVersion: CLASSIFIER_VERSION - 1 } },
    }))
    const m = await freshModule('overwrite-old')
    await m.setEntry('KIC1', 'PERIODIC_UNIFORM', { onlyIfMissing: true })
    const e = (await m.snapshotCache())['KIC1']
    assert.equal(e.pattern, 'PERIODIC_UNIFORM', 'old-version entry was replaced')
    assert.equal(e.classifierVersion, CLASSIFIER_VERSION)
  })

  it('writes when the star is absent entirely', async () => {
    const m = await freshModule('write-missing')
    await m.setEntry('KIC-new', PATTERN, { onlyIfMissing: true })
    assert.equal((await m.snapshotCache())['KIC-new'].pattern, PATTERN)
  })
})

describe('patternCache — CLASSIFIER_VERSION staleness', () => {
  it('getCachedIds EXCLUDES entries from an older classifier version', async () => {
    // This is the batch job's resume skip-list: excluding stale entries
    // is what makes a version bump re-classify the catalog rather than
    // serve mixed-provenance labels.
    await writeRaw(JSON.stringify({
      entries: {
        current: { pattern: 'IRREGULAR', computedAt: 1, classifierVersion: CLASSIFIER_VERSION },
        older: { pattern: 'IRREGULAR', computedAt: 1, classifierVersion: CLASSIFIER_VERSION - 1 },
        ancient: { pattern: 'IRREGULAR', computedAt: 1, classifierVersion: 1 },
      },
    }))
    const ids = await (await freshModule('stale-ids')).getCachedIds()
    assert.ok(ids.has('current'))
    assert.ok(!ids.has('older'), 'previous version is stale')
    assert.ok(!ids.has('ancient'), 'much older version is stale')
    assert.equal(ids.size, 1)
  })

  it('treats a pre-versioning entry (no classifierVersion field) as stale', async () => {
    await writeRaw(JSON.stringify({
      entries: { legacy: { pattern: 'IRREGULAR', computedAt: 1 } },
    }))
    const ids = await (await freshModule('stale-legacy')).getCachedIds()
    assert.equal(ids.size, 0, 'unversioned entries never count as current')
  })

  it('still SERVES stale entries through snapshotCache (the radar keeps rendering)', async () => {
    // Deliberate asymmetry: getCachedIds gates the BATCH, snapshotCache
    // feeds the RADAR. A stale label is better than a blank sky until
    // the re-batch replaces it.
    await writeRaw(JSON.stringify({
      entries: { older: { pattern: 'IRREGULAR', computedAt: 1, classifierVersion: CLASSIFIER_VERSION - 1 } },
    }))
    const m = await freshModule('serve-stale')
    assert.equal((await m.snapshotCache())['older'].pattern, 'IRREGULAR')
    assert.equal((await m.getCachedIds()).size, 0, 'but it is not counted as done')
  })
})

describe('patternCache — corrupt or missing files fall back to a cache miss', () => {
  it('starts empty when no cache file exists', async () => {
    const m = await freshModule('missing-file')
    assert.deepEqual(await m.snapshotCache(), {})
    assert.equal((await m.getCachedIds()).size, 0)
  })

  it('does not throw on invalid JSON — treats it as empty', async () => {
    await writeRaw('{ this is not json')
    const m = await freshModule('bad-json')
    assert.deepEqual(await m.snapshotCache(), {}, 'falls back to a blank cache')
  })

  it('does not throw on well-formed JSON with the wrong SHAPE', async () => {
    for (const [i, body] of ['[]', '"a string"', 'null', '{"noEntriesKey":1}', '{"entries":42}'].entries()) {
      await writeRaw(body)
      const m = await freshModule(`bad-shape-${i}`)
      assert.deepEqual(await m.snapshotCache(), {}, `shape ${body} treated as empty`)
    }
  })

  it('recovers by writing a fresh cache after a corrupt read', async () => {
    await writeRaw('garbage')
    const m = await freshModule('recover')
    await m.setEntry('KIC1', PATTERN)
    const onDisk = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))
    assert.equal(onDisk.entries['KIC1'].pattern, PATTERN, 'corrupt file replaced with a valid one')
  })
})
