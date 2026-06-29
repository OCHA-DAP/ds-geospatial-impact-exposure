"""DuckDB connection helper — the join/spatial engine for the exposure ETL.

Mirrors the upstream viewer repo's ``db.py``: a single DuckDB process with the
``spatial`` and ``azure`` extensions, authed against the team blob with the
shared ``DSCI_AZ_BLOB_*`` SAS tokens via a DuckDB azure secret. We do NOT load
``h3`` here — the exposure pipeline works in projected/admin space, not on the
H3 grid.

In practice the heavy upstream inputs (the Overture base, building_flags) are
mirrored to local disk first (see ``pipelines/mirror.py``) because the blob
endpoint stalls on sustained reads; DuckDB then reads those local GeoParquet
files. The azure secret is still set up so small reads and writes work directly.
"""

from __future__ import annotations

import os

import duckdb

from giex.config import Settings, load_settings


def _ca_bundle() -> str | None:
    try:
        import certifi
    except ImportError:
        return None
    return certifi.where()


def connect(settings: Settings | None = None, *, write: bool = False) -> duckdb.DuckDBPyConnection:
    """Return a DuckDB connection with spatial/azure loaded and Azure auth set."""
    settings = settings or load_settings()
    bundle = _ca_bundle()
    if bundle:
        # The azure extension's curl transport honours CURL_CA_INFO (a PEM file).
        os.environ.setdefault("CURL_CA_INFO", bundle)
    con = duckdb.connect()

    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("INSTALL azure; LOAD azure;")
    con.execute("SET enable_progress_bar = false;")
    con.execute("SET azure_transport_option_type = 'curl';")
    con.execute(
        f"""
        CREATE OR REPLACE SECRET azure_blob (
            TYPE azure,
            ACCOUNT_NAME '{settings.account_name}',
            CONNECTION_STRING '{settings.connection_string(write=write)}'
        );
        """
    )
    return con
