/**
 * @description Unit tests for the bounded LRU cache backing the
 * lightcurve route's L1: cap is enforced, eviction follows recency
 * (get refreshes, has does not), and same-key set replaces in place.
 *
 * Run via `npm run test:unit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LruCache } from '../lruCache.ts'

describe('LruCache', () => {
  it('never exceeds the cap and evicts the least-recently-used entry', () => {
    const c = new LruCache<number>(3)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.set('d', 4) // evicts 'a'
    assert.equal(c.size, 3)
    assert.equal(c.get('a'), undefined)
    assert.equal(c.get('b'), 2)
  })

  it('get refreshes recency so the read entry survives the next eviction', () => {
    const c = new LruCache<number>(3)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.get('a') // 'a' is now newest; 'b' is oldest
    c.set('d', 4)
    assert.equal(c.get('b'), undefined)
    assert.equal(c.get('a'), 1)
  })

  it('has does NOT refresh recency', () => {
    const c = new LruCache<number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.has('a') // must not rescue 'a'
    c.set('c', 3)
    assert.equal(c.get('a'), undefined)
    assert.equal(c.get('b'), 2)
  })

  it('setting an existing key replaces the value without evicting others', () => {
    const c = new LruCache<number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 10)
    assert.equal(c.size, 2)
    assert.equal(c.get('a'), 10)
    assert.equal(c.get('b'), 2)
  })

  it('rejects a non-positive cap', () => {
    assert.throws(() => new LruCache<number>(0))
  })
})
