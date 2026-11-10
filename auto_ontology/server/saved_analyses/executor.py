# SPDX-License-Identifier: Apache-2.0

"""Run one bound, guarded, row-capped statement and describe its result.

Postgres and MySQL/MariaDB get a dedicated connection per run inside a
**read-only transaction** that is always rolled back, with the statement
timeout set in that transaction. Result types come from the driver's column
description, and rows stay tuples, so two columns with the same name are not
merged the way the connectors' ``dict_row`` frames merge them.

Every other connector goes through :func:`execute_chat_sql` with the timeout.
It returns a DataFrame, so column types are inferred from the values and the
read-only guarantee is the SQL guard plus the connector's own configuration
(DuckDB opens read-only) plus the database account.

The connection details are taken from the connector's private attributes
(``_connection_string``, ``_connect``) rather than by changing the connectors,
to keep the fork's diff to upstream files small. A connector without them
falls back to the generic path.
"""

from __future__ import annotations

import base64
import datetime as dt
import logging
import math
import time
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from auto_ontology.connectors.base import SQLDatabase, StatementTimeout
from auto_ontology.retrieval.text_to_sql.chat_sql import execute_chat_sql, log_chat_sql
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
from auto_ontology.server.saved_analyses.params import JS_SAFE_INTEGER

logger = logging.getLogger(__name__)

#: Result column types in the contract.
COLUMN_TYPES = (
    "integer",
    "number",
    "decimal",
    "string",
    "date",
    "datetime",
    "bool",
    "json",
    "unknown",
)


@dataclass
class QueryResult:
    columns: list[dict[str, str]]  # [{"name", "type"}]
    rows: list[list[Any]]  # JSON-safe values, column order
    duration_ms: int
    read_only_transaction: bool


# ---------------------------------------------------------------------------
# Value serialisation
# ---------------------------------------------------------------------------


def to_json_value(value: Any) -> Any:
    """A JSON-safe form of one result cell.

    Decimals and integers beyond 2**53 become strings so no digit is lost on
    the way to a JavaScript client; NaN and infinities become null.
    """
    if value is None:
        return None
    if hasattr(value, "item") and not isinstance(value, (list, dict, str, bytes)):
        try:
            value = value.item()  # numpy / pandas scalars
        except (AttributeError, ValueError):
            pass
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return str(value) if abs(value) > JS_SAFE_INTEGER else value
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, Decimal):
        if not value.is_finite():
            return None
        return format(value, "f")
    if isinstance(value, dt.datetime):
        return value.isoformat()
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return "base64:" + base64.b64encode(raw).decode("ascii")
    if isinstance(value, (list, tuple)):
        return [to_json_value(v) for v in value]
    if isinstance(value, dict):
        return {str(k): to_json_value(v) for k, v in value.items()}
    try:
        import pandas as pd

        if value is pd.NaT:
            return None
        if isinstance(value, pd.Timestamp):
            return value.isoformat()
    except ImportError:  # pragma: no cover
        pass
    return str(value)


def infer_type(values: list[Any]) -> str:
    """Contract type for a column known only by its Python values."""
    for value in values:
        if value is None:
            continue
        if hasattr(value, "item") and not isinstance(value, (str, bytes)):
            try:
                value = value.item()
            except (AttributeError, ValueError):
                pass
        if isinstance(value, float) and math.isnan(value):
            continue
        if isinstance(value, bool):
            return "bool"
        if isinstance(value, int):
            return "integer"
        if isinstance(value, float):
            return "number"
        if isinstance(value, Decimal):
            return "decimal"
        if isinstance(value, dt.datetime):
            return "datetime"
        if isinstance(value, dt.date):
            return "date"
        if isinstance(value, (dict, list)):
            return "json"
        try:
            import pandas as pd

            if value is pd.NaT:
                continue
            if isinstance(value, pd.Timestamp):
                return "datetime"
        except ImportError:  # pragma: no cover
            pass
        return "string"
    return "unknown"


_PG_TYPES = {
    "int2": "integer",
    "int4": "integer",
    "int8": "integer",
    "oid": "integer",
    "float4": "number",
    "float8": "number",
    "numeric": "decimal",
    "money": "decimal",
    "bool": "bool",
    "date": "date",
    "timestamp": "datetime",
    "timestamptz": "datetime",
    "json": "json",
    "jsonb": "json",
}

_MYSQL_TYPES = {
    "TINY": "integer",
    "SHORT": "integer",
    "LONG": "integer",
    "LONGLONG": "integer",
    "INT24": "integer",
    "YEAR": "integer",
    "BIT": "integer",
    "FLOAT": "number",
    "DOUBLE": "number",
    "DECIMAL": "decimal",
    "NEWDECIMAL": "decimal",
    "DATE": "date",
    "NEWDATE": "date",
    "DATETIME": "datetime",
    "TIMESTAMP": "datetime",
    "JSON": "json",
}


# ---------------------------------------------------------------------------
# Execution paths
# ---------------------------------------------------------------------------


