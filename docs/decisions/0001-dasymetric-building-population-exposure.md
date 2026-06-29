---
status: "partially superseded by 0002"
date: 2026-06-29
deciders: tdowning
---

> **Note:** decisions 1 (all-building base) and 4 (raw footprint-area weight) are
> superseded by [ADR-0002](0002-residential-only-and-clamped-area-weight.md):
> the base is now residential-only and the weight is *clamped* footprint area, and
> the metric is framed as "residents of damaged buildings" (displacement, not
> casualties). The dasymetric principle and 100 m WorldPop choice (decisions 2–3)
> still stand.

# Population exposure as area-weighted dasymetric people-per-damaged-building

## Context and Problem Statement

The `ds-geospatial-impact-estimates` viewer harmonizes four satellite damage
sources (Microsoft, Copernicus EMS, IMPACT SAR, OSU S1 coherence) onto a single
Overture building base and reports, per admin unit, how many buildings each
source flagged damaged. The natural next question for a humanitarian response is
**how many people** are in those damaged buildings. This project answers it
without touching the viewer repo: it reads the viewer's lake, attaches a
population estimate to each building, and aggregates per source per admin.

How should we turn "this building is damaged" into "this many people"?

## Decision Drivers

* Damage is spatially clustered (a coastal strip of La Guaira, not spread evenly
  across the state), so the estimate must be **building-level**, not a
  state-population × damage-rate fraction that smears the disaster.
* Reuse the viewer's harmonization — its `building_flags` already says which
  source flagged which Overture building — rather than re-deriving damage.
* Be honest: each source assessed only part of the country, so the result is a
  **floor** (detected), not a census.
* Keep it a small, static, reproducible artifact (GH Pages); no live backend.

## Considered Options

* **Admin damage-rate × admin population.** `damaged_buildings / total_buildings
  × WorldPop(admin)`.
* **Naive raster sampling.** Read the WorldPop value under each building.
* **Area-weighted dasymetric redistribution.** Split each WorldPop cell's people
  among the buildings whose centroid falls in it, weighted by footprint area.

## Decision Outcome

Chosen: **area-weighted dasymetric redistribution**, at **100 m** WorldPop.

```
pop(building) = worldpop_cell × footprint_area / Σ(footprint_area in that cell)
```

1. **Dasymetric, not naive sampling.** A 100 m cell holds many buildings; reading
   the cell value per building would assign the whole cell's population to *each*
   building (overcount ≈ buildings-per-cell). Redistributing by footprint area
   conserves each cell's people and gives larger structures more occupants — a
   standard building-based dasymetric estimate. The denominator needs **every**
   building in the cell, so the pipeline drives off the full Overture base, not
   just the damaged set.
2. **100 m WorldPop, constrained, matching vintage.** The team blob only mirrors
   1 km WorldPop — too coarse to redistribute to footprints — so we fetch the
   *same* vintage at 100 m (`Global_2015_2030/R2025A/2026/VEN`, `CN` =
   constrained: population only where buildings exist). Constrained + 100 m keeps
   the redistribution sharp and avoids spreading people over empty land.
3. **Centroid binning.** A building is assigned to the cell its centroid lands
   in (not split across cells it straddles). At 100 m vs typical footprints the
   edge error is negligible and the implementation is a vectorized index, not a
   per-building raster intersect over ~2 M buildings.
4. **Report per-source plus union and agreement.** Sources overlap, so we never
   sum across them. We report each source's exposed population, plus `any`
   (union) and `agree2` (≥ 2 sources flag the same building). `agree2` is the
   most decision-useful — robust to any single source's false alarms.

### Consequences

* Good: numbers are conserved (Σ building pop ≈ Σ WorldPop in footprints) and
  attributable to clustered damage; the agreement figure is a built-in
  cross-validation of the four sources.
* Good: read-only on the viewer lake — no risk to it; output is a few hundred KB
  of JSON/GeoJSON, trivially hosted on GH Pages.
* **Bad / honest caveat:** it is a *detected* floor. A source's number is bounded
  by its coverage (OSU ~77 %, etc.); low numbers can mean "little damage" or
  "little assessed". The page labels this explicitly.
* Neutral: WorldPop residential modelling and the area (not volume) weighting
  ignore building height/occupancy type. A height- or floor-area weighting (if
  Overture height is present) is a clean v2.
* Neutral: bound to WorldPop 2026 R2025A constrained and the viewer's Overture
  vintage; both are the current canonical inputs.

## Pros and Cons of the Options

### Area-weighted dasymetric (chosen)
* Good: spatially faithful to clustered damage; conserves cell population.
* Good: reuses the viewer's per-building harmonization directly.
* Bad: needs the full building base for the per-cell denominator (more I/O).

### Naive raster sampling
* Good: trivial.
* Bad: systematically overcounts by the number of buildings per cell — unusable
  at 100 m.

### Admin damage-rate × admin population
* Good: needs no building base.
* Bad: assumes damage is uniform across the admin unit — exactly false for an
  earthquake; throws away the building-level signal the viewer worked to build.

## More Information

WorldPop 100 m constrained, R2025A, 2026 (`ven_pop_2026_CN_100m_R2025A_v1.tif`),
EPSG:4326. Damage flags and the Overture base come from
`ds-geospatial-impact-estimates` (gold `building_flags`, silver
`source=overture`); admin boundaries from its bronze CODAB. Revisit: (1)
floor-area / height weighting if Overture height coverage is good; (2) a 100 m
mirror of WorldPop on the team `raster` container so the fetch step can drop.
