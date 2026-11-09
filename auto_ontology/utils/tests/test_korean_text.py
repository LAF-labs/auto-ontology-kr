# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import re

import pytest

from auto_ontology.utils.korean_text import (
    PARTICLE_PATTERN,
    contains_hangul,
    stemmed_word_tokens,
    strip_particle,
    token_variants,
    word_tokens,
)


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("매출액은", "매출액"),
        ("거래처별", "거래처"),
        ("고객별로", "고객"),
        ("사이즈별로", "사이즈"),
        ("고객들의", "고객"),
        ("냉장실에서", "냉장실"),
        ("얼마인가요", "얼마"),
        ("단가를", "단가"),
        # Listed one-syllable nouns may keep a single syllable.
        ("수를", "수"),
        ("값이", "값"),
        # Latin and digit stems: the particle is unambiguous after them.
        ("roas가", "roas"),
        ("sku를", "sku"),
        ("2024년에", "2024년"),
        ("1분기에", "1분기"),
        ("2000년부터", "2000년"),
    ],
)
def test_strip_particle_removes_one_trailing_particle(
    token: str, expected: str
) -> None:
    assert strip_particle(token) == expected


@pytest.mark.parametrize(
    "token",
    [
        # Nouns that end in a particle-like syllable keep it: the stem would
        # be a single syllable.
        "단가",
        "국가",
        "길이",
        "회의",
        "결과",
        "성별",
        "월별",
        # 도 and 만 are never stripped alone.
        "만족도",
        "빈도",
        "100만",
        # Nothing Hangul at the end: untouched.
        "revenue",
        "total_amount",
        "2024",
        "",
    ],
)
def test_strip_particle_leaves_nouns_alone(token: str) -> None:
    assert strip_particle(token) == token


def test_strip_particle_strips_once() -> None:
    # "에서는" is one compound particle, not "에서" then "는".
    assert strip_particle("서울에서는") == "서울"
    assert strip_particle(strip_particle("고객별로")) == "고객"


def test_word_tokens_split_mixed_script_questions() -> None:
    assert word_tokens("ROAS가 낮은 SKU") == ["roas가", "낮은", "sku"]
    assert stemmed_word_tokens("ROAS가 낮은 SKU") == ["roas", "낮은", "sku"]
    assert stemmed_word_tokens("2024년 1월 매출액은?") == ["2024년", "1월", "매출액"]
    assert stemmed_word_tokens("'Northwind' 브랜드를") == ["northwind", "브랜드"]


def test_token_variants_keep_the_original_when_stripping_may_be_wrong() -> None:
    # "판매가" (sale price) looks like "판매" + 가.
    assert token_variants("판매가") == ("판매가", "판매")
    assert token_variants("매출액") == ("매출액",)


def test_particle_pattern_matches_whole_particles_only() -> None:
    pattern = re.compile(rf"서울(?:{PARTICLE_PATTERN})?$")
    assert pattern.match("서울에서")
    assert pattern.match("서울")
    assert not pattern.match("서울특별시")


def test_contains_hangul() -> None:
    assert contains_hangul("ROAS가")
    assert not contains_hangul("ROAS")


def test_decomposed_hangul_is_composed_before_matching() -> None:
    """NFD Hangul (macOS file names, some exports) is jamo outside 가-힣."""
    import unicodedata

    from auto_ontology.utils.korean_text import nfc, strip_particle, word_tokens

    nfd = unicodedata.normalize("NFD", "매출액은")
    assert nfd != "매출액은"
    assert nfc(nfd) == "매출액은"
    assert word_tokens(nfd) == ["매출액은"]
    assert strip_particle(nfd) == "매출액"
