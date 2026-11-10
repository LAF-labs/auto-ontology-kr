# SPDX-License-Identifier: Apache-2.0

"""The generic execution path (any connector but Postgres and MySQL), on SQLite.

No store database: this exercises :func:`executor.run_query` and the SQL
preparation only.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from auto_ontology.connectors.registry import create_connector
from auto_ontology.server.saved_analyses import params, service
from auto_ontology.server.saved_analyses.executor import run_query


@pytest.fixture
def connector(tmp_path: Path):
    path = tmp_path / "shop.sqlite"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE orders (id INTEGER, customer TEXT, amount REAL, note TEXT);
            INSERT INTO orders VALUES (1, 'kim', 10.5, NULL), (2, 'lee', 20.0, NULL),
                                      (3, 'kim', 1.25, NULL);
            """
        )
    db = create_connector(f"sqlite:///{path}")
    yield db
    db.close()


def test_generic_path_infers_types_and_caps_rows(connector) -> None:
    definitions = params.validate_definitions(
        [{"name": "who", "type": "string", "default": "kim"}]
    )
    values = params.resolve_values(definitions, {})
    sql = "SELECT id, customer, amount, note FROM orders WHERE customer = :who ORDER BY id"
    service.check_definitions_against_sql(sql, connector.dialect, definitions)
    _, executed = service.prepare_sql(sql, connector.dialect, definitions, values, 2)
    assert executed.endswith("ORDER BY id\nLIMIT 2")

    result = run_query(connector, executed, timeout_s=5, max_rows=2)
    assert result.read_only_transaction is False
    assert [(c["name"], c["type"]) for c in result.columns] == [
        ("id", "integer"),
        ("customer", "string"),
        ("amount", "number"),
        ("note", "unknown"),  # all null: nothing to infer from
    ]
    assert result.rows == [[1, "kim", 10.5, None], [3, "kim", 1.25, None]]


def test_unknown_columns_match_anything() -> None:
    fixed = [{"name": "note", "type": "unknown"}, {"name": "n", "type": "integer"}]
    assert service.columns_match(
        fixed, [{"name": "note", "type": "string"}, {"name": "n", "type": "integer"}]
    )
    assert not service.columns_match(
        fixed, [{"name": "note", "type": "string"}, {"name": "n", "type": "string"}]
    )
    assert not service.columns_match(
        fixed, [{"name": "n", "type": "integer"}, {"name": "note", "type": "string"}]
    )
