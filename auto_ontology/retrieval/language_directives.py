# SPDX-License-Identifier: Apache-2.0

"""Prompt add-ons for answering in the configured language.

The upstream prompts are English and stay that way. In Korean mode each prompt
gets one of these blocks appended, which keeps every English prompt
byte-identical and the Korean behaviour in one file. Every function returns
``""`` unless :func:`auto_ontology.utils.language.is_korean` is true, so call
sites can append unconditionally.

The blocks state explicitly that they override earlier language instructions:
``SQLGenerationModel.response`` and the SQL output spec both ask for "plain
English", and a later, explicit instruction is what wins against them.
"""

from __future__ import annotations

from auto_ontology.utils.language import is_korean

_ANSWER_LANGUAGE_KO = """

## Answer language
The user works in Korean. Write every user-facing natural-language field \
(`response`, and any question or explanation shown to the user) in Korean \
(한국어), even where an instruction or a field description elsewhere asks for \
English. When naming a table or column in that text, use its Korean description \
rather than the raw identifier. Everything that is code stays as you would \
otherwise write it: SQL keywords, table and column names, column aliases (keep \
them ASCII snake_case), and literal values. Translate none of it."""

_EXTRACTION_LANGUAGE_KO = """
## Korean questions
The question is in Korean. Apply every rule above with these adjustments:
- Keep `sanitized_question` in Korean. Do not translate it.
- Write each `required_entity_name` entry, and `subject`, as a Korean noun \
phrase in dictionary form: drop the particles and endings attached to words \
(은/는/이/가/을/를/의/에/에서/으로/별/들 and the like). \
"매출액은" → "매출액", "고객별" → "고객", "주문의" → "주문".
- Keep Latin-script terms, codes, and product or brand names exactly as written \
("ROAS", "SKU", "Northwind").
- The aggregation words in the rules above include their Korean forms \
(수, 건수, 합계, 총, 평균, 최대, 최소).
- Date rule in Korean: end the phrase with "일자" instead of "date". \
"지난달 배송된 출고 건수" → ["출고", "출고 배송 월 일자"].

"""

_REWRITE_LANGUAGE_KO = """

## Language
The question is in Korean. Write rewritten or standalone questions and any \
extracted text in Korean, in the user's own wording. Do not translate them."""

_CLARIFY_LANGUAGE_KO = """

The user works in Korean: write the question text itself in Korean (한국어). \
Keep the control words PROCEED, ASK and RESOLVED in English exactly as specified."""

#: Korean phrases for a previous calendar period, the counterpart of the
#: English "last week / last month / last year" reminder in SQL generation.
_CALENDAR_WINDOW_PHRASES_KO: tuple[str, ...] = (
    "지난주",
    "지난 주",
    "지난달",
    "지난 달",
    "지난해",
    "작년",
    "전주",
    "전월",
    "전년",
)


def answer_language_directive() -> str:
    """Block for prompts that produce user-facing answers alongside SQL."""
    return _ANSWER_LANGUAGE_KO if is_korean() else ""


def extraction_language_directive() -> str:
    """Block for the question-sanitization and entity-extraction prompt."""
    return _EXTRACTION_LANGUAGE_KO if is_korean() else ""


def rewrite_language_directive() -> str:
    """Block for prompts that rewrite the user's question."""
    return _REWRITE_LANGUAGE_KO if is_korean() else ""


def clarify_language_directive() -> str:
    """Block for prompts that ask the user a clarification question."""
    return _CLARIFY_LANGUAGE_KO if is_korean() else ""


def calendar_window_phrases() -> tuple[str, ...]:
    """Extra previous-period phrases that trigger the calendar-window reminder."""
    return _CALENDAR_WINDOW_PHRASES_KO if is_korean() else ()


__all__ = [
    "answer_language_directive",
    "calendar_window_phrases",
    "clarify_language_directive",
    "extraction_language_directive",
    "rewrite_language_directive",
]
