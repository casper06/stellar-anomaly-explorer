/**
 * @description Unit tests for the catalog disk-cache helper backing the
 * KOI/TOI freshness policy: fetchedAt is persisted and read back with a
 * computed age, legacy `{rows}`-only files read as a miss (the
 * migration path), malformed/empty/missing files read as a miss, and
 * writes are atomic (no tmp file left behind).
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readCatalogCache, writeCatalogCache } from '../catalogCache.ts'

/**
 * @description Creates a unique temp file path for one test.
 * @param name Distinguishing suffix.
 * @returns Absolute path under a per-run temp directory.
 */
async function tmpFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-cache-test-'))
  return path.join(dir, `${name}.json`)
}

interface Row { id: string }

describe('catalogCache', () => {
  it('round-trips rows with a persisted fetchedAt and computes age', async () => {
    const file = await tmpFile('roundtrip')
    const before = Date.now()
    const fetchedAt = await writeCatalogCache<Row>(file, [{ id: 'a' }, { id: 'b' }], '[test]')
    assert.ok(fetchedAt >= before, 'writeCatalogCache returns the recorded timestamp')
    const entry = await readCatalogCache<Row>(file, '[test]')
    assert.ok(entry, 'entry expected')
    assert.equal(entry.rows.length, 2)
    assert.equal(entry.fetchedAt, JSON.parse(await fs.readFile(file, 'utf8')).fetchedAt)
    assert.ok(entry.ageMs >= 0 && entry.ageMs < 60_000, `age ${entry.ageMs}ms is recent`)
  })

  it('returns the entry regardless of age (freshness is the caller policy)', async () => {
    const file = await tmpFile('old')
    // Hand-write an entry fetched 30 days ago.
    const fetchedAt = Date.now() - 30 * 24 * 3600 * 1000
    await fs.writeFile(file, JSON.stringify({ fetchedAt, rows: [{ id: 'x' }] }), 'utf8')
    const entry = await readCatalogCache<Row>(file, '[test]')
    assert.ok(entry, 'stale entries are still returned')
    assert.ok(entry.ageMs > 29 * 24 * 3600 * 1000, 'age reflects the stored fetchedAt')
  })

  it('treats a legacy {rows}-only file (no fetchedAt) as a miss', async () => {
    const file = await tmpFile('legacy')
    await fs.writeFile(file, JSON.stringify({ rows: [{ id: 'x' }] }), 'utf8')
    assert.equal(await readCatalogCache<Row>(file, '[test]'), null)
  })

  it('treats missing, malformed, and empty-rows files as a miss', async () => {
    const missing = await tmpFile('missing')
    assert.equal(await readCatalogCache<Row>(missing, '[test]'), null)

    const malformed = await tmpFile('malformed')
    await fs.writeFile(malformed, 'not json', 'utf8')
    assert.equal(await readCatalogCache<Row>(malformed, '[test]'), null)

    const empty = await tmpFile('empty')
    await fs.writeFile(empty, JSON.stringify({ fetchedAt: Date.now(), rows: [] }), 'utf8')
    assert.equal(await readCatalogCache<Row>(empty, '[test]'), null)
  })

  it('writes atomically — no tmp file left next to the cache', async () => {
    const file = await tmpFile('atomic')
    await writeCatalogCache<Row>(file, [{ id: 'a' }], '[test]')
    const siblings = await fs.readdir(path.dirname(file))
    assert.deepEqual(siblings, [path.basename(file)], `only the cache file remains (${siblings})`)
  })
})
