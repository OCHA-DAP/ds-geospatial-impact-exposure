---
status: "accepted"
date: 2026-06-29
deciders: tdowning
supersedes: "0001 (decisions 1 & 4: the all-building base and raw-area weight)"
---

# Residential-only base, clamped-area weight, and an honest "residents" framing

## Context and Problem Statement

ADR-0001 redistributed WorldPop to **all** building footprints weighted by **raw
footprint area**. Two problems surfaced:

1. **WorldPop is a *residential* distribution** (census home-counts; where people
   sleep). Spreading it over *all* buildings hands residential population to
   warehouses, malls and civic buildings, and — more importantly — invites the
   wrong reading of the result as "people who were inside at the moment of the
   quake". Those are different quantities, and a residential layer only answers
   the first.
2. **Raw footprint area over-weights large footprints.** A single big building
   (often non-residential, and frequently *untagged*) can vacuum up a cell's
   population. Footprint area is also a weak occupancy proxy with no vertical
   information.

The ideal weight is **volume** (area × height), but Overture height/num_floors
coverage in Venezuela is ≤ 1% (measured), so a volume weight would be raw-area
weighting wearing a hat. And Overture subtype/class coverage is ~3% — so a strict
"subtype = residential" filter would delete ~97% of the base.

## Decision Drivers

* Make the number mean one defensible thing: **residents of damaged buildings**
  (a displacement / shelter signal), explicitly not casualties.
* Work within sparse Overture tagging (~97% of VE buildings are untagged).
* Keep the building-level weighting *proportionate* — it is a second-order error
  next to WorldPop's own model error, the damage detectors' coverage/false-alarm,
  and the residential split. Don't over-engineer it.

## Considered Options

* **Weight:** volume (area × height) · raw footprint area · **clamped footprint
  area** · equal-per-building (count).
* **Residential filter:** strict (`subtype = residential` only) · **exclude
  explicitly non-residential, keep untagged** · none.

## Decision Outcome

1. **Residential filter = exclude explicitly-tagged non-residential, keep untagged
   + residential.** We pull Overture attributes back (`fetch_overture_attrs.py`,
   the tagged ~3% only) and drop buildings whose `subtype` is non-residential
   (commercial, industrial, civic, education, outbuilding, …) or whose `class`
   names a non-residential structure when subtype is null. Untagged buildings —
   the residential majority in barrio neighbourhoods — are kept. Non-residential
   buildings leave **both** the numerator and the cell denominator, so residential
   population flows only to homes.
2. **Weight = footprint area, clamped** to `[30 m², 99th-percentile]`. Keeps the
   size signal (apartment block > shack) and degrades to ~count in uniform
   barrios, while the cap stops a stray large *untagged* footprint (a stadium, an
   unmapped warehouse) from dominating a cell. We rejected a volume weight (no
   height) and pure count (loses the size signal).
3. **Relabel as "residents of damaged buildings".** The page, JSON `meta`, and
   titles now say residents / homes-damaged, with a caveat that this is a
   displacement signal and **not** occupancy-at-impact or casualties (for which we
   point to USGS PAGER). Time-of-day ("what if people weren't home?") does not
   affect a *displacement* estimate — a destroyed home displaces its household
   regardless of where they were when it shook.

### Consequences

* Good: the headline is now a clean, defensible humanitarian quantity; the worst
  area-weighting distortion (large non-residential footprints) is removed at the
  source.
* Good: cheap and robust — one small attribute pull, a boolean filter, a clamp.
* Neutral: only the *tagged* non-residential (~3%) can be excluded; untagged
  non-residential (sheds, the odd unmapped warehouse) remain, mitigated by the
  area cap.
* Bad / accepted: no vertical density. Apartment blocks are under-weighted vs a
  true volume estimate. This is the standing v2.

## More Information

A genuine volume weight is feasible from a *raster* height product rather than
sparse per-building tags — **Google Open Buildings 2.5D Temporal** covers
Venezuela (~4 m, building heights) and would let us sample height per footprint.
Deferred because (a) the affected coast (La Guaira / Caracas barrios) is mostly
low-rise, so height buys little there, and (b) intra-cell weighting is dominated
by larger error sources. Revisit if the method is reused where mid/high-rise
housing dominates. Clamp bounds (`AREA_FLOOR_M2`, `AREA_CAP_PCTL`) are tunable in
`estimate_exposure.py`.
