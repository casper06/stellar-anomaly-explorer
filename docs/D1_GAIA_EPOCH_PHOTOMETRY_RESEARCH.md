# Bloque D1 — Gaia DR3 epoch (time-series) photometry: worth a viewer?

*Research only. No code written, no modules created, no existing files
modified. Measured against the live Gaia Archive DataLink service on
2026-07-23. Issue #16.*

## TL;DR — recommendation: **not worth building a second light-curve viewer.**

Gaia DR3 epoch photometry exists and is anonymously fetchable, but for
this project's objects it is a **sparse, non-phase-coherent scatter of
~40 points over 2.6 years**, not a light curve. Of the four C1 test
objects, **only HAT-P-7 has any epoch photometry at all** — and its real
data is 40 G-band epochs spanning 0.024 mag peak-to-peak (dominated by
noise + Gaia's own variability rejection), which cannot reproduce
anything like the transit the Kepler/TESS viewer shows. Tabby's Star —
our flagship — has **no epoch photometry whatsoever**. Building "a second
light-curve viewer" on this would ship something empty for 3 of 4
objects and misleading for the 4th.

There is a **narrow, honest alternative** worth considering later (a
plain time-ordered magnitude scatter with error bars, shown *only* when
epoch data exists, framed as "Gaia independently sampled this star's
brightness at N epochs over M years" — never as a transit curve). It is
NOT a priority and NOT this session's call to build. Detail below.

---

## Test set (same four objects + source_ids as C1)

| Object | App id | Gaia DR3 source_id | `has_epoch_photometry` (C1) |
|---|---|---|---|
| Tabby's Star | KIC 8462852 | 2081900940499099136 | False |
| HAT-P-7 | KIC 10666592 | 2129256395211984000 | **True** |
| WASP-126 | TIC 25155310 | 4666498154837086208 | False |
| K2-22 | EPIC 201637175 | 3811002791880297600 | False |

The C1.1 finding (only HAT-P-7 has epoch photometry) **still holds** —
re-verified live this session against the actual DataLink product listing
for each source, not just the `gaia_source` flag.

---

## D1.1 — What epoch tables exist, and how they're *actually* accessed

**The table:** `gaiadr3.epoch_photometry`. Confirmed against the official
DR3 datamodel (Part V, ch. 20.7.1). It holds per-transit G / BP / RP
photometry: `g_transit_time`, `g_transit_flux`, `g_transit_mag`,
`bp_obs_time`, `bp_mag`, `rp_obs_time`, `rp_mag`, per-band flux errors,
and 25 boolean processing/rejection flags.

**Access — NOT a plain TAP SELECT.** This is the load-bearing D1.1
finding, and the task's suspicion was correct:

> *"Note this table is not available through the main archive TAP
> interface. Data are delivered via the Massive Data service indexed by
> the VO DataLink protocol."* — Gaia DR3 datamodel ch. 20.7.1.

So unlike `gaia_source` (which C1/C2 access as a one-line
`SELECT … WHERE source_id = N` against `…/tap-server/tap/sync`), epoch
photometry requires the **DataLink retrieval service**:

1. **Discovery** — `GET https://gea.esac.esa.int/data-server/datalink/links?ID=Gaia+DR3+<source_id>&RETRIEVAL_TYPE=EPOCH_PHOTOMETRY`
   returns a VOTable listing available data products. If the source has
   epoch photometry, one row carries an `access_url`; **if not, the row
   is simply absent** (no error — measured: Tabby/WASP-126/K2-22 return
   only spectral/MCMC products, no EPOCH_PHOTOMETRY row).
2. **Retrieval** — `GET https://gea.esac.esa.int/data-server/data?ID=Gaia+DR3+<source_id>&RETRIEVAL_TYPE=EPOCH_PHOTOMETRY&LINKING_PARAMETER=SOURCE_ID&FORMAT=csv`
   returns the actual per-transit rows (CSV/VOTable/FITS/ECSV;
   `DATA_STRUCTURE=INDIVIDUAL` = one file per source, the default).

**Anonymous access works** — no login, no API key, at our one-query-per-
click volume. Both the discovery and retrieval GETs above succeeded this
session with no auth. Same host as the existing Gaia TAP
(`gea.esac.esa.int`), but a **different service path** (`/data-server/…`
vs `/tap-server/tap/sync`) and a **two-step protocol**, not a single
ADQL round-trip.

**Per-epoch radial velocity:** DR3 does publish `EPOCH_RV` /
`RVS`-related DataLink products for the small subset of sources with
RVS time series (and the RR Lyrae/Cepheid SOS pipeline processed epoch
RVs). None of our four objects is a useful case: WASP-126 has `has_rvs`
but that's the *mean* RVS spectrum product, not a time series suited to
a viewer; the others have no RVS epoch data. Not investigated further —
even sparser and rarer than epoch photometry.

**Practical access caveat for any future implementation:** the DataLink
service enforces a **5,000-source cap per request** and is a distinct
service from TAP — it would need its own route, its own body-sniffing
(the C1 HTTP-200-HTML-outage lesson applies to `/data-server/` too), and
the AIP mirror does **not** obviously serve the same DataLink endpoint
(C1 found AIP mirrors `gaia_source` with a different *format* contract;
DataLink parity was not verified and should not be assumed).

---

## D1.2 — Real measured point-counts and sizes (not estimates)

**All four objects, live DataLink discovery this session:**

| Object | EPOCH_PHOTOMETRY product present? | Other products returned |
|---|---|---|
| Tabby's Star | **No** | MCMC MSC, XP sampled, XP continuous |
| HAT-P-7 | **Yes** | (+ the epoch photometry access_url) |
| WASP-126 | **No** | MCMC MSC, XP sampled, XP continuous, MCMC GSP-Phot, RVS mean spectra |
| K2-22 | **No** | MCMC MSC only |

**HAT-P-7 — the only object with real epoch data — measured:**

| Quantity | Measured value |
|---|---|
| Total transit rows | ~42–45 (CSV, one row per FoV transit) |
| Usable G-band epochs | ~40 (2 empty G flux, 1 row no G) |
| BP epochs | 42 |
| RP epochs | 42 |
| CSV columns | 25 (retrieval CSV) / 47 (raw datamodel) |
| Time column | `g_transit_time`, BJD in TCB − 2 455 197.5 d (T0 = 2010-01-01) |
| First / last G epoch | 1731.485 → 2681.544 (days from 2010-01-01) |
| **Time baseline** | **~950 days ≈ 2.6 years** (≈ 2014.7 → 2017.3, the DR3 34-month window) |
| **G_transit_mag range** | **10.352 → 10.376 → span 0.024 mag peak-to-peak** |
| G_transit_mag mean | 10.367 |
| Rows flagged `variability_flag_g_reject=true` | 6 of ~40 |
| Response size (CSV) | ~28 KB |
| Latency | comparable to a TAP round-trip (~1–2 s warm); two-step (discovery + retrieval) |

The mean (10.367) matches the C1 `gaia_source` `phot_g_mean_mag` (10.368)
to 0.001 mag — a nice cross-check that the epoch product is the same
source.

**Confirming the sparse-cadence assumption:** ~40 G-band epochs over 2.6
years is **~15 epochs/year**, i.e. one measurement every ~24 days on
average, clustered irregularly by Gaia's scanning law (three
observations land within seconds of each other at 2681.5439 — a single
FoV transit's CCD sequence — then months of gap). This is exactly the
"~20–40 revisits over the mission" the task described, **confirmed with
real numbers for a real object**, not assumed. It is ~1,500× sparser
than one Kepler quarter alone (~4,000 long-cadence points/90 days).

---

## D1.3 — Would it be visually / scientifically meaningful?

**As a "light curve comparable to the Kepler/TESS viewer": no.** Two
independent reasons, both from the measured HAT-P-7 data:

1. **Point count.** ~40 points cannot support the existing viewer's
   interaction model — LTTB downsampling, per-dip pinning, zoom/pan
   across ~60k samples, transit-window inspection. There is nothing to
   downsample and no dip to pin. It would be a scatter plot wearing a
   light-curve viewer's clothes.

2. **No phase coherence with the physical signal.** HAT-P-7b is a
   2.2-day-period hot Jupiter with a ~0.7% (~7,000 ppm) transit lasting
   ~4 hours. Forty epochs scattered pseudo-randomly across 2.6 years
   sample that ephemeris essentially at random — the odds of catching
   mid-transit are ~4h/53h ≈ 7% per epoch, so ~3 of 40 points *might*
   sit in transit, indistinguishable from noise. And the measured G
   scatter is **0.024 mag peak-to-peak total**, of which the transit is
   a fraction — the rest is photometric noise and the 6 Gaia-rejected
   epochs. Without folding on a *known external* period (which defeats
   the point of "showing the star's own curve"), the transit is
   invisible. This is the same lesson as the KOI "catalog metadata ≠
   rendered curve" gotcha, one level worse: here even the raw data can't
   show the signal.

For the other three objects the question is moot — **no data to plot.**

**Is there a genuinely different, still-valuable sparse-data mode?**
Marginally, and only with honest framing. A **time-ordered G-magnitude
scatter with error bars** (40 points, x = years, y = mag, error bars from
`g_transit_flux_over_error`) *can* truthfully say: *"Gaia independently
measured this star's brightness at ~40 epochs over 2.6 years; the
spread is X mag."* That has real value as an **independent-instrument
corroboration** — the same spirit as the existing Gaia descriptive
panel (Bloque C) and the SIMBAD "also known as" block: bonus context,
absence-is-silent, never a verdict. It would pair naturally with C's
existing RUWE/RV readout as "and here is Gaia's actual photometric
sampling," for the rare source that has it.

But note what it is **not**: it is not a transit curve, not zoomable to a
dip, not comparable to the Kepler viewer, and **present for well under
half of even our hand-picked bright test objects** (1 of 4; far worse
for faint KOI hosts, which mostly aren't even in SIMBAD per Bloque B).
Its natural home is a **small static sparkline inside the existing Gaia
section**, not a new fullscreen viewer.

---

## Honest recommendation

**Do not build a second (Gaia) light-curve viewer.** The data doesn't
support the interaction model, and it's absent for the objects that
matter most to this project (Tabby's Star: nothing; 3 of 4 test objects:
nothing).

**Optionally, later — a low-priority sparkline, not a viewer:** if a
lightweight "Gaia sampled this star N times over M years (spread X mag)"
sparkline is ever wanted, it would live *inside* the existing Bloque-C
Gaia panel, gated on the DataLink EPOCH_PHOTOMETRY product existing,
silent when absent, and framed strictly as independent sampling — never
a transit curve. That is the only shape that survives contact with the
real data. It is explicitly **not** recommended for now and would be its
own scoped issue if pursued.

**Genuinely unclear / would need more before any build:** DataLink
service reliability + the AIP-mirror parity question (C1's HTTP-200-HTML
outage mode was on `/tap-server/`; whether `/data-server/datalink` fails
the same way, and whether AIP mirrors it at all, was not verified this
session). Name that as the open item if the sparkline is ever revisited.

---

## Things that surprised me / didn't smooth over

1. **Epoch photometry is NOT a TAP table** — it's a two-step DataLink
   Massive-Data retrieval on a different service path. Anyone assuming
   "it's just another `SELECT` like `gaia_source`" would build the wrong
   thing. (Confirmed, not assumed.)

2. **The absence signal is silent, not an error.** A source without
   epoch photometry just omits the EPOCH_PHOTOMETRY row from the DataLink
   listing — same "absence is not news" shape as SIMBAD misses. Good for
   a bonus-context design, but it means you can't distinguish "no data"
   from "asked wrong" without checking the `has_epoch_photometry` flag
   first.

3. **HAT-P-7's real epoch scatter is 0.024 mag over 40 points** — I
   expected sparse, but seeing that the *entire* peak-to-peak range is
   0.024 mag (transit + noise + 6 rejected epochs combined) made it
   concrete that even the one object *with* data can't show its transit.
   The "sparse cadence" assumption wasn't just confirmed — it's
   understated. Sparse *and* shallow-relative-to-noise.

4. **WASP-126 has RVS mean spectra but no epoch photometry**, while
   HAT-P-7 has epoch photometry but no useful RVS variability — the two
   time-series data types don't co-occur even on our bright FGK dwarfs.
   No single object in the set would populate a combined "Gaia time
   series" panel richly.

---

## Sources

- **`gaiadr3.epoch_photometry` datamodel + "not available through TAP,
  delivered via DataLink Massive Data"** — [Gaia DR3 Documentation, Part
  V, ch. 20.7.1 epoch_photometry](https://gea.esac.esa.int/archive/documentation/GDR3/Gaia_archive/chap_datamodel/sec_dm_photometry/ssec_dm_epoch_photometry.html)
  (verified: access-method quote + column list + time-reference
  definition).
- **DataLink retrieval service (endpoint, RETRIEVAL_TYPE,
  DATA_STRUCTURE, 5000-source cap, anonymous access)** — [COSMOS: How to
  extract Gaia ancillary data using DataLink](https://www.cosmos.esa.int/web/gaia-users/archive/datalink-products)
  and live GETs against
  `https://gea.esac.esa.int/data-server/datalink/links` and
  `…/data-server/data` this session.
- **DR3 variable-source counts / epoch-photometry context (12.4M
  variables; 270,905 RR Lyrae; 15,006 Cepheids released with multiband
  epoch photometry)** — [Gaia DR3: All-sky classification of 12.4 million
  variable sources, A&A 674 A16 (2023)](https://www.aanda.org/articles/aa/full_html/2023/06/aa45591-22/aa45591-22.html)
  and [Gaia DR3: RR Lyrae and Cepheid sample papers, A&A 674 A18 / A17](https://arxiv.org/html/2206.06278).
- **DR3 photometry provenance (≥5 FoV G measurements per source; Riello
  et al. 2021)** — [Gaia EDR3: Photometric content and validation, A&A
  649 A3](https://www.aanda.org/articles/aa/full_html/2021/05/aa39587-20/aa39587-20.html).
- **All per-object measured values (row counts, mag range, time span,
  size)** — live DataLink retrievals this session for source_ids
  2129256395211984000 (HAT-P-7), 2081900940499099136 (Tabby),
  4666498154837086208 (WASP-126), 3811002791880297600 (K2-22).
