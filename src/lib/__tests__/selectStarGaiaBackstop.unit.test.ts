/**
 * @description Backstop test for `resolveGaiaFor`'s local try/catch (Task 2
 * follow-up in Bloque C3). `fetchGaiaForStar` is documented never-throws,
 * but that contract lives in `gaiaClient.ts` — a neighboring module the
 * selection path does not own. Here we deliberately regress it (via
 * `mock.module`) so it DOES throw, and assert the backstop degrades to the
 * same benign outcome as a miss: the selection completes, the
 * light-curve/identity paths are unaffected, and the Gaia slot ends up null
 * and not-loading — never a stuck spinner or a propagated crash.
 *
 * ⚠ This lives in its OWN file, NOT alongside `selectStar.unit.test.ts`, on
 * purpose: `mock.module` only reroutes NEW module resolutions, so
 * `selectStar` must be dynamically imported AFTER the mock is registered
 * and must NOT already be statically imported anywhere in the same file
 * (a static import binds `fetchGaiaForStar` before the mock exists, and the
 * dynamic import would then return that already-bound cached instance).
 * The main selectStar suite imports it statically, so the mocked variant
 * needs this separate module.
 *
 * Requires `--experimental-test-module-mocks` (set in the `test:unit`
 * script). Run via `npm run test:unit`.
 */
import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { useStore, type Star } from '../store.ts'

const realFetch = globalThis.fetch

/** @description Minimal catalog star for driving a selection. */
function star(id: string): Star {
  return {
    id, name: id, ra: 290, dec: 44, magnitude: 12,
    colorIndex: 0.6, hasAnomaly: true, anomalyScore: 0.5,
  } as Star
}

/** @description A successful /api/lightcurve payload tagged so we can identify it. */
function lightcurveJson(tag: number) {
  return {
    times: [tag, tag + 0.02, tag + 0.04],
    flux: [1, 1, 1],
    source: 'real',
    provenance: { sourceName: 'NASA/MAST', mission: 'Kepler', dataType: 'PDCSAP flux' },
    mission: 'Kepler',
    gapDays: 5,
  }
}

describe('Gaia resolution — local backstop when fetchGaiaForStar throws (Task 2)', () => {
  afterEach(() => {
    mock.reset()
    globalThis.fetch = realFetch
  })

  it('a throw is caught, logged, and treated like a miss (slot null, selection unaffected)', async () => {
    // Regress the never-throws contract: make the Gaia leg reject.
    // `namedExports` (not the newer `exports`) is used because the installed
    // @types/node types this option as `namedExports`; the runtime still
    // honors it. Both replace the module's named exports.
    mock.module('../gaiaClient.ts', {
      namedExports: {
        fetchGaiaForStar: async () => {
          throw new Error('simulated gaiaClient regression')
        },
        fetchGaiaBySourceId: async () => null,
      },
    })

    // Minimal network for the lightcurve + identity legs so the rest of the
    // selection flow runs to completion (identity is a clean SIMBAD miss).
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.startsWith('/api/pattern-cache')) return new Response('{}', { status: 200 })
      if (u.startsWith('/api/identity/')) {
        return new Response(JSON.stringify({ source: 'real', identity: null }), { status: 200 })
      }
      return new Response(JSON.stringify(lightcurveJson(777)), { status: 200 })
    }) as typeof fetch

    useStore.setState({
      selectedStar: null, lightcurve: null, lightcurveLoading: false, anomalies: [],
      mode: 'explore', visitedIds: new Set(), classifiedPatterns: new Map(),
      identity: null, identityLoading: false, resolvedIdentities: new Map(),
      gaia: null, gaiaLoading: false,
    })

    // Capture the expected backstop log rather than letting it print.
    const origErr = console.error
    let logged = ''
    console.error = (...a: unknown[]) => { logged += a.join(' ') }

    // Dynamic import AFTER the mock so selectStar binds the throwing stub.
    const { selectStarAndFetchCurve } = await import('../selectStar.ts')

    try {
      await selectStarAndFetchCurve(star('KIC_THROW'))
      // Let the void-ed resolveGaiaFor settle its catch/finally.
      await new Promise<void>(r => setTimeout(r, 20))
    } finally {
      console.error = origErr
    }

    const s = useStore.getState()
    assert.equal(s.gaia, null, 'Gaia slot cleared, exactly like a miss')
    assert.equal(s.gaiaLoading, false, 'not left stuck-loading')
    assert.equal(s.lightcurve?.times[0], 777, 'the light-curve path was unaffected')
    assert.equal(s.lightcurveLoading, false)
    assert.equal(s.identity, null, 'identity path unaffected (this star is a SIMBAD miss)')
    assert.match(logged, /Gaia resolution threw unexpectedly/, 'the throw was logged, not swallowed silently')
  })
})
