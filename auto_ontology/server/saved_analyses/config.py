# SPDX-License-Identifier: Apache-2.0

"""Limits and defaults for saved analyses.

Every value is read from the environment at call time, so tests and operators
can change one without a restart. A value that is missing or not a positive
integer falls back to the default rather than failing requests.
"""

from __future__ import annotations

import logging
import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

logger = logging.getLogger(__name__)

DEFAULTS: dict[str, int] = {
    # Per-version defaults, used when a save request leaves the field out.
    "SAVED_ANALYSES_DEFAULT_ROW_LIMIT": 5000,
    "SAVED_ANALYSES_DEFAULT_TIMEOUT_S": 30,
    "SAVED_ANALYSES_DEFAULT_CACHE_TTL_S": 3600,
    # Hard caps a version cannot exceed.
    "SAVED_ANALYSES_MAX_ROW_LIMIT": 50000,
    "SAVED_ANALYSES_MAX_TIMEOUT_S": 300,
    "SAVED_ANALYSES_MAX_CACHE_TTL_S": 7 * 24 * 3600,
    # Concurrent statements per database, and how long a run waits for a slot
    # before answering 429. Kept below the Postgres connector's pool of 4,
    # which chat shares.
    "SAVED_ANALYSES_MAX_CONCURRENCY_PER_DB": 2,
    "SAVED_ANALYSES_QUEUE_TIMEOUT_S": 10,
    # run-batch
    "SAVED_ANALYSES_BATCH_MAX_ITEMS": 50,
    "SAVED_ANALYSES_BATCH_PARALLELISM": 4,
}

DEFAULT_TIMEZONE = "Asia/Seoul"


def setting(name: str) -> int:
    """The positive integer configured as *name*, or its default."""
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


def timezone() -> ZoneInfo:
    """The zone relative dates (``month_start(-1)``…) are computed in.

    ``SAVED_ANALYSES_TIMEZONE``, ``Asia/Seoul`` when unset or unknown.
    """
    name = (os.environ.get("SAVED_ANALYSES_TIMEZONE") or DEFAULT_TIMEZONE).strip()
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        logger.warning(
            "Unknown SAVED_ANALYSES_TIMEZONE %r; using %s", name, DEFAULT_TIMEZONE
        )
        return ZoneInfo(DEFAULT_TIMEZONE)
