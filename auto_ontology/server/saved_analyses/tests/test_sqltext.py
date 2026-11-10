# SPDX-License-Identifier: Apache-2.0

"""The SQL guard, placeholder handling, row cap and table extraction. No database."""

from __future__ import annotations

import pytest

from auto_ontology.server.saved_analyses import sqltext
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError


def _guard(sql: str, dialect: str = "postgres") -> None:
    sqltext.check_read_only(sqltext.parse_single(sql, dialect))


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM orders",
        "DELETE FROM orders WHERE id = 1",
        "UPDATE orders SET amount = 0",
        "INSERT INTO orders (id) VALUES (1)",
        "INSERT INTO orders SELECT * FROM orders",
        "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
        "TRUNCATE orders",
        "DROP TABLE orders",
        "CREATE TABLE x (a int)",
        "CREATE TABLE x AS SELECT 1",
        "ALTER TABLE orders ADD COLUMN x int",
        "GRANT SELECT ON orders TO public",
        "COPY orders TO '/tmp/x'",
        "SET search_path = evil",
        "VACUUM orders",
        "BEGIN",
        "COMMIT",
        "EXPLAIN ANALYZE DELETE FROM orders",
        "VALUES (1)",
        "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d",
        "WITH u AS (UPDATE orders SET amount = 0 RETURNING id) SELECT count(*) FROM u",
        "SELECT * INTO new_table FROM orders",
        "SELECT * FROM orders FOR UPDATE",
        "SELECT pg_sleep(10)",
        "SELECT pg_catalog.pg_sleep(10)",
        "SELECT set_config('statement_timeout', '0', false)",
        "SELECT nextval('seq')",
        "SELECT query_to_xml('DELETE FROM orders', true, true, '')",
        "SELECT * FROM dblink('host=x', 'SELECT 1') AS t(a int)",
        "SELECT pg_read_file('/etc/passwd')",
        "SELECT lo_import('/etc/passwd')",
        "SELECT $1",
    ],
)
def test_guard_rejects_writes_and_side_effects(sql: str) -> None:
    with pytest.raises(SavedAnalysisError) as info:
        _guard(sql)
    assert info.value.code in ("forbidden_statement", "parse_error")


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT 1; DELETE FROM orders",
        "SELECT 1; SELECT 2",
        "SELECT * FROM orders;; DROP TABLE orders",
    ],
)
def test_guard_rejects_multiple_statements(sql: str) -> None:
    with pytest.raises(SavedAnalysisError) as info:
        _guard(sql)
    assert info.value.code == "forbidden_statement"
    assert "one statement" in info.value.message


@pytest.mark.parametrize(
    ("sql", "dialect"),
    [
        ("SELECT SLEEP(5)", "mysql"),
        ("SELECT BENCHMARK(100000000, MD5('a'))", "mysql"),
        ("SELECT LOAD_FILE('/etc/passwd')", "mysql"),
        ("SELECT GET_LOCK('x', 10)", "mysql"),
        ("SELECT @a := 1", "mysql"),
        ("SELECT a INTO OUTFILE '/tmp/x' FROM t", "mysql"),
        ("SELECT * FROM read_csv('/etc/passwd')", "duckdb"),
        ("SELECT * FROM '/etc/passwd.csv'", "duckdb"),
    ],
)
def test_guard_rejects_dialect_specific_side_effects(sql: str, dialect: str) -> None:
    with pytest.raises(SavedAnalysisError):
        _guard(sql, dialect)


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT count(*) FROM orders",
        "select * from s.orders o join s.customers c on c.id = o.customer_id",
        "WITH m AS (SELECT date_trunc('month', created) AS month, sum(amount) AS total FROM orders GROUP BY 1) SELECT * FROM m ORDER BY month",
        "SELECT 1 AS a UNION ALL SELECT 2",
        "(SELECT 1 AS a)",
        "SELECT * FROM generate_series(1, 3) AS g(n)",
        "SELECT 'DELETE FROM orders' AS harmless_text",
        "-- comment\nSELECT 1;",
    ],
)
def test_guard_accepts_reads(sql: str) -> None:
    _guard(sql)


def test_parse_error_is_reported() -> None:
    with pytest.raises(SavedAnalysisError) as info:
        sqltext.parse_single("SELEC 1 FROM", "postgres")
    assert info.value.code in ("parse_error", "forbidden_statement")
    with pytest.raises(SavedAnalysisError) as info:
        sqltext.parse_single("   ", "postgres")
    assert info.value.code == "parse_error"


# ---------------------------------------------------------------------------
# Placeholders
# ---------------------------------------------------------------------------


def _spans(sql: str, dialect: str = "postgres") -> list[str]:
    tree = sqltext.parse_single(sql, dialect)
    return [s.name for s in sqltext.placeholders(sql, dialect, tree)]


@pytest.mark.parametrize(
    "dialect", ["postgres", "mysql", "duckdb", "snowflake", "trino", "sqlite"]
)
def test_named_placeholders_are_found_in_every_dialect(dialect: str) -> None:
    sql = (
        "SELECT count(*) AS n FROM t WHERE created >= :start_date AND created < :end_date "
        "AND status IN (:statuses) AND x=:x LIMIT :top_n"
    )
    assert sorted(_spans(sql, dialect)) == [
        "end_date",
        "start_date",
        "statuses",
        "top_n",
        "x",
    ]


