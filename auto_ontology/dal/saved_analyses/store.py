# SPDX-License-Identifier: Apache-2.0

"""Reads and writes for saved analyses. SQLAlchemy Core, like the rest of the DAL.

Versions are append-only: nothing here updates a version's SQL, parameters,
columns or limits. The only mutable fields are its status and verification
record, and :func:`set_version_status` allows only forward transitions.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from auto_ontology.dal import schema as s
from auto_ontology.dal.saved_analyses.tables import (
    STATUS_DRAFT,
    STATUS_RETIRED,
    STATUS_VERIFIED,
    saved_analysis,
    saved_analysis_run,
    saved_analysis_version,
    saved_analysis_version__table,
)
from auto_ontology.dal.session import store, write_transaction


class NameConflict(Exception):
    pass


class NotFound(Exception):
    pass


class InvalidTransition(Exception):
    pass


#: Allowed status changes. Retired is final; verified cannot go back to draft.
TRANSITIONS = {
    STATUS_DRAFT: {STATUS_VERIFIED, STATUS_RETIRED},
    STATUS_VERIFIED: {STATUS_RETIRED},
    STATUS_RETIRED: set(),
}

_VERSION_COLUMNS = [c for c in saved_analysis_version.c]


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _tables_for(analysis_id: str, version: int) -> list[dict[str, Any]]:
    t = saved_analysis_version__table
    rows = store().query_read(
        select(t.c.database_name, t.c.schema_name, t.c.table_name, t.c.table_id)
        .where(t.c.analysis_id == analysis_id, t.c.version == version)
        .order_by(t.c.schema_name, t.c.table_name)
    )
    return [
        {
            "database_name": r["database_name"],
            "schema_name": r["schema_name"] or None,
            "table_name": r["table_name"],
            "table_id": r["table_id"],
        }
        for r in rows
    ]


def _insert_version(
    analysis_id: str,
    version: int,
    fields: dict[str, Any],
    tables: list[dict[str, Any]],
    created_by: str | None,
) -> None:
    store().query_write(
        saved_analysis_version.insert().values(
            analysis_id=analysis_id,
            version=version,
            status=STATUS_DRAFT,
            created_by=created_by,
            **fields,
        )
    )
    for table in tables:
        store().query_write(
            saved_analysis_version__table.insert().values(
                analysis_id=analysis_id,
                version=version,
                database_name=table["database_name"],
                schema_name=table.get("schema_name") or "",
                table_name=table["table_name"],
                table_id=table.get("table_id"),
            )
        )


def create_analysis(
    *,
    name: str,
    description: str | None,
    database_name: str,
    version_fields: dict[str, Any],
    tables: list[dict[str, Any]],
    created_by: str | None,
) -> str:
    """Insert an analysis with version 1 (draft). Returns its id."""
    try:
        with write_transaction():
            rows = store().query_write(
                saved_analysis.insert()
                .values(
                    name=name,
                    description=description,
                    database_name=database_name,
                    latest_version=1,
                    created_by=created_by,
                )
                .returning(saved_analysis.c.id)
            )
            analysis_id = rows[0]["id"]
            _insert_version(analysis_id, 1, version_fields, tables, created_by)
    except IntegrityError as exc:
        if "uq_saved_analysis_name" in str(exc.orig):
            raise NameConflict(name) from None
        raise
    return analysis_id


def add_version(
    analysis_id: str,
    *,
    description: str | None,
    version_fields: dict[str, Any],
    tables: list[dict[str, Any]],
    created_by: str | None,
) -> int:
    """Append a draft version. Returns its number."""
    with write_transaction():
        rows = store().query_write(
            select(saved_analysis.c.latest_version)
            .where(saved_analysis.c.id == analysis_id)
            .with_for_update()
        )
        if not rows:
            raise NotFound(analysis_id)
        version = rows[0]["latest_version"] + 1
        _insert_version(analysis_id, version, version_fields, tables, created_by)
        values: dict[str, Any] = {"latest_version": version, "updated": func.now()}
        if description is not None:
            values["description"] = description
        store().query_write(
            saved_analysis.update()
            .where(saved_analysis.c.id == analysis_id)
            .values(**values)
        )
    return version


def set_version_status(
    analysis_id: str,
    version: int,
    status: str,
    *,
    user_id: str | None,
    note: str | None,
) -> None:
    with write_transaction():
        rows = store().query_write(
            select(saved_analysis_version.c.status)
            .where(
                saved_analysis_version.c.analysis_id == analysis_id,
                saved_analysis_version.c.version == version,
            )
            .with_for_update()
        )
        if not rows:
            raise NotFound(f"{analysis_id} v{version}")
        current = rows[0]["status"]
        if status not in TRANSITIONS[current]:
            raise InvalidTransition(f"{current} -> {status}")
        values: dict[str, Any] = {"status": status}
        if status == STATUS_VERIFIED:
            values.update(
                verified_by=user_id, verified_at=_now(), verification_note=note
            )
        elif note:
            values["verification_note"] = note
        store().query_write(
            saved_analysis_version.update()
            .where(
                saved_analysis_version.c.analysis_id == analysis_id,
                saved_analysis_version.c.version == version,
            )
            .values(**values)
        )
        store().query_write(
            saved_analysis.update()
            .where(saved_analysis.c.id == analysis_id)
            .values(updated=func.now())
        )


def get_analysis(analysis_id: str) -> dict[str, Any] | None:
    rows = store().query_read(
        select(saved_analysis).where(saved_analysis.c.id == analysis_id)
    )
    if not rows:
        return None
    row = dict(rows[0])
    row["latest_verified_version"] = _latest_with_status(analysis_id, STATUS_VERIFIED)
    return row


def _latest_with_status(analysis_id: str, status: str) -> int | None:
    rows = store().query_read(
        select(func.max(saved_analysis_version.c.version).label("version")).where(
            saved_analysis_version.c.analysis_id == analysis_id,
            saved_analysis_version.c.status == status,
        )
    )
    return rows[0]["version"] if rows else None


def get_version(analysis_id: str, version: int) -> dict[str, Any] | None:
    rows = store().query_read(
        select(*_VERSION_COLUMNS).where(
            saved_analysis_version.c.analysis_id == analysis_id,
            saved_analysis_version.c.version == version,
        )
    )
    if not rows:
        return None
    row = dict(rows[0])
    row["tables"] = _tables_for(analysis_id, version)
    return row


def list_versions(analysis_id: str) -> list[dict[str, Any]]:
    v = saved_analysis_version
    rows = store().query_read(
        select(
            v.c.version,
            v.c.status,
            v.c.created,
            v.c.created_by,
            v.c.verified_at,
            v.c.verified_by,
        )
        .where(v.c.analysis_id == analysis_id)
        .order_by(v.c.version)
    )
    return [dict(r) for r in rows]


def list_analyses(
    *, search: str | None, status: str | None, skip: int, limit: int | None
) -> tuple[list[dict[str, Any]], int]:
    a, v = saved_analysis, saved_analysis_version
    verified = (
        select(func.max(v.c.version))
        .where(v.c.analysis_id == a.c.id, v.c.status == STATUS_VERIFIED)
        .scalar_subquery()
        .label("latest_verified_version")
    )
    conditions = []
    if search:
        pattern = f"%{search}%"
        conditions.append(or_(a.c.name.ilike(pattern), a.c.description.ilike(pattern)))
    if status == STATUS_VERIFIED:
        conditions.append(verified.is_not(None))
    elif status == STATUS_DRAFT:
        conditions.append(verified.is_(None))
    where = and_(*conditions) if conditions else None

    # "C" orders by code point whatever the database's default collation is,
    # so every deployment lists the same order (Hangul in 가나다 order).
    query = select(a, verified).order_by(a.c.name.collate("C")).offset(skip)
    count_query = select(func.count().label("total")).select_from(a)
    if where is not None:
        query = query.where(where)
        count_query = count_query.where(where)
    if limit is not None:
        query = query.limit(limit)
    rows = [dict(r) for r in store().query_read(query)]
    total_rows = store().query_read(count_query)
    total = total_rows[0]["total"] if total_rows else 0
    return rows, int(total)


def all_analysis_ids() -> list[str]:
    rows = store().query_read(
        select(saved_analysis.c.id).order_by(saved_analysis.c.created)
    )
    return [r["id"] for r in rows]


# ---------------------------------------------------------------------------
# Custom Analyses copy
# ---------------------------------------------------------------------------


def custom_analysis_links(analysis_id: str) -> list[dict[str, Any]]:
    """``{version, custom_analysis_id}`` for the versions that record a copy."""
    v = saved_analysis_version
    rows = store().query_read(
        select(v.c.version, v.c.custom_analysis_id)
        .where(v.c.analysis_id == analysis_id, v.c.custom_analysis_id.is_not(None))
        .order_by(v.c.version)
    )
    return [dict(r) for r in rows]


def set_custom_analysis_link(
    analysis_id: str, version: int | None, custom_analysis_id: str | None
) -> None:
    """Record *custom_analysis_id* on *version* and clear it everywhere else.

    One analysis has at most one copy, on the version it was made from.
    """
    v = saved_analysis_version
    with write_transaction():
        store().query_write(
            v.update()
            .where(v.c.analysis_id == analysis_id, v.c.custom_analysis_id.is_not(None))
            .values(custom_analysis_id=None)
        )
        if version is not None and custom_analysis_id is not None:
            store().query_write(
                v.update()
                .where(v.c.analysis_id == analysis_id, v.c.version == version)
                .values(custom_analysis_id=custom_analysis_id)
            )


# ---------------------------------------------------------------------------
# Runs (cache)
# ---------------------------------------------------------------------------


def get_run(analysis_id: str, version: int, params_hash: str) -> dict[str, Any] | None:
    r = saved_analysis_run
    rows = store().query_read(
        select(r).where(
            r.c.analysis_id == analysis_id,
            r.c.version == version,
            r.c.params_hash == params_hash,
        )
    )
    return dict(rows[0]) if rows else None


def record_success(
    *,
    analysis_id: str,
    version: int,
    params_hash: str,
    params: dict[str, Any],
    columns: list[dict[str, Any]],
    rows: list[list[Any]],
    truncated: bool,
    sql: str,
    executed_at: dt.datetime,
    duration_ms: int,
    expires_at: dt.datetime,
) -> None:
    values = {
        "analysis_id": analysis_id,
        "version": version,
        "params_hash": params_hash,
        "params": params,
        "status": "ok",
        "error_code": None,
        "error": None,
        "attempted_at": executed_at,
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "truncated": truncated,
        "sql": sql,
        "executed_at": executed_at,
        "duration_ms": duration_ms,
        "expires_at": expires_at,
    }
    statement = pg_insert(saved_analysis_run).values(**values)
    statement = statement.on_conflict_do_update(
        index_elements=["analysis_id", "version", "params_hash"],
        set_={
            k: statement.excluded[k]
            for k in values
            if k not in ("analysis_id", "version", "params_hash")
        },
    )
    store().query_write(statement)


def record_failure(
    *,
    analysis_id: str,
    version: int,
    params_hash: str,
    params: dict[str, Any],
    error_code: str,
    error: str,
) -> None:
    """Note a failed attempt. The last successful rows, if any, stay."""
    values = {
        "analysis_id": analysis_id,
        "version": version,
        "params_hash": params_hash,
        "params": params,
        "status": "error",
        "error_code": error_code,
        "error": error[:4000],
        "attempted_at": _now(),
    }
    statement = pg_insert(saved_analysis_run).values(**values)
    statement = statement.on_conflict_do_update(
        index_elements=["analysis_id", "version", "params_hash"],
        set_={
            k: statement.excluded[k]
            for k in ("status", "error_code", "error", "attempted_at")
        },
    )
    store().query_write(statement)


# ---------------------------------------------------------------------------
# Catalog lookups
# ---------------------------------------------------------------------------


def resolve_catalog_tables(
    database_name: str, refs: list[tuple[str, str]]
) -> dict[tuple[str, str], tuple[str, str] | None]:
    """Map ``(schema, table)`` references to ``(schema, catalog table id)``.

    An unqualified reference (schema ``''``) resolves when exactly one schema
    of the database has a table of that name. Unresolved references map to
    None; callers keep them by name.
    """
    if not refs:
        return {}
    names = sorted({name for _, name in refs})
    rows = store().query_read(
        select(
            s.catalog_schema.c.name.label("schema_name"),
            s.catalog_table.c.name.label("table_name"),
            s.catalog_table.c.id.label("table_id"),
        )
        .select_from(
            s.catalog_table.join(
                s.catalog_schema, s.catalog_table.c.schema_id == s.catalog_schema.c.id
            ).join(
                s.catalog_database,
                s.catalog_schema.c.database_id == s.catalog_database.c.id,
            )
        )
        .where(
            s.catalog_database.c.name == database_name,
            s.catalog_table.c.name.in_(names),
        )
    )
    by_name: dict[str, list[tuple[str, str]]] = {}
    for row in rows:
        by_name.setdefault(row["table_name"], []).append(
            (row["schema_name"], row["table_id"])
        )
    resolved: dict[tuple[str, str], tuple[str, str] | None] = {}
    for schema, name in refs:
        candidates = by_name.get(name, [])
        if schema:
            match = [c for c in candidates if c[0] == schema]
        else:
            match = candidates
        resolved[(schema, name)] = match[0] if len(match) == 1 else None
    return resolved


__all__ = [
    "InvalidTransition",
    "NameConflict",
    "NotFound",
    "STATUS_RETIRED",
    "TRANSITIONS",
    "add_version",
    "create_analysis",
    "get_analysis",
    "get_run",
    "get_version",
    "list_analyses",
    "list_versions",
    "record_failure",
    "record_success",
    "resolve_catalog_tables",
    "set_version_status",
]
