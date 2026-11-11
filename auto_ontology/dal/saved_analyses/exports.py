# SPDX-License-Identifier: Apache-2.0

"""The export log: one row per bulk export of a saved analysis.

Each row records who asked (the gateway's user id, i.e. the API token's
owner), which analysis and version, with which bound parameters, how many rows
went into the file, and what became of the file. The rows also back the daily
quotas, so they are kept after the file itself is deleted.

Registered on :data:`METADATA` by the import at the bottom of
:mod:`auto_ontology.dal.saved_analyses.tables`.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    Index,
    Integer,
    Table,
    Text,
    func,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB

from auto_ontology.dal.schema import METADATA
from auto_ontology.dal.session import store

#: ``running`` while the file is written; ``ready`` once it can be fetched;
#: ``failed`` when the export stopped (a limit, the database, the deadline);
#: ``expired`` once retention deleted the file.
EXPORT_RUNNING = "running"
EXPORT_READY = "ready"
EXPORT_FAILED = "failed"
EXPORT_EXPIRED = "expired"
EXPORT_STATES = (EXPORT_RUNNING, EXPORT_READY, EXPORT_FAILED, EXPORT_EXPIRED)

saved_analysis_export = Table(
    "saved_analysis_export",
    METADATA,
    Column("id", Text, primary_key=True),
    # No foreign key: the log must outlive the analysis it describes.
    Column("analysis_id", Text, nullable=False),
    Column("analysis_name", Text, nullable=False),
    Column("version", Integer, nullable=False),
    Column("database_name", Text, nullable=False),
    Column("params", JSONB, nullable=False),
    Column("params_hash", Text, nullable=False),
    Column("format", Text, nullable=False),
    Column("state", Text, nullable=False),
    Column("requested_by", Text, nullable=True),
    Column("sql", Text, nullable=False),
    Column("columns", JSONB, nullable=False),
    # Rows read from the database so far; final once the state leaves running.
    # A failed export counts the rows it read before it stopped.
    Column("row_count", BigInteger, nullable=False, server_default="0"),
    Column("byte_size", BigInteger, nullable=True),
    Column("sha256", Text, nullable=True),
    Column("file_name", Text, nullable=True),
    Column("error_code", Text, nullable=True),
    Column("error", Text, nullable=True),
    Column(
        "created", DateTime(timezone=True), nullable=False, server_default=func.now()
    ),
    Column("finished", DateTime(timezone=True), nullable=True),
    Column("duration_ms", Integer, nullable=True),
    Column("expires_at", DateTime(timezone=True), nullable=True),
    Column("deleted_at", DateTime(timezone=True), nullable=True),
    CheckConstraint(
        "state IN ('running', 'ready', 'failed', 'expired')", name="state_valid"
    ),
    CheckConstraint("format IN ('parquet', 'csv')", name="format_valid"),
)

Index("ix_saved_analysis_export_created", saved_analysis_export.c.created)
Index(
    "ix_saved_analysis_export_analysis",
    saved_analysis_export.c.analysis_id,
    saved_analysis_export.c.version,
)

_t = saved_analysis_export


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def start(
    *,
    export_id: str,
    analysis_id: str,
    analysis_name: str,
    version: int,
    database_name: str,
    params: dict[str, Any],
    params_hash: str,
    fmt: str,
    requested_by: str | None,
    sql: str,
    columns: list[dict[str, Any]],
) -> dict[str, Any]:
    store().query_write(
        _t.insert().values(
            id=export_id,
            analysis_id=analysis_id,
            analysis_name=analysis_name,
            version=version,
            database_name=database_name,
            params=params,
            params_hash=params_hash,
            format=fmt,
            state=EXPORT_RUNNING,
            requested_by=requested_by,
            sql=sql,
            columns=columns,
            row_count=0,
            created=_now(),
        )
    )
    row = get(export_id)
    assert row is not None
    return row


def finish_ready(
    export_id: str,
    *,
    row_count: int,
    byte_size: int,
    sha256: str,
    file_name: str,
    duration_ms: int,
    expires_at: dt.datetime,
) -> None:
    store().query_write(
        update(_t)
        .where(_t.c.id == export_id)
        .values(
            state=EXPORT_READY,
            row_count=row_count,
            byte_size=byte_size,
            sha256=sha256,
            file_name=file_name,
            finished=_now(),
            duration_ms=duration_ms,
            expires_at=expires_at,
        )
    )


def finish_failed(
    export_id: str,
    *,
    row_count: int,
    error_code: str,
    error: str,
    duration_ms: int,
) -> None:
    store().query_write(
        update(_t)
        .where(_t.c.id == export_id)
        .values(
            state=EXPORT_FAILED,
            row_count=row_count,
            error_code=error_code,
            error=error[:4000],
            finished=_now(),
            duration_ms=duration_ms,
        )
    )


def mark_expired(export_id: str) -> None:
    store().query_write(
        update(_t)
        .where(_t.c.id == export_id, _t.c.state == EXPORT_READY)
        .values(state=EXPORT_EXPIRED, deleted_at=_now())
    )


def get(export_id: str) -> dict[str, Any] | None:
    rows = store().query_read(select(_t).where(_t.c.id == export_id))
    return dict(rows[0]) if rows else None


def list_recent(*, skip: int, limit: int) -> tuple[list[dict[str, Any]], int]:
    rows = store().query_read(
        select(_t).order_by(_t.c.created.desc(), _t.c.id).offset(skip).limit(limit)
    )
    total = store().query_read(select(func.count()).select_from(_t))[0]
    return [dict(r) for r in rows], int(next(iter(total.values())))


def usage_since(since: dt.datetime) -> tuple[int, int]:
    """``(exports, rows)`` started at or after *since*, whatever their outcome."""
    row = store().query_read(
        select(
            func.count().label("exports"),
            func.coalesce(func.sum(_t.c.row_count), 0).label("rows"),
        ).where(_t.c.created >= since)
    )[0]
    return int(row["exports"]), int(row["rows"])


def due_for_deletion(now: dt.datetime) -> list[dict[str, Any]]:
    """Ready exports whose retention has passed."""
    rows = store().query_read(
        select(_t.c.id, _t.c.file_name).where(
            _t.c.state == EXPORT_READY, _t.c.expires_at <= now
        )
    )
    return [dict(r) for r in rows]


def stale_running(before: dt.datetime) -> list[dict[str, Any]]:
    """Exports still marked running although they started before *before*.

    Left behind when the process died mid-export.
    """
    rows = store().query_read(
        select(_t.c.id, _t.c.created).where(
            _t.c.state == EXPORT_RUNNING, _t.c.created < before
        )
    )
    return [dict(r) for r in rows]


__all__ = [
    "EXPORT_EXPIRED",
    "EXPORT_FAILED",
    "EXPORT_READY",
    "EXPORT_RUNNING",
    "EXPORT_STATES",
    "saved_analysis_export",
]
