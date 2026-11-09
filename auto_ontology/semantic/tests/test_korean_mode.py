# SPDX-License-Identifier: Apache-2.0

"""Korean-mode term extraction: labels, fallback names, prompts, synonyms."""

from __future__ import annotations

import logging
from typing import Any
from unittest.mock import patch

import pytest

from auto_ontology.semantic import korean, term_extractor
from auto_ontology.semantic.deterministic import _describe_column_batch, to_term_name
from auto_ontology.semantic.models import (
    ColumnAttributeSpec,
    ColumnDescriptionResult,
    RawTableTermsResult,
    RawTermProposal,
    TermColumnRef,
)
from auto_ontology.semantic.term_extractor import _sanitize_result, extract_term


@pytest.fixture
def ko(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")


@pytest.fixture
def en(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AUTO_ONTOLOGY_LANGUAGE", raising=False)


def _specs() -> list[ColumnAttributeSpec]:
    return [
        ColumnAttributeSpec(
            source_column="ORD_DT",
            name="ordDt",
            datatype="char",
            description="수주일자 — format: YYYYMMDD",
        ),
        ColumnAttributeSpec(
            source_column="CUST_NM",
            name="custNm",
            datatype="varchar",
            description="거래처명 — samples: 삼성전자, LG화학",
        ),
    ]


def _raw(term: str, labels: dict[str, str]) -> RawTableTermsResult:
    return RawTableTermsResult(
        terms=[
            RawTermProposal(
                name=term,
                description="고객이 낸 주문",
                attributes=[
                    TermColumnRef(source_column=col, display_name=label)
                    for col, label in labels.items()
                ],
            )
        ]
    )


@pytest.mark.usefixtures("ko")
def test_ko_keeps_korean_labels() -> None:
    raw = _raw("수주", {"ORD_DT": "수주 일자", "CUST_NM": "거래처명"})

    result = _sanitize_result(raw, table={"name": "TB_ORD"}, specs=_specs())

    term = result.terms[0]
    assert term.name == "수주"
    assert term.description == "고객이 낸 주문"
    assert {a.source_column: a.display_name for a in term.attributes} == {
        "ORD_DT": "수주 일자",
        "CUST_NM": "거래처명",
    }
    assert result.rejected_labels == 0


@pytest.mark.usefixtures("ko")
def test_ko_mixed_labels_and_whitespace_are_normalized() -> None:
    raw = _raw("VAT  포함 매출", {"ORD_DT": " 1차 승인일 "})

    result = _sanitize_result(raw, table={"name": "TB_ORD"}, specs=_specs())

    assert result.terms[0].name == "VAT 포함 매출"
    assert result.terms[0].attributes[0].display_name == "1차 승인일"


@pytest.mark.usefixtures("ko")
def test_ko_rejected_labels_fall_back_to_comment_and_are_counted(
    caplog: pytest.LogCaptureFixture,
) -> None:
    raw = _raw("없음", {"ORD_DT": "ORD_DT", "CUST_NM": "거래처(명)"})

    with caplog.at_level(logging.WARNING):
        result = _sanitize_result(raw, table={"name": "TB_수주"}, specs=_specs())

    term = result.terms[0]
    assert term.name == "TB 수주"
    # Short Korean comments are the fallback display names.
    assert {a.source_column: a.display_name for a in term.attributes} == {
        "ORD_DT": "수주일자",
        "CUST_NM": "거래처명",
    }
    assert result.rejected_labels == 3
    assert "3 LLM label(s) rejected" in caplog.text


@pytest.mark.usefixtures("ko")
def test_ko_fallback_display_skips_sentence_comments() -> None:
    spec = ColumnAttributeSpec(
        source_column="REG_DT",
        name="regDt",
        description="이 레코드가 처음 등록된 시각을 나타냅니다.",
    )

    result = _sanitize_result(_raw("수주", {}), table={"name": "T"}, specs=[spec])

    assert result.terms[0].attributes[0].display_name == "regDt"


@pytest.mark.usefixtures("en")
def test_en_still_rejects_korean_labels() -> None:
    raw = _raw("수주", {"ORD_DT": "수주 일자"})

    result = _sanitize_result(raw, table={"name": "TB_ORD"}, specs=_specs())

    term = result.terms[0]
    assert term.name == "TB ORD"
    assert term.attributes[0].display_name == "ordDt"
    assert result.rejected_labels == 0


@pytest.mark.parametrize(
    ("physical", "expected"),
    [
        ("고객", "고객"),
        ("tb_주문", "Tb 주문"),
        ("TB_주문_상세", "TB 주문 상세"),
        ("CUST_NM", "CUST NM"),
        ("purchase_orders", "Purchase Orders"),
        ("고객ID", "고객ID"),
        ("___", "___"),
    ],
)
def test_ko_term_name_from_physical(
    monkeypatch: pytest.MonkeyPatch, physical: str, expected: str
) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")
    assert to_term_name(physical) == expected


@pytest.mark.usefixtures("en")
def test_en_term_name_unchanged_for_hangul() -> None:
    # Upstream behaviour, pinned: Hangul is dropped in English mode.
    assert to_term_name("고객") == ""
    assert to_term_name("tb_주문") == "Tb"


class _Capture:
    def __init__(self, *results: Any) -> None:
        self.calls: list[list[Any]] = []
        self.schemas: list[Any] = []
        self._results = list(results)

    def __call__(self, _llm: Any, messages: list[Any], schema: Any) -> Any:
        self.calls.append(messages)
        self.schemas.append(schema)
        return self._results.pop(0) if self._results else None


def _run_extract(
    capture: _Capture, description: str = "", table_name: str = "TB_ORD"
) -> Any:
    with (
        patch.object(term_extractor, "invoke_with_structured_output", capture),
        patch.object(term_extractor, "get_llm_client", return_value=None),
    ):
        return extract_term(
            {"name": table_name, "description": description}, {}, _specs()
        )


def _korean_raw(term: str, english: str) -> korean.KoreanRawTableTermsResult:
    return korean.KoreanRawTableTermsResult(
        terms=[
            korean.KoreanRawTermProposal(
                name=term,
                english_name=english,
                attributes=[
                    korean.KoreanTermColumnRef(
                        source_column="ORD_DT", display_name="수주 일자"
                    )
                ],
            )
        ]
    )


@pytest.mark.usefixtures("ko")
def test_ko_prompt_has_language_instruction_and_synonyms() -> None:
    capture = _Capture(_raw("수주", {"ORD_DT": "수주 일자", "CUST_NM": "거래처명"}))

    result = _run_extract(capture)

    system = capture.calls[0][0].content
    assert system.startswith(term_extractor._SYSTEM)
    assert "Language: Korean" in system
    assert capture.schemas[0] is korean.KoreanRawTableTermsResult
    assert result.terms[0].synonyms == ["TB ORD", "TB_ORD"]


@pytest.mark.usefixtures("ko")
def test_ko_synonyms_include_llm_english_name() -> None:
    capture = _Capture(_korean_raw("수주", "Sales Order"))

    result = _run_extract(capture)

    assert result.terms[0].name == "수주"
    assert result.terms[0].synonyms == ["Sales Order", "TB ORD", "TB_ORD"]


@pytest.mark.usefixtures("ko")
def test_ko_hangul_physical_name_skips_lossy_ascii_form() -> None:
    capture = _Capture(_korean_raw("고객", "Customer (master)"))

    result = _run_extract(capture, table_name="tb_고객")

    # The invalid English name is dropped; "Tb" would be noise.
    assert result.terms[0].synonyms == ["tb_고객"]


@pytest.mark.usefixtures("ko")
def test_ko_synonyms_merge_description_aliases_with_physical_names() -> None:
    synonym_result = term_extractor._SynonymExtractionModel(synonyms=["SO", "수주"])
    capture = _Capture(_raw("수주", {"ORD_DT": "수주 일자"}), synonym_result)

    result = _run_extract(capture, description="수주(SO) 정보")

    assert "Korean cues" in capture.calls[1][0].content
    # The Term's own name is not repeated as a synonym.
    assert result.terms[0].synonyms == ["SO", "TB ORD", "TB_ORD"]


@pytest.mark.usefixtures("ko")
def test_ko_structured_output_failure_is_flagged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        result = _run_extract(_Capture())

    assert result.used_fallback_terms is True
    assert result.terms[0].name == "TB ORD"
    assert result.terms[0].description.startswith("테이블 TB_ORD")
    assert result.terms[0].synonyms == ["TB_ORD"]
    assert "structured output failed" in caplog.text


@pytest.mark.usefixtures("en")
def test_en_prompt_and_synonyms_unchanged() -> None:
    capture = _Capture(_raw("Sales Order", {"ORD_DT": "Order Date"}))

    result = _run_extract(capture)

    assert capture.calls[0][0].content == term_extractor._SYSTEM
    assert capture.schemas[0] is RawTableTermsResult
    assert result.terms[0].synonyms == []
    assert result.used_fallback_terms is False


@pytest.mark.parametrize(("lang", "expected"), [("ko", True), ("en", False)])
def test_column_description_prompt_language(
    monkeypatch: pytest.MonkeyPatch, lang: str, expected: bool
) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", lang)
    captured: list[Any] = []

    def _fake(_llm: Any, messages: list[Any], _schema: Any) -> Any:
        captured.append(messages)
        return ColumnDescriptionResult()

    with (
        patch(
            "auto_ontology.semantic.deterministic.invoke_with_structured_output",
            _fake,
        ),
        patch("auto_ontology.semantic.deterministic.get_llm_client"),
    ):
        _describe_column_batch([{"name": "CUST_NM", "data_type": "varchar"}], {})

    assert ("Write each description in Korean" in captured[0][0].content) is expected


@pytest.mark.usefixtures("ko")
def test_ko_ascii_labels_are_split_like_english() -> None:
    raw = _raw("PurchaseOrder", {"ORD_DT": "orderDate", "CUST_NM": "CUSTName"})

    result = _sanitize_result(raw, table={"name": "TB_ORD"}, specs=_specs())

    term = result.terms[0]
    assert term.name == "Purchase Order"
    assert {a.source_column: a.display_name for a in term.attributes} == {
        "ORD_DT": "Order Date",
        "CUST_NM": "CUST Name",
    }
    assert result.rejected_labels == 0


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("수주 일자", "수주 일자"),
        ("수주일자", "수주일자"),
        ("고객 Order", "고객 Order"),
        ("고객 PurchaseOrder", "고객 PurchaseOrder"),
        ("VAT  금액", "VAT 금액"),
        ("TotalAmount", "Total Amount"),
        ("SKU", "SKU"),
    ],
)
def test_ko_label_split_rule(label: str, expected: str) -> None:
    assert korean.normalize_label(label) == expected


@pytest.mark.usefixtures("ko")
def test_ko_english_name_synonym_is_split() -> None:
    capture = _Capture(_korean_raw("수주", "SalesOrder"))

    result = _run_extract(capture)

    assert result.terms[0].synonyms == ["Sales Order", "TB ORD", "TB_ORD"]


def test_decomposed_hangul_names_are_composed() -> None:
    """A table or label in NFD (macOS exports) must not lose its Hangul."""
    import unicodedata

    nfd_table = unicodedata.normalize("NFD", "월별_매출목표")
    assert korean.term_name_from_physical(nfd_table) == "월별 매출목표"
    assert (
        korean.normalize_label(unicodedata.normalize("NFD", "거래처명")) == "거래처명"
    )
