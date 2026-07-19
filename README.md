# Stellar Anomaly Explorer

**A 3D interactive sky explorer that uses real NASA Kepler/TESS data to hunt for stellar anomalies — like Google Earth, but for the universe.**

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-r185-000000?logo=three.js)
![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)

Navigate freely through a WebGL sky built from real astronomical catalogs. The system highlights stars with documented anomalies, guides you toward them, and lets you inspect each star's actual light curve — fetched live from NASA's archives — to see the dips for yourself. Found something interesting? Report it to Zooniverse, the NASA Exoplanet Archive, or the SETI Institute.

## What it does

- **Real star field** — the full ~118,000-star Hipparcos main catalog (all-sky, no magnitude ceiling), rendered as a single GPU point cloud with true B–V colors (blue = hot, red = cool) and magnitude-driven size and brightness.
- **Anomaly markers from two missions** — ~9,500 Kepler Objects of Interest and TESS Objects of Interest plotted with per-mission color themes, plus 11 hand-curated famous anomalies (Tabby's Star, the disintegrating-planet candidate KIC 12557548, …).
- **On-demand light curves from MAST** — click any star and the app fetches its actual Kepler quarters or TESS sectors, stitches them, and runs dip detection. Works even for background stars via positional cone search: real data or an honest "not observed", never a fake curve.
- **Interactive light curve viewer** — fullscreen chart with zoom/pan, dip inspection, LTTB downsampling of ~60k-sample curves, cosmic-ray filtering that never clips real transits, and per-dip provenance ("Source: NASA/MAST · Kepler · PDCSAP flux").
- **Curve classification** — measures periodicity, depth consistency, dip shape, and baseline noise, then labels the *pattern* (PERIODIC_UNIFORM / IRREGULAR / HIGH_VARIABILITY / …). It describes what the data looks like; it never claims what causes it.
- **Quadrant navigation & progress** — a 6×6 grid over the Kepler field with per-quadrant anomaly/visited/flagged counts, persistent bookmarks, and a global "explored" progress bar.
- **Sky radar** — a background batch classifier pre-computes pattern labels for the whole catalog and tints the markers, so you can see at a glance which stars are worth a closer look before opening a single curve.
- **Pixel-level vetting** — for confident transit signals, an opt-in difference-image centroid check downloads the raw target-pixel data and measures whether the dimming is centered on the target star or a nearby contaminant, following NASA's centroid-offset convention.
- **Celestial orientation** — the HUD names the constellation you're pointing at ("…you're looking at Cygnus"), and each selected star shows its constellation plus a hemisphere-visibility line ("visible north of −46°, best viewed around July").
- **In-app tutorial** — a guided walkthrough of the two datasets, the mission counters, the data-source badges, navigation, and the citizen-science hand-off, separate from the first-run onboarding overlay.

Planned (not yet implemented): constellation boundary outlines on the minimap and more curated anomaly seeds. See `CLAUDE.md → Next features` for the working list.

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
| Cross-identifiers & common names | [SIMBAD](https://simbad.cds.unistra.fr/simbad/), CDS Strasbourg (TAP service) |

All external archives are proxied through Next.js API routes (CORS + caching); the browser never talks to them directly.

### Required acknowledgments

Each archive below asks users of its data to reproduce a specific
acknowledgment. These are **academic citation norms — not software
license terms**, and they are entirely separate from this project's
GPL/MIT licensing (see [License](#license)). They are reproduced here
verbatim, as each provider words them, and should be carried into any
paper, poster, or publication built on this project.

**Kepler** (light curves via MAST):

> This paper includes data collected by the Kepler mission and obtained from the MAST data archive at the Space Telescope Science Institute (STScI). Funding to US Institutions for the Kepler mission was provided by the NASA Science Mission Directorate. STScI is operated by the Association of Universities for Research in Astronomy, Inc., under NASA contract NAS 5–26555.

**TESS** (light curves via MAST):

> This paper includes data collected with the TESS mission, obtained from the MAST data archive at the Space Telescope Science Institute (STScI). Funding for US Institutions for the TESS mission is provided by the NASA Explorer Program. STScI is operated by the Association of Universities for Research in Astronomy, Inc., under NASA contract NAS 5–26555.

**NASA Exoplanet Archive** (KOI + TOI catalogs):

> This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program.

**VizieR** (Hipparcos catalog access):

> This research has made use of the VizieR catalogue access tool, CDS, Strasbourg, France.

**SIMBAD** (cross-identifier resolution):

> This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France.

VizieR and SIMBAD are both CDS services but require **separate**
acknowledgments — using one does not cover the other, and this project
uses both.

### Citable references

Acknowledgment text and a paper citation are different obligations;
most of these providers want both. Verified references:

| Source | Reference | DOI |
|---|---|---|
| Kepler | Borucki et al. 2010, *Science*, 327, 977 | [10.1126/science.1185402](https://doi.org/10.1126/science.1185402) |
| TESS | Ricker et al. 2015, *JATIS*, 1, 014003 | [10.1117/1.JATIS.1.1.014003](https://doi.org/10.1117/1.JATIS.1.1.014003) |
| NASA Exoplanet Archive | Christiansen et al. 2025, *PSJ*, 6, 186 | [10.3847/PSJ/ade3c2](https://doi.org/10.3847/PSJ/ade3c2) |
| VizieR | Ochsenbein, Bauer & Marcout 2000, *A&AS*, 143, 23 | [10.1051/aas:2000169](https://doi.org/10.1051/aas:2000169) |
| SIMBAD | Wenger et al. 2000, *A&AS*, 143, 9 | [10.1051/aas:2000332](https://doi.org/10.1051/aas:2000332) |

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
