# AI Usage Disclosure

This document describes how generative AI was used in building **Stellar
Anomaly Explorer**, and — per the U.S. Copyright Office's guidance
requesting *"a brief explanation of the human author's contributions"* —
what the human author contributed. It is provided for transparency and to
support any copyright registration, in which AI-generated material must be
disclosed and the human authorship identified.

> **Summary.** This project was built by a human author working with an
> AI coding assistant (Anthropic's Claude, via Claude Code) as a
> pair-programming tool. The human conceived the project, made all
> product and architecture decisions, directed each task, reviewed and
> tested the results, and authored every commit. The AI generated
> substantial portions of the source text (code and documentation) under
> that direction. The creative selection, arrangement, integration,
> debugging, and verification that make the work function as a coherent
> whole are the human author's.

## How to read this

The U.S. Copyright Office has stated that copyright protects material an
author creates, and that purely AI-generated content — where the machine,
not a human, determines the expressive elements — is not itself
protectable. Where AI assistance is used, the applicant should disclose it
and identify the human's own creative contributions. The breakdown below
is written in those terms: it separates **human authorship** (the
protectable creative choices) from **AI-assisted generation** (text
produced by the tool under human direction).

## Human author's contributions

The following were conceived, decided, and directed by the human author.
These are the creative and intellectual contributions that shape the work:

- **Concept and product design.** The idea of a "Google Earth for the
  sky" that navigates real astronomical data, detects stellar anomalies,
  routes attention toward them, and hands off to citizen-science
  platforms. What the app is, who it is for, and what it should feel like.
- **Architecture decisions.** The choice of stack (Next.js, Three.js,
  Zustand); the decision to proxy all external archives through server-
  side API routes for CORS; the two-level (in-process + disk) caching
  strategy; rendering the sky as a single `THREE.Points` for performance;
  the separation of the descriptive classifier from any causal claim.
- **The "describe, don't diagnose" principle** and its enforcement as a
  hard rule across the classifier and UI — a deliberate scientific and
  ethical stance, not a technical default.
- **Data-integration choices.** Which catalogs to use (Hipparcos, KOI,
  TOI, Kepler/TESS PDC), how to score anomalies, how to merge missions,
  and how to present provenance ("REAL DATA" vs "DATA UNAVAILABLE" vs
  "DEV/SYNTHETIC") honestly to the user.
- **Direction of every task.** Each unit of work was specified, scoped,
  and prioritized by the human — including the investigations (e.g.
  diagnosing the MAST partial-download issue, the cache-staleness
  incident, the VizieR contract drift) whose conclusions the human
  evaluated and accepted or redirected.
- **Review, testing, and acceptance.** The human ran the app, inspected
  results in the browser, judged whether behavior was correct, and
  decided what shipped. All commits are authored by the human.
- **Selection and arrangement.** Which generated suggestions to keep,
  modify, or discard, and how the pieces fit together into a working
  whole — the editorial and integrative judgment throughout.

## AI-assisted generation

Anthropic's Claude (via the Claude Code CLI) was used as a
pair-programming assistant. Under the human's direction and review, it
generated substantial portions of the project's *text*, including:

- **Source code drafts** across the app — React components, Three.js
  rendering code, the Next.js API routes, the light-curve/FITS handling,
  the BLS classifier, state management, and utilities — typically
  produced from a human-specified task, then reviewed, tested, and
  revised (often across several iterations) before the human committed
  them.
- **Documentation drafts** — including `CLAUDE.md`, `README.md`, this
  file, and `docs/KNOWLEDGE_BASE.md` — written to the human's
  specifications and edited/accepted by the human.
- **Investigation and debugging assistance** — running diagnostic
  probes, characterizing failures (e.g. the concurrency-dependent MAST
  segment-download failure), and proposing fixes, which the human then
  evaluated. In several cases the human explicitly withheld a fix pending
  their own review of the diagnosis.
- **Test authoring** — the unit, data-regression, and end-to-end test
  suites were drafted with AI assistance against human-specified
  expected behavior, with fixture values hand-verified by the human.

The AI did not independently decide the product, the architecture, or
what was correct. It operated within the human's direction, and its
output was subject to the human's review, testing, and acceptance at
every step.

## Nature of the collaboration

The workflow was iterative and conversational: the human posed a goal;
the AI proposed code or analysis; the human tested, corrected, and
redirected; the cycle repeated until the human accepted the result and
committed it. Many of the project's most consequential decisions —
adding a real Box Least Squares search instead of a heuristic, versioning
the light-curve cache to kill mixed-provenance data, loading the full
118k-star Hipparcos catalog, keeping the classifier strictly descriptive
— originated as human product/engineering judgments that the human then
directed the AI to help implement.

## Scope and honesty notes

- This disclosure describes the development process as of the date below.
  It is a good-faith characterization, not a line-by-line attribution;
  most files reflect a mix of AI-generated text and human editing,
  direction, and verification.
- Nothing here is legal advice, and this document does not itself make a
  legal determination of copyrightability. It is intended to give an
  accurate account of AI usage and human authorship so that any such
  determination can be made on correct facts.

---

*Last updated 2026-07-05.*
