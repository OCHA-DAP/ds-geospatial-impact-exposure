"""Configuration for the geospatial impact *exposure* project.

This project is a read-only consumer of the ``ds-geospatial-impact-estimates``
damage lake (the "viewer" repo): it reads that project's harmonized
per-building damage flags + the Overture base, multiplies by WorldPop, and
writes its own small per-admin exposure outputs back under *this* project's
prefix. We never write to the upstream project.

Settings come from environment variables (a local ``.env`` in dev). Storage
reuses the team Azure Blob account and the same ``DSCI_AZ_BLOB_*`` SAS tokens as
``ocha-stratus``; we query through DuckDB directly (mirroring the upstream
repo's engine choice, see its ADR-0002/0003).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

Stage = Literal["dev", "prod"]

# The upstream damage project whose lake we read (its gold building_flags +
# silver Overture base + bronze CODAB). Fixed: we are its downstream consumer.
UPSTREAM_PROJECT_PREFIX = "ds-geospatial-impact-estimates"

# WorldPop and other shared rasters live in their own container, not ``projects``.
RASTER_CONTAINER = "raster"


@dataclass(frozen=True)
class Settings:
    """Azure Blob settings shared with ``ocha-stratus``.

    Storage account is ``{account_prefix}{stage}`` (set ``account_prefix`` via
    ``GIEX_BLOB_ACCOUNT_PREFIX``, kept out of the repo). Our own outputs live
    under ``{container}/{project_prefix}/...``; upstream reads use
    ``UPSTREAM_PROJECT_PREFIX``.
    """

    stage: Stage = "dev"
    account_prefix: str = ""
    container: str = "projects"
    project_prefix: str = "ds-geospatial-impact-exposure"
    raster_container: str = RASTER_CONTAINER

    @property
    def account_name(self) -> str:
        if not self.account_prefix:
            raise RuntimeError(
                "Storage account prefix not set — define GIEX_BLOB_ACCOUNT_PREFIX "
                "in your .env (the team blob-account prefix, same as the viewer repo)."
            )
        return f"{self.account_prefix}{self.stage}"

    @property
    def account_host(self) -> str:
        return f"{self.account_name}.blob.core.windows.net"

    def sas_token(self, *, write: bool = False) -> str:
        """Read the team SAS token from the environment (shared with ocha-stratus)."""
        suffix = self.stage.upper()
        keys = (
            [f"DSCI_AZ_BLOB_{suffix}_SAS_WRITE"]
            if write
            else [f"DSCI_AZ_BLOB_{suffix}_SAS", f"DSCI_AZ_BLOB_{suffix}_SAS_WRITE"]
        )
        for key in keys:
            token = os.getenv(key)
            if token:
                return token.lstrip("?")
        raise RuntimeError(
            f"No SAS token found. Set one of {keys} in your .env "
            "(same tokens used by ocha-stratus / the viewer repo)."
        )

    def connection_string(self, *, write: bool = False) -> str:
        """Azure connection string embedding the SAS token, for a DuckDB secret."""
        return (
            f"BlobEndpoint=https://{self.account_host};"
            f"SharedAccessSignature={self.sas_token(write=write)}"
        )

    # --- our own project paths (writes) -----------------------------------
    def blob_path(self, *parts: str) -> str:
        """Path within the container under *this* project (no ``az://``)."""
        return "/".join([self.project_prefix, *parts])

    def az_path(self, *parts: str) -> str:
        """``az://`` path under this project the DuckDB azure extension understands."""
        return f"az://{self.container}/{self.blob_path(*parts)}"

    # --- upstream damage lake paths (reads) -------------------------------
    def upstream_path(self, layer: Literal["bronze", "silver", "gold"], *parts: str) -> str:
        """Path within the container under the upstream viewer project (no ``az://``)."""
        return "/".join([UPSTREAM_PROJECT_PREFIX, layer, *parts])

    def upstream_az(self, layer: Literal["bronze", "silver", "gold"], *parts: str) -> str:
        """``az://`` path into the upstream viewer project's lake."""
        return f"az://{self.container}/{self.upstream_path(layer, *parts)}"

    # --- raster container (WorldPop) --------------------------------------
    def raster_az(self, *parts: str) -> str:
        return f"az://{self.raster_container}/{'/'.join(parts)}"


def load_settings(stage: Stage | None = None) -> Settings:
    """Resolve settings from the environment (``GIEX_STAGE``/``GIEX_CONTAINER``/...)."""
    resolved = stage or os.getenv("GIEX_STAGE", "dev")
    if resolved not in ("dev", "prod"):
        raise ValueError(f"Invalid stage: {resolved!r} (expected 'dev' or 'prod')")
    return Settings(
        stage=resolved,  # type: ignore[arg-type]
        account_prefix=os.getenv("GIEX_BLOB_ACCOUNT_PREFIX", ""),
        container=os.getenv("GIEX_CONTAINER", "projects"),
        project_prefix=os.getenv("GIEX_PROJECT_PREFIX", "ds-geospatial-impact-exposure"),
    )
