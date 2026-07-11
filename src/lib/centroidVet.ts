/**
 * @description App-side shim for the difference-image centroid engine, which lives in the extracted
 * MIT engine package (`packages/stellar-vetting-engine`). The app imports
 * through this path (`@/lib/centroidVet`) so call sites are stable; the engine
 * package is the single source of truth. See KNOWLEDGE_BASE.md for the
 * dual-license structure (app GPL-3.0-or-later, engine MIT).
 */
export * from '../../packages/stellar-vetting-engine/src/centroidVet'
