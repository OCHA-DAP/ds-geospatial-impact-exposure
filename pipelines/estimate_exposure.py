"""Estimate residents of damaged buildings, per source per admin division.

Pipeline (all read-only on the upstream ``ds-geospatial-impact-estimates`` lake):

  1. Pull the harmonized per-building damage flags (gold ``building_flags``), the
     Overture base (silver) + its attributes (this project's bronze, from
     fetch_overture_attrs) + CODAB admin boundaries (bronze) from the viewer lake;
     spatially join each base building to its adm1/adm2 in DuckDB. Then keep
     **residential** buildings only (drop explicitly-tagged non-residential —
     ADR-0002), because WorldPop is a residential distribution and the dasymetric
     denominator below should be homes, not warehouses.

  2. Dasymetric redistribution (the methodological crux — ADR-0001/0002):
     WorldPop is a 100 m residential grid; a footprint is far smaller. Naively
     reading the grid value per building would assign a whole cell's people to
     *every* building in it (gross overcount). Instead we split each cell's
     population among the residential buildings whose centroid falls in it,
     weighted by *clamped* footprint area:

         pop(b) = worldpop_cell * clamp(area_b) / Sigma(clamp(area) in cell)

     The clamp (floor 30 m², cap 99th pct) keeps the size signal but stops a stray
     large untagged footprint from dominating a cell. Cell population is conserved.

  3. Sum pop(b) over each source's *damaged* buildings, grouped by admin. Plus two
     cross-source figures: ``any`` (union of all four sources) and ``agree2``
     (>= 2 sources flag the same building) — the latter is the most decision-useful,
     being robust to any single source's false alarms.

The result estimates RESIDENTS of damaged buildings — a displacement / shelter
signal, NOT people inside at the moment of the quake (for casualties see USGS
PAGER). And it is DETECTED only: each source assessed part of the country, so it
is a floor, not a total.

Outputs (this project's space; upstream lake untouched):
  * blob  processed/exposure/adm0=VE/exposure_by_admin.parquet   (long, tidy)
  * web/data/exposure.json   (per-admin, per-source — for the static page)
  * web/data/adm1.geojson, web/data/adm2.geojson   (simplified, for the map)

Run: uv run python pipelines/estimate_exposure.py
"""

from __future__ import annotations

import io
import json
import os

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from azure.storage.blob import ContainerClient
from mirror import mirror_blob, mirror_prefix

from giex.config import load_settings
from giex.db import connect

ADM0 = "VE"
STAGE = "dev"
WORLDPOP_FILE = "ven_pop_2026_CN_100m_R2025A_v1.tif"
WEB_DATA = os.path.join(os.path.dirname(__file__), "..", "web", "data")

# canonical source key -> per-building damaged-flag column in building_flags
SOURCES = {
    "microsoft": "ms_dmg",
    "copernicus_ems": "cems_dmg",
    "impact_initiatives": "sar_dmg",
    "osu": "osu_dmg",
}
# human labels for the page (kept in sync with the viewer's SOURCE_LABEL)
SOURCE_LABEL = {
    "microsoft": "Microsoft",
    "copernicus_ems": "Copernicus EMS",
    "impact_initiatives": "IMPACT SAR (S1 amplitude)",
    "osu": "OSU S1 (coherence)",
    "any": "Any source (union)",
    "agree2": "Agreement (≥ 2 sources)",
}
METRICS = [*SOURCES, "any", "agree2"]
SIMPLIFY_TOL = 0.004  # ~400 m; keeps the admin GeoJSON small for the browser

# Residential filter (ADR-0002). Overture in VE is ~97% untagged, so we EXCLUDE
# only buildings explicitly tagged non-residential and KEEP untagged + residential.
# Population (WorldPop is residential) is then redistributed over homes only.
NONRES_SUBTYPE = {
    "agricultural",
    "civic",
    "commercial",
    "education",
    "entertainment",
    "industrial",
    "medical",
    "military",
    "religious",
    "service",
    "transportation",
    "outbuilding",
}
# When subtype is null but class names a clearly non-residential structure.
NONRES_CLASS = {
    "garage",
    "garages",
    "carport",
    "parking",
    "shed",
    "warehouse",
    "retail",
    "commercial",
    "industrial",
    "supermarket",
    "kiosk",
    "service",
    "hangar",
    "factory",
    "barn",
    "farm_auxiliary",
    "stable",
    "sty",
    "cowshed",
    "greenhouse",
    "silo",
    "hospital",
    "school",
    "university",
    "college",
    "government",
    "civic",
    "church",
    "mosque",
    "temple",
    "cathedral",
    "chapel",
    "shrine",
    "stadium",
    "grandstand",
    "sports_hall",
    "hotel",
    "transportation",
    "train_station",
}
# Footprint-area clamp for the dasymetric weight (ADR-0002): keeps the
# size signal but stops a stray large untagged footprint from dominating a cell.
AREA_FLOOR_M2 = 30.0
AREA_CAP_PCTL = 99  # cap = this percentile of residential footprint area


