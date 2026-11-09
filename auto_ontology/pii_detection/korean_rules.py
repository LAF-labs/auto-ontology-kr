# SPDX-License-Identifier: Apache-2.0

"""Korean-mode PII rules: Korean column names, Korean comments, and the
English abbreviations Korean schemas use (``HP_NO``, ``RCV_NM``, ``JUMIN_NO``).

Reached only when :func:`auto_ontology.utils.language.is_korean` is true, from
:func:`auto_ontology.pii_detection.rules.evaluate_rules`, before the English
rules. Every rule matches a whole label, never a substring, so ``상품명`` or
``ITEM_NM`` never reads as a person's name.

Two sources are tried, in this order of trust:

1. the column name itself (``주민등록번호``, ``hp_no``);
2. the column comment's label, the text before any `` — `` suffix
   (``HP_NO`` commented ``휴대폰번호``).

A column that matches nothing returns ``None`` and goes to the LLM, as before.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from auto_ontology.pii_detection.models import PiiDecision, PiiStatus
from auto_ontology.utils.korean_text import nfc

# Who a field belongs to, written before it: 고객 휴대폰번호, 수령인 주소.
_KO_OWNERS = (
    "고객|회원|사용자|수령인|수취인|받는분|받는 분|주문자|구매자|보내는분|발송인|"
    "직원|사원|임직원|대표자|담당자|보호자|신청자|본인|환자|학생"
)
# The same owners as Korean-schema abbreviations: rcv_hp, cust_nm, emp_nm.
_ABBR_OWNERS = (
    "cust|customer|mbr|member|usr|user|rcv|recv|rcvr|receiver|ord|orderer|buyer|"
    "snd|sndr|sender|emp|empl|ceo|rep|mgr|chrg|guard|appl|pat|std"
)


@dataclass(frozen=True, slots=True)
class _Rule:
    category: str
    korean: re.Pattern[str]
    abbreviation: re.Pattern[str] | None


def _rule(category: str, korean: str, abbreviation: str | None = None) -> _Rule:
    """*korean* matches a compacted label (spaces removed) with an optional
    owner prefix; *abbreviation* matches the space-separated normalized name
    with an optional owner token in front."""
    return _Rule(
        category,
        re.compile(rf"^(?:{_KO_OWNERS.replace(' ', '')})*(?:{korean})$"),
        re.compile(rf"^(?:(?:{_ABBR_OWNERS}) )*(?:{abbreviation})$")
        if abbreviation
        else None,
    )


_DIRECT_RULES = (
    _rule(
        "government_id",
        r"주민등록번호|주민번호|외국인등록번호|여권번호|운전면허번호|면허번호",
        r"jumin(?: no| num| number)?|rrn|rrno|frgn no|psprt no|passport no|"
        r"lcns no|license no",
    ),
    _rule(
        "phone_number",
        r"휴대폰(?:번호)?|휴대전화(?:번호)?|핸드폰(?:번호)?|전화(?:번호)?|연락처|"
        r"휴대폰연락처|자택전화(?:번호)?",
        r"hp(?: no| num)?|tel(?: no| num)?|telno|hpno|mobile no|mbl no|cel no|"
        r"cell no|phone no|ph no",
    ),
    _rule(
        "email_address",
        r"이메일(?:주소)?|전자우편(?:주소)?|메일주소",
        r"email(?: addr)?|eml|mail addr",
    ),
    _rule(
        "date_of_birth",
        r"생년월일|생일|출생일(?:자)?",
        r"birth(?: dt| ymd| date| day)?|brth(?: dt| ymd)?|brdt|bday",
    ),
    _rule(
        "payment_card",
        r"(?:신용|체크)?카드번호",
        r"card(?: no| num)|crd no",
    ),
    _rule(
        "banking",
        r"계좌번호|은행계좌(?:번호)?|환불계좌(?:번호)?",
        r"acct (?:no|num)|acnt no|bank acct(?: no)?|refund acct(?: no)?",
    ),
    _rule(
        "credential",
        r"비밀번호|패스워드|암호",
        r"pwd|passwd|pw|pass wd",
    ),
    _rule(
        "person_name",
        r"성명|이름|실명|고객명|회원명|수령인명|수취인명|주문자명|구매자명|발송인명|"
        r"대표자명|직원명|사원명|담당자명|보호자명|환자명|학생명",
        # A bare ``nm`` is not enough; the owner prefix makes it a person.
        r"(?:cust|customer|mbr|member|usr|user|rcv|recv|rcvr|receiver|ord|orderer|"
        r"buyer|snd|sndr|sender|emp|empl|ceo|rep|mgr|chrg|guard|appl|pat|std) nm",
    ),
    _rule(
        "postal_address",
        r"주소|상세주소|도로명주소|지번주소|배송지(?:주소)?|배송주소|자택주소",
        r"addr(?: dtl| detail| 1| 2)?|dlv addr|ship addr|road addr",
    ),
    _rule(
        "financial",
        r"연봉|급여|월급|소득|월소득|연소득",
        # English salary/income stay with the upstream person-table rule; and not
        # ``sal``: SAL_AMT is the usual abbreviation for a sales amount.
        None,
    ),
)

# Business fields that look like the above but are not about a person.
_NOT_PII = re.compile(
    r"^(?:상품명|품목명|제품명|카테고리명|분류명|부서명|직급|직위|거래처명|업체명|"
    r"회사명|상호|상호명|택배사|송장번호|운송장번호|창고명|매장명|지점명|채널명|"
    r"판매채널|브랜드명|캠페인명|사업자등록번호)$"
)
_NOT_PII_ABBR = re.compile(
    r"^(?:item nm|prod nm|prdt nm|goods nm|cate nm|ctgr nm|dept nm|dept cd|"
    r"invc no|wh nm|store nm|chnl nm|chnl cd|brand nm|biz no|bizno|corp nm|"
    r"vndr nm|vendor nm|com nm|comp nm)$"
)

_COMMENT_SUFFIX = " — "


def _label(text: str | None) -> str:
    """A comment's label, compacted: ``휴대폰번호 — samples: …`` → ``휴대폰번호``.

    Parenthesised notes are dropped first (``고객구분(01:개인)`` → ``고객구분``).
    """
    if not text:
        return ""
    head = nfc(text).split(_COMMENT_SUFFIX, 1)[0]
    head = re.sub(r"\([^)]*\)", "", head)
    return re.sub(r"[\W_]+", "", head.casefold())


def _decision(status: PiiStatus, category: str | None, why: str) -> PiiDecision:
    confidence = 0.97 if status is PiiStatus.PII else 0.95
    return PiiDecision(status, category, confidence, why, "rules")


def evaluate_korean_rules(
    column_name: str, compact_column_name: str, description: str | None
) -> PiiDecision | None:
    """Korean-mode decision for one column, or ``None`` to fall through.

    *column_name* and *compact_column_name* are the normalized forms
    :func:`auto_ontology.pii_detection.rules.evaluate_rules` already computed.
    """
    comment = _label(description)

    if (
        _NOT_PII.fullmatch(compact_column_name)
        or _NOT_PII_ABBR.fullmatch(column_name)
        or (comment and _NOT_PII.fullmatch(comment))
    ):
        return _decision(
            PiiStatus.NOT_PII, None, "Korean business field, not about a person."
        )

    for rule in _DIRECT_RULES:
        if rule.korean.fullmatch(compact_column_name):
            return _decision(
                PiiStatus.PII,
                rule.category,
                f"Korean column name matches the {rule.category} rule.",
            )
        if rule.abbreviation is not None and rule.abbreviation.fullmatch(column_name):
            return _decision(
                PiiStatus.PII,
                rule.category,
                f"Korean-schema abbreviation matches the {rule.category} rule.",
            )

    if comment:
        for rule in _DIRECT_RULES:
            if rule.korean.fullmatch(comment):
                return _decision(
                    PiiStatus.PII,
                    rule.category,
                    f"Column comment matches the {rule.category} rule.",
                )
    return None


__all__ = ["evaluate_korean_rules"]
