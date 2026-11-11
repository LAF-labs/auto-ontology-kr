# SPDX-License-Identifier: Apache-2.0

"""Bulk exports against a live MySQL or MariaDB.

Opt-in like ``test_saved_analyses_mysql``: defined only when
``SAVED_ANALYSES_TEST_MYSQL_URL`` and the ``POSTGRES_*`` store are set (CI has
no MySQL server and fails on extra skips). See that module for how to start
one locally.
"""

from __future__ import annotations

import datetime as dt
import os
import tracemalloc
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator

import pytest

MYSQL_URL = os.environ.get("SAVED_ANALYSES_TEST_MYSQL_URL")

if MYSQL_URL and os.environ.get("POSTGRES_USER"):
    import pyarrow as pa
    import pyarrow.parquet as pq
    from sqlalchemy import delete

    from auto_ontology.dal.saved_analyses import exports as export_log
    from auto_ontology.dal.saved_analyses.tables import saved_analysis
    from auto_ontology.dal.session import store
    from auto_ontology.server.saved_analyses import service
    from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
    from auto_ontology.server.saved_analyses.exports import service as exports

    PREFIX = f"sa_mysql_export_{uuid.uuid4().hex[:8]}"
    TABLE = f"sa_export_{uuid.uuid4().hex[:6]}"
    AUDIT = f"sa_export_audit_{uuid.uuid4().hex[:6]}"
    WRITER = f"sa_export_write_{uuid.uuid4().hex[:6]}"

    @pytest.fixture(scope="module")
    def connector() -> Iterator[Any]:
        from auto_ontology.connectors.mysql import MySQLDatabase

        db = MySQLDatabase(MYSQL_URL)

        def run(*statements: str) -> None:
            connection = db._connect()
            try:
                cursor = connection.cursor()
                for statement in statements:
                    cursor.execute(statement)
                connection.commit()
            finally:
                connection.close()

        run(
            f"CREATE TABLE {TABLE} (id INT PRIMARY KEY, status VARCHAR(20), "
            "amount DECIMAL(12,2), created DATE, at DATETIME, "
            "big BIGINT UNSIGNED, ratio DOUBLE, doc JSON)",
            f"INSERT INTO {TABLE} VALUES "
            "(1, 'APPROVED', 100.10, '2026-10-01', '2026-10-01 09:00:00', 18446744073709551615, 0.5, '{\"a\": 1}'), "
            "(2, 'APPROVED', 0.20, '2026-10-15', '2026-10-15 10:00:00', 1, NULL, NULL), "
            "(3, '대기', NULL, '2026-11-02', '2026-11-02 11:00:00', 2, -2.5, '[1]')",
            f"CREATE TABLE {AUDIT} (note VARCHAR(20))",
            f"CREATE FUNCTION {WRITER}(mode VARCHAR(10)) RETURNS INT MODIFIES SQL DATA "
            f"BEGIN IF mode = 'write' THEN INSERT INTO {AUDIT} VALUES ('written'); END IF; "
            "RETURN 1; END",
        )
        try:
            yield db
        finally:
            store().query_write(
                delete(saved_analysis).where(saved_analysis.c.name.like(f"{PREFIX}%"))
            )
            store().query_write(
                delete(export_log.saved_analysis_export).where(
                    export_log.saved_analysis_export.c.analysis_name.like(f"{PREFIX}%")
                )
            )
            run(f"DROP FUNCTION {WRITER}", f"DROP TABLE {AUDIT}", f"DROP TABLE {TABLE}")

    @pytest.fixture(autouse=True)
    def only_this_connector(monkeypatch: pytest.MonkeyPatch, connector: Any) -> None:
        import auto_ontology.connectors.registry as registry

        monkeypatch.setattr(registry, "get_connectors", lambda: [connector])

    @pytest.fixture(autouse=True)
    def export_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
        path = tmp_path / "exports"
        monkeypatch.setenv("SAVED_ANALYSES_EXPORT_DIR", str(path))
        monkeypatch.setenv("SAVED_ANALYSES_EXPORT_DAILY_MAX_COUNT", "1000000")
        monkeypatch.setenv("SAVED_ANALYSES_EXPORT_DAILY_MAX_ROWS", "1000000000")
        return path

    def _verified(connector: Any, sql: str, params: list | None = None) -> str:
        detail = service.create_analysis(
            {
                "name": f"{PREFIX}_{uuid.uuid4().hex[:6]}",
                "database_name": connector.database_name,
                "sql": sql,
                "params": params or [],
                "row_limit": 10,
            },
            None,
        )
        service.change_status(detail["id"], 1, "verified", user_id="r", note=None)
        return detail["id"]

    def _export(analysis_id: str, **kwargs: Any) -> dict[str, Any]:
        return exports.create_export(
            analysis_id,
            version=None,
            supplied_params=kwargs.pop("params", {}),
            fmt=kwargs.pop("fmt", "parquet"),
            user_id="exporter",
        )

    def test_mysql_parquet_types(connector: Any, export_dir: Path) -> None:
        analysis_id = _verified(
            connector,
            f"SELECT id, status, amount, SUM(amount) OVER (ORDER BY id) AS running, "
            f"created, at, big, ratio, doc FROM {TABLE} ORDER BY id",
        )
        data = _export(analysis_id)
        table = pq.read_table(export_dir / data["file"]["name"])
        types = {f.name: f.type for f in table.schema}
        assert types["id"] == pa.int64()
        assert types["status"] == pa.string()
        # MySQL sends decimals with the column's fixed scale.
        assert types["amount"] == pa.decimal128(38, 2)
        assert types["running"] == pa.decimal128(38, 2)
        assert types["created"] == pa.date32()
        assert types["at"] == pa.timestamp("us")
        assert types["big"] == pa.uint64()
        assert types["ratio"] == pa.float64()
        rows = table.to_pylist()
        assert rows[0]["amount"] == Decimal("100.10")
        assert rows[2]["amount"] is None and rows[2]["running"] == Decimal("100.30")
        assert rows[0]["big"] == 18446744073709551615
        assert rows[0]["at"] == dt.datetime(2026, 10, 1, 9, 0)
        assert rows[2]["status"] == "대기"
        assert rows[0]["doc"] is not None and rows[1]["doc"] is None

    def test_mysql_csv(connector: Any, export_dir: Path) -> None:
        analysis_id = _verified(
            connector, f"SELECT id, amount, at FROM {TABLE} ORDER BY id"
        )
        data = _export(analysis_id, fmt="csv")
        lines = (export_dir / data["file"]["name"]).read_text().splitlines()
        assert lines == [
            "id,amount,at",
            "1,100.10,2026-10-01T09:00:00",
            "2,0.20,2026-10-15T10:00:00",
            "3,,2026-11-02T11:00:00",
        ]

    def test_mysql_read_only_transaction(connector: Any) -> None:
        # MariaDB refuses a MODIFIES SQL DATA function inside a read-only
        # transaction even when it would not write, so the save-time run
        # cannot take this SQL. Put it in the store directly.
        from auto_ontology.dal.saved_analyses.tables import saved_analysis_version

        analysis_id = _verified(connector, "SELECT 1 AS w")
        store().query_write(
            saved_analysis_version.update()
            .where(saved_analysis_version.c.analysis_id == analysis_id)
            .values(sql=f"SELECT {WRITER}('write') AS w")
        )
        with pytest.raises(SavedAnalysisError) as info:
            _export(analysis_id)
        assert info.value.code == "forbidden_statement"
        count = connector.execute(f"SELECT COUNT(*) AS n FROM {AUDIT}").iloc[0, 0]
        assert int(count) == 0

    def test_mysql_row_cap_and_timeout(
        connector: Any, monkeypatch: pytest.MonkeyPatch, export_dir: Path
    ) -> None:
        analysis_id = _verified(
            connector,
            "SELECT seq AS n FROM seq_1_to_100000 WHERE seq <= :n ORDER BY seq",
            [{"name": "n", "type": "int", "default": 5, "min": 1, "max": 100000}],
        )
        monkeypatch.setenv("SAVED_ANALYSES_EXPORT_MAX_ROWS", "1000")
        monkeypatch.setenv("SAVED_ANALYSES_EXPORT_CHUNK_ROWS", "300")
        assert _export(analysis_id, params={"n": 1000})["row_count"] == 1000
        with pytest.raises(SavedAnalysisError) as info:
            _export(analysis_id, params={"n": 1001})
        assert info.value.code == "export_too_large"
        assert (
            sorted(p.name for p in export_dir.iterdir() if p.name.startswith(".")) == []
        )

        slow = _verified(
            connector,
            "SELECT COUNT(*) AS n FROM information_schema.columns x, "
            "information_schema.columns y, information_schema.columns z "
            "WHERE x.ordinal_position > :floor",
            [{"name": "floor", "type": "int", "default": 1000}],
        )
        monkeypatch.setenv("SAVED_ANALYSES_EXPORT_TIMEOUT_S", "1")
        with pytest.raises(SavedAnalysisError) as info:
            _export(slow, params={"floor": 0})
        assert info.value.code == "timeout"

    def test_mysql_memory_stays_flat(
        connector: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SAVED_ANALYSES_EXPORT_CHUNK_ROWS", "5000")
        analysis_id = _verified(
            connector,
            "SELECT seq AS n, REPEAT('x', 100) AS pad FROM seq_1_to_1000000 "
            "WHERE seq <= :n ORDER BY seq",
            [{"name": "n", "type": "int", "default": 5, "min": 1, "max": 1000000}],
        )

        def peak(n: int) -> int:
            tracemalloc.start()
            try:
                assert _export(analysis_id, params={"n": n})["row_count"] == n
                return tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()

        small, large = peak(20_000), peak(400_000)
        assert large < small * 1.5 + (2 << 20), (small, large)
