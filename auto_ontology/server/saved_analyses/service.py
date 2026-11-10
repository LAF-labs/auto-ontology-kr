# SPDX-License-Identifier: Apache-2.0

"""Save, verify and run saved analyses; the result cache.

No LLM is involved anywhere here: a run is parameter validation, text binding,
the SQL guard, one statement, and a cache write.

**Concurrency.** Each database gets a semaphore of
``SAVED_ANALYSES_MAX_CONCURRENCY_PER_DB`` slots; a run that cannot get one in
``SAVED_ANALYSES_QUEUE_TIMEOUT_S`` fails with ``busy``. Identical runs (same
version and bound parameters) are single-flight inside the process: the second
waits for the first and reuses its result. The backend serves from one process
(``python -m auto_ontology.server`` runs a single uvicorn worker), so an
in-process lock is enough; a multi-worker deployment would run duplicates at
worst, never return wrong rows.

**Batch deadline.** ``run-batch`` answers within its deadline. Items still
running then are reported as ``timeout`` and left to finish in the background:
the statement keeps its own ``timeout_s``, and a result that arrives late
still lands in the cache for the next call. Items not yet started are dropped.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import contextmanager
from typing import Any

from auto_ontology.connectors.base import SQLDatabase
from auto_ontology.dal.saved_analyses import store
from auto_ontology.dal.saved_analyses.tables import (
    STATUS_DRAFT,
    STATUS_RETIRED,
    STATUS_VERIFIED,
)
from auto_ontology.server.saved_analyses import config, params, sqltext
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
from auto_ontology.server.saved_analyses.executor import QueryResult, run_query

logger = logging.getLogger(__name__)

PREVIEW_ROWS = 100


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(value: dt.datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Connectors
# ---------------------------------------------------------------------------


def get_connector(database_name: str) -> SQLDatabase:
    from auto_ontology.connectors.registry import get_connectors

    connectors = get_connectors()
    for connector in connectors:
        if connector.database_name == database_name:
            return connector
    raise SavedAnalysisError(
        "unknown_database",
        f"No connection serves database {database_name!r}",
        details={"available": sorted(c.database_name for c in connectors)},
    )


# ---------------------------------------------------------------------------
# SQL preparation
# ---------------------------------------------------------------------------


def check_definitions_against_sql(
    sql: str, dialect: str, definitions: list[dict[str, Any]]
) -> list[sqltext.TableRef]:
    """Guard the saved SQL and match its placeholders to the definitions.

    Returns the tables it references.
    """
    tree = sqltext.parse_single(sql, dialect)
    sqltext.check_read_only(tree)
    spans = sqltext.placeholders(sql, dialect, tree)
    used = {span.name for span in spans}
    defined = {d["name"] for d in definitions}
    if used - defined:
        raise SavedAnalysisError(
            "invalid_definition",
            f"Placeholders without a definition: {sorted(used - defined)}",
        )
    if defined - used:
        raise SavedAnalysisError(
            "invalid_definition",
            f"Parameters not used in the SQL: {sorted(defined - used)}",
        )
    list_params = {d["name"] for d in definitions if params.split_type(d["type"])[1]}
    sqltext.check_list_placements(tree, list_params)
    return sqltext.referenced_tables(tree)


def prepare_sql(
    sql: str,
    dialect: str,
    definitions: list[dict[str, Any]],
    values: dict[str, Any],
    fetch_rows: int,
) -> tuple[str, str]:
    """Return ``(bound_sql, executed_sql)`` for resolved *values*.

    The bound SQL is checked again by the guard: binding only inserts literals
    rendered by sqlglot, but the guard is cheap and this is the statement that
    will run.
    """
    tree = sqltext.parse_single(sql, dialect)
    sqltext.check_read_only(tree)
    spans = sqltext.placeholders(sql, dialect, tree)
    by_name = {d["name"]: d for d in definitions}
    literals = {
        name: params.to_sql_literal(by_name[name], values[name], dialect)
        for name in {span.name for span in spans}
    }
    bound = sqltext.bind(sql, spans, literals)
    bound_tree = sqltext.parse_single(bound, dialect)
    sqltext.check_read_only(bound_tree)
    if any(True for _ in bound_tree.find_all(sqltext.exp.Placeholder)):
        raise SavedAnalysisError(
            "unsupported_placeholder", "A placeholder survived binding"
        )
    executed = sqltext.apply_row_limit(bound, dialect, bound_tree, fetch_rows)
    sqltext.check_read_only(sqltext.parse_single(executed, dialect))
    return bound, executed


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------

_slots_lock = threading.Lock()
_slots: dict[str, tuple[int, threading.BoundedSemaphore]] = {}
_flights_lock = threading.Lock()
_flights: dict[tuple[str, int, str], list[Any]] = {}  # key -> [lock, refcount]


def _semaphore(database_name: str) -> threading.BoundedSemaphore:
    size = config.setting("SAVED_ANALYSES_MAX_CONCURRENCY_PER_DB")
    with _slots_lock:
        current = _slots.get(database_name)
        if current is None or current[0] != size:
            current = (size, threading.BoundedSemaphore(size))
            _slots[database_name] = current
        return current[1]


@contextmanager
def database_slot(database_name: str) -> Iterator[None]:
    semaphore = _semaphore(database_name)
    wait_s = config.setting("SAVED_ANALYSES_QUEUE_TIMEOUT_S")
    if not semaphore.acquire(timeout=wait_s):
        raise SavedAnalysisError(
            "busy",
            f"Too many saved analyses are running on {database_name!r}; retry shortly.",
            details={"database_name": database_name, "waited_s": wait_s},
        )
    try:
        yield
    finally:
        semaphore.release()


@contextmanager
def single_flight(key: tuple[str, int, str]) -> Iterator[None]:
    with _flights_lock:
        entry = _flights.setdefault(key, [threading.Lock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _flights_lock:
            entry[1] -= 1
            if entry[1] == 0:
                _flights.pop(key, None)


# ---------------------------------------------------------------------------
# Column structure
# ---------------------------------------------------------------------------

_ROLE_BY_TYPE = {
    "integer": "measure",
    "number": "measure",
    "decimal": "measure",
    "date": "time",
    "datetime": "time",
}


def fix_columns(
    observed: list[dict[str, str]], hints: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    names = [c["name"] for c in observed]
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise SavedAnalysisError(
            "duplicate_columns",
            f"Result columns must have distinct names; repeated: {duplicates}. Alias them.",
            details={"columns": duplicates},
        )
    unknown = sorted(set(hints) - set(names))
    if unknown:
        raise SavedAnalysisError(
            "invalid_definition",
            f"column_hints name columns the query does not return: {unknown}",
        )
    columns = []
    for column in observed:
        hint = hints.get(column["name"]) or {}
        columns.append(
            {
                "name": column["name"],
                "type": column["type"],
                "role": hint.get("role")
                or _ROLE_BY_TYPE.get(column["type"], "dimension"),
                "unit": hint.get("unit"),
                "label": hint.get("label"),
                "description": hint.get("description"),
            }
        )
    return columns


def columns_match(fixed: list[dict[str, Any]], observed: list[dict[str, str]]) -> bool:
    if [c["name"] for c in fixed] != [c["name"] for c in observed]:
        return False
    for want, got in zip(fixed, observed):
        if "unknown" in (want["type"], got["type"]):
            continue  # all-null column seen through a DataFrame
        if want["type"] != got["type"]:
            return False
    return True


# ---------------------------------------------------------------------------
# Save
# ---------------------------------------------------------------------------


def _limits(body: dict[str, Any]) -> dict[str, int]:
    out = {}
    for field, default_key, max_key in (
        (
            "row_limit",
            "SAVED_ANALYSES_DEFAULT_ROW_LIMIT",
            "SAVED_ANALYSES_MAX_ROW_LIMIT",
        ),
        (
            "timeout_s",
            "SAVED_ANALYSES_DEFAULT_TIMEOUT_S",
            "SAVED_ANALYSES_MAX_TIMEOUT_S",
        ),
        (
            "cache_ttl_s",
            "SAVED_ANALYSES_DEFAULT_CACHE_TTL_S",
            "SAVED_ANALYSES_MAX_CACHE_TTL_S",
        ),
    ):
        value = body.get(field)
        maximum = config.setting(max_key)
        if value is None:
            value = min(config.setting(default_key), maximum)
        if value > maximum:
            raise SavedAnalysisError(
                "invalid_definition", f"{field} {value} exceeds the maximum {maximum}"
            )
        out[field] = int(value)
    return out


def _build_version(
    database_name: str, body: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    """Validate, run once, and return ``(version_fields, tables, preview)``."""
    connector = get_connector(database_name)
    dialect = connector.dialect
    definitions = params.validate_definitions(body.get("params") or [])
    refs = check_definitions_against_sql(body["sql"], dialect, definitions)
    limits = _limits(body)

    values = params.resolve_values(definitions, body.get("sample_params") or {})
    bound, executed = prepare_sql(
        body["sql"], dialect, definitions, values, limits["row_limit"] + 1
    )
    with database_slot(database_name):
        result = run_query(
            connector,
            executed,
            timeout_s=limits["timeout_s"],
            max_rows=limits["row_limit"] + 1,
        )
    hints = {
        k: (v if isinstance(v, dict) else v.model_dump())
        for k, v in (body.get("column_hints") or {}).items()
    }
    columns = fix_columns(result.columns, hints)

    resolved = store.resolve_catalog_tables(
        database_name, [(r.schema, r.name) for r in refs]
    )
    tables = []
    for ref in refs:
        hit = resolved.get((ref.schema, ref.name))
        tables.append(
            {
                "database_name": database_name,
                "schema_name": ref.schema or (hit[0] if hit else ""),
                "table_name": ref.name,
                "table_id": hit[1] if hit else None,
            }
        )
    fields = {
        "sql": body["sql"],
        "params": definitions,
        "columns": columns,
        **limits,
    }
    preview = {
        "params": params.to_json(values),
        "columns": columns,
        "rows": result.rows[:PREVIEW_ROWS],
        "row_count": min(len(result.rows), limits["row_limit"]),
        "truncated": len(result.rows) > limits["row_limit"],
        "duration_ms": result.duration_ms,
        "read_only_transaction": result.read_only_transaction,
        "sql": executed,
        "unresolved_tables": [
            t["table_name"]
            if not t["schema_name"]
            else f"{t['schema_name']}.{t['table_name']}"
            for t in tables
            if t["table_id"] is None
        ],
    }
    return fields, tables, preview


def create_analysis(body: dict[str, Any], user_id: str | None) -> dict[str, Any]:
    fields, tables, preview = _build_version(body["database_name"], body)
    try:
        analysis_id = store.create_analysis(
            name=body["name"],
            description=body.get("description"),
            database_name=body["database_name"],
            version_fields=fields,
            tables=tables,
            created_by=user_id,
        )
    except store.NameConflict:
        raise SavedAnalysisError(
            "name_conflict", f"A saved analysis named {body['name']!r} already exists"
        ) from None
    detail = get_detail(analysis_id, 1)
    detail["preview"] = preview
    return detail


def add_version(
    analysis_id: str, body: dict[str, Any], user_id: str | None
) -> dict[str, Any]:
    analysis = store.get_analysis(analysis_id)
    if analysis is None:
        raise SavedAnalysisError("not_found", f"No saved analysis {analysis_id!r}")
    fields, tables, preview = _build_version(analysis["database_name"], body)
    try:
        version = store.add_version(
            analysis_id,
            description=body.get("description"),
            version_fields=fields,
            tables=tables,
            created_by=user_id,
        )
    except store.NotFound:
        raise SavedAnalysisError(
            "not_found", f"No saved analysis {analysis_id!r}"
        ) from None
    detail = get_detail(analysis_id, version)
    detail["preview"] = preview
    return detail


def change_status(
    analysis_id: str,
    version: int,
    status: str,
    *,
    user_id: str | None,
    note: str | None,
) -> dict[str, Any]:
    try:
        store.set_version_status(
            analysis_id, version, status, user_id=user_id, note=note
        )
    except store.NotFound:
        raise SavedAnalysisError(
            "not_found", f"No version {version} of {analysis_id!r}"
        ) from None
    except store.InvalidTransition as exc:
        raise SavedAnalysisError(
            "invalid_status_transition", f"Cannot change status: {exc}"
        ) from None
    from auto_ontology.server.saved_analyses import custom_copy

    # Verify and retire both move the latest verified version, which is the
    # one mirrored into Custom Analyses.
    synced = custom_copy.sync(analysis_id)
    detail = get_detail(analysis_id, version)
    detail["custom_analysis_sync"] = synced
    return detail


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


def _summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "database_name": row["database_name"],
        "latest_version": row["latest_version"],
        "latest_verified_version": row.get("latest_verified_version"),
        "created": _iso(row["created"]),
        "created_by": row["created_by"],
        "updated": _iso(row["updated"]),
    }


def _version_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": row["version"],
        "status": row["status"],
        "sql": row["sql"],
        "params": row["params"],
        "columns": row["columns"],
        "row_limit": row["row_limit"],
        "timeout_s": row["timeout_s"],
        "cache_ttl_s": row["cache_ttl_s"],
        "tables": row["tables"],
        "verified_by": row["verified_by"],
        "verified_at": _iso(row["verified_at"]),
        "verification_note": row["verification_note"],
        "created": _iso(row["created"]),
        "created_by": row["created_by"],
    }


def list_analyses(
    *, search: str | None, status: str | None, skip: int, limit: int | None
) -> tuple[list[dict[str, Any]], int]:
    rows, total = store.list_analyses(
        search=search, status=status, skip=skip, limit=limit
    )
    return [_summary(r) for r in rows], total


def get_detail(analysis_id: str, version: int | None = None) -> dict[str, Any]:
    analysis = store.get_analysis(analysis_id)
    if analysis is None:
        raise SavedAnalysisError("not_found", f"No saved analysis {analysis_id!r}")
    if version is None:
        version = analysis["latest_verified_version"] or analysis["latest_version"]
    row = store.get_version(analysis_id, version)
    if row is None:
        raise SavedAnalysisError(
            "not_found", f"No version {version} of {analysis_id!r}"
        )
    detail = _summary(analysis)
    detail["versions"] = [
        {
            "version": v["version"],
            "status": v["status"],
            "created": _iso(v["created"]),
            "created_by": v["created_by"],
            "verified_at": _iso(v["verified_at"]),
            "verified_by": v["verified_by"],
        }
        for v in store.list_versions(analysis_id)
    ]
    detail["version"] = _version_payload(row)
    from auto_ontology.server.saved_analyses import custom_copy

    detail["custom_analysis"] = custom_copy.copy_state(
        analysis_id, analysis["latest_verified_version"]
    )
    return detail


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def params_hash(values_json: dict[str, Any]) -> str:
    canonical = json.dumps(
        values_json, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _resolve_version(
    analysis_id: str, version: int | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    analysis = store.get_analysis(analysis_id)
    if analysis is None:
        raise SavedAnalysisError("not_found", f"No saved analysis {analysis_id!r}")
    if version is None:
        version = analysis["latest_verified_version"]
        if version is None:
            raise SavedAnalysisError(
                "not_verified",
                f"{analysis['name']!r} has no verified version; pass an explicit version to run a draft.",
                details={"latest_version": analysis["latest_version"]},
            )
    row = store.get_version(analysis_id, version)
    if row is None:
        raise SavedAnalysisError(
            "not_found", f"No version {version} of {analysis_id!r}"
        )
    if row["status"] == STATUS_RETIRED:
        raise SavedAnalysisError(
            "retired", f"Version {version} of {analysis['name']!r} is retired"
        )
    return analysis, row


def _source(analysis: dict[str, Any], version_row: dict[str, Any]) -> dict[str, Any]:
    return {
        "database_name": analysis["database_name"],
        "tables": [
            f"{t['schema_name']}.{t['table_name']}"
            if t["schema_name"]
            else t["table_name"]
            for t in version_row["tables"]
        ],
    }


def _slice(run: dict[str, Any], row_limit: int) -> tuple[list[list[Any]], bool]:
    rows = run["rows"] or []
    if len(rows) > row_limit:
        return rows[:row_limit], True
    return rows, bool(run["truncated"])


def _last_success(
    run: dict[str, Any] | None,
    analysis: dict[str, Any],
    version_row: dict[str, Any],
    row_limit: int,
) -> dict[str, Any] | None:
    """The cached successful result, shaped like a run's ``data``.

    Same field names as a fresh run (``name``, ``version``, ``source``,
    ``sql``…), so a caller can say which version the stale numbers come from.
    ``cache.hit`` is true and ``cache.expires_at`` may lie in the past.
    """
    if not run or run.get("rows") is None or run.get("executed_at") is None:
        return None
    return _payload(analysis, version_row, run["params"], run, row_limit, hit=True)


def _payload(
    analysis: dict[str, Any],
    version_row: dict[str, Any],
    values_json: dict[str, Any],
    run: dict[str, Any],
    row_limit: int,
    *,
    hit: bool,
    shared: bool = False,
) -> dict[str, Any]:
    rows, truncated = _slice(run, row_limit)
    return {
        "analysis_id": analysis["id"],
        "name": analysis["name"],
        "version": version_row["version"],
        "status": version_row["status"],
        "params": values_json,
        "columns": version_row["columns"],
        "rows": rows,
        "row_count": len(rows),
        "truncated": truncated,
        "executed_at": _iso(run["executed_at"]),
        "duration_ms": run["duration_ms"],
        "cache": {"hit": hit, "shared": shared, "expires_at": _iso(run["expires_at"])},
        "source": _source(analysis, version_row),
        "sql": run["sql"],
    }


def _fresh(run: dict[str, Any] | None, now: dt.datetime, max_age_s: int | None) -> bool:
    if not run or run.get("rows") is None or run.get("executed_at") is None:
        return False
    if run["expires_at"] is None or run["expires_at"] <= now:
        return False
    if max_age_s is not None and (now - run["executed_at"]).total_seconds() > max_age_s:
        return False
    return True


def run_analysis(
    analysis_id: str,
    *,
    version: int | None = None,
    supplied_params: dict[str, Any] | None = None,
    max_age_s: int | None = None,
    row_limit: int | None = None,
) -> dict[str, Any]:
    """Run (or serve from cache) one saved analysis. Returns the ``data`` payload."""
    requested_at = _now()
    analysis, version_row = _resolve_version(analysis_id, version)
    definitions = version_row["params"]
    values = params.resolve_values(definitions, supplied_params)
    values_json = params.to_json(values)
    key_hash = params_hash(values_json)
    version_limit = version_row["row_limit"]
    if row_limit is not None and row_limit > version_limit:
        raise SavedAnalysisError(
            "invalid_params",
            f"row_limit {row_limit} exceeds this version's limit of {version_limit}",
            details={"row_limit": version_limit},
        )
    effective_limit = row_limit or version_limit
    number = version_row["version"]

    cached = store.get_run(analysis_id, number, key_hash)
    if _fresh(cached, requested_at, max_age_s):
        return _payload(
            analysis, version_row, values_json, cached, effective_limit, hit=True
        )

    with single_flight((analysis_id, number, key_hash)):
        cached = store.get_run(analysis_id, number, key_hash)
        if (
            cached
            and cached.get("executed_at")
            and cached["executed_at"] >= requested_at
            and cached["status"] == "ok"
        ):
            # Produced by the identical request we waited behind.
            return _payload(
                analysis,
                version_row,
                values_json,
                cached,
                effective_limit,
                hit=True,
                shared=True,
            )
        if _fresh(cached, _now(), max_age_s):
            return _payload(
                analysis, version_row, values_json, cached, effective_limit, hit=True
            )
        return _execute(
            analysis,
            version_row,
            values,
            values_json,
            key_hash,
            cached,
            effective_limit,
        )


def _execute(
    analysis: dict[str, Any],
    version_row: dict[str, Any],
    values: dict[str, Any],
    values_json: dict[str, Any],
    key_hash: str,
    cached: dict[str, Any] | None,
    effective_limit: int,
) -> dict[str, Any]:
    analysis_id, number = analysis["id"], version_row["version"]
    version_limit = version_row["row_limit"]
    try:
        connector = get_connector(analysis["database_name"])
        _, executed = prepare_sql(
            version_row["sql"],
            connector.dialect,
            version_row["params"],
            values,
            version_limit + 1,
        )
        with database_slot(analysis["database_name"]):
            result: QueryResult = run_query(
                connector,
                executed,
                timeout_s=version_row["timeout_s"],
                max_rows=version_limit + 1,
            )
        if not columns_match(version_row["columns"], result.columns):
            raise SavedAnalysisError(
                "schema_mismatch",
                "The result columns no longer match the ones fixed when this version was saved.",
                details={
                    "expected": [
                        {"name": c["name"], "type": c["type"]}
                        for c in version_row["columns"]
                    ],
                    "actual": result.columns,
                },
            )
    except SavedAnalysisError as exc:
        if exc.code not in ("busy",):
            try:
                store.record_failure(
                    analysis_id=analysis_id,
                    version=number,
                    params_hash=key_hash,
                    params=values_json,
                    error_code=exc.code,
                    error=exc.message,
                )
            except Exception:  # noqa: BLE001 - the original error matters more
                logger.exception("Could not record a failed saved-analysis run")
        exc.last_success = _last_success(cached, analysis, version_row, effective_limit)
        raise

    executed_at = _now()
    rows = result.rows[:version_limit]
    truncated = len(result.rows) > version_limit
    run = {
        "rows": rows,
        "truncated": truncated,
        "executed_at": executed_at,
        "duration_ms": result.duration_ms,
        "expires_at": executed_at + dt.timedelta(seconds=version_row["cache_ttl_s"]),
        "sql": executed,
        "params": values_json,
    }
    try:
        store.record_success(
            analysis_id=analysis_id,
            version=number,
            params_hash=key_hash,
            params=values_json,
            columns=[{"name": c["name"], "type": c["type"]} for c in result.columns],
            rows=rows,
            truncated=truncated,
            sql=executed,
            executed_at=executed_at,
            duration_ms=result.duration_ms,
            expires_at=run["expires_at"],
        )
    except Exception:  # noqa: BLE001 - a cache write failure must not lose the result
        logger.exception("Could not cache a saved-analysis run")
    return _payload(analysis, version_row, values_json, run, effective_limit, hit=False)


def batch_deadline(requested_s: int | None) -> int:
    """The deadline a batch runs under: the request's, else the configured default."""
    maximum = config.setting("SAVED_ANALYSES_BATCH_MAX_DEADLINE_S")
    if requested_s is None:
        return min(config.setting("SAVED_ANALYSES_BATCH_DEADLINE_S"), maximum)
    if requested_s > maximum:
        raise SavedAnalysisError(
            "invalid_params",
            f"deadline_s {requested_s} exceeds the maximum of {maximum}",
            details={"deadline_s": maximum},
        )
    return requested_s


