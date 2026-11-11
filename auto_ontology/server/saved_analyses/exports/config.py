# SPDX-License-Identifier: Apache-2.0

"""Limits and locations for bulk exports.

Read from the environment at call time, like :mod:`..config`. A value that is
missing or not a positive integer falls back to its default. The defaults are
deliberately small; raise them per deployment.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULTS: dict[str, int] = {
    # One export.
    "SAVED_ANALYSES_EXPORT_MAX_ROWS": 1_000_000,
    "SAVED_ANALYSES_EXPORT_MAX_BYTES": 256 * 1024 * 1024,
    # Wall clock for the whole export: query, fetch and write. Keep it under
    # the ~300 s Node's fetch waits for response headers, so the gateway
    # relays the answer rather than failing the call itself.
    "SAVED_ANALYSES_EXPORT_TIMEOUT_S": 120,
    # Everyone together, per calendar day in SAVED_ANALYSES_TIMEZONE.
    "SAVED_ANALYSES_EXPORT_DAILY_MAX_COUNT": 50,
    "SAVED_ANALYSES_EXPORT_DAILY_MAX_ROWS": 5_000_000,
    # Exports running at once in this process. More answer `busy`.
    "SAVED_ANALYSES_EXPORT_MAX_CONCURRENCY": 1,
    # How long a finished file stays before it is deleted.
    "SAVED_ANALYSES_EXPORT_RETENTION_S": 24 * 3600,
    # Rows fetched and written per step; bounds the memory an export holds.
    "SAVED_ANALYSES_EXPORT_CHUNK_ROWS": 10_000,
    # How often the retention sweep runs while the server is up.
    "SAVED_ANALYSES_EXPORT_SWEEP_INTERVAL_S": 600,
}

#: File and directory modes. Group-readable so a sandbox that mounts the
#: directory read-only can run with the owner's group instead of as the owner.
DEFAULT_FILE_MODE = 0o640
DEFAULT_DIR_MODE = 0o750


def setting(name: str) -> int:
    default = DEFAULTS[name]
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        value = 0
    if value > 0:
        return value
    logger.warning("%s=%r is not a positive integer; using %s", name, raw, default)
    return default


def _mode(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw, 8)
    except ValueError:
        value = -1
    if 0 <= value <= 0o777:
        return value
    logger.warning("%s=%r is not an octal mode; using %o", name, raw, default)
    return default


def file_mode() -> int:
    """``SAVED_ANALYSES_EXPORT_FILE_MODE`` (octal), 0640 by default."""
    return _mode("SAVED_ANALYSES_EXPORT_FILE_MODE", DEFAULT_FILE_MODE)


def export_dir() -> Path:
    """``SAVED_ANALYSES_EXPORT_DIR``, created on first use.

    Defaults to ``<system temp>/auto-ontology-exports``. Set it in a
    deployment: it is the directory an analysis sandbox mounts read-only.
    """
    raw = (os.environ.get("SAVED_ANALYSES_EXPORT_DIR") or "").strip()
    path = (
        Path(raw).expanduser()
        if raw
        else Path(tempfile.gettempdir()) / "auto-ontology-exports"
    )
    if not path.is_dir():
        path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, DEFAULT_DIR_MODE)
    return path
