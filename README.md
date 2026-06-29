# ds-geospatial-impact-exposure

Population exposure for multi-source satellite damage estimates.

This is a **read-only downstream consumer** of
[`ds-geospatial-impact-estimates`](https://github.com/OCHA-DAP/ds-geospatial-impact-estimates)
(the "damage viewer"). It takes that project's harmonized, per-building damage
flags — which Overture buildings each source (Microsoft, Copernicus EMS, IMPACT
SAR, OSU S1 coherence) flagged damaged — estimates the **population in each
damaged building** from WorldPop, and aggregates **per source per admin
division**. Output is a small static page on GitHub Pages.

It never writes to the viewer's lake; its own outputs land under this project's
prefix.

## Method (see [ADR-0001](docs/decisions/0001-dasymetric-building-population-exposure.md))

Area-weighted **dasymetric redistribution** at 100 m:

```
pop(building) = worldpop_cell × footprint_area / Σ(footprint_area in that cell)
```

A WorldPop 100 m cell holds many buildings; we split each cell's people among
the buildings whose centroid falls in it, weighted by footprint area (so the
cell's population is conserved and larger structures get more people). We then
sum over each source's *damaged* buildings, plus `any` (union of all four
sources) and `agree2` (≥ 2 sources agree on a building — the most robust figure).

These are **detected** damaged-building populations: each source assessed only
part of the country, so they are a floor, not a total.

## Pipeline

```bash
uv sync
# 1. fetch the 100 m constrained WorldPop for VE into this project's bronze
uv run python pipelines/fetch_worldpop.py
# 2. join damage flags + Overture base, redistribute population, aggregate, emit
uv run python pipelines/estimate_exposure.py
```

`estimate_exposure.py` writes:

| output | where | what |
|---|---|---|
| `exposure_by_admin.parquet` | blob `processed/exposure/adm0=VE/` | tidy long table (level, pcode, metric, pop_exposed, n_damaged) |
| `exposure.json` | `web/data/` | per-admin per-source figures for the page |
| `adm1.geojson`, `adm2.geojson` | `web/data/` | simplified admin boundaries for the map |

## Data sources

| input | from |
|---|---|
| per-building damage flags (`building_flags`) | viewer gold `model=common/adm0=VE` |
| Overture building base (footprints) | viewer silver `source=overture/adm0=VE` |
| admin boundaries (CODAB adm1/adm2) | viewer bronze `source=codab/adm0=VE` |
| population (WorldPop 100 m constrained, 2026 R2025A) | WorldPop portal → this project's bronze |

## Config

Set `GIEX_BLOB_ACCOUNT_PREFIX` in a local `.env` (see `.env.example`). SAS tokens
are read from the shared shell environment (`DSCI_AZ_BLOB_{DEV,PROD}_SAS[_WRITE]`,
the same ones `ocha-stratus` uses) — never committed.

## Web

`web/` is a self-contained static page (MapLibre choropleth + sortable table)
served via GitHub Pages from the `gh-pages` deploy workflow. It reads only the
generated files in `web/data/`.
