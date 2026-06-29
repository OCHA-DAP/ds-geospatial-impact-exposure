"""Fetch Overture building *attributes* (subtype/class/height) for VE -> bronze.

The viewer's silver Overture base carries only ``id`` + ``geometry`` — the
building attributes were dropped at ingest. To (a) keep only residential
buildings and (b) know building height, we pull the attributes back from the
same Overture release the viewer used (``2026-06-17.0``) and join by ``id``.

Venezuela's Overture is ~97% untagged (most footprints come from ML / Google
Open Buildings with no attributes), so we store ONLY the tagged minority: any
building with a non-null subtype, class, height or num_floors. A base ``id``
absent from this table is therefore "untagged" downstream — treated as
residential (see estimate_exposure.residential_subset / ADR-0002).

Reads Overture directly from its public S3 release with a bbox predicate over
the assessed north-central region (keeps the scan small).

Run: uv run python pipelines/fetch_overture_attrs.py
"""

from __future__ import annotations

import io

import duckdb
from azure.storage.blob import ContainerClient

from giex.config import load_settings

ADM0 = "VE"
STAGE = "dev"
RELEASE = "2026-06-17.0"  # the release the viewer's Overture base was built from
# Generous bbox over the assessed states (north-central VE) — every base
# building falls inside it; the bbox predicate prunes Overture's row groups.
BBOX = {"w": -70.0, "e": -65.0, "s": 8.5, "n": 11.5}


def main() -> None:
    settings = load_settings(STAGE)
    src = f"s3://overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/*"
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    print(f"querying Overture {RELEASE} over the assessed bbox …", flush=True)
    df = con.execute(
        f"""
        SELECT id, subtype, class AS bclass, height, num_floors
        FROM read_parquet('{src}', hive_partitioning=false)
        WHERE bbox.xmin > {BBOX["w"]} AND bbox.xmax < {BBOX["e"]}
          AND bbox.ymin > {BBOX["s"]} AND bbox.ymax < {BBOX["n"]}
          AND (subtype IS NOT NULL OR class IS NOT NULL
               OR height IS NOT NULL OR num_floors IS NOT NULL)
        """
    ).df()
    con.close()
    print(f"  {len(df):,} tagged buildings", flush=True)
    print("  subtype top:", df["subtype"].value_counts().head(6).to_dict(), flush=True)

    blob = settings.blob_path("bronze", "overture_attrs", f"adm0={ADM0}", "building_attrs.parquet")
    buf = io.BytesIO()
    df.to_parquet(buf, compression="zstd", index=False)
    data = buf.getvalue()
    cc = ContainerClient.from_connection_string(
        settings.connection_string(write=True), container_name=settings.container
    )
    cc.upload_blob(name=blob, data=data, overwrite=True, length=len(data), max_concurrency=8)
    print(f"  bronze <- {blob} ({len(data) / 1e6:.1f} MB)", flush=True)
    print("done.", flush=True)


if __name__ == "__main__":
    main()