# --------------------------------------------------------------------------- #
# Step 1 — building base + damage flags + admin, via DuckDB over local mirrors
# --------------------------------------------------------------------------- #
def load_buildings(settings) -> pd.DataFrame:
    base_prefix = settings.upstream_path("silver", "source=overture", f"adm0={ADM0}")
    base_dir = mirror_prefix(base_prefix, settings.container, STAGE)
    base_glob = os.path.join(base_dir, "region=*", "*.parquet")

    flags = mirror_blob(
        settings.upstream_path("gold", "model=common", f"adm0={ADM0}", "building_flags.parquet"),
        settings.container,
        STAGE,
    )
    adm2 = mirror_blob(
        settings.upstream_path("bronze", "source=codab", f"adm0={ADM0}", "adm2.parquet"),
        settings.container,
        STAGE,
    )
    # Overture attributes (subtype/class) for the residential filter — only the
    # tagged minority is stored, so a missing id is "untagged" (see ADR-0002).
    attrs = mirror_blob(
        settings.blob_path("bronze", "overture_attrs", f"adm0={ADM0}", "building_attrs.parquet"),
        settings.container,
        STAGE,
    )

    con = connect(settings)
    print("  spatial join: base buildings -> adm2 + damage flags + attrs", flush=True)
    df = con.execute(
        f"""
        WITH base AS (
            SELECT id,
                   ST_Centroid(geometry) AS c,
                   ST_Area_Spheroid(geometry) AS area_m2
            FROM read_parquet('{base_glob}', hive_partitioning=true)
        ),
        loc AS (
            SELECT b.id, ST_X(b.c) AS lon, ST_Y(b.c) AS lat, b.area_m2,
                   a.adm1_id, a.adm2_id
            FROM base b
            LEFT JOIN read_parquet('{adm2}') a ON ST_Within(b.c, a.geometry)
        )
        SELECT l.id, l.lon, l.lat, l.area_m2, l.adm1_id, l.adm2_id,
               oa.subtype AS subtype, oa.bclass AS bclass,
               COALESCE(f.ms_dmg, false)   AS ms_dmg,
               COALESCE(f.cems_dmg, false) AS cems_dmg,
               COALESCE(f.sar_dmg, false)  AS sar_dmg,
               COALESCE(f.osu_dmg, false)  AS osu_dmg
        FROM loc l
        LEFT JOIN read_parquet('{flags}') f ON f.id = l.id
        LEFT JOIN read_parquet('{attrs}') oa ON oa.id = l.id
        """
    ).df()
    con.close()
    print(
        f"  {len(df):,} base buildings ({df['adm2_id'].notna().mean():.1%} located in an adm2)",
        flush=True,
    )
    return df


def residential_subset(df: pd.DataFrame) -> pd.DataFrame:
    """Drop explicitly non-residential buildings; keep untagged + residential.

    WorldPop is a residential distribution, so only homes should receive its
    people. With ~97% of VE Overture untagged we can only exclude the *tagged*
    non-residential set — that still removes the large warehouses/civic/retail
    footprints that distort area weighting (ADR-0002)."""
    sub = df["subtype"]
    cls = df["bclass"]
    is_nonres = sub.isin(NONRES_SUBTYPE) | (sub.isna() & cls.isin(NONRES_CLASS))
    out = df[~is_nonres].copy()
    print(
        f"  residential filter: kept {len(out):,} / {len(df):,} "
        f"(dropped {is_nonres.sum():,} tagged non-residential)",
        flush=True,
    )
    return out


