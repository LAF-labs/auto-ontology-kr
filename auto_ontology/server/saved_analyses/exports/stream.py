# SPDX-License-Identifier: Apache-2.0

"""Fetch a guarded statement's result in chunks, inside a read-only transaction.

The run path (:mod:`..executor`) fetches at most a version's ``row_limit`` and
holds it in memory. An export may read a million rows, so here the rows come
in chunks of ``SAVED_ANALYSES_EXPORT_CHUNK_ROWS`` and only one chunk is alive
at a time:

* **Postgres**: a server-side (named) cursor, ``FETCH`` per chunk. The
  statement timeout is reset before every fetch to what is left of the
  export's wall-clock budget, so the whole export, not each fetch, is bounded.
* **MySQL / MariaDB**: an unbuffered cursor, which reads rows off the socket
  as they are fetched. The session statement timeout is the whole budget.

Both run inside ``READ ONLY`` transactions that are always rolled back, on a
dedicated connection, exactly like a run. Other connectors only return whole
DataFrames, so they are not offered for export (``export_unsupported``).
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from auto_ontology.connectors.base import SQLDatabase, StatementTimeout
from auto_ontology.retrieval.text_to_sql.chat_sql import log_chat_sql
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
from auto_ontology.server.saved_analyses.executor import _MYSQL_TYPES, _PG_TYPES


@dataclass
class ColumnInfo:
    """One result column as the driver describes it."""

    name: str
    type: str  # contract type, as in executor.COLUMN_TYPES
    precision: int | None = None  # decimals, when the driver knows them
    scale: int | None = None
    with_timezone: bool = False  # datetimes: timestamptz
    unsigned: bool = False  # integers: MySQL UNSIGNED


@dataclass
class Opened:
    columns: list[ColumnInfo]
    chunks: Iterator[list[tuple]]
    dialect_family: str  # "postgres" | "mysql"


def supports(connector: SQLDatabase) -> bool:
    from auto_ontology.server.saved_analyses.executor import _native_runner

    return _native_runner(connector) is not None


def _remaining(deadline: float, timeout_s: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise StatementTimeout(timeout_s)
    return left


def _timeout_error(timeout_s: float) -> SavedAnalysisError:
    return SavedAnalysisError(
        "timeout",
        f"The export ran longer than its {timeout_s:g}s limit and was cancelled.",
        details={"timeout_s": timeout_s},
    )


def _readonly_error(exc: Exception) -> SavedAnalysisError:
    return SavedAnalysisError(
        "forbidden_statement",
        f"The database refused a write inside the read-only transaction: {exc}",
    )


def _db_error(exc: Exception) -> SavedAnalysisError:
    return SavedAnalysisError("db_error", f"The database returned an error: {exc}")


def _pg_error(exc: Exception, timeout_s: float) -> SavedAnalysisError | None:
    import psycopg

    if isinstance(exc, (StatementTimeout, TimeoutError)):
        return _timeout_error(timeout_s)
    if isinstance(exc, psycopg.errors.QueryCanceled) and "statement timeout" in str(
        exc
    ):
        return _timeout_error(timeout_s)
    if isinstance(exc, psycopg.errors.ReadOnlySqlTransaction):
        return _readonly_error(exc)
    if isinstance(exc, psycopg.Error):
        return _db_error(exc)
    return None


def _mysql_error(exc: Exception, timeout_s: float) -> SavedAnalysisError | None:
    import mysql.connector

    from auto_ontology.connectors.mysql import _TIMEOUT_ERRNOS

    if isinstance(exc, (StatementTimeout, TimeoutError)):
        return _timeout_error(timeout_s)
    if isinstance(exc, mysql.connector.Error):
        if exc.errno in _TIMEOUT_ERRNOS:
            return _timeout_error(timeout_s)
        if exc.errno == 1792:  # ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
            return _readonly_error(exc)
        return _db_error(exc)
    return None


@contextmanager
def _translated(
    mapper: Callable[[Exception, float], SavedAnalysisError | None], timeout_s: float
) -> Iterator[None]:
    """Turn driver errors raised in the block into contract errors.

    Wraps only calls into the driver, never the caller's own code, so a disk
    error while writing the file is not reported as a database error.
    """
    try:
        yield
    except SavedAnalysisError:
        raise
    except Exception as exc:
        mapped = mapper(exc, timeout_s)
        if mapped is None:
            raise
        raise mapped from exc


# ---------------------------------------------------------------------------
# Postgres
# ---------------------------------------------------------------------------


def _pg_columns(conn: Any, description: list[Any]) -> list[ColumnInfo]:
    columns = []
    for col in description:
        info = conn.adapters.types.get(col.type_code)
        type_name = info.name if info is not None else ""
        mapped = "json" if type_name.startswith("_") else _PG_TYPES.get(type_name)
        columns.append(
            ColumnInfo(
                name=col.name,
                type=mapped or "string",
                precision=col.precision if mapped == "decimal" else None,
                scale=col.scale if mapped == "decimal" else None,
                with_timezone=type_name == "timestamptz",
            )
        )
    return columns


@contextmanager
def _open_postgres(
    connector: Any, sql: str, *, deadline: float, timeout_s: float, chunk_rows: int
) -> Iterator[Opened]:
    import psycopg

    def guard() -> Any:
        return _translated(_pg_error, timeout_s)

    def set_timeout(conn: Any) -> None:
        left_ms = max(1, int(_remaining(deadline, timeout_s) * 1000))
        conn.execute(
            "SELECT set_config('statement_timeout', %s, true)", (f"{left_ms}ms",)
        )

    with guard():
        conn = psycopg.connect(
            connector._connection_string, autocommit=False, connect_timeout=10
        )
    try:
        with guard():
            conn.execute("SET TRANSACTION READ ONLY")
            set_timeout(conn)
            cursor = conn.cursor(name="saved_analysis_export")
            cursor.itersize = chunk_rows
            cursor.execute(sql)
            columns = _pg_columns(conn, cursor.description or [])

        def chunks() -> Iterator[list[tuple]]:
            while True:
                with guard():
                    set_timeout(conn)
                    rows = cursor.fetchmany(chunk_rows)
                if not rows:
                    return
                yield rows

        yield Opened(columns=columns, chunks=chunks(), dialect_family="postgres")
    finally:
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001 - closing discards the transaction anyway
            pass
        conn.close()


# ---------------------------------------------------------------------------
# MySQL / MariaDB
# ---------------------------------------------------------------------------


@contextmanager
def _open_mysql(
    connector: Any, sql: str, *, deadline: float, timeout_s: float, chunk_rows: int
) -> Iterator[Opened]:
    from mysql.connector.constants import FieldFlag, FieldType

    def guard() -> Any:
        return _translated(_mysql_error, timeout_s)

    with guard():
        connection = connector._connect()
    cursor = None
    try:
        with guard():
            cursor = connection.cursor(buffered=False)
            connector._set_statement_timeout(cursor, _remaining(deadline, timeout_s))
            cursor.execute("START TRANSACTION READ ONLY")
            cursor.execute(sql)
            columns = []
            for d in cursor.description or []:
                field = FieldType.get_info(d[1]) or ""
                flags = d[7] if len(d) > 7 and d[7] else 0
                columns.append(
                    ColumnInfo(
                        name=d[0],
                        type=_MYSQL_TYPES.get(field, "string"),
                        unsigned=bool(flags & FieldFlag.UNSIGNED),
                    )
                )

        def chunks() -> Iterator[list[tuple]]:
            while True:
                with guard():
                    _remaining(deadline, timeout_s)
                    rows = cursor.fetchmany(chunk_rows)
                if not rows:
                    return
                yield rows

        yield Opened(columns=columns, chunks=chunks(), dialect_family="mysql")
    finally:
        # An unbuffered cursor left mid-result cannot roll back or close
        # cleanly; closing the connection discards the rest.
        for step in (
            connection.rollback,
            (cursor.close if cursor is not None else None),
            connection.close,
        ):
            if step is None:
                continue
            try:
                step()
            except Exception:  # noqa: BLE001
                pass


@contextmanager
def open_stream(
    connector: SQLDatabase,
    sql: str,
    *,
    deadline: float,
    timeout_s: float,
    chunk_rows: int,
) -> Iterator[Opened]:
    """Open *sql* (already guarded and capped) for chunked reading.

    Opening and iterating ``chunks`` raise ``timeout``, ``forbidden_statement``
    or ``db_error`` as :class:`SavedAnalysisError`. Errors raised by the
    caller's own code inside the block pass through unchanged.
    """
    from auto_ontology.connectors.mysql import MySQLDatabase
    from auto_ontology.connectors.postgres import PostgresDatabase

    if not supports(connector):
        raise SavedAnalysisError(
            "export_unsupported",
            "Exports run only on Postgres and MySQL/MariaDB connections, which can "
            "stream a result inside a read-only transaction.",
            details={"database_name": getattr(connector, "database_name", None)},
        )
    opener = _open_postgres if isinstance(connector, PostgresDatabase) else None
    if opener is None and isinstance(connector, MySQLDatabase):
        opener = _open_mysql
    assert opener is not None
    log_chat_sql(connector, sql, kind="saved analysis export (read-only)")
    with opener(
        connector,
        sql,
        deadline=deadline,
        timeout_s=timeout_s,
        chunk_rows=chunk_rows,
    ) as opened:
        yield opened
