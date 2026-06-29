"""Fetch the WorldPop 100 m constrained population raster for Venezuela -> bronze.

The team blob mirrors a 1 km WorldPop COG (``raster/worldpop/pop_count/
global_pop_2026_CN_1km_R2025A_UA_v1.tif``), but a 1 km cell holds hundreds of
buildings — too coarse to redistribute population to individual building
footprints (the dasymetric step in ``estimate_exposure.py``). So we pull the
*same vintage* at 100 m straight from WorldPop:

  Global_2015_2030 / R2025A / 2026 / VEN / 100m / constrained
  -> ven_pop_2026_CN_100m_R2025A_v1.tif   (CN = constrained: population only
     where buildings exist; ~30 MB; EPSG:4326)

We land it under this project's bronze (provenance + reproducibility), keeping
the upstream viewer lake untouched.

Run: uv run python pipelines/fetch_worldpop.py
"""

from __future__ import annotations

import os
import tempfile
import urllib.request

from azure.storage.blob import ContainerClient

from giex.config import load_settings

SOURCE_URL = (
    "https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2026/"
    "VEN/v1/100m/constrained/ven_pop_2026_CN_100m_R2025A_v1.tif"
)
FILENAME = "ven_pop_2026_CN_100m_R2025A_v1.tif"
ADM0 = "VE"
STAGE = "dev"


def main() -> None:
    settings = load_settings(STAGE)
    blob = settings.blob_path("bronze", "worldpop", f"adm0={ADM0}", FILENAME)

    with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as tf:
        tmp = tf.name
    try:
        print(f"downloading {SOURCE_URL}", flush=True)
        urllib.request.urlretrieve(SOURCE_URL, tmp)
        size = os.path.getsize(tmp)
        print(f"  {size / 1e6:.1f} MB -> bronze: {blob}", flush=True)

        cc = ContainerClient.from_connection_string(
            settings.connection_string(write=True), container_name=settings.container
        )
        with open(tmp, "rb") as f:
            cc.upload_blob(name=blob, data=f, overwrite=True, length=size, max_concurrency=8)
        print("done.", flush=True)
    finally:
        os.unlink(tmp)


if __name__ == "__main__":
    main()