def peek_last_success(
    analysis_id: str,
    *,
    version: int | None = None,
    supplied_params: dict[str, Any] | None = None,
    row_limit: int | None = None,
) -> dict[str, Any] | None:
    """The cached last success for a run request, without running anything.

    None when there is none or the request would not resolve (unknown
    analysis, bad parameters…).
    """
    try:
        analysis, version_row = _resolve_version(analysis_id, version)
        values = params.resolve_values(version_row["params"], supplied_params)
    except SavedAnalysisError:
        return None
    values_json = params.to_json(values)
    cached = store.get_run(
        analysis_id, version_row["version"], params_hash(values_json)
    )
    limit = min(row_limit or version_row["row_limit"], version_row["row_limit"])
    return _last_success(cached, analysis, version_row, limit)


def _deadline_error(
    item: dict[str, Any], deadline_s: int, started: bool
) -> dict[str, Any]:
    try:
        last = peek_last_success(
            item["analysis_id"],
            version=item.get("version"),
            supplied_params=item.get("params"),
            row_limit=item.get("row_limit"),
        )
    except Exception:  # noqa: BLE001 - the timeout is the answer either way
        logger.exception("Could not look up the last success of a timed-out item")
        last = None
    state = "finished" if started else "started"
    return SavedAnalysisError(
        "timeout",
        f"The batch deadline of {deadline_s}s passed before this item {state}.",
        details={"deadline_s": deadline_s},
        last_success=last,
    ).payload()


