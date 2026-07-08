/**
 * @description Minimal bounded LRU cache, dependency-free. Exists because
 * the lightcurve route's L1 in-process cache was a raw unbounded Map:
 * each entry holds a full-mission curve (~1–2 MB of times/flux arrays),
 * so a batch run pushing thousands of stars through the route grew the
 * heap until Next.js dev hit its memory threshold and auto-restarted —
 * the root cause of the v3 re-batch's two mid-run worker deaths
 * (KNOWLEDGE_BASE, 2026-07-08). A bounded LRU fixes the CLASS of problem
 * regardless of caller: linear scans (batch) simply cycle through the
 * window, while the on-demand path keeps its benefit — a user flipping
 * between recently viewed stars stays inside the window.
 *
 * Implementation rides on Map's insertion-order iteration: a get
 * re-inserts the key (making it newest); eviction removes the first key
 * (oldest). All operations O(1).
 */
export class LruCache<V> {
  private map = new Map<string, V>()
  // Note: NOT a constructor parameter property — Node's strip-only type
  // stripping (the unit-test runtime) rejects that TS-only syntax.
  private readonly maxEntries: number

  /**
   * @description Creates the cache.
   * @param maxEntries Maximum number of entries held; inserting beyond
   * this evicts the least-recently-used entry.
   */
  constructor(maxEntries: number) {
    if (!(maxEntries > 0)) throw new Error(`maxEntries must be positive, got ${maxEntries}`)
    this.maxEntries = maxEntries
  }

  /**
   * @description Returns the cached value and marks it most-recently-used,
   * or undefined when absent.
   * @param key Cache key.
   * @returns The value, or undefined.
   */
  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)!
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  /**
   * @description Whether the key is present. Does NOT touch recency —
   * use `get` when access should count as use.
   * @param key Cache key.
   * @returns True when cached.
   */
  has(key: string): boolean {
    return this.map.has(key)
  }

  /**
   * @description Inserts or replaces a value as most-recently-used,
   * evicting the least-recently-used entry when the cap is exceeded.
   * @param key Cache key.
   * @param value Value to store.
   */
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string
      this.map.delete(oldest)
    }
  }

  /** @description Number of entries currently held. */
  get size(): number {
    return this.map.size
  }
}