# --------------------------------------------------------------------------- #
# Step 2 — dasymetric: WorldPop cell pop shared among its (residential) buildings
#          by *clamped* footprint area (ADR-0002)
# --------------------------------------------------------------------------- #
def assign_population(df: pd.DataFrame, wp_path: str) -> pd.DataFrame:
    with rasterio.open(wp_path) as src:
        arr = src.read(1).astype("float64")
        t = src.transform
        nodata = src.nodata
        h, w = arr.shape
    if t.b != 0 or t.d != 0:
        raise ValueError("WorldPop raster is not north-up; rotation not handled")
    arr[arr == nodata] = 0.0
    arr[~np.isfinite(arr)] = 0.0
    arr[arr < 0] = 0.0

    lon = df["lon"].to_numpy()
    lat = df["lat"].to_numpy()
    col = np.floor((lon - t.c) / t.a).astype(np.int64)
    row = np.floor((lat - t.f) / t.e).astype(np.int64)
    valid = (row >= 0) & (row < h) & (col >= 0) & (col < w)

    cell_pop = np.zeros(len(df), dtype="float64")
    cell_pop[valid] = arr[row[valid], col[valid]]

    # clamp footprint area: floor so tiny detections aren't starved, cap (a high
    # percentile) so a stray large untagged footprint can't dominate a cell.
    cap = float(np.percentile(df["area_m2"], AREA_CAP_PCTL))
    wgt = np.clip(df["area_m2"].to_numpy(), AREA_FLOOR_M2, cap)

    pix = np.where(valid, row * w + col, -1)
    out = df.copy()
    out["pix"] = pix
    out["cell_pop"] = cell_pop
    out["wgt"] = wgt
    wgt_sum = out.groupby("pix")["wgt"].transform("sum")
    share = np.where(wgt_sum > 0, wgt / wgt_sum, 0.0)
    out["pop"] = np.where(valid & (wgt_sum > 0), cell_pop * share, 0.0)

    total_grid = float(arr.sum())
    total_assigned = float(out["pop"].sum())
    print(
        f"  weight = footprint area clamped [{AREA_FLOOR_M2:.0f}, {cap:.0f}] m²; "
        f"WorldPop total {total_grid:,.0f}; assigned to residential buildings "
        f"{total_assigned:,.0f} ({total_assigned / total_grid:.1%} captured)",
        flush=True,
    )
    return out


# --------------------------------------------------------------------------- #
# Step 3 — aggregate per admin per source (+ union + agreement)
# --------------------------------------------------------------------------- #
def _flag(df: pd.DataFrame, metric: str, n_src: pd.Series) -> pd.Series:
    if metric in SOURCES:
        return df[SOURCES[metric]]
    if metric == "any":
        return n_src >= 1
    if metric == "agree2":
        return n_src >= 2
    raise KeyError(metric)


