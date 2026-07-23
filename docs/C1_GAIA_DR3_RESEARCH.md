# Bloque C1 — Gaia DR3 engine research & design findings

*Research/design only. No code written, no modules created, no existing files modified.
Measured against the live Gaia Archive on 2026-07-21.*

## TL;DR

The identity chain works end-to-end and Gaia DR3 has genuinely useful,
real data for our test objects — but the **most useful engine here is NOT
"is this star variable per Gaia's classifier"**, because Gaia's variability
tables cover only a small fraction of sources (1 of our 4 test objects,
and NOT Tabby's Star). The engine that IS backed by real data for
essentially every source is a **descriptive readout of the per-source
astrometric + RV + photometric summary statistics already in
`gaia_source`**, with Gaia's own published thresholds used to phrase
(never diagnose) the observations. Full detail below.

---

## Test set (from frozen SIMBAD fixtures)

Four of the five SIMBAD fixtures carry a Gaia DR3 `source_id` in their
cross-IDs; M31 does not (it's a galaxy — expected, and a nice negative
control that the chain won't hallucinate one).

| Object | App id | Gaia DR3 source_id |
|---|---|---|
| Tabby's Star | KIC 8462852 | 2081900940499099136 |
| HAT-P-7 | KIC 10666592 | 2129256395211984000 |
| WASP-126 | TIC 25155310 | 4666498154837086208 |
| K2-22 | EPIC 201637175 | 3811002791880297600 |

---

## C1.1 — Access, query pattern, latency, size, contract surprises

**Endpoint**: `https://gea.esac.esa.int/tap-server/tap/sync`, table
`gaiadr3.gaia_source`. Same sync-TAP/ADQL pattern already used for MAST
and NASA Exoplanet Archive. **No auth, no API key** for anonymous sync
queries at our volume (one query per user click).

**Query pattern — CONFIRMED: `source_id`-direct, not cone search.** We
already hold the `source_id` from SIMBAD, so
`WHERE source_id = <n>` is exact, unambiguous, and index-backed. Cone
search would reintroduce the position-match ambiguity SIMBAD already
resolved for us. Use the direct lookup.

**Latency**: ~1.0–1.6 s warm for a single-source `gaia_source` query;
first query of a session ~4.2 s cold. `vari_summary` full-row ~1.5 s.
Comparable to the MAST TAP round-trip.

**Response size** (single source):
- `gaia_source`, ~19 useful columns → **~5.4 KB JSON** (ESAC) / ~6.0 KB VOTable.
- `vari_summary`, all 68 columns → **~17 KB VOTable** (only for the rare source that's in it).
- `vari_classifier_result`, 4 columns → ~2.4 KB.

All tiny. A per-source disk cache (same pattern as the identity/lightcurve
caches) is trivially affordable; Gaia DR3 is a frozen historical release,
so a long TTL like the identity cache's 30 days is appropriate.

### ⚠ Contract surprises found (the "measure first" payoff)

1. **ESAC returns a VOTable XML *error envelope* even with `FORMAT=json`.**
   A bad column name → HTTP 400 + XML `<INFO name="QUERY_STATUS"
   value="ERROR">`, not JSON. Identical in spirit to SIMBAD's XML-on-error
   and VizieR's `#INFO QUERY_STATUS=ERROR` behavior. The future parser
   must detect this envelope and not assume JSON on a non-200.

2. **ESAC serves an outage as HTTP 200 + an HTML "ESDC Archives downtime"
   page — NOT a 5xx.** This actually happened *mid-session*: my first
   Tabby query succeeded, then the whole `gea.esac.esa.int` TAP front
   (including the `/availability` VOSI endpoint) began returning a 9505-byte
   maintenance HTML page with status 200. **Status code alone cannot detect
   a Gaia outage** — the route must sniff the body (`<VOTABLE`/JSON magic
   vs `<html`), exactly the lesson from the VizieR silent-fallback audit.
   The health check (a future #8) should assert a real column comes back,
   not just reachability.

3. **Partner-mirror fallback exists and works.** The downtime page itself
   points to partner data centres. I completed the other three objects
   against the **AIP mirror** `https://gaia.aip.de/tap/sync`, which serves
   the identical `gaiadr3.gaia_source` schema and returned byte-identical
   values for Tabby (cross-checked against the ESAC result before ESAC
   went down). Caveat: **AIP rejects `FORMAT=json`/`FORMAT=csv`** and
   returns VOTable XML regardless. So the mirrors are not drop-in URL
   swaps — format handling differs. Worth recording as a known
   fallback, but the primary contract is ESAC.

---

## C1.2 — What the engine should describe (recommendation)

Measured, per test object (live values):

| metric | Tabby | HAT-P-7 | WASP-126 | K2-22 |
|---|---|---|---|---|
| `phot_g_mean_mag` | 11.759 | 10.368 | 11.066 | 14.934 |
| `phot_variable_flag` | NOT_AVAILABLE | **VARIABLE** | NOT_AVAILABLE | NOT_AVAILABLE |
| `ruwe` | 0.815 | 0.977 | 0.750 | 0.996 |
| `astrometric_excess_noise` | 0.059 | 0.092 | 0.068 | 0.0 |
| `ipd_frac_multi_peak` | 0 | 0 | 0 | 0 |
| `radial_velocity` (km/s) | −0.461 | −10.228 | 29.507 | — |
| `radial_velocity_error` | 3.906 | 0.254 | 0.292 | — |
| `rv_nb_transits` | 17 | 20 | 22 | — |
| `rv_chisq_pvalue` | 0.0 | 0.725 | 0.368 | — |
| `rv_renormalised_gof` | 10.905 | −0.272 | 0.350 | — |
| `non_single_star` | 0 | 0 | 0 | 0 |
| `has_epoch_photometry` | False | True | False | False |
| `has_rvs` | False | False | True | False |
| in `vari_summary`? | **no** | **yes** | no | no |
| in `vari_classifier_result`? | no | yes (`EP`, score 1.0) | no | no |

### Recommendation, metric by metric

**1. RUWE — YES, describe it.** Populated for all 4 (real floats, not
null). This is the single most broadly-available, most interpretable
Gaia metric for our purpose. Descriptive framing: report the value and
whether it sits below/above the well-behaved-single-star band. NOT
"binary"/"not binary".

**2. Radial-velocity variability — YES, describe it *when present*.**
Populated for the 3 brighter FGK dwarfs; **null for K2-22** (G=14.9,
too faint for the RVS spectrograph — `has_rvs=False`, all RV columns
null). So this is a *conditional* readout: present it only when
`rv_nb_transits` is non-null. This is the richest finding —
see the Tabby result under C1.3.

**3. Gaia's ML variability classification (`vari_classifier_result` /
`vari_summary`) — describe it ONLY when the source is actually in the
table, and treat absence as "no statement", never "not variable".**
This is the big caveat. Only **1 of 4** objects (HAT-P-7) is in
`vari_summary`/`vari_classifier_result`. When present it's rich: 68
populated columns of per-band amplitude stats plus a class
(HAT-P-7 → `EP`, eclipsing/planetary-transit, score 1.0,
`in_vari_planetary_transit=True`, G range 0.0219 mag). But **Tabby's
Star — the most famous irregular dipper in the Kepler field — is NOT in
these tables at all.** So an engine built *primarily* on Gaia's
variability classification would be silent on our flagship object. This
should be a *bonus* layer shown when data exists, exactly like the
SIMBAD "ALSO KNOWN AS" block — never a core feature, and its absence is
not news.

**4. Photometric variability *amplitude* from `gaia_source` alone —
describe with care.** `gaia_source` gives mean mags + `phot_*_n_obs`
but NOT a per-source amplitude/scatter (that lives in `vari_summary`,
which most sources aren't in). `phot_variable_flag` is the only
`gaia_source` variability signal, and see the trap below.

**5. `non_single_star` / `ipd_frac_multi_peak` / `astrometric_excess_noise`
— describe as supplementary astrometric-multiplicity context.** All
populated. `non_single_star=0` for all four (none has a dedicated NSS
solution). Cheap to include alongside RUWE.

**Do NOT propose describing**: epoch photometry / RVS time series as a
core feature — `has_epoch_photometry=True` for only HAT-P-7 and
`has_rvs=True` for only WASP-126 among our set, and pulling the actual
epoch series is a DataLink download, not a `gaia_source` column. Out of
scope for a summary-statistics engine.

---

## C1.3 — Published calibration thresholds (sourced)

**RV variability (the headline criterion).** Gaia DR3's own documented,
conservative criterion for calling a source RV-variable is **more
specific than the phrasing in the task** — it carries two extra guards:

> `rv_nb_transits ≥ 10 & rv_template_teff ∈ [3900, 8000] K &
> rv_chisq_pvalue ≤ 0.01 & rv_renormalised_gof > 4`

Source: Katz et al. 2023, *Gaia DR3: Properties and validation of the
radial velocities*, A&A 674, A5 — the official DR3 RV validation paper.
The `≥10 transits` and `teff ∈ [3900,8000]` guards matter: the indices
are only reliable with enough measurements and for stars whose RV
template is trustworthy. **The task's phrasing
(`rv_chisq_pvalue <= 0.01 & rv_renormalised_gof > 4`) is the core of it
but drops these two guards — we should use the full four-part form.**

Applying the full criterion to measured data (all three RVS objects have
`rv_template_teff` in range: Tabby 6250 K, HAT-P-7 6500 K, WASP-126 5750 K):

| object | n≥10 | teff∈[3900,8000] | p≤0.01 | gof>4 | → RV-variable? |
|---|---|---|---|---|---|
| Tabby | ✓ (17) | ✓ (6250) | ✓ (0.0) | ✓ (10.9) | **YES** |
| HAT-P-7 | ✓ (20) | ✓ (6500) | ✗ (0.725) | ✗ (−0.27) | no |
| WASP-126 | ✓ (22) | ✓ (5750) | ✗ (0.368) | ✗ (0.35) | no |
| K2-22 | — no RVS data — | | | | n/a |

**RUWE.** No single ESA-blessed hard cutoff. The **RUWE ≈ 1.4**
good-astrometric-fit breakpoint originates with **Lindegren 2018** (the
DR2 RUWE technical note), who located it as the break in the RUWE
distribution of a 100 pc sample where the near-1.0 single-star peak gives
way to a high tail. **Belokurov et al. 2020** then established elevated
RUWE (illustratively `RUWE > 1.4`) as a *selector of unresolved
binaries*, translating the value to companion separation and validating
it against known spectroscopic binaries — though it treats RUWE as a
continuous diagnostic, not a hard law. So: **RUWE ≲ 1.4 = well-behaved
single-star solution; well above → possible unresolved multiplicity.**
The 1.4 value is restrictive (misses many binaries; some use ~1.25), and
future releases are *predicted* to tighten (DR4 ≈ 1.15, DR5 ≈ 1.11 —
Guerriero, Penoyre & Brown, arXiv:2511.02476, which is about those
forward predictions, NOT the DR3-era 1.4 convention). For a descriptive
readout, report the value against the 1.4 reference band and cite it as a
convention, not a law.

**Photometric `phot_variable_flag` — ⚠ SEMANTIC TRAP (biggest finding
for "describe, don't diagnose").** In DR3 this column takes only two
values: `VARIABLE` and `NOT_AVAILABLE`. **There is NO `CONSTANT` value.**
The official DR3 variability/data-model documentation (CU7, chap. 10)
states both halves: a source is `VARIABLE` iff it appears in one of the
`vari_*` tables, and non-appearing sources get `NOT_AVAILABLE` — there is
no `CONSTANT` value, so **`NOT_AVAILABLE` means "not identified as
variable during DR3's intermediate processing" — explicitly NOT a claim
that the star is constant.** (Eyer et al. 2023, A&A 674 A13, corroborates
the `VARIABLE`-iff-in-a-`vari_*`-table half but does not itself spell out
the two-value/no-`CONSTANT` point — that is the CU7 documentation's.) So we must never render `NOT_AVAILABLE` as
"not variable" / "stable". For Tabby it literally reads `NOT_AVAILABLE`
while the star is the textbook irregular variable — rendering that as
"Gaia: not variable" would be actively wrong. Correct descriptive
phrasing: "Not flagged as variable in Gaia DR3's variability processing
(DR3 makes no constancy claim)."

Sources:
- **RV criterion** — [Katz, D., Sartoretti, P., Guerrier, A., et al. 2023, *Gaia DR3 — Properties and validation of the radial velocities*, A&A 674, A5](https://www.aanda.org/articles/aa/full_html/2023/06/aa44220-22/aa44220-22.html) (verified: exact four-part criterion quoted from the text).
- **`phot_variable_flag` two-value / no-`CONSTANT` semantics** — [Gaia DR3 CU7 variability data-products documentation, chap. 10](https://gea.esac.esa.int/archive/documentation/GDR3/Data_analysis/chap_cu7var/sec_cu7var_intro/ssec_cu7var_dataproducts.html) (verified: states `VARIABLE`/`NOT_AVAILABLE` only). Corroborating (`VARIABLE`-iff-in-`vari_*` half only): [Eyer, L., Audard, M., Holl, B., et al. 2023, *Gaia DR3 — Summary of the variability processing and analysis*, A&A 674, A13](https://www.aanda.org/articles/aa/full_html/2023/06/aa44242-22/aa44242-22.html).
- **RUWE ≈ 1.4 origin** — Lindegren, L. 2018, *Re-normalising the astrometric chi-square in Gaia DR2*, Gaia technical note GAIA-C3-TN-LU-LL-124 (introduced RUWE; located the ~1.4 breakpoint in a 100 pc sample).
- **RUWE > 1.4 as an unresolved-binary selector** — [Belokurov, V., Penoyre, Z., Oh, S., et al. 2020, *Unresolved stellar companions with Gaia DR2 astrometry*, MNRAS 496(2), 1922](https://academic.oup.com/mnras/article/496/2/1922/5849452) (verified: uses elevated RUWE for binarity; treats it as continuous, does not attribute 1.4 to itself).
- **Predicted DR4/DR5 RUWE limits (~1.15 / ~1.11), NOT the DR3 convention** — [Guerriero, Penoyre & Brown, arXiv:2511.02476](https://arxiv.org/abs/2511.02476).

---

## C1.4 — Identity chain, end-to-end

**Works, no gaps, verified through the project's real code.**

I ran the actual `parseSimbadIdentityResponse` from `src/lib/simbadIds.ts`
(via the repo's `register-ts-resolver.mjs`) against the frozen fixtures,
then fed the extracted `source_id` into a live Gaia query:

```
KIC8462852  → parseSimbadIdentityResponse(fixture) → gaiaDr3=2081900940499099136 → gaia_source ✓ (real row)
TIC25155310 → parseSimbadIdentityResponse(fixture) → gaiaDr3=4666498154837086208 → gaia_source ✓ (real row)
```

The parser already has a `gaiaDr3` field extracted via
`/^Gaia DR3 (\d+)$/` (simbadIds.ts:106) — the plumbing Bloque B built is
exactly what Bloque C needs; nothing new is required on the identity
side. The `main_id` also resolves sensibly (Tabby → `TYC 3162-665-1`,
WASP-126 → `WASP-126`).

**One gap to design around, not in the chain itself:** the chain requires
the star to *have* a Gaia DR3 id in SIMBAD. All 4 stellar fixtures do,
but faint KOI hosts frequently aren't in SIMBAD at all (Bloque B already
found most faint KOI hosts return a SIMBAD miss). For those, we'd have no
`source_id` and therefore no Gaia lookup — **unless** we later add a
direct SIMBAD→Gaia or a Gaia cone-search fallback. Recommendation:
mirror Bloque B's posture — Gaia data is *bonus context shown when the
identity resolves*, its absence is silent, not an error.

---

## Things that surprised me / didn't work as assumed

1. **Tabby's Star is invisible to Gaia's photometric variability
   pipeline** (`phot_variable_flag=NOT_AVAILABLE`, absent from
   `vari_summary` and `vari_classifier_result`) despite being the
   canonical irregular variable. If we'd designed the engine around
   "Gaia's variable-star classification" we'd have shipped something
   silent on our flagship object. This is the whole reason the
   recommendation pivots to `gaia_source` summary statistics (RUWE + RV)
   as the backbone, with the classifier as a bonus layer.

2. **`NOT_AVAILABLE` ≠ constant.** DR3 has no `CONSTANT` flag value at
   all. Easy to misread as "Gaia says it's stable". It says no such thing.

3. **The task's RV criterion was incomplete** — the official DR3 form
   adds `rv_nb_transits ≥ 10` and `rv_template_teff ∈ [3900,8000]`. Not a
   contradiction of the task, but exactly why the task said "verify
   against official docs, don't take my phrasing as ground truth."

4. **`in_vari_summary` is not a column** in `gaia_source` (my first query
   400'd on it). The correct membership signal is querying `vari_summary`
   directly, or the `has_epoch_photometry` boolean for a related-but-
   different thing.

5. **The Gaia Archive went into maintenance mid-session**, and it signals
   downtime as **HTTP 200 + HTML**, not a 5xx — so the outage was
   invisible to status-code checks and I only caught it by the body not
   parsing. The AIP partner mirror saved the session but has a *different
   format contract* (VOTable-only). Both facts belong in the C2 route
   design and the health check.

6. **`ipd_frac_multi_peak` and `non_single_star` are 0 for all four** —
   clean, unblended, no dedicated non-single-star solution. Fine as
   supplementary context but not a discriminator on this set.

---

## Suggested scope for C2 (implementation), for review — NOT built here

- `source_id`-direct `gaia_source` query; ESAC primary, body-sniff for
  the HTML-downtime + XML-error envelopes; AIP as a documented (format-
  differing) fallback, decided later.
- Descriptive readout backbone: **RUWE** (always) + **RV-variability**
  (full 4-part DR3 criterion, only when `rv_nb_transits` non-null) +
  supplementary astrometric context (`non_single_star`,
  `astrometric_excess_noise`, `ipd_frac_multi_peak`).
- Bonus layer: `vari_classifier_result` class + `vari_summary` amplitude
  stats, shown only when the source is in those tables; absence is silent.
- `phot_variable_flag` rendered with the "no constancy claim" phrasing.
- Per-source disk cache, long TTL (frozen release), schema-versioned.
- Frozen fixtures for the same 4 objects (+ a not-in-Gaia negative like
  M31 or a faint SIMBAD-miss KOI host) to pin the criteria and the
  absence-is-silent behavior, mirroring the SIMBAD fixture discipline.
- Health check #8: assert a real column returns for a known source_id
  (catches the HTML-downtime-as-200 class).
- Strictly descriptive vocabulary throughout — RUWE/RV/variability
  numbers reported, never "binary"/"planet"/"variable star" as a verdict.
```