def test_colons_that_are_not_placeholders_are_left_alone() -> None:
    sql = "SELECT a::date AS d, ':not_a_param' AS s FROM t WHERE c = :c -- :in_comment\n/* :also */"
    assert _spans(sql) == ["c"]


def test_repeated_placeholder_is_bound_everywhere() -> None:
    sql = "SELECT * FROM t WHERE a = :v OR b = :v"
    tree = sqltext.parse_single(sql, "postgres")
    spans = sqltext.placeholders(sql, "postgres", tree)
    assert (
        sqltext.bind(sql, spans, {"v": "42"})
        == "SELECT * FROM t WHERE a = 42 OR b = 42"
    )


@pytest.mark.parametrize(
    "sql", ["SELECT * FROM t WHERE a = ?", "SELECT * FROM t WHERE a = %s"]
)
def test_anonymous_placeholders_are_rejected(sql: str) -> None:
    with pytest.raises(SavedAnalysisError) as info:
        _spans(sql)
    assert info.value.code == "unsupported_placeholder"


def test_ambiguous_json_path_colon_is_rejected() -> None:
    # Postgres-dialect sqlglot reads `obj:field` as a placeholder, the tokens do
    # not: the disagreement is refused instead of guessed.
    with pytest.raises(SavedAnalysisError) as info:
        _spans("SELECT obj:field FROM t WHERE a = :a")
    assert info.value.code == "unsupported_placeholder"


def test_bind_keeps_the_saved_text_byte_for_byte() -> None:
    sql = "SELECT  x  -- keep me\nFROM t WHERE d >= :d ORDER BY x DESC NULLS LAST"
    tree = sqltext.parse_single(sql, "postgres")
    spans = sqltext.placeholders(sql, "postgres", tree)
    bound = sqltext.bind(sql, spans, {"d": "CAST('2026-10-01' AS DATE)"})
    assert bound == (
        "SELECT  x  -- keep me\nFROM t WHERE d >= CAST('2026-10-01' AS DATE) "
        "ORDER BY x DESC NULLS LAST"
    )


def test_list_parameter_only_inside_in() -> None:
    ok = sqltext.parse_single("SELECT * FROM t WHERE s IN (:ss)", "postgres")
    sqltext.check_list_placements(ok, {"ss"})
    for sql in (
        "SELECT * FROM t WHERE s = :ss",
        "SELECT * FROM t WHERE s IN (:ss, 'x')",
    ):
        with pytest.raises(SavedAnalysisError) as info:
            sqltext.check_list_placements(sqltext.parse_single(sql, "postgres"), {"ss"})
        assert info.value.code == "invalid_definition"


# ---------------------------------------------------------------------------
# Row cap
# ---------------------------------------------------------------------------


def _capped(sql: str, limit: int = 11, dialect: str = "postgres") -> str:
    return sqltext.apply_row_limit(
        sql, dialect, sqltext.parse_single(sql, dialect), limit
    )


def test_row_cap_is_appended_after_order_by() -> None:
    assert (
        _capped("SELECT a FROM t ORDER BY a DESC;")
        == "SELECT a FROM t ORDER BY a DESC\nLIMIT 11"
    )


def test_row_cap_survives_a_trailing_comment() -> None:
    assert _capped("SELECT a FROM t -- trailing") == "SELECT a FROM t\nLIMIT 11"


def test_row_cap_wraps_a_query_with_its_own_limit() -> None:
    out = _capped("SELECT a FROM t ORDER BY a LIMIT 100000")
    assert (
        out
        == "SELECT * FROM (\nSELECT a FROM t ORDER BY a LIMIT 100000\n) AS _saved_analysis_rows\nLIMIT 11"
    )
    sqltext.check_read_only(sqltext.parse_single(out, "postgres"))


def test_row_cap_on_union() -> None:
    assert _capped("SELECT 1 AS a UNION ALL SELECT 2 ORDER BY 1") == (
        "SELECT 1 AS a UNION ALL SELECT 2 ORDER BY 1\nLIMIT 11"
    )


# ---------------------------------------------------------------------------
# Referenced tables
# ---------------------------------------------------------------------------


def test_referenced_tables_skip_ctes_and_table_functions() -> None:
    tree = sqltext.parse_single(
        "WITH recent AS (SELECT * FROM sales.orders WHERE d > now()) "
        "SELECT * FROM recent r JOIN customers c ON c.id = r.cid "
        "CROSS JOIN generate_series(1, 2) g "
        "WHERE EXISTS (SELECT 1 FROM sales.refunds x WHERE x.oid = r.id)",
        "postgres",
    )
    refs = [(t.schema, t.name) for t in sqltext.referenced_tables(tree)]
    assert refs == [("", "customers"), ("sales", "orders"), ("sales", "refunds")]


def test_output_names() -> None:
    tree = sqltext.parse_single(
        "SELECT a, b AS bee, count(*) AS n FROM t GROUP BY 1, 2", "postgres"
    )
    assert sqltext.output_names(tree) == ["a", "bee", "n"]
