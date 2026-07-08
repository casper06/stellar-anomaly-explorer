# Contributing to Stellar Anomaly Explorer

Thanks for your interest in contributing! This document covers how to set
up a development environment, how to run the test suite (and which layer
to run for which kind of change), how to propose changes, and the
project's code-style expectations.

For background on *why* things are built the way they are, see
[docs/KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md) (confirmed findings,
incident root causes, methodology) and [CLAUDE.md](CLAUDE.md) (the
operational quick-reference used during day-to-day development).

## Development setup

Requirements:

- **Node.js ≥ 22.6** — the test layers run TypeScript through Node's
  native type stripping, no build step or test framework needed.
- npm (bundled with Node).

```bash
git clone https://github.com/casper06/stellar-anomaly-explorer.git
cd stellar-anomaly-explorer
npm install
npm run dev        # → http://localhost:3000
```

Notes on first run:

- The app proxies real astronomical archives (VizieR Hipparcos, NASA
  Exoplanet Archive KOI/TOI, MAST light curves) through its own API
  routes. The first catalog load is network-bound (~5–15 s per mission
  catalog); after that, responses come from a disk cache under your OS
  temp directory (`<tmpdir>/stellar-cache/`).
- Opening a star's light curve triggers a real MAST fetch that can take
  up to ~60 s cold; it is disk-cached (7-day TTL) afterwards.
- No API keys are required — all upstream services are public.

## Running the tests

Three layers, all runnable locally:

| Command | Layer | Needs |
|---|---|---|
| `npm run test:unit` | Unit tests (`node --test`, zero deps) | Node ≥ 22.6 |
| `npm run test:data` | Data regression against frozen real-data fixtures | Node ≥ 22.6 |
| `npm test` | `test:unit` + `test:data` — the fast offline gate (~5 s) | Node ≥ 22.6 |
| `npm run test:e2e` | Playwright end-to-end (boots or reuses the dev server) | one-time `npx playwright install chromium` |
| `npm run test:external-health` | Live probe of the 5 external services (contract checks) | network |

**Which layer to run for which change** — run the matching commands
*before and after* touching the listed area:

| Touching | Run |
|---|---|
| `anomalyDetector` / `curveClassifier` / `bls` / `oddEven` / `secondaryEclipse` / `fitsReader` / `/api/lightcurve` fetch or normalization | `npm run test:data` + `npm run test:unit` |
| `selectStar` / `store` / `persistence` | `npm run test:unit` (+ `test:e2e` if the selection flow changed) |
| `StarField` selection paths / CameraSync / disambiguation popover / HUD panels | `npm run test:e2e` |
| anything else | `npx tsc --noEmit` + verify in the browser |

If an **intentional** algorithm change shifts the data-regression
values: run `npm run test:data -- --print`, re-verify the newly measured
values by hand (against NASA catalog values or documented behavior —
each fixture's doc comment says what was cross-checked), then update
`EXPECTED` in `src/lib/__tests__/dataRegression.test.ts`. Never update
the expectations to silence a failure you can't explain.

## Proposing changes

- **Branch model**: `dev` is the working branch; `main` holds the latest
  stable snapshot only and is updated by merging a verified `dev` (or
  a PR). Don't commit directly to `main`.
- Open a pull request against **`dev`** with:
  - a description of what changed and why;
  - the test layers you ran (per the table above) and their results;
  - for changes touching the fetch pipeline or the classifier: whether
    `CACHE_SCHEMA_VERSION` (lightcurve route) or `CLASSIFIER_VERSION`
    (`curveClassifier.ts`) needs a bump — the rules are documented at
    each constant. Label-affecting classifier changes bump the version;
    purely additive profile fields don't.
- Bug reports and feature ideas are welcome as GitHub issues. For bugs,
  include the star id (KIC/TIC/KOI/TOI) when relevant — most data
  issues are reproducible from just that.

## Code style expectations

- **TypeScript, no `any` where avoidable**; the repo must pass
  `npx tsc --noEmit` clean.
- **JSDoc on every function, component, type alias, and exported
  constant**, in English, using standard tags: `@description` (always
  first), `@param` for every parameter, `@returns` for non-void
  returns. React component props are documented as `@param` entries.
  See CLAUDE.md ("Documentation style") for the exact skeleton.
- **All user-facing strings are English.**
- **Describe, don't diagnose** (hard rule): no string in the classifier
  or the UI may assert a physical cause for a light-curve feature — no
  "planet", "binary", "eclipse" as conclusions. Measurements and
  numbers only; the user interprets. This is a scientific-integrity
  stance (the app feeds citizen-science reporting), not a style
  preference.
- **Rendering performance**: catalog stars must stay a single
  `THREE.Points` with `BufferGeometry` — never per-star meshes.
- **Fallback honesty**: synthetic data must never be presented as real.
  Anything that degrades (catalog fetch, light-curve fetch, partial
  segment coverage) must degrade *loudly* in the UI and logs — silent
  fallback has caused real incidents here (see KNOWLEDGE_BASE §4).

## License

By contributing, you agree that your contributions are licensed under
the repository's license (see `LICENSE`).
