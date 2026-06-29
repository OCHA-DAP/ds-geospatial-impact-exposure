"""Mirror upstream-lake blobs to local disk before DuckDB reads them.

The team blob endpoint intermittently *stalls* on sustained reads (the upstream
viewer repo hit the same thing and mirrors to ``/tmp`` for the exact same
reason). So rather than point DuckDB at ``az://`` for the big inputs (the
Overture base, building_flags), we download once to a local cache and let
DuckDB read local GeoParquet — fast and reliable.

Uses ocha-stratus' container client (shared SAS auth). Files already present
with a matching size are skipped, so reruns are cheap.
"""

from __future__ import annotations

import os

import ocha_stratus as stratus

CACHE_ROOT = os.environ.get("GIEX_CACHE", "/tmp/giex_cache")


def _cc(container: str, stage: str):
    return stratus.get_container_client(container, stage=stage)


def mirror_blob(blob_path: str, container: str, stage: str) -> str:
    """Download a single blob to the local cache, return the local path.

    ``blob_path`` is the in-container path (no ``az://``/container)."""
    dst = os.path.join(CACHE_ROOT, container, blob_path)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    cc = _cc(container, stage)
    bc = cc.get_blob_client(blob_path)
    props = bc.get_blob_properties()
    if os.path.exists(dst) and os.path.getsize(dst) == props.size:
        return dst
    print(f"  mirror {container}/{blob_path} ({props.size / 1e6:.1f} MB)", flush=True)
    with open(dst, "wb") as f:
        bc.download_blob(max_concurrency=8).readinto(f)
    return dst


def mirror_prefix(prefix: str, container: str, stage: str) -> str:
    """Mirror every blob under ``prefix`` into the local cache.

    Returns the local directory that mirrors ``prefix`` (so callers can build a
    glob like ``<dir>/region=*/*.parquet``)."""
    cc = _cc(container, stage)
    local_root = os.path.join(CACHE_ROOT, container, prefix)
    for b in cc.list_blobs(name_starts_with=prefix.rstrip("/") + "/"):
        # Skip zero-byte hierarchical "directory marker" blobs (e.g. a bare
        # ``region=aragua``): they collide with the real ``region=aragua/*.parquet``
        # files when materialised on a POSIX filesystem.
        if b.size == 0:
            continue
        mirror_blob(b.name, container, stage)
    return local_root


if __name__ == "__main__":  # pragma: no cover - manual smoke test
    import sys

    from giex.config import load_settings

    s = load_settings()
    print(
        mirror_blob(
            s.upstream_path("gold", "model=common", "adm0=VE", "building_flags.parquet"),
            s.container,
            s.stage,
        )
    )
    sys.exit(0)