def run_batch(
    items: list[dict[str, Any]],
    default_max_age_s: int | None,
    *,
    deadline_s: int | None = None,
) -> dict[str, Any]:
    """Run many analyses; identical items run once. Returns ``{key: {data}|{error}}``.

    The call returns within *deadline_s* (see :func:`batch_deadline`); items
    unfinished by then answer ``timeout`` with ``details.deadline_s``.
    """
    deadline = batch_deadline(deadline_s)
    max_items = config.setting("SAVED_ANALYSES_BATCH_MAX_ITEMS")
    if len(items) > max_items:
        raise SavedAnalysisError(
            "invalid_params",
            f"A batch holds at most {max_items} items; got {len(items)}",
        )
    keys = [item["key"] for item in items]
    repeated = sorted({k for k in keys if keys.count(k) > 1})
    if repeated:
        raise SavedAnalysisError("invalid_params", f"Repeated batch keys: {repeated}")

    def max_age(item: dict[str, Any]) -> int | None:
        own = item.get("max_age_s")
        return own if own is not None else default_max_age_s

    def signature(item: dict[str, Any]) -> str:
        return json.dumps(
            [
                item["analysis_id"],
                item.get("version"),
                item.get("params") or {},
                item.get("row_limit"),
                max_age(item),
            ],
            sort_keys=True,
            default=str,
        )

    unique: dict[str, dict[str, Any]] = {}
    key_to_signature: dict[str, str] = {}
    for item in items:
        sig = signature(item)
        key_to_signature[item["key"]] = sig
        unique.setdefault(sig, item)

    def run_one(item: dict[str, Any]) -> dict[str, Any]:
        try:
            data = run_analysis(
                item["analysis_id"],
                version=item.get("version"),
                supplied_params=item.get("params"),
                max_age_s=max_age(item),
                row_limit=item.get("row_limit"),
            )
            return {"data": data}
        except SavedAnalysisError as exc:
            return exc.payload()
        except Exception as exc:  # noqa: BLE001 - one item must not fail the batch
            logger.exception("Saved analysis batch item failed")
            return SavedAnalysisError("db_error", f"Unexpected error: {exc}").payload()

    workers = min(config.setting("SAVED_ANALYSES_BATCH_PARALLELISM"), len(unique))
    pool = ThreadPoolExecutor(
        max_workers=max(1, workers), thread_name_prefix="saved-analysis"
    )
    futures = {sig: pool.submit(run_one, item) for sig, item in unique.items()}
    try:
        wait(futures.values(), timeout=deadline)
    finally:
        # Drop what has not started; let running statements end on their own
        # timeout_s without holding up the answer.
        pool.shutdown(wait=False, cancel_futures=True)
    results: dict[str, dict[str, Any]] = {}
    for sig, future in futures.items():
        if future.done() and not future.cancelled():
            results[sig] = future.result()
        else:
            results[sig] = _deadline_error(
                unique[sig], deadline, started=not future.cancelled()
            )
    return {key: results[key_to_signature[key]] for key in keys}


__all__ = [
    "STATUS_DRAFT",
    "STATUS_RETIRED",
    "STATUS_VERIFIED",
    "add_version",
    "change_status",
    "create_analysis",
    "get_detail",
    "list_analyses",
    "run_analysis",
    "run_batch",
]
