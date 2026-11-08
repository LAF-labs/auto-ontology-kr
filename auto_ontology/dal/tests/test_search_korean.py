# SPDX-License-Identifier: Apache-2.0

"""Korean-mode tokens and synonym patterns for global search, without a database.

``test_search.py`` covers the queries against Postgres. This checks the two
things Korean mode changes before a query is built: which tokens a search
becomes, and the whole-word synonym pattern that Python and Postgres share.
"""

from __future__ import annotations

import pytest

pytest.importorskip("sqlalchemy")

from sqlalchemy.dialects import postgresql  # noqa: E402

from auto_ontology.dal import search  # noqa: E402


@pytest.fixture
def korean(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")


@pytest.fixture
def english(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AUTO_ONTOLOGY_LANGUAGE", raising=False)


def test_english_mode_ignores_hangul_as_before(english: None) -> None:
    assert search.search_tokens("매출액은") == ["매출액은"]
    assert search.synonym_word_tokens("매출액") == []
    assert search.synonym_word_tokens("ROAS가") == ["roas"]


@pytest.mark.parametrize(
    ("term", "expected"),
    [
        ("매출액은", ["매출액"]),
        ("거래처별 매출액", ["거래처", "매출액"]),
        ("ROAS가 낮은 SKU", ["roas", "낮은", "sku"]),
        ("2024년에", ["2024년"]),
        ("단가를", ["단가"]),
        # English searches are unchanged in Korean mode.
        ("Annual Revenue", ["annual", "revenue"]),
        ("total_amount", ["total_amount"]),
        ("created-at", ["created", "at"]),
    ],
)
def test_korean_search_tokens_drop_particles(
    korean: None, term: str, expected: list[str]
) -> None:
    assert search.search_tokens(term) == expected


def test_korean_synonym_tokens_keep_hangul(korean: None) -> None:
    assert search.synonym_word_tokens("거래처 매출액은") == ["거래처", "매출액은"]
    assert search.synonym_word_tokens("Business Unit") == ["business", "unit"]


@pytest.mark.parametrize(
    ("synonym", "query", "expected"),
    [
        ("매출액", "매출액은", True),
        ("월 매출액", "매출액", True),
        ("CUST_NM 거래처명", "거래처명", True),
        # Whole words only: Hangul counts as a word character.
        ("월매출액", "매출액", False),
        ("매출액", "매출", False),
        # The original word is tried as well as its stem.
        ("판매가", "판매가", True),
        ("판매가", "판매가를", True),
        # Every token must land in the same synonym.
        ("거래처 매출액", "거래처별 매출액", True),
        ("거래처", "거래처별 매출액", False),
        # Mixed script.
        ("ROAS", "ROAS가", True),
        ("Business Unit", "unit", True),
        ("Business Unit", "uni", False),
    ],
)
def test_korean_synonym_matching(
    korean: None, synonym: str, query: str, expected: bool
) -> None:
    tokens = search.synonym_word_tokens(query)
    assert search.synonym_matches_tokens(synonym, tokens) is expected


def test_korean_synonym_sql_uses_the_python_pattern(korean: None) -> None:
    tokens = search.synonym_word_tokens("판매가를")
    compiled = search._synonym_exists(tokens).compile(dialect=postgresql.dialect())
    patterns = [v for v in compiled.params.values() if isinstance(v, str)]
    assert patterns == [search._korean_synonym_pattern("판매가를")]
    assert "가-힣" in patterns[0]


def test_english_synonym_sql_is_unchanged(english: None) -> None:
    compiled = search._synonym_exists(["unit"]).compile(dialect=postgresql.dialect())
    patterns = [v for v in compiled.params.values() if isinstance(v, str)]
    assert patterns == ["(^|[^a-z0-9])unit([^a-z0-9]|$)"]


_POSTGRES_CASES = [
    ("매출액", "매출액은", True),
    ("월 매출액", "매출액", True),
    ("월매출액", "매출액", False),
    ("판매가", "판매가를", True),
    ("CUST_NM 거래처명", "거래처명", True),
    ("ROAS", "ROAS가", True),
]


@pytest.mark.parametrize(("synonym", "query", "expected"), _POSTGRES_CASES)
def test_postgres_regex_agrees_with_python(
    korean: None, synonym: str, query: str, expected: bool
) -> None:
    """The pattern means the same to Postgres ARE as to Python ``re``.

    Hangul ranges in a bracket expression depend on the database encoding, so
    this runs against a real server when one is configured.
    """
    import os

    from sqlalchemy import text

    if not os.environ.get("POSTGRES_USER"):
        pytest.skip("POSTGRES_* not set")
    from auto_ontology.dal.session import store

    tokens = search.synonym_word_tokens(query)
    hits = [
        store().query_read(
            text("SELECT lower(:synonym) ~ :pattern AS hit"),
            {"synonym": synonym, "pattern": search._korean_synonym_pattern(token)},
        )[0]["hit"]
        for token in tokens
    ]
    assert all(hits) is expected
    assert search.synonym_matches_tokens(synonym, tokens) is expected
