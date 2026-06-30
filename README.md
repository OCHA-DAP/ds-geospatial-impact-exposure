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

## Method (see [ADR-0001](docs/decisions/0001-dasymetric-building-population-exposure.md), [ADR-0002](docs/decisions/0002-residential-only-and-clamped-area-weight.md))

Area-weighted **dasymetric redistribution** of *residential* population at 100 m:

```
pop(building) = worldpop_cell × clamp(footprint_area) / Σ(clamp(footprint_area) in that cell)
```

WorldPop is a residential distribution, so we redistribute it over **residential
buildings only** (non-residential excluded — ADR-0002) and split each 100 m
cell's people among the homes whose centroid falls in it, weighted by **clamped**
footprint area (floor 30 m², cap 99th percentile — keeps the apartment-block
signal without letting a stray large footprint dominate). We then sum over each
source's *damaged* buildings, plus `any` (union of all four sources) and `agree2`
(≥ 2 sources agree on a building — the most robust figure).

The result is an estimate of **residents of damaged buildings** — a displacement /
shelter signal, *not* people inside at the moment of the quake (for casualties see
USGS PAGER). And it is **detected**: each source assessed only part of the country,
so it is a floor, not a total.

## Pipeline

```bash
uv sync
# 1. fetch the 100 m constrained WorldPop for VE into this project's bronze
uv run python pipelines/fetch_worldpop.py
# 2. fetch Overture building attributes (subtype/class) for the residential filter
uv run python pipelines/fetch_overture_attrs.py
# 3. fetch the HNO 2025 People-in-Need (per municipio) for the pre-existing-need overlay
uv run python pipelines/fetch_hno.py
# 4. join damage flags + Overture base, residential-filter, redistribute, aggregate,
#    overlay HNO shelter-need tiers
uv run python pipelines/estimate_exposure.py
# 4. (optional) validation layers: damaged footprints -> PMTiles + WorldPop -> PNG
#    needs tippecanoe on PATH (brew install tippecanoe)
uv run python pipelines/build_validation_layers.py
```

`estimate_exposure.py` writes:

| output | where | what |
|---|---|---|
| `exposure_by_admin.parquet` | blob `processed/exposure/adm0=VE/` | tidy long table (level, pcode, metric, pop_exposed, n_damaged) |
| `exposure.json` | `web/data/` | per-admin per-source figures for the page |
| `adm1.geojson`, `adm2.geojson` | `web/data/` | simplified admin boundaries for the map |

`build_validation_layers.py` (for `web/validate.html`) writes
`buildings.pmtiles` (~340k damaged footprints, vector tiles, per-building
population on hover) and `worldpop.png` (the 100 m grid as a colorized overlay) —
a zoom-in validation view: building colour vs the population grid underneath.

## Data sources

| input | from |
|---|---|
| per-building damage flags (`building_flags`) | viewer gold `model=common/adm0=VE` |
| Overture building base (footprints) | viewer silver `source=overture/adm0=VE` |
| Overture building attributes (subtype/class, tagged only) | Overture S3 release `2026-06-17.0` → this project's bronze |
| admin boundaries (CODAB adm1/adm2) | viewer bronze `source=codab/adm0=VE` |
| population (WorldPop 100 m constrained, 2026 R2025A) | WorldPop portal → this project's bronze |
| pre-existing need (HNO 2025 PiN per municipio, incl. Shelter) | HDX → this project's bronze (joined by state+municipio name) |

## Config

Set `GIEX_BLOB_ACCOUNT_PREFIX` in a local `.env` (see `.env.example`). SAS tokens
are read from the shared shell environment (`DSCI_AZ_BLOB_{DEV,PROD}_SAS[_WRITE]`,
the same ones `ocha-stratus` uses) — never committed.

## Web

`web/` is a self-contained static page (MapLibre choropleth + sortable table)
served via GitHub Pages from the `gh-pages` deploy workflow. It reads only the
generated files in `web/data/`.
