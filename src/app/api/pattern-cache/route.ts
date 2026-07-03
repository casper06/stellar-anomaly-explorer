import { NextResponse } from 'next/server'
import { setEntry, snapshotCache } from '@/lib/patternCache'
import type { CurvePattern } from '@/lib/curveClassifier'

/**
 * @description GET /api/pattern-cache — returns the whole pattern cache as
 * a flat map { starId: { pattern, computedAt } }. Read at page load by
 * the client so the sky-radar overlay can tint markers immediately for
 * every star we've already classified. Cache size at full population
 * (~9k stars) is a few hundred KB — trivial payload, no need to
 * paginate or partial-serve.
 * @returns JSON `{ entries: Record<starId, { pattern, computedAt }> }`.
 */
export async function GET() {
  const entries = await snapshotCache()
  return NextResponse.json({ entries })
}

/**
 * @description Union of all valid `CurvePattern` values for runtime
 * validation of client-supplied bodies (client code trusts the type
 * checker, but the API boundary can't).
 */
const VALID_PATTERNS: ReadonlySet<CurvePattern> = new Set<CurvePattern>([
  'PERIODIC_UNIFORM',
  'IRREGULAR',
  'HIGH_VARIABILITY',
  'SPARSE',
  'UNCERTAIN',
])

/**
 * @description POST /api/pattern-cache — the lazy fill-in write path.
 * Body: `{ starId, pattern }`. Called from the client after a user
 * opens a light curve and `classifyCurve` produces a profile — the
 * client sends the resulting pattern here so the shared cache absorbs
 * it. `onlyIfMissing: true` because an in-progress batch job could
 * have written a fresher entry between the user's fetch and this POST
 * (unlikely but harmless to guard).
 * @param req JSON `{ starId, pattern }`.
 * @returns JSON `{ ok }` on success, 400 on malformed input.
 */
export async function POST(req: Request) {
  let body: { starId?: unknown; pattern?: unknown } = {}
  try { body = await req.json() } catch { /* handled below */ }
  const starId = typeof body.starId === 'string' ? body.starId : ''
  const pattern = typeof body.pattern === 'string' ? (body.pattern as CurvePattern) : null
  if (!starId || !pattern || !VALID_PATTERNS.has(pattern)) {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 })
  }
  await setEntry(starId, pattern, { onlyIfMissing: true })
  return NextResponse.json({ ok: true })
}
