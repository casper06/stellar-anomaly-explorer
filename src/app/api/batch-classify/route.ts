import { NextResponse } from 'next/server'
import { startBatch, stopBatch, getBatchStatus, type BatchStarSpec } from '@/lib/batchClassifier'

/**
 * @description POST /api/batch-classify — starts a batch classification
 * pass over a list of star ids. Request body is JSON `{ stars: [{ id,
 * ra?, dec? }, ...] }` OR omitted — when omitted, the route reads the
 * KOI + TOI catalogs itself (via the local /api/koi and /api/toi
 * routes) and uses their union as the input.
 *
 * Idempotent: a POST while a batch is already running returns HTTP 200
 * with `{ started: false, alreadyRunning: true }` so a repeated curl
 * doesn't spawn a second worker. Otherwise returns `{ started: true,
 * total: N }` and the batch proceeds in the background — poll
 * `/api/batch-classify/status` for progress.
 *
 * The status route also handles `?action=stop` (documented in
 * CLAUDE.md) as an alternative to a dedicated stop endpoint.
 * @param req Request; JSON body optional.
 * @returns JSON summary of the start attempt.
 */
export async function POST(req: Request) {
  const url = new URL(req.url)
  if (url.searchParams.get('action') === 'stop') {
    stopBatch()
    return NextResponse.json({ stopping: true, status: getBatchStatus() })
  }

  let stars: BatchStarSpec[] = []
  try {
    const body = await req.json().catch(() => null) as { stars?: BatchStarSpec[] } | null
    if (body && Array.isArray(body.stars)) {
      stars = body.stars.filter(s => s && typeof s.id === 'string')
    }
  } catch { /* empty body — fall through to catalog fetch */ }

  if (stars.length === 0) {
    // No explicit list supplied — pull the KOI + TOI catalogs from our
    // own routes. Origin comes from the incoming request so this works
    // in both dev (localhost:3000) and any deployed host.
    const base = url.origin
    try {
      const [koiRes, toiRes] = await Promise.all([
        fetch(`${base}/api/koi`),
        fetch(`${base}/api/toi`),
      ])
      if (koiRes.ok) {
        const koi = await koiRes.json() as { rows?: Array<{ id: string; ra: number; dec: number }> }
        for (const r of koi.rows ?? []) {
          if (r && r.id) stars.push({ id: r.id, ra: r.ra, dec: r.dec })
        }
      }
      if (toiRes.ok) {
        const toi = await toiRes.json() as { rows?: Array<{ id: string; ra: number; dec: number }> }
        for (const r of toi.rows ?? []) {
          if (r && r.id) stars.push({ id: r.id, ra: r.ra, dec: r.dec })
        }
      }
    } catch (e) {
      return NextResponse.json({ started: false, error: `catalog fetch failed: ${String(e)}` }, { status: 500 })
    }
  }

  if (stars.length === 0) {
    return NextResponse.json({ started: false, error: 'no stars to classify' }, { status: 400 })
  }

  const started = await startBatch(stars, url.origin)
  if (!started) {
    return NextResponse.json({ started: false, alreadyRunning: true, status: getBatchStatus() })
  }
  return NextResponse.json({ started: true, total: stars.length, status: getBatchStatus() })
}

/**
 * @description GET /api/batch-classify — same as POST but only returns
 * status (never starts a run). Kept for convenience so a plain browser
 * visit doesn't accidentally kick off a job.
 * @returns JSON `{ status }`.
 */
export async function GET() {
  return NextResponse.json({ status: getBatchStatus() })
}