def aggregate(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    n_src = df[list(SOURCES.values())].sum(axis=1)
    tables: dict[str, pd.DataFrame] = {}
    for level, key in (("adm1", "adm1_id"), ("adm2", "adm2_id")):
        g = df[df[key].notna()].copy()
        base = g.groupby(key).agg(pop_total=("pop", "sum"), n_buildings=("pop", "size"))
        rows = []
        for metric in METRICS:
            flag = _flag(g, metric, n_src.loc[g.index])
            sub = g[flag]
            agg = sub.groupby(key).agg(pop_exposed=("pop", "sum"), n_damaged=("pop", "size"))
            agg = base.join(agg, how="left").fillna({"pop_exposed": 0.0, "n_damaged": 0})
            agg["metric"] = metric
            rows.append(agg.reset_index().rename(columns={key: "pcode"}))
        tables[level] = pd.concat(rows, ignore_index=True)
    return tables


# --------------------------------------------------------------------------- #
# Admin boundaries: names + simplified GeoJSON for the map
# --------------------------------------------------------------------------- #
def load_admin_geo(settings):
    adm1 = mirror_blob(
        settings.upstream_path("bronze", "source=codab", f"adm0={ADM0}", "adm1.parquet"),
        settings.container,
        STAGE,
    )
    adm2 = mirror_blob(
        settings.upstream_path("bronze", "source=codab", f"adm0={ADM0}", "adm2.parquet"),
        settings.container,
        STAGE,
    )
    g1 = gpd.read_parquet(adm1)
    g2 = gpd.read_parquet(adm2)
    return g1, g2


def write_geojson(gdf: gpd.GeoDataFrame, level: str, keep: list[str], path: str) -> None:
    out = gdf[[*keep, "geometry"]].copy()
    out["geometry"] = out["geometry"].simplify(SIMPLIFY_TOL, preserve_topology=True)
    out = out.set_crs(4326, allow_override=True)
    out.to_file(path, driver="GeoJSON")
    print(f"  web/data/{os.path.basename(path)} ({len(out)} features)", flush=True)


# --------------------------------------------------------------------------- #
def upload_parquet(frame: pd.DataFrame, blob: str, settings) -> None:
    buf = io.BytesIO()
    frame.to_parquet(buf, compression="zstd", index=False)
    data = buf.getvalue()
    cc = ContainerClient.from_connection_string(
        settings.connection_string(write=True), container_name=settings.container
    )
    cc.upload_blob(name=blob, data=data, overwrite=True, length=len(data), max_concurrency=8)


def build_web_json(tables, g1, g2) -> dict:
    name1 = g1.set_index("adm1_id")["adm1_name"].to_dict()
    name2 = g2.set_index("adm2_id")["adm2_name"].to_dict()
    parent = g2.set_index("adm2_id")["adm1_id"].to_dict()

    def pack(level, names, parents=None):
        t = tables[level]
        wide = t.pivot(index="pcode", columns="metric", values=["pop_exposed", "n_damaged"])
        recs = []
        for pcode, base in t.groupby("pcode"):
            row = {
                "pcode": pcode,
                "name": names.get(pcode, pcode),
                "pop_total": round(float(base["pop_total"].iloc[0])),
                "n_buildings": int(base["n_buildings"].iloc[0]),
                "sources": {},
            }
            if parents is not None:
                row["adm1_id"] = parents.get(pcode)
            for metric in METRICS:
                row["sources"][metric] = {
                    "pop": round(float(wide.loc[pcode, ("pop_exposed", metric)])),
                    "n": int(wide.loc[pcode, ("n_damaged", metric)]),
                }
            recs.append(row)
        recs.sort(key=lambda r: -r["sources"]["any"]["pop"])
        return recs

    adm1 = pack("adm1", name1)
    adm2 = pack("adm2", name2, parent)
    national = {
        m: {
            "pop": sum(r["sources"][m]["pop"] for r in adm1),
            "n": sum(r["sources"][m]["n"] for r in adm1),
        }
        for m in METRICS
    }
    return {
        "meta": {
            "adm0": ADM0,
            "event": "2026-06-24 Venezuela earthquake (USGS us6000t7zp; EMSR884)",
            "population": "WorldPop 2026 residential (constrained, 100 m, R2025A), "
            "area-weighted dasymetric over residential building footprints "
            "(non-residential excluded; footprint clamped — ADR-0002)",
            "note": "Residents of damaged buildings — an estimate of people whose "
            "homes were damaged (a displacement / shelter signal), NOT people inside "
            "at the moment of the quake. For casualties see USGS PAGER. Detected only: "
            "a floor, since each source assessed part of the country.",
            "labels": SOURCE_LABEL,
            "metrics": METRICS,
            "national": national,
        },
        "adm1": adm1,
        "adm2": adm2,
    }


def main() -> None:
    settings = load_settings(STAGE)
    os.makedirs(WEB_DATA, exist_ok=True)

    # WorldPop: mirror from our bronze (run fetch_worldpop.py first).
    wp_blob = settings.blob_path("bronze", "worldpop", f"adm0={ADM0}", WORLDPOP_FILE)
    wp_path = mirror_blob(wp_blob, settings.container, STAGE)

    df = load_buildings(settings)
    df = residential_subset(df)
    df = assign_population(df, wp_path)
    tables = aggregate(df)

    g1, g2 = load_admin_geo(settings)
    write_geojson(g1, "adm1", ["adm1_id", "adm1_name"], os.path.join(WEB_DATA, "adm1.geojson"))
    write_geojson(g2, "adm2", ["adm2_id", "adm2_name"], os.path.join(WEB_DATA, "adm2.geojson"))

    # tidy long parquet -> blob (provenance)
    long = pd.concat([t.assign(adm_level=lvl) for lvl, t in tables.items()], ignore_index=True)
    blob = settings.blob_path("processed", "exposure", f"adm0={ADM0}", "exposure_by_admin.parquet")
    upload_parquet(long, blob, settings)
    print(f"  processed <- {blob} ({len(long):,} rows)", flush=True)

    web = build_web_json(tables, g1, g2)
    with open(os.path.join(WEB_DATA, "exposure.json"), "w") as f:
        json.dump(web, f, separators=(",", ":"))
    nat = web["meta"]["national"]
    print(
        f"  web/data/exposure.json  (national: any={nat['any']['pop']:,} exposed, "
        f"agree2={nat['agree2']['pop']:,})",
        flush=True,
    )
    print("done.", flush=True)


if __name__ == "__main__":
    main()
