"""Build the validation map layers: damaged-building footprints (with per-building
population) as PMTiles, and the WorldPop raster as a colorized PNG overlay.

The headline page (exposure.json) is admin-aggregated. To *validate* the
dasymetric estimate you want to see the actual inputs: each damaged building's
footprint, the population we attributed to it, and the WorldPop grid underneath —
so you can eyeball that buildings on dense cells get more people and that the
redistribution is sane.

Volume is the problem: ~340k damaged buildings is far too many for browser
GeoJSON. So:
  * Footprints -> vector tiles (PMTiles, a single static file MapLibre reads via
    HTTP range requests) carrying pop + which sources flagged each building.
    Only a few hundred render per viewport at footprint zoom.
  * WorldPop 100 m -> one colorized RGBA PNG (clipped to the assessed area,
    reprojected to Web Mercator) shown as an image overlay with an opacity slider.

Reuses the exposure pipeline's building load + dasymetric assignment, then keeps
only the damaged set and joins footprint geometry back from the Overture base.

Requires: tippecanoe on PATH (brew install tippecanoe).
Run: uv run python pipelines/build_validation_layers.py
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile

import numpy as np
import rioxarray  # noqa: F401 - registers the .rio accessor
from estimate_exposure import (
    SOURCES,
    WORLDPOP_FILE,
    assign_population,
    load_buildings,
    residential_subset,
)
from mirror import mirror_blob, mirror_prefix
from PIL import Image
from pyproj import Transformer

from giex.config import load_settings

ADM0 = "VE"
STAGE = "dev"
WEB_DATA = os.path.join(os.path.dirname(__file__), "..", "web", "data")
BUILDING_BREAKS = [1, 3, 7, 15, 40]  # people per building, for the legend/ramp

# WorldPop background ramp: cool BLUES, deliberately distinct from the warm/red
# damaged-building colours so the population grid doesn't read as "damage". (stop, r,g,b)
RAMP = [
    (0.00, 222, 235, 247),  # #deebf7
    (0.25, 158, 202, 225),  # #9ecae1
    (0.50, 107, 174, 214),  # #6baed6
    (0.75, 49, 130, 189),  # #3182bd
    (1.00, 8, 81, 156),  # #08519c
]


def build_pmtiles(settings) -> tuple[int, list[float]]:
    """Damaged building footprints + per-building pop -> web/data/buildings.pmtiles.

    Returns (n_damaged, [lon, lat] of the agreement-cluster centroid for the view)."""
    wp_path = mirror_blob(
        settings.blob_path("bronze", "worldpop", f"adm0={ADM0}", WORLDPOP_FILE),
        settings.container,
        STAGE,
    )
    base_dir = mirror_prefix(
        settings.upstream_path("silver", "source=overture", f"adm0={ADM0}"),
        settings.container,
        STAGE,
    )
    base_glob = os.path.join(base_dir, "region=*", "*.parquet")

    df = load_buildings(settings)
    df = residential_subset(df)
    df = assign_population(df, wp_path)
    df["n_src"] = df[list(SOURCES.values())].sum(axis=1)
    dmg = df[df["n_src"] >= 1][["id", "pop", "n_src", "area_m2", *SOURCES.values()]].copy()
    print(f"  {len(dmg):,} damaged buildings (any source) -> footprints", flush=True)

    # write the damaged set, then let DuckDB join footprint geometry from the base
    # and stream it straight to GeoJSON for tippecanoe (avoids 340k geoms in pandas).
    from giex.db import connect

    with tempfile.TemporaryDirectory() as td:
        dmg_pq = os.path.join(td, "dmg.parquet")
        dmg.to_parquet(dmg_pq, index=False)
        geojson = os.path.join(td, "buildings.geojson")
        con = connect(settings)
        con.execute(
            f"""
            COPY (
                SELECT b.geometry,
                       round(d.pop, 1)        AS pop,
                       d.n_src::INT           AS n_src,
                       d.ms_dmg::INT          AS ms,
                       d.cems_dmg::INT        AS cems,
                       d.sar_dmg::INT         AS sar,
                       d.osu_dmg::INT         AS osu,
                       round(d.area_m2)::INT  AS area
                FROM read_parquet('{base_glob}', hive_partitioning=true) b
                JOIN read_parquet('{dmg_pq}') d ON b.id = d.id
            ) TO '{geojson}' WITH (FORMAT GDAL, DRIVER 'GeoJSON');
            """
        )
        con.close()

        out = os.path.join(WEB_DATA, "buildings.pmtiles")
        print("  tippecanoe -> buildings.pmtiles", flush=True)
        subprocess.run(
            [
                "tippecanoe",
                "-o",
                out,
                "-l",
                "buildings",
                "-Z10",
                "-z16",
                "--drop-densest-as-needed",
                "--extend-zooms-if-still-dropping",
                "--no-tile-size-limit",
                "--force",
                geojson,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    size = os.path.getsize(out) / 1e6
    print(f"  web/data/buildings.pmtiles ({size:.1f} MB)", flush=True)

    # default view: the centroid of the agreement cluster (the real hotspot)
    agree = df[df["n_src"] >= 2]
    center = [round(float(agree["lon"].mean()), 4), round(float(agree["lat"].mean()), 4)]
    return len(dmg), center


def _colorize(norm: np.ndarray, mask: np.ndarray) -> np.ndarray:
    stops = np.array([s[0] for s in RAMP])
    rgba = np.zeros((*norm.shape, 4), dtype="uint8")
    for ch in range(3):
        chan = np.array([s[ch + 1] for s in RAMP])
        rgba[..., ch] = np.interp(norm, stops, chan).astype("uint8")
    rgba[..., 3] = np.where(mask, 205, 0).astype("uint8")
    return rgba


def build_worldpop_png(settings, aoi) -> dict:
    """Clip + reproject + colorize the 100 m WorldPop -> web/data/worldpop.png."""
    wp_path = mirror_blob(
        settings.blob_path("bronze", "worldpop", f"adm0={ADM0}", WORLDPOP_FILE),
        settings.container,
        STAGE,
    )
    minx, miny, maxx, maxy = aoi
    da = rioxarray.open_rasterio(wp_path, masked=True).squeeze()
    da = da.rio.clip_box(minx, miny, maxx, maxy)
    da = da.rio.reproject("EPSG:3857")
    vals = da.values.astype("float64")
    finite = np.isfinite(vals) & (vals > 0)

    # log-stretch between the 50th and 99.5th percentile of populated cells
    pv = vals[finite]
    lo, hi = np.percentile(pv, [50, 99.5])
    llo, lhi = np.log1p(lo), np.log1p(hi)
    norm = np.clip((np.log1p(np.where(finite, vals, lo)) - llo) / (lhi - llo), 0, 1)
    rgba = _colorize(norm, finite)
    png_path = os.path.join(WEB_DATA, "worldpop.png")
    Image.fromarray(rgba, "RGBA").save(png_path)
    # content hash -> cache-buster in the URL, so a recolor refetches even when the
    # filename is unchanged (browsers cache map image sources past a hard reload).
    with open(png_path, "rb") as f:
        ver = hashlib.md5(f.read()).hexdigest()[:8]

    left, bottom, right, top = da.rio.bounds()
    tx = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    wlon, _ = tx.transform(left, 0)
    elon, _ = tx.transform(right, 0)
    _, nlat = tx.transform(0, top)
    _, slat = tx.transform(0, bottom)
    print(
        f"  web/data/worldpop.png ({rgba.shape[1]}x{rgba.shape[0]} px, "
        f"max {float(pv.max()):,.0f} ppl/cell)",
        flush=True,
    )
    return {
        "coordinates": [[wlon, nlat], [elon, nlat], [elon, slat], [wlon, slat]],
        "max_per_cell": round(float(pv.max())),
        "stretch": [round(float(lo), 1), round(float(hi), 1)],
        "v": ver,
    }


def main() -> None:
    settings = load_settings(STAGE)
    os.makedirs(WEB_DATA, exist_ok=True)

    n_dmg, center = build_pmtiles(settings)

    # AOI for the raster = a small buffer around the agreement hotspot view, but
    # wide enough to cover the assessed coast (keeps the PNG light).
    aoi = (center[0] - 1.6, center[1] - 0.9, center[0] + 1.6, center[1] + 0.9)
    wp = build_worldpop_png(settings, aoi)

    meta = {
        "n_damaged": n_dmg,
        "center": center,
        "zoom": 12,
        "building_breaks": BUILDING_BREAKS,
        "worldpop": wp,
        "note": "Footprints appear as you zoom in (z≥13). Residential buildings only; "
        "colour = estimated residents (clamped-area share of the building's WorldPop "
        "cell). Non-residential footprints are excluded (ADR-0002).",
    }
    with open(os.path.join(WEB_DATA, "validate.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"  web/data/validate.json (center {center}, {n_dmg:,} buildings)", flush=True)
    print("done.", flush=True)


if __name__ == "__main__":
    main()