def _run_postgres(
    connector: Any, sql: str, timeout_s: float, max_rows: int
) -> tuple[list[dict[str, str]], list[tuple]]:
    import psycopg

    connection_string = connector._connection_string
    with psycopg.connect(
        connection_string, autocommit=False, connect_timeout=10
    ) as conn:
        try:
            # First statement of the transaction, as Postgres requires.
            conn.execute("SET TRANSACTION READ ONLY")
            conn.execute(
                "SELECT set_config('statement_timeout', %s, true)",
                (f"{max(1, int(timeout_s * 1000))}ms",),
            )
            with conn.cursor() as cur:
                cur.execute(sql)
                description = cur.description or []
                rows = cur.fetchmany(max_rows) if description else []
            columns = []
            for col in description:
                info = conn.adapters.types.get(col.type_code)
                type_name = info.name if info is not None else ""
                if type_name.startswith("_"):
                    mapped = "json"  # arrays
                else:
                    mapped = _PG_TYPES.get(type_name, "string")
                columns.append({"name": col.name, "type": mapped})
            return columns, rows
        except psycopg.errors.QueryCanceled as exc:
            if "statement timeout" in str(exc):
                raise StatementTimeout(timeout_s) from exc
            raise
        except psycopg.errors.ReadOnlySqlTransaction as exc:
            raise SavedAnalysisError(
                "forbidden_statement",
                f"The database refused a write inside the read-only transaction: {exc}",
            ) from exc
        finally:
            conn.rollback()


def _run_mysql(
    connector: Any, sql: str, timeout_s: float, max_rows: int
) -> tuple[list[dict[str, str]], list[tuple]]:
    import mysql.connector
    from mysql.connector.constants import FieldType

    from auto_ontology.connectors.mysql import _TIMEOUT_ERRNOS

    connection = connector._connect()
    started = time.monotonic()
    try:
        cursor = connection.cursor(buffered=True)
        try:
            connector._set_statement_timeout(cursor, timeout_s)
            cursor.execute("START TRANSACTION READ ONLY")
            cursor.execute(sql)
            description = cursor.description or []
            rows = cursor.fetchmany(max_rows) if description else []
            columns = [
                {
                    "name": d[0],
                    "type": _MYSQL_TYPES.get(FieldType.get_info(d[1]) or "", "string"),
                }
                for d in description
            ]
            return columns, rows
        except mysql.connector.Error as exc:
            if exc.errno in _TIMEOUT_ERRNOS:
                raise StatementTimeout.since(timeout_s, started) from exc
            if exc.errno == 1792:  # ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
                raise SavedAnalysisError(
                    "forbidden_statement",
                    f"The database refused a write inside the read-only transaction: {exc}",
                ) from exc
            raise
        finally:
            try:
                connection.rollback()
            finally:
                cursor.close()
    finally:
        connection.close()


def _run_generic(
    connector: SQLDatabase, sql: str, timeout_s: float, max_rows: int
) -> tuple[list[dict[str, str]], list[tuple]]:
    frame = execute_chat_sql(connector, sql, kind="saved analysis", timeout_s=timeout_s)
    frame = frame.head(max_rows)
    names = [str(c) for c in frame.columns]
    raw_rows = list(frame.itertuples(index=False, name=None))
    columns = [
        {"name": name, "type": infer_type([row[i] for row in raw_rows])}
        for i, name in enumerate(names)
    ]
    return columns, raw_rows


def _native_runner(connector: SQLDatabase):
    from auto_ontology.connectors.mysql import MySQLDatabase
    from auto_ontology.connectors.postgres import PostgresDatabase

    if isinstance(connector, PostgresDatabase) and hasattr(
        connector, "_connection_string"
    ):
        return _run_postgres
    if (
        isinstance(connector, MySQLDatabase)
        and hasattr(connector, "_connect")
        and hasattr(connector, "_set_statement_timeout")
    ):
        return _run_mysql
    return None


def run_query(
    connector: SQLDatabase, sql: str, *, timeout_s: float, max_rows: int
) -> QueryResult:
    """Execute *sql* (already guarded and capped) and return typed JSON-safe rows.

    *max_rows* bounds what is fetched; the SQL itself should already carry a
    ``LIMIT`` at least that large. Raises ``timeout`` or ``db_error``.
    """
    runner = _native_runner(connector)
    started = time.monotonic()
    try:
        if runner is not None:
            log_chat_sql(connector, sql, kind="saved analysis (read-only)")
            columns, raw_rows = runner(connector, sql, timeout_s, max_rows)
        else:
            columns, raw_rows = _run_generic(connector, sql, timeout_s, max_rows)
    except SavedAnalysisError:
        raise
    except (StatementTimeout, TimeoutError) as exc:
        raise SavedAnalysisError(
            "timeout",
            f"The query ran longer than its {timeout_s:g}s limit and was cancelled.",
            details={"timeout_s": timeout_s},
        ) from exc
    except Exception as exc:  # noqa: BLE001 - every driver error becomes db_error
        logger.warning(
            "Saved analysis query failed on %s: %s",
            getattr(connector, "database_name", "?"),
            exc,
        )
        raise SavedAnalysisError(
            "db_error", f"The database returned an error: {exc}"
        ) from exc
    duration_ms = int((time.monotonic() - started) * 1000)

    rows = [[to_json_value(v) for v in row] for row in raw_rows]
    # A driver-typed column that came back unknown still has values to look at.
    for index, column in enumerate(columns):
        if column["type"] == "unknown":
            column["type"] = infer_type([row[index] for row in raw_rows])
    return QueryResult(
        columns=columns,
        rows=rows,
        duration_ms=duration_ms,
        read_only_transaction=runner is not None,
    )
