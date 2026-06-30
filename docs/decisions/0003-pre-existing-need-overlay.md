---
status: "accepted"
date: 2026-06-30
deciders: tdowning
---

# Overlaying pre-existing humanitarian need (HNO 2025) as a selectable "exposed & in need" metric

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
placeholder. Fetched to bronze by `fetch_hno.py` (PiN per sector — intersectoral,
Shelter, WASH, Health, Nutrition, Food security, Education, Protection — plus
population per municipio).

1. **Treat need like exposure: a selectable "exposed & in need" metric.** The HNO
   gives PiN **counts** per sector, not a severity phase. So per admin per sector
   we derive a prevalence (PiN / population), assume it is **uniform across the
   admin**, and compute

   ```
   exposed_in_need(admin, source, sector) = exposure(source) × min(1, PiN_sector / population)
   ```

   The page adds a **sector selector** beside the source selector; choosing a
   sector turns every exposure figure (map, table, cards) into exposed-&-in-need
   for that sector. "— exposure only —" leaves plain exposure.
   - We rejected a single *severity tier* (an earlier iteration): the **official
     JIAF phase isn't open**, and tiering on intersectoral PiN-per-capita is
     nearly flat for VE (most municipios 26–37%) — uninformative. Per-sector
     prevalence applied to exposure is more honest and more useful.
2. **Join by `state + municipio` name, not pcode.** The HNO uses legacy `VE####`
   pcodes; our admin boundaries use FieldMaps `VEN-<date>-##-##`. Municipio names
   like "Libertador"/"Sucre" repeat across states, so the join key is normalised
   *state + municipio* (accent-folded). Matches 92/95 of our assessed municipios
   (98.5% of exposure); misses / sectors absent → "no HNO data" (transparent).
3. **A cross-sector summary panel.** For the current source, a small bar panel
   shows national exposed-&-in-need across all sectors (click a bar to select it).

### Consequences

* Good: answers "of the people whose homes were damaged, how many were already in
  need for sector X" — directly, from authoritative data, for any sector.
* Good: name-join sidesteps the pcode-scheme mismatch; coverage ~98.5%.
* Neutral / honest: the uniform-prevalence assumption means the damaged-area
  population is assigned the admin-average need rate (it may well be higher);
  this is **not** the official JIAF severity phase. The page/footer say so.
* Bad / accepted: name-join is brittle to spelling (a few municipios unmatched);
  some municipio×sector cells lack PiN and show as no-data. 2025 baseline
  slightly predates the June 2026 event (2026 admin data not yet published).

## More Information

If OCHA later publishes the JIAF intersectoral severity phase per municipio (or a
2026 admin-level HNO), swap it in behind the same name-join scaffold. Sector list
lives in `estimate_exposure.SECTORS` / `fetch_hno.SECTOR_CODES`.
