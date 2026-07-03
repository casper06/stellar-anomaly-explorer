import { NextResponse } from 'next/server'
import { getBatchStatus } from '@/lib/batchClassifier'

/**
 * @description GET /api/batch-classify/status — polling endpoint for the
 * batch job's live progress. Returns the shared `BatchStatus` object
 * from `batchClassifier`. Safe to call at any frequency; response is
 * a small JSON snapshot with no side effects.
 * @returns JSON `BatchStatus`.
 */
export async function GET() {
  return NextResponse.json(getBatchStatus())
}
