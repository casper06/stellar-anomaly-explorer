# Architecture overview

> This diagram is a snapshot of the architecture as of 2026-07-24 — see individual route/module files for current implementation details.

This is the full-project architecture overview: five external data
sources feed into the app through Next.js API routes, where the
MIT-licensed `stellar-vetting-engine` runs the detection pipeline (BLS →
odd/even → secondary eclipse → centroid) and the `src/lib` descriptive
connectors resolve Gaia and SIMBAD context. Every source is buffered by
its own versioned, TTL'd disk cache before reaching the UI. The
`AnomalyPanel` presents each source as an independent instrument section
under the project's N-instrument model — no score fusion, describe rather
than diagnose.

```mermaid
flowchart TB
    classDef source fill:#1f3a5f,stroke:#4a90d9,color:#e8f1fb,stroke-width:1px
    classDef engine fill:#1f5f4a,stroke:#4ad9a0,color:#e8fbf3,stroke-width:1px
    classDef lib fill:#5f4a1f,stroke:#d9a04a,color:#fbf3e8,stroke-width:1px
    classDef cache fill:#3a1f5f,stroke:#a04ad9,color:#f3e8fb,stroke-width:1px
    classDef ui fill:#5f1f2f,stroke:#d94a6a,color:#fbe8ec,stroke-width:1px
    classDef principle fill:#2b2b2b,stroke:#999,color:#fff,stroke-width:2px

    subgraph SOURCES["Data sources (5)"]
        direction LR
        KOI["Kepler KOI<br/>NASA Exoplanet Archive"]:::source
        TOI["TESS TOI<br/>NASA Exoplanet Archive"]:::source
        HIP["Hipparcos<br/>ESA / VizieR — ~118k stars"]:::source
        GAIA["Gaia DR3<br/>ESA Archive TAP"]:::source
        SIMBAD["SIMBAD<br/>CDS cross-identifier resolver"]:::source
    end

    subgraph ENGINE["stellar-vetting-engine — MIT package, zero app coupling"]
        direction LR
        BLS["BLS<br/>Box Least Squares"]:::engine
        ODDEVEN["Odd / Even<br/>transit check"]:::engine
        ECLIPSE["Secondary eclipse<br/>check"]:::engine
        CENTROID["Centroid vetting<br/>WCS / TPF"]:::engine
    end

    subgraph LIB["src/lib — descriptive connectors"]
        direction LR
        GAIASRC["gaiaSource.ts<br/>RUWE + RV variability"]:::lib
        SIMBADIDS["simbadIds.ts<br/>cross-identifier parser"]:::lib
    end

    subgraph CACHE["Disk cache — versioned, TTL per source"]
        direction LR
        C1["KOI / TOI cache<br/>7d / 24h, stale-while-revalidate"]:::cache
        C2["Lightcurve cache<br/>7d TTL + in-memory LRU"]:::cache
        C3["Gaia cache<br/>30d TTL, AIP mirror fallback"]:::cache
        C4["Identity cache<br/>30d TTL"]:::cache
    end

    PANEL["AnomalyPanel<br/>independent instrument sections"]:::ui

    KOI --> C1
    TOI --> C1
    C1 --> PANEL
    HIP --> PANEL

    KOI -. FITS via MAST .-> BLS
    TOI -. FITS via MAST .-> BLS
    BLS --> ODDEVEN --> ECLIPSE --> CENTROID --> C2 --> PANEL

    GAIA --> C3 --> GAIASRC --> PANEL
    SIMBAD --> C4 --> SIMBADIDS --> PANEL
    SIMBADIDS -. resolves Gaia source_id .-> GAIASRC

    PANEL --> MODEL["N-instrument model<br/>no score fusion — describe, don't diagnose"]:::principle
```

## Verified against the codebase (2026-07-24)

Every node and annotation in the diagram was checked against the real code:

- **Engine modules** — `bls.ts`, `oddEven.ts`, `secondaryEclipse.ts`,
  `centroidVet.ts` all live in `packages/stellar-vetting-engine/src/`
  (the MIT-licensed package, no app coupling).
- **Descriptive connectors** — `gaiaSource.ts` and `simbadIds.ts` are in
  `src/lib/`, deliberately outside the engine package (catalog-identifier
  and descriptive plumbing, not vetting science).
- **Cache TTLs** — KOI `7d`, TOI `24h`, lightcurve `7d` (+ an in-process
  `LruCache`), Gaia `30d` (with the ESAC→AIP mirror fallback), identity
  `30d`. All match the `DISK_CACHE_TTL_MS` constants in their routes.
