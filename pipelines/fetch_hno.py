"""Fetch the Venezuela HNO 2025 People-in-Need (per municipio) -> bronze.

To put the earthquake exposure in humanitarian context we overlay the
*pre-existing* need from the 2025 Humanitarian Needs Overview (the standardised
HPC/JIAF data on HDX). That file publishes People in Need per admin2 (municipio),
intersectoral and by cluster — including **Shelter**, the cluster most relevant
to building damage — plus total population.

Notes / caveats baked in here:
  * 2025 is the latest year with admin-2 detail; the 2026 resource is only a
    single national placeholder, so we use 2025 as the pre-event baseline.
  * The HNO uses legacy ``VE####`` pcodes, NOT the FieldMaps pcodes our admin
    boundaries use, so the join downstream is by **state + municipio name**
    (municipio names like "Libertador"/"Sucre" repeat across states, so the
    state is required to disambiguate). We store normalised name keys for that.
  * The official JIAF intersectoral *severity phase* (1–5) is NOT in the open
    data — only PiN — so downstream we tier by Shelter-PiN per capita, not a
    phase (see estimate_exposure.SHELTER_BREAKS).

Run: uv run python pipelines/fetch_hno.py
"""

from __future__ import annotations

import io
import re
import unicodedata

import pandas as pd
from azure.storage.blob import ContainerClient

from giex.config import load_settings

ADM0 = "VE"
STAGE = "dev"
YEAR = 2025
HNO_CSV = (
    "https://data.humdata.org/dataset/0ea5e9cd-4c46-499d-9c31-f53e9315d6db/"
    "resource/a41113dc-a70e-41ad-ad8e-d92210edbb2f/download/ven_hpc_needs_api_2025.csv"
)


def norm(s: str) -> str:
    """Accent-fold + lowercase + collapse non-alphanumerics — for name joins."""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def main() -> None:
    settings = load_settings(STAGE)
    raw = pd.read_csv(HNO_CSV, skiprows=[1])  # row 1 is the HXL hashtag row
    adm2 = raw[raw["Admin 2 PCode"].notna()].copy()
    parts = adm2["Admin 2 Name"].str.split(",", n=1, expand=True)
    adm2["state"] = parts[0].str.strip()
    adm2["municipio"] = parts[1].str.strip()
    adm2["key"] = adm2["state"].map(norm) + "|" + adm2["municipio"].map(norm)

    def cluster_pin(code: str) -> pd.Series:
        sub = adm2[adm2["Cluster"].astype(str) == code]
        return sub.set_index("key")["In Need"]

    inter = adm2[adm2["Cluster"].astype(str) == "ALL"].set_index("key")
    out = pd.DataFrame(
        {
            "state": inter["state"],
            "municipio": inter["municipio"],
            "ve_pcode": inter["Admin 2 PCode"],  # legacy pcode, for provenance
            "population": inter["Population"],
            "pin_intersectoral": inter["In Need"],
            "pin_shelter": cluster_pin("SHL"),
            "pin_wash": cluster_pin("WSH"),
            "pin_health": cluster_pin("HEA"),
        }
    ).reset_index()
    print(
        f"  {len(out):,} municipios; intersectoral PiN {int(out['pin_intersectoral'].sum()):,}, "
        f"shelter PiN {int(out['pin_shelter'].sum()):,}",
        flush=True,
    )

    blob = settings.blob_path("bronze", "hno", f"adm0={ADM0}", f"hno_{YEAR}_adm2.parquet")
    buf = io.BytesIO()
    out.to_parquet(buf, compression="zstd", index=False)
    data = buf.getvalue()
    cc = ContainerClient.from_connection_string(
        settings.connection_string(write=True), container_name=settings.container
    )
    cc.upload_blob(name=blob, data=data, overwrite=True, length=len(data), max_concurrency=8)
    print(f"  bronze <- {blob} ({len(data) / 1e3:.0f} KB)", flush=True)
    print("done.", flush=True)


if __name__ == "__main__":
    main()
