# Stellar Anomaly Explorer

**A 3D interactive sky explorer that uses real NASA Kepler/TESS data to hunt for stellar anomalies — like Google Earth, but for the universe.**

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-r185-000000?logo=three.js)
![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)

Navigate freely through a WebGL sky built from real astronomical catalogs. The system highlights stars with documented anomalies, guides you toward them, and lets you inspect each star's actual light curve — fetched live from NASA's archives — to see the dips for yourself. Found something interesting? Report it to Zooniverse, the NASA Exoplanet Archive, or the SETI Institute.

## What it does

- **Real star field** — ~8,000 stars from the Hipparcos catalog, rendered as GPU points with true B–V colors (blue = hot, red = cool).
- **Anomaly markers from two missions** — ~9,500 Kepler Objects of Interest and TESS Objects of Interest plotted with per-mission color themes, plus 11 hand-curated famous anomalies (Tabby's Star, the disintegrating-planet candidate KIC 12557548, …).
- **On-demand light curves from MAST** — click any star and the app fetches its actual Kepler quarters or TESS sectors, stitches them, and runs dip detection. Works even for background stars via positional cone search: real data or an honest "not observed", never a fake curve.
- **Interactive light curve viewer** — fullscreen chart with zoom/pan, dip inspection, LTTB downsampling of ~60k-sample curves, cosmic-ray filtering that never clips real transits, and per-dip provenance ("Source: NASA/MAST · Kepler · PDCSAP flux").
- **Curve classification** — measures periodicity, depth consistency, dip shape, and baseline noise, then labels the *pattern* (PERIODIC_UNIFORM / IRREGULAR / HIGH_VARIABILITY / …). It describes what the data looks like; it never claims what causes it.
- **Quadrant navigation & progress** — a 6×6 grid over the Kepler field with per-quadrant anomaly/visited/flagged counts, persistent bookmarks, and a global "explored" progress bar.
- **Sky radar** — a background batch classifier pre-computes pattern labels for the whole catalog and tints the markers, so you can see at a glance which stars are worth a closer look before opening a single curve.

Planned (not yet implemented): constellation identification ("you're looking at Cygnus"), hemisphere-visibility info, an in-app tutorial, and more curated anomaly seeds. See `CLAUDE.md → Next features` for the working list.

## Tech stack

- [Next.js 16](https://nextjs.org) + TypeScript
- [Three.js](https://threejs.org) via [@react-three/fiber](https://github.com/pmndrs/react-three-fiber) and [@react-three/drei](https://github.com/pmndrs/drei)
- [Zustand](https://github.com/pmndrs/zustand) for state, Tailwind CSS for styling
- A hand-rolled ~150-line FITS BINTABLE reader (no dependencies) for parsing mission data server-side

## Data sources & attribution

| Data | Source |
|---|---|
| Star catalog (positions, magnitudes, B–V colors) | [Hipparcos main catalog (I/239)](https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=I/239) via VizieR, CDS Strasbourg |
| Kepler Objects of Interest (KOI) & TESS Objects of Interest (TOI) | [NASA Exoplanet Archive](https://exoplanetarchive.ipac.caltech.edu/) (TAP service) |
| Kepler & TESS light curves (PDCSAP flux) | [MAST — Mikulski Archive for Space Telescopes](https://archive.stsci.edu/), STScI |

All external archives are proxied through Next.js API routes (CORS + caching); the browser never talks to them directly.

## Getting started

```bash
git clone <repo-url>
cd stellar-anomaly-explorer
npm install
npm run dev     # → http://localhost:3000
```

First load fetches the catalogs (~1 s for Hipparcos, ~5–15 s per mission catalog, then disk-cached for 24 h). Light curves are fetched from MAST on demand and cached for 7 days.

### For contributors: the data regression test

```bash
npm run test:data
```

Runs the dip detector + curve classifier against frozen real-data fixtures (Tabby's Star and three KOIs) with hand-verified expected values, and fails loudly on any drift. **Run it before and after touching** `anomalyDetector.ts`, `curveClassifier.ts`, `fitsReader.ts`, or the `/api/lightcurve` fetch/normalization layer. Requires Node ≥ 22.6 (runs TypeScript via native type stripping — no test framework).

## Data integrity principles

Two rules are load-bearing in this codebase:

1. **No silent synthetic data.** Production users and on-demand lookups get real MAST data or an explicit "DATA UNAVAILABLE" — never a generated stand-in. The only synthetic path is a dev-mode fallback, and it's badged **DEV/SYNTHETIC** in loud orange so it can't be mistaken for real data in a screenshot.
2. **The classifier describes, it doesn't diagnose.** Pattern labels are measurements of the data's shape. No string in the classifier or its UI asserts a physical cause — no "planet", no "binary", no "megastructure". The user interprets; the app measures.

Supporting both: every curve carries provenance (source, mission, data type) through to the UI, and the lightcurve disk cache is schema-versioned so data written by older pipeline code is refetched rather than silently served.

## License

[GPL-3.0-or-later](LICENSE) — GNU General Public License v3.0 or any later version.
