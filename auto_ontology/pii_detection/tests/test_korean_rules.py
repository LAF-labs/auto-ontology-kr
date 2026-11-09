# SPDX-License-Identifier: Apache-2.0

"""Korean-mode PII rules, and the Unicode fix every mode gets."""

from __future__ import annotations

import pytest

from auto_ontology.pii_detection.models import ColumnInput, PiiStatus
from auto_ontology.pii_detection.rules import evaluate_rules, normalize


@pytest.fixture
def korean(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")


@pytest.fixture
def english(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AUTO_ONTOLOGY_LANGUAGE", raising=False)


def _status(column: str, table: str = "tb_cust", description: str | None = None):
    decision = evaluate_rules(
        ColumnInput(column_name=column, table_name=table, description=description)
    )
    return None if decision is None else (decision.status, decision.category)


# --- every mode -------------------------------------------------------------


def test_normalize_keeps_non_latin_letters_and_ascii_is_unchanged() -> None:
    assert normalize("주민등록번호") == "주민등록번호"
    assert normalize("고객_휴대폰번호") == "고객 휴대폰번호"
    assert normalize("Customer_EMAIL-addr") == "customer email addr"


def test_english_mode_sends_a_korean_name_to_the_llm(english: None) -> None:
    """It used to normalize to "" and come back as rules/REVIEW, marked
    processed without the LLM ever seeing it."""
    assert _status("주민등록번호", "고객") is None


# --- Korean mode: the evaluation fixture's columns ---------------------------


@pytest.mark.parametrize(
    ("table", "column", "description", "category"),
    [
        ("tb_cust", "cust_nm", "고객명", "person_name"),
        ("tb_cust", "ceo_nm", "대표자명", "person_name"),
        ("tb_cust", "hp_no", "휴대폰번호", "phone_number"),
        ("tb_cust", "email", "이메일", "email_address"),
        ("tb_cust", "addr", "주소", "postal_address"),
        ("tb_cust", "addr_dtl", "상세주소", "postal_address"),
        ("tb_dlv", "rcv_nm", "수령인명", "person_name"),
        ("tb_dlv", "rcv_hp", "수령인 연락처", "phone_number"),
        ("tb_dlv", "rcv_addr", "배송지 주소", "postal_address"),
        ("직원", "성명", None, "person_name"),
        ("직원", "주민등록번호", None, "government_id"),
        ("직원", "휴대전화", None, "phone_number"),
        ("직원", "연봉", None, "financial"),
    ],
)
def test_fixture_pii_columns_are_tagged(
    korean: None, table: str, column: str, description: str | None, category: str
) -> None:
    assert _status(column, table, description) == (PiiStatus.PII, category)


@pytest.mark.parametrize(
    ("table", "column", "description"),
    [
        ("tb_cust", "biz_no", "사업자등록번호"),
        ("tb_dlv", "invc_no", "송장번호"),
        ("tb_item", "item_nm", "상품명"),
        ("직원", "부서명", None),
        ("tb_ord_m", "chnl_cd", "판매채널"),
    ],
)
def test_business_fields_are_not_pii(
    korean: None, table: str, column: str, description: str | None
) -> None:
    assert _status(column, table, description) == (PiiStatus.NOT_PII, None)


# --- Korean mode: what must not over-match ---------------------------------------


@pytest.mark.parametrize(
    ("column", "description"),
    [
        ("nm", None),  # a bare name abbreviation has no owner
        ("상품이름", None),  # 상품 is not a person
        ("sal_amt", "매출금액"),  # SAL_AMT is a sales amount
        ("acct_cd", "계정과목코드"),  # an accounting code, not a bank account
        ("ord_dt", "주문일자"),
    ],
)
def test_lookalikes_fall_through(
    korean: None, column: str, description: str | None
) -> None:
    status = _status(column, "tb_ord_m", description)
    assert status is None or status[0] is not PiiStatus.PII


def test_comment_label_tags_an_opaque_column(korean: None) -> None:
    """``COL_07`` says nothing; its comment does."""
    assert _status("col_07", "tb_cust", "휴대폰번호 — samples: 010-1234-5678") == (
        PiiStatus.PII,
        "phone_number",
    )


def test_owner_prefixed_korean_names(korean: None) -> None:
    assert _status("고객_휴대폰번호") == (PiiStatus.PII, "phone_number")
    assert _status("수령인주소") == (PiiStatus.PII, "postal_address")


def test_decomposed_hangul_column_name_is_tagged(korean: None) -> None:
    import unicodedata

    nfd = unicodedata.normalize("NFD", "주민등록번호")
    assert _status(nfd, "직원") == (PiiStatus.PII, "government_id")
