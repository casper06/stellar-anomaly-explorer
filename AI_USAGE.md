# AI Usage Disclosure

This document discloses how generative AI was used in building **Stellar
Anomaly Explorer**. It is structured around the three-part disclosure
that the Journal of Open Source Software (JOSS) requires — **tool use**,
**nature and scope of assistance**, and **confirmation of review** — and
additionally records the human author's contributions per the U.S.
Copyright Office's guidance requesting *"a brief explanation of the human
author's contributions"* (see the final section).

> **Summary.** This project was built by a human author working with an
> AI coding assistant (Anthropic's Claude, via Claude Code) as a
> pair-programming tool. The human conceived the project, made all
> product and architecture decisions, directed each task, reviewed and
> tested the results, and authored every commit. The AI generated
> substantial portions of the source text (code and documentation) under
> that direction. The creative selection, arrangement, integration,
> debugging, and verification that make the work function as a coherent
> whole are the human author's.

## Tool use

**Which tools/models:** Anthropic Claude models, operated through the
**Claude Code** CLI/agent environment, were the only generative AI tools
used. No other code-generation, text-generation, or AI review tools were
involved.

**Where AI assistance was applied:**

- **Code** — drafts across the application: React components, Three.js
  rendering code, the Next.js API routes, light-curve/FITS handling, the
  BLS classifier and vetting checks, state management, and utilities.
- **Documentation** — drafts of `CLAUDE.md`, `README.md`,
  `docs/KNOWLEDGE_BASE.md`, `CONTRIBUTING.md`, and this file.
- **Tests** — the unit, data-regression, and end-to-end suites, drafted
  against human-specified expected behavior, with regression-fixture
  values hand-verified by the human.

## Nature and scope of assistance

The workflow was iterative and conversational: the human posed a goal;
the AI proposed code or analysis; the human tested, corrected, and
redirected; the cycle repeated until the human accepted the result and
committed it. Within that loop, the assistance took these forms:

- **Code generation and refactoring** — producing implementation drafts
  from a human-specified task, then revising them (often across several
  iterations) in response to the human's review, test results, and
  redirection.
- **Investigation and debugging assistance** — running diagnostic
  probes, characterizing failures (e.g. the concurrency-dependent MAST
  segment-download failure, the VizieR contract drift, the cache-
  staleness incident), and proposing fixes, which the human then
  evaluated. In several cases the human explicitly withheld a fix
  pending their own review of the diagnosis.
- **Test authoring** — writing test code and capturing real-data
  regression fixtures against expected values specified and hand-
  verified by the human.
- **Documentation drafting and style correction** — writing and
  restructuring project documentation to the human's specifications.

The AI did not independently decide the product, the architecture, or
what was correct. Many of the project's most consequential decisions —
adding a real Box Least Squares search instead of a heuristic, versioning
the light-curve cache to kill mixed-provenance data, loading the full
118k-star Hipparcos catalog, keeping the classifier strictly descriptive
— originated as human product/engineering judgments that the human then
directed the AI to help implement.

## Confirmation of review

**The human author reviewed, edited, and validated all AI-generated
output before it entered the repository, and made all core design
decisions.** Specifically:

- Every commit was reviewed and authored by the human; nothing generated
  by the AI shipped without human acceptance.
- Validation went beyond reading: the human ran the app, inspected
  behavior in the browser, ran the layered test suites (unit,
  data-regression against hand-verified real-data fixtures, and
  end-to-end), and judged whether results were correct before accepting
  them.
- Each unit of work was specified, scoped, and prioritized by the human,
  including the investigations whose conclusions the human evaluated and
  accepted or redirected.
- The core design decisions were the human's: the concept and product
  design ("Google Earth for the sky" over real archival data, handing
  off to citizen science); the architecture (Next.js/Three.js/Zustand,
  server-side proxying of all external archives, the two-level caching
  strategy, `THREE.Points` rendering); the scientific stance (the
  "describe, don't diagnose" rule enforced across classifier and UI);
  and the data-integration and provenance-presentation choices.

## Human authorship (copyright disclosure)

The U.S. Copyright Office has stated that copyright protects material an
author creates, and that purely AI-generated content — where the machine,
not a human, determines the expressive elements — is not itself
protectable. Where AI assistance is used, the applicant should disclose
it and identify the human's own creative contributions. In those terms:
the human authorship in this work comprises the concept and product
design; the architecture decisions; the "describe, don't diagnose"
principle and its enforcement; the data-integration choices; the
direction of every task; the review, testing, and acceptance of all
results; and the selection and arrangement of generated material into a
working whole — the editorial and integrative judgment throughout.

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

*Last updated 2026-07-07.*
