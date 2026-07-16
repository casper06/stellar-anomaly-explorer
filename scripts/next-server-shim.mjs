/**
 * @description Minimal `next/server` stand-in for route-level unit tests
 * run under plain `node --test`. The real `next/server` can't be imported
 * outside the Next build (no `exports` map for the bare specifier, and it
 * pulls in the whole server runtime), but the API routes only use
 * `NextResponse.json(...)`. This provides a `Response`-compatible object
 * with the same `.json()` / `.status` surface the tests read, so a route
 * handler's return value can be inspected exactly as the browser would.
 *
 * NOT used by `next dev` / `next build` — only wired in by
 * `register-route-test-resolver.mjs` for tests.
 */

/**
 * @description Drop-in for `NextResponse` covering the `.json()` factory
 * the routes use. Returns a standard `Response` (whose async `.json()` the
 * tests await) so no bespoke body plumbing is needed.
 */
export const NextResponse = {
  /**
   * @description Mirrors `NextResponse.json(body, init)`.
   * @param body JSON-serializable payload.
   * @param init Optional ResponseInit (status, headers).
   * @returns A web `Response` with a JSON body and content-type.
   */
  json(body, init = {}) {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  },
}
