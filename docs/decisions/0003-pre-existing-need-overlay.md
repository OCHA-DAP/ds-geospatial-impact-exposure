---
status: "accepted"
date: 2026-06-30
deciders: tdowning
---

# Overlaying pre-existing humanitarian need (HNO 2025), tiered by Shelter PiN

## Context and Problem Statement

The exposure estimate answers "how many residents had their homes damaged". The
operationally important follow-up is *where that lands relative to pre-existing
need* — damage falling on already-stressed municipios compounds the crisis. We
wanted "exposure per severity level, per admin". So we needed the Venezuela
humanitarian severity data and a way to join it to our admin units.

## Decision Drivers

* Use an authoritative, citable pre-event baseline.
* Join cleanly to our admin units (which use FieldMaps pcodes).
* Be honest about what "severity" we can actually show.

## Considered Options

* **Official JIAF intersectoral severity phase (1–5)** per municipio.
* **Intersectoral PiN per capita** as a severity proxy.
* **Shelter-cluster PiN per capita** as the severity proxy.

## Decision Outcome

Source: the standardised **HNO** People-in-Need data on HDX
(`ven_hpc_needs_api_{year}.csv`, OCHA HPC/JIAF). We use **2025** — the latest
year with admin-2 detail; the 2026 resource is only a single national
placeholder. Fetched to bronze by `fetch_overture_attrs`'s sibling
`fetch_hno.py` (intersectoral + Shelter/WASH/Health PiN + population per
municipio).

1. **Tier by Shelter-cluster PiN per capita**, into four levels (Low <5%,
   Moderate 5–10%, High 10–15%, Very high ≥15%). Rationale:
   - The **official JIAF severity phase is not in the open data** — only PiN — so
     we cannot show the phase itself.
   - **Intersectoral** PiN-per-capita is nearly flat for VE (most municipios
     26–37%), so it doesn't discriminate; tiering on it would mislead.
   - **Shelter** need varies widely (per-capita ~2% to >100% in displacement
     areas) *and* is the cluster most relevant to building damage — the right
     proxy for this product.
2. **Join by `state + municipio` name, not pcode.** The HNO uses legacy `VE####`
   pcodes; our admin boundaries use FieldMaps `VEN-<date>-##-##`. Municipio names
   like "Libertador"/"Sucre" repeat across states, so the join key is normalised
   *state + municipio* (accent-folded). This matches 92/95 of our assessed
   municipios (98.5% of exposure); the few misses fall to a "no data" tier.
3. **Surface it three ways** without changing the core metric: an *exposure-by-
   shelter-need-tier* breakdown (current source × level), per-admin `Pre-PiN` +
   shelter-tier columns in the table, and a map "shade by shelter need" toggle
   (a purple ramp, distinct from the red exposure ramp).

### Consequences

* Good: the compounding-crisis question is answerable from authoritative data,
  with an honest label (Shelter PiN tier, not a JIAF phase).
* Good: name-join sidesteps the pcode-scheme mismatch; coverage is ~98.5%.
* Neutral / honest: this is **not** the official intersectoral severity phase; the
  page and footer say so and link the HNO source.
* Bad / accepted: name-join is brittle to spelling (3 municipios unmatched until
  aliased); ~20 municipios lack Shelter PiN and show as "no data". 2025 baseline
  slightly predates the June 2026 event (2026 admin data not yet published).

## More Information

If OCHA later publishes the JIAF intersectoral severity phase per municipio (or a
2026 admin-level HNO), swap it in behind the same join + tiering scaffold. Tier
breaks live in `estimate_exposure.SHELTER_BREAKS`.
