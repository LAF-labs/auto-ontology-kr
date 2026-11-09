# SPDX-License-Identifier: Apache-2.0

"""Korean-mode behaviour of ingest and semantic compile helpers."""

from __future__ import annotations

import unicodedata

import pandas as pd
import pytest

from auto_ontology.catalog import diff
from auto_ontology.catalog.common_codes import has_code_annotation
from auto_ontology.catalog.normalize import normalize_columns
from auto_ontology.semantic import deterministic, korean
from auto_ontology.semantic.embed import _build_rows
from auto_ontology.semantic.models import ColumnAttributeSpec
from auto_ontology.utils.sample_values import render_sample_value


@pytest.fixture
def ko(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")


@pytest.fixture
def en(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AUTO_ONTOLOGY_LANGUAGE", raising=False)


@pytest.mark.parametrize(
    ("comment", "label"),
    [
        ("사용여부(Y/N)", "사용여부"),
        ("단가(원)", "단가"),
        ("입·출고구분", "입 출고구분"),
        ("거래처명/상호", "거래처명 상호"),
        ("금액(VAT포함) — samples: 1000", "금액"),
    ],
)
def test_fallback_label_survives_bracketed_and_joined_comments(
    ko: None, comment: str, label: str
) -> None:
    spec = ColumnAttributeSpec(source_column="x", name="Use Yn", description=comment)
    assert korean.fallback_display_name(spec) == label


def test_description_samples_are_short_and_capped_in_korean_mode(ko: None) -> None:
    long_text = "배송 전 반드시 연락 바랍니다. 부재 시 경비실에 맡겨 주세요."
    profiling = {
        "memo": {
            "sample_values": [
                long_text,
                "문 앞",
                "550e8400-e29b-41d4-a716-446655440000",
            ]
            + [f"값{i}" for i in range(20)]
        }
    }
    samples = deterministic._get_column_samples({"name": "memo"}, profiling)
    assert long_text not in samples
    assert "문 앞" in samples
    assert not any("-" in s and len(s) == 36 for s in samples)
    assert len(samples) == 10


def test_description_samples_unchanged_in_english_mode(en: None) -> None:
    values = ["x" * 80, "550e8400-e29b-41d4-a716-446655440000"]
    profiling = {"memo": {"sample_values": values}}
    assert deterministic._get_column_samples({"name": "memo"}, profiling) == values


def _rows() -> list[dict]:
    term = {
        "name": "거래처",
        "description": "매입처 마스터",
        "synonyms": ["업체", "tb_georaecheo"],
    }
    attrs = [
        {"name": "거래처 코드", "source_column": "georaecheo_cd", "term_name": "거래처"}
    ]
    return _build_rows("korean_smb", term, attrs)


def test_embedding_text_carries_synonyms_and_source_column(ko: None) -> None:
    term_row, attr_row = _rows()
    assert term_row["text"].startswith("Term: 거래처 (업체, tb_georaecheo).")
    assert "[column georaecheo_cd]" in attr_row["text"]


def test_embedding_text_unchanged_in_english_mode(en: None) -> None:
    term_row, attr_row = _rows()
    assert term_row["text"] == "Term: 거래처. 매입처 마스터"
    assert "[column" not in attr_row["text"]


def test_code_annotation_detection() -> None:
    assert has_code_annotation(
        "창고코드 — 공통코드 WH: WH01=이천 물류센터 (tb_comm_cd.grp_cd = 'WH')"
    )
    assert not has_code_annotation("창고코드 (공통코드 WH)")
    assert not has_code_annotation(None)


def test_array_samples_keep_hangul_readable() -> None:
    assert render_sample_value(["이천", "부산"]) == '["이천", "부산"]'


def test_column_comments_are_nfc_in_korean_mode(ko: None) -> None:
    decomposed = unicodedata.normalize("NFD", "거래처명")
    df = pd.DataFrame(
        {
            "table_schema": ["public"],
            "table_name": ["tb_georaecheo"],
            "column_name": ["georaecheo_nm"],
            "ordinal_position": [1],
            "data_type": ["varchar"],
            "is_nullable": [True],
            "description": [decomposed],
        }
    )
    assert normalize_columns(df)["description"].iloc[0] == "거래처명"


@pytest.mark.parametrize(
    ("stored", "source", "fills"),
    [
        (None, "거래처명", True),
        ("", "거래처명", True),
        ("직접 정리한 설명", "거래처명", False),  # curated: never overwritten
        (None, None, False),
        (None, "  ", False),
    ],
)
def test_reingest_fills_only_empty_descriptions(
    ko: None, stored: object, source: object, fills: bool
) -> None:
    assert diff._fills_empty_description(stored, source) is fills


def test_reingest_fill_is_korean_only(en: None) -> None:
    assert diff._fills_empty_description(None, "Customer name") is False


def test_description_fills_from_column_merge(ko: None) -> None:
    merge = pd.DataFrame(
        {
            "description_graph": [None, "curated"],
            "description_files": ["거래처명", "새 주석"],
            "props_graph": [{"id": "c1"}, {"id": "c2"}],
        }
    )
    assert diff._description_fills(merge) == [
        {"id": "c1", "label": "Column", "props": {"description": "거래처명"}}
    ]
