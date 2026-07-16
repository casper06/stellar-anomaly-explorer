/**
 * @description Module-resolution hook for running the app's Next.js API
 * ROUTE handlers directly under `node --test` (native type stripping).
 * Extends the base `register-ts-resolver.mjs` behavior with the two things
 * routes need that plain Node can't resolve:
 *   1. `@/…` path alias → `src/…` (matching tsconfig `paths`), retrying
 *      with a `.ts` extension for extensionless specifiers.
 *   2. `next/server` → a minimal local shim (`next-server-shim.mjs`)
 *      exposing `NextResponse.json`, so a route module imports without
 *      dragging in the full Next runtime (which isn't loadable outside a
 *      Next build).
 *   3. Bundler-style extensionless relative imports → `.ts` (as the base
 *      resolver does).
 *
 * Registered via `node --import ./scripts/register-route-test-resolver.mjs`.
 * No effect on `next dev` / `next build`.
 */
import { registerHooks } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url)) // scripts/
const SRC_DIR = path.join(ROOT, '..', 'src')
const NEXT_SHIM = pathToFileURL(path.join(ROOT, 'next-server-shim.mjs')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Shim next/server → local minimal NextResponse.
    if (specifier === 'next/server') {
      return { url: NEXT_SHIM, shortCircuit: true }
    }

    // Map the `@/…` alias to an absolute src/ file URL, retrying `.ts`.
    if (specifier.startsWith('@/')) {
      const rel = specifier.slice(2) // strip "@/"
      const base = path.join(SRC_DIR, rel)
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
        try {
          return nextResolve(pathToFileURL(candidate).href, context)
        } catch {
          // try next candidate
        }
      }
      // Fall through to default (produces a clear error) if none resolved.
      return nextResolve(pathToFileURL(`${base}.ts`).href, context)
    }

    try {
      return nextResolve(specifier, context)
    } catch (err) {
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
      const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier)
      if (isRelative && !hasExtension) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw err
    }
  },
})
