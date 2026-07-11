/**
 * @description Node module-resolution hook for running the app's TypeScript
 * directly under `node --test` (native type stripping). App source uses
 * bundler-style extensionless relative imports (`./persistence`), which
 * Node's ESM loader rejects; this hook retries any failing relative
 * extensionless specifier with `.ts` appended. Registered synchronously
 * (in-thread) via `node --import ./scripts/register-ts-resolver.mjs`.
 * No effect on `next dev`/`next build` — those use their own bundler.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
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
