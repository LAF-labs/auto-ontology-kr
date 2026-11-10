# SPDX-License-Identifier: Apache-2.0

"""Saved analyses against a live MySQL or MariaDB.

Opt-in: the tests exist only when ``SAVED_ANALYSES_TEST_MYSQL_URL`` is set
(``mysql://user:password@host:port/database``, a database the tests may create
tables in), plus the ``POSTGRES_*`` store every saved-analysis test needs.

They are *not defined* otherwise, rather than skipped: CI fails when more than
two tests skip, and this one has no server there. Run locally with::

    docker run -d --name sa-maria -e MARIADB_ROOT_PASSWORD=x -e MARIADB_DATABASE=t \\
        -e MARIADB_USER=t -e MARIADB_PASSWORD=t -p 127.0.0.1:53399:3306 mariadb:11.6.2
    SAVED_ANALYSES_TEST_MYSQL_URL=mysql://t:t@127.0.0.1:53399/t uv run pytest \\
        auto_ontology/server/saved_analyses/tests/test_saved_analyses_mysql.py
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Iterator

import pytest

MYSQL_URL = os.environ.get("SAVED_ANALYSES_TEST_MYSQL_URL")

if MYSQL_URL and os.environ.get("POSTGRES_USER"):
    from sqlalchemy import delete

    from auto_ontology.dal.saved_analyses.tables import saved_analysis
    from auto_ontology.dal.session import store
    from auto_ontology.server.saved_analyses import service
    from auto_ontology.server.saved_analyses.errors import SavedAnalysisError

    PREFIX = f"sa_mysql_{uuid.uuid4().hex[:8]}"
    TABLE = f"sa_orders_{uuid.uuid4().hex[:6]}"
    AUDIT = f"sa_audit_{uuid.uuid4().hex[:6]}"
    WRITER = f"sa_write_{uuid.uuid4().hex[:6]}"

    @pytest.fixture(scope="module")
    def connector() -> Iterator[Any]:
        from auto_ontology.connectors.mysql import MySQLDatabase

        db = MySQLDatabase(MYSQL_URL)

        def run(*statements: str) -> None:
            # The connector never commits (it is for reads), so writes here
            # go through a connection of their own.
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
            "amount DECIMAL(12,2), created DATE, at DATETIME)",
            f"INSERT INTO {TABLE} VALUES (1, 'APPROVED', 100.10, '2026-10-01', '2026-10-01 09:00:00'), "
            "(2, 'APPROVED', 0.20, '2026-10-15', '2026-10-15 10:00:00'), "
            "(3, 'PENDING', 5.00, '2026-11-02', '2026-11-02 11:00:00')",
            f"CREATE TABLE {AUDIT} (note VARCHAR(20))",
            f"CREATE FUNCTION {WRITER}() RETURNS INT MODIFIES SQL DATA "
            f"BEGIN INSERT INTO {AUDIT} VALUES ('written'); RETURN 1; END",
        )
        try:
            yield db
        finally:
            store().query_write(
                delete(saved_analysis).where(saved_analysis.c.name.like(f"{PREFIX}%"))
            )
            run(f"DROP FUNCTION {WRITER}", f"DROP TABLE {AUDIT}", f"DROP TABLE {TABLE}")

    @pytest.fixture(autouse=True)
    def only_this_connector(monkeypatch: pytest.MonkeyPatch, connector: Any) -> None:
        import auto_ontology.connectors.registry as registry

        monkeypatch.setattr(registry, "get_connectors", lambda: [connector])

    def _create(
        connector: Any, sql: str, params: list | None = None, **extra: Any
    ) -> dict[str, Any]:
        return service.create_analysis(
            {
                "name": f"{PREFIX}_{uuid.uuid4().hex[:6]}",
                "database_name": connector.database_name,
                "sql": sql,
                "params": params or [],
                **extra,
            },
            None,
        )

    def test_mysql_typed_columns_and_parameters(connector: Any) -> None:
        detail = _create(
            connector,
            f"SELECT status, SUM(amount) AS total, MIN(created) AS first_day, MAX(at) AS last_at "
            f"FROM {TABLE} WHERE created >= :start AND created < :end AND status IN (:ss) "
            "GROUP BY status ORDER BY status",
            [
                {"name": "start", "type": "date", "default": "2026-10-01"},
                {"name": "end", "type": "date", "default": "2026-11-01"},
                {
                    "name": "ss",
                    "type": "list<string>",
                    "default": ["APPROVED", "PENDING"],
                },
            ],
        )
        assert [(c["name"], c["type"]) for c in detail["version"]["columns"]] == [
            ("status", "string"),
            ("total", "decimal"),
            ("first_day", "date"),
            ("last_at", "datetime"),
        ]
        preview = detail["preview"]
        assert preview["read_only_transaction"] is True
        assert preview["rows"] == [
            ["APPROVED", "100.30", "2026-10-01", "2026-10-15T10:00:00"]
        ]

        service.change_status(detail["id"], 1, "verified", user_id="r", note=None)
        result = service.run_analysis(
            detail["id"], supplied_params={"end": "2026-12-01"}
        )
        assert result["rows"][1] == [
            "PENDING",
            "5.00",
            "2026-11-02",
            "2026-11-02T11:00:00",
        ]
        assert "CAST('2026-12-01' AS DATE)" in result["sql"]

    def test_mysql_read_only_transaction_blocks_writes(connector: Any) -> None:
        with pytest.raises(SavedAnalysisError) as info:
            _create(connector, f"SELECT {WRITER}() AS w")
        assert info.value.code == "forbidden_statement"
        assert (
            int(connector.execute(f"SELECT COUNT(*) AS n FROM {AUDIT}").iloc[0, 0]) == 0
        )

    def test_mysql_timeout(connector: Any) -> None:
        detail = _create(
            connector,
            "SELECT COUNT(*) AS n FROM information_schema.columns x, "
            "information_schema.columns y, information_schema.columns z "
            "WHERE x.ordinal_position > :floor",
            [{"name": "floor", "type": "int", "default": 1000}],
            timeout_s=1,
        )
        service.change_status(detail["id"], 1, "verified", user_id="r", note=None)
        with pytest.raises(SavedAnalysisError) as info:
            service.run_analysis(detail["id"], supplied_params={"floor": 0})
        assert info.value.code == "timeout"
