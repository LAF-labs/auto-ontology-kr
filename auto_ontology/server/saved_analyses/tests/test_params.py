# SPDX-License-Identifier: Apache-2.0

"""Parameter definitions, values, relative dates and SQL literals. No database."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest

from auto_ontology.server.saved_analyses import params
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
from auto_ontology.server.saved_analyses.sqltext import check_read_only, parse_single

DEFS = params.validate_definitions(
    [
        {
            "name": "start_date",
            "type": "date",
            "required": True,
            "default": "month_start(-1)",
        },
        {"name": "end_date", "type": "date", "default": "month_start(0)"},
        {
            "name": "status",
            "type": "enum",
            "values": ["APPROVED", "PENDING"],
            "default": "APPROVED",
        },
        {"name": "top_n", "type": "int", "min": 1, "max": 100, "default": 5},
        {"name": "ratio", "type": "number", "default": "0.5"},
        {"name": "label", "type": "string", "required": True},
        {"name": "ids", "type": "list<int>", "default": [1, 2]},
        {"name": "flag", "type": "bool", "default": False},
        {"name": "since", "type": "datetime", "default": "2026-01-01T09:30:00"},
    ]
)


@pytest.mark.parametrize(
    ("expr", "expected"),
    [
        ("today", dt.date(2026, 11, 10)),
        ("today(-1)", dt.date(2026, 11, 9)),
        ("today(+30)", dt.date(2026, 12, 10)),
        ("week_start", dt.date(2026, 11, 9)),
        ("week_start(-1)", dt.date(2026, 11, 2)),
        ("month_start(0)", dt.date(2026, 11, 1)),
        ("month_start(-1)", dt.date(2026, 10, 1)),
        ("month_start(-11)", dt.date(2025, 12, 1)),
        ("month_start(2)", dt.date(2027, 1, 1)),
        ("quarter_start(0)", dt.date(2026, 10, 1)),
        ("quarter_start(-1)", dt.date(2026, 7, 1)),
        ("year_start(-1)", dt.date(2025, 1, 1)),
        ("2026-10-01", None),
    ],
)
def test_relative_dates(expr: str, expected: dt.date | None) -> None:
    assert params.resolve_relative_date(expr, today=dt.date(2026, 11, 10)) == expected


def test_relative_dates_follow_the_configured_zone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAVED_ANALYSES_TIMEZONE", "Pacific/Kiritimati")  # UTC+14
    ahead = params.resolve_relative_date("today")
    monkeypatch.setenv("SAVED_ANALYSES_TIMEZONE", "Pacific/Pago_Pago")  # UTC-11
    behind = params.resolve_relative_date("today")
    assert (ahead - behind).days in (1, 2)


def test_defaults_fill_and_values_are_canonical() -> None:
    values = params.resolve_values(
        DEFS, {"label": "x", "start_date": "2026-09-01", "top_n": "7"}
    )
    assert values["start_date"] == dt.date(2026, 9, 1)
    assert values["top_n"] == 7
    assert values["ratio"] == Decimal("0.5")
    assert values["ids"] == [1, 2]
    assert values["since"] == dt.datetime(2026, 1, 1, 9, 30)
    as_json = params.to_json(values)
    assert as_json["start_date"] == "2026-09-01"
    assert as_json["ratio"] == "0.5"
    assert as_json["since"] == "2026-01-01T09:30:00"


@pytest.mark.parametrize(
    ("supplied", "bad"),
    [
        ({}, "label"),  # required, no default
        ({"label": "x", "top_n": 0}, "top_n"),  # below min
        ({"label": "x", "top_n": 101}, "top_n"),
        ({"label": "x", "top_n": 1.5}, "top_n"),
        ({"label": "x", "top_n": True}, "top_n"),
        ({"label": "x", "status": "DELETED"}, "status"),
        ({"label": "x", "start_date": "10/01/2026"}, "start_date"),
        ({"label": "x", "start_date": "2026-10-01T00:00:00"}, "start_date"),
        ({"label": "x", "ids": []}, "ids"),
        ({"label": "x", "ids": "1,2"}, "ids"),
        ({"label": "x", "flag": "yes"}, "flag"),
        ({"label": "x", "ratio": "NaN"}, "ratio"),
        ({"label": "x", "nope": 1}, "nope"),
        ({"label": "a\x00b"}, "label"),
    ],
)
def test_invalid_values_are_named(supplied: dict, bad: str) -> None:
    with pytest.raises(SavedAnalysisError) as info:
        params.resolve_values(DEFS, supplied)
    assert info.value.code == "invalid_params"
    assert bad in info.value.details["params"]


@pytest.mark.parametrize(
    "definition",
    [
        [{"name": "1bad", "type": "int", "default": 1}],
        [{"name": "a", "type": "money", "default": 1}],
        [{"name": "a", "type": "int"}],  # neither default nor required
        [{"name": "a", "type": "enum", "default": "x"}],  # no values
        [{"name": "a", "type": "int", "default": "x"}],
        [{"name": "a", "type": "string", "min": 1, "default": "x"}],
        [{"name": "a", "type": "int", "default": 1, "unexpected": True}],
        [
            {"name": "a", "type": "int", "default": 1},
            {"name": "a", "type": "int", "default": 2},
        ],
    ],
)
def test_bad_definitions(definition: list) -> None:
    with pytest.raises(SavedAnalysisError) as info:
        params.validate_definitions(definition)
    assert info.value.code == "invalid_definition"


@pytest.mark.parametrize(
    ("dialect", "expected"),
    [
        ("postgres", "CAST('2026-10-01' AS DATE)"),
        ("mysql", "CAST('2026-10-01' AS DATE)"),
        ("duckdb", "CAST('2026-10-01' AS DATE)"),
    ],
)
def test_date_literal(dialect: str, expected: str) -> None:
    assert (
        params.to_sql_literal({"type": "date"}, dt.date(2026, 10, 1), dialect)
        == expected
    )


def test_datetime_literal_uses_the_dialect_type() -> None:
    value = dt.datetime(2026, 10, 1, 9, 0)
    assert params.to_sql_literal({"type": "datetime"}, value, "postgres") == (
        "CAST('2026-10-01 09:00:00' AS TIMESTAMP)"
    )
    assert params.to_sql_literal({"type": "datetime"}, value, "mysql") == (
        "CAST('2026-10-01 09:00:00' AS DATETIME)"
    )


def test_negative_numbers_are_parenthesised() -> None:
    # `a - :n` with n = -5 must not turn into `a - -5` (a comment).
    assert params.to_sql_literal({"type": "int"}, -5, "postgres") == "(-5)"
    assert (
        params.to_sql_literal({"type": "number"}, Decimal("-0.25"), "postgres")
        == "(-0.25)"
    )
    assert (
        params.to_sql_literal({"type": "number"}, Decimal("1E+3"), "postgres") == "1000"
    )


@pytest.mark.parametrize(
    "dialect", ["postgres", "mysql", "duckdb", "snowflake", "databricks"]
)
@pytest.mark.parametrize(
    "hostile",
    [
        "x'; DELETE FROM orders; --",
        "x\\'; DROP TABLE orders; --",
        "it's",
        "back\\slash",
        "줄바꿈\n'",
    ],
)
def test_string_values_cannot_break_out(dialect: str, hostile: str) -> None:
    literal = params.to_sql_literal({"type": "string"}, hostile, dialect)
    sql = f"SELECT * FROM orders WHERE note = {literal}"
    tree = parse_single(sql, dialect)  # still one statement
    check_read_only(tree)
    literals = [
        node
        for node in tree.find_all(__import__("sqlglot").exp.Literal)
        if node.is_string
    ]
    assert [node.this for node in literals] == [hostile]


def test_list_literal() -> None:
    assert (
        params.to_sql_literal({"type": "list<string>"}, ["A", "O'B"], "postgres")
        == "'A', 'O''B'"
    )
    assert (
        params.to_sql_literal({"type": "list<int>"}, [1, -2], "postgres") == "1, (-2)"
    )


def test_bool_literal() -> None:
    assert params.to_sql_literal({"type": "bool"}, True, "postgres") == "TRUE"
