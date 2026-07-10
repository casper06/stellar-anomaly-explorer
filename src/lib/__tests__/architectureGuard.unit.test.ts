/**
 * @description Architecture guard — a PERMANENT decoupling test for the
 * core science ("engine") modules. These files implement the portable
 * measurement pipeline (period search, vetting checks, FITS parsing,
 * centroid engine) and are candidates for extraction as a standalone
 * package; this test fails the suite the moment any of them grows an
 * import that would break that portability: React, Zustand, `next/*`,
 * Three.js, our HTTP client, any other third-party package, or a
 * relative import that reaches OUTSIDE the engine set (e.g. the store,
 * a component, an API-route helper).
 *
 * Policy (default-deny):
 * - Bare package specifiers: ONLY `node:*` builtins are allowed. A new
 *   third-party dependency in an engine module is an architectural
 *   decision, not a convenience — add it here consciously if it ever
 *   happens, with its license noted (the extraction plan assumes the
 *   subset can be re-licensed MIT, so any dependency must be
 *   MIT-compatible).
 * - Relative imports: must point at another engine module.
 * - `require(...)` / dynamic `import(...)` are scanned too, so the rule
 *   can't be dodged.
 *
 * KNOWN DEBT (explicit, verified exception — do not widen silently):
 * `curveClassifier.ts` imports `type Dip` from `./anomalyDetector`.
 * `anomalyDetector.ts` is a MIXED module: it holds the pure `detectDips`
 * science code AND the app-specific lightcurve client
 * (`fetch('/api/lightcurve/…')`, a `process.env.NODE_ENV` dev-synthetic
 * gate), so it is deliberately NOT in the engine set. The `Dip` import
 * is type-only (erased at compile time — zero runtime coupling), and the
 * exception below asserts it STAYS type-only; turning it into a value
 * import fails this test. The clean fix — recorded as extraction-phase
 * work, not done here — is to move `detectDips` + its types into an
 * engine module and leave `anomalyDetector.ts` as the app-side client.
 *
 * Run via `npm run test:unit` (plain Node ≥ 22.6, node:test).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @description The engine set: core science modules that must stay
 * portable. Keep in sync with the extraction plan — a new pure
 * measurement module belongs in this list.
 */
const ENGINE_MODULES = [
  'bls.ts',
  'curveClassifier.ts',
  'oddEven.ts',
  'secondaryEclipse.ts',
  'fitsCore.ts',
  'fitsReader.ts',
  'tpfReader.ts',
  'centroidVet.ts',
]

/**
 * @description Documented exceptions to the relative-import rule. Each
 * entry allows ONE specifier in ONE file, and only as a type-only
 * import. Adding an entry here is a reviewed decision — see the module
 * doc's KNOWN DEBT note for the single current case.
 */
const KNOWN_TYPE_ONLY_EXCEPTIONS: Array<{ file: string; specifier: string; reason: string }> = [
  {
    file: 'curveClassifier.ts',
    specifier: './anomalyDetector',
    reason:
      'type Dip lives in the mixed detector+client module; type-only import, zero runtime coupling. Fix at extraction time by moving detectDips into the engine set.',
  },
]

/** @description One import found in a source file. */
interface FoundImport {
  specifier: string
  /** True when the whole import clause is `import type … from`. */
  typeOnly: boolean
  /** Line text for failure messages. */
  line: string
}

/**
 * @description Strips block and line comments so JSDoc examples
 * containing the word `import` can't produce false positives.
 * @param src Source text.
 * @returns Comment-free source.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * @description Extracts every static import, side-effect import,
 * `export … from`, `require(...)` and dynamic `import(...)` specifier
 * from a module's source.
 * @param src Comment-stripped source text.
 * @returns All found imports.
 */
function extractImports(src: string): FoundImport[] {
  const found: FoundImport[] = []
  // Static imports and re-exports with a from-clause (multi-line tolerant).
  const fromRe = /(import|export)\s+(type\s+)?([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g
  for (const m of src.matchAll(fromRe)) {
    found.push({ specifier: m[4], typeOnly: m[2] !== undefined, line: m[0].replace(/\s+/g, ' ').slice(0, 120) })
  }
  // Side-effect imports: import 'polyfill'
  for (const m of src.matchAll(/import\s*['"]([^'"]+)['"]/g)) {
    found.push({ specifier: m[1], typeOnly: false, line: m[0] })
  }
  // require(...) and dynamic import(...)
  for (const m of src.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ specifier: m[1], typeOnly: false, line: m[0] })
  }
  return found
}

/**
 * @description Resolves a relative specifier against the lib dir and
 * returns the engine-relative filename (e.g. "./bls" → "bls.ts"), or
 * null when it points outside `src/lib`.
 * @param specifier Relative import specifier.
 * @returns Normalized lib filename or null.
 */
function libFileFor(specifier: string): string | null {
  const resolved = path.normalize(path.join(LIB_DIR, specifier))
  const rel = path.relative(LIB_DIR, resolved)
  if (rel.startsWith('..') || rel.includes(path.sep)) return null
  return rel.endsWith('.ts') ? rel : `${rel}.ts`
}

describe('architecture guard — engine modules stay portable', () => {
  const engineSet = new Set(ENGINE_MODULES)

  for (const file of ENGINE_MODULES) {
    it(`${file} imports nothing app-specific or non-portable`, () => {
      const src = stripComments(readFileSync(path.join(LIB_DIR, file), 'utf8'))
      const violations: string[] = []

      for (const imp of extractImports(src)) {
        const { specifier } = imp
        if (specifier.startsWith('.')) {
          const target = libFileFor(specifier)
          if (target !== null && engineSet.has(target)) continue
          const exception = KNOWN_TYPE_ONLY_EXCEPTIONS.find(
            e => e.file === file && e.specifier === specifier,
          )
          if (exception) {
            if (!imp.typeOnly) {
              violations.push(
                `${specifier} — allowed ONLY as a type-only import (${exception.reason}); found value import: ${imp.line}`,
              )
            }
            continue
          }
          violations.push(`relative import outside the engine set: '${specifier}' (${imp.line})`)
        } else if (specifier.startsWith('node:')) {
          continue // Node builtins are part of the runtime, not a dependency.
        } else {
          violations.push(`third-party / app package import: '${specifier}' (${imp.line})`)
        }
      }

      assert.deepEqual(
        violations,
        [],
        `${file} has coupling violations:\n  ${violations.join('\n  ')}\n` +
          'Engine modules must stay portable (see this test file\'s policy doc).',
      )
    })
  }

  it('every engine module exists (list stays in sync with the codebase)', () => {
    for (const file of ENGINE_MODULES) {
      assert.doesNotThrow(() => readFileSync(path.join(LIB_DIR, file)), `${file} missing from src/lib`)
    }
  })

  it('the documented exception is still needed (remove it when the debt is paid)', () => {
    // If curveClassifier stops importing from ./anomalyDetector, this
    // exception must be deleted rather than lingering as a hole.
    const src = stripComments(readFileSync(path.join(LIB_DIR, 'curveClassifier.ts'), 'utf8'))
    const stillThere = /from\s*['"]\.\/anomalyDetector['"]/.test(src)
    assert.equal(
      stillThere,
      true,
      'curveClassifier no longer imports ./anomalyDetector — delete the KNOWN_TYPE_ONLY_EXCEPTIONS entry.',
    )
  })
})
