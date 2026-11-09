# SPDX-License-Identifier: Apache-2.0

"""What a good Korean-mode compile of ``korean_smb`` should produce.

``TERM_NAMES``: Korean Term names accepted for each table (any one is enough;
spaces and case are ignored).

``PII_COLUMNS``: columns PII detection should flag (``True``) or leave alone
(``False``). Checked by hand in the UI for now; the API check is a follow-up.
"""

from __future__ import annotations

TERM_NAMES: dict[str, list[str]] = {
    "tb_cust": ["고객", "회원", "고객 마스터", "고객 정보"],
    "tb_cate": ["카테고리", "상품 카테고리", "상품 분류", "상품분류"],
    "tb_item": ["상품", "품목", "상품 마스터", "상품 정보"],
    "tb_ord_m": ["주문", "주문 마스터", "주문 정보", "주문서"],
    "tb_ord_d": ["주문 상세", "주문 품목", "주문 라인", "주문 상품", "주문 내역"],
    "tb_dlv": ["배송", "배송 정보", "출고", "배송 내역"],
    "tb_stock": ["재고", "재고 현황", "창고 재고"],
    "직원": ["직원", "사원", "임직원", "직원 정보"],
    "월별_매출목표": ["매출 목표", "월별 매출 목표", "판매 목표", "월별 판매 목표"],
    "ad_spend": ["광고비", "광고 비용", "광고 집행", "광고 지출", "광고 성과"],
}

PII_COLUMNS: dict[tuple[str, str], bool] = {
    ("tb_cust", "cust_nm"): True,  # 개인 고객은 이름
    ("tb_cust", "ceo_nm"): True,
    ("tb_cust", "hp_no"): True,
    ("tb_cust", "email"): True,
    ("tb_cust", "addr"): True,
    ("tb_cust", "addr_dtl"): True,
    ("tb_cust", "biz_no"): False,  # 사업자등록번호는 공개 정보
    ("tb_cust", "grade_cd"): False,
    ("tb_dlv", "rcv_nm"): True,
    ("tb_dlv", "rcv_hp"): True,
    ("tb_dlv", "rcv_addr"): True,
    ("tb_dlv", "invc_no"): False,
    ("직원", "성명"): True,
    ("직원", "주민등록번호"): True,
    ("직원", "휴대전화"): True,
    ("직원", "연봉"): True,
    ("직원", "부서명"): False,
    ("tb_item", "item_nm"): False,
}
