# SPDX-License-Identifier: Apache-2.0

"""Korean-mode helpers for semantic compilation.

Everything here is reached only when :func:`auto_ontology.utils.language.is_korean`
is true. Upstream modules call into this file from small ``is_korean()``
branches so the English path stays byte-for-byte what upstream ships, and the
fork's patch surface in those files stays a handful of lines.

Prompts keep their English instructions and get a Korean-mode suffix appended
at call time (not import time), so the language follows the environment of the
running process.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from pydantic import ConfigDict, Field

from auto_ontology.semantic.models import (
    RawTableTermsResult,
    RawTermProposal,
    TermColumnRef,
)
from auto_ontology.utils.korean_text import nfc
from auto_ontology.utils.language import is_korean

if TYPE_CHECKING:
    from auto_ontology.semantic.models import ColumnAttributeSpec, TableTermsResult

# Labels: Hangul syllables, ASCII letters and digits, single spaces between
# words. No punctuation, so a label never looks like the "name (db.schema.table)"
# suffix upsert_table_term uses to qualify a colliding Term name.
_LABEL_RE = re.compile(r"^[가-힣A-Za-z0-9]+(?: [가-힣A-Za-z0-9]+)*$")
_HAS_WORD_RE = re.compile(r"[가-힣A-Za-z]")
_HANGUL_RE = re.compile(r"[가-힣]")
_ENGLISH_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$")
_INVALID = {"unnamed", "unknown", "none", "", "없음", "알 수 없음", "미상", "이름 없음"}
# A column comment longer than this is a sentence, not a label.
_MAX_COMMENT_LABEL_LEN = 20
# Separator column_attribute_specs uses before samples / date notation.
_DESCRIPTION_SUFFIX_SEP = " — "

TERM_PROMPT_SUFFIX = """

Language: Korean (한국어).
6. Write every Term name, display_name and description in Korean, using the \
business terminology a Korean company would use (e.g. 발주, 주문 일자, 공급가액). \
Do not answer in English and do not transliterate the physical name.
7. Table and column descriptions (after "—") are often Korean comments written by \
the database owners. They are the strongest evidence of business meaning: when a \
column description is a short label (e.g. 거래처명), use it as the display_name as \
written.
8. Physical names are often English abbreviations (e.g. CUST_NM, ORD_DT, REG_DT). \
Infer their meaning from the description, the sample values and the table context; \
never return the abbreviation itself as a label.
9. Labels contain only Korean, English letters, digits and single spaces — no \
punctuation, parentheses, slashes or underscores. Keep established English acronyms \
as they are (e.g. VAT, SKU).
10. For rule 5, use a Korean qualifier (e.g. 보관, 이력, 임시, 삭제) instead of an \
English one.
11. Also give each Term's usual English business name in english_name (e.g. Sales \
Order for 수주), so English questions can find it."""

SYNONYM_PROMPT_SUFFIX = """

The description may be written in Korean. Korean cues for an explicitly stated \
alternate name include "~라고도 한다", "일명", "약칭", "약어", "줄여서", "(이하 OO)", and \
a parenthetical directly after the entity name such as "사업부(BU)". Return such names \
verbatim, in whatever language they are written."""

COLUMN_DESCRIPTION_PROMPT_SUFFIX = """
- Write each description in Korean, in the business terms a Korean company would use."""

FALLBACK_TERM_DESCRIPTION = "테이블 {table}이(가) 나타내는 업무 개체"


class KoreanTermColumnRef(TermColumnRef):
    """Korean-mode column assignment: same fields, Korean label guidance."""

    display_name: str = Field(
        ...,
        description="Korean ColumnAttribute label (e.g. 수주 일자, 거래처명).",
    )


class KoreanRawTermProposal(RawTermProposal):
    """Korean-mode Term: Korean name plus the English business name."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        ...,
        description="Korean business Term name (e.g. 수주, 거래처).",
    )
    english_name: str = Field(
        default="",
        description=(
            "The same Term's usual English business name in Title Case "
            "(e.g. Sales Order). Empty when there is none."
        ),
    )
    attributes: list[KoreanTermColumnRef] = Field(
        default_factory=list,
        description="Candidate columns assigned to this Term with Korean labels.",
    )


class KoreanRawTableTermsResult(RawTableTermsResult):
    """Korean-mode structured output schema; English mode never sees it."""

    terms: list[KoreanRawTermProposal] = Field(
        ...,
        description=(
            "Usually one Term. Propose multiple only when columns clearly belong "
            "to distinct business concepts."
        ),
    )


def language_suffix(suffix: str) -> str:
    """*suffix* in Korean mode, empty otherwise."""
    return suffix if is_korean() else ""


def normalize_label(name: str) -> str | None:
    """Cleaned Korean-mode label, or ``None`` when it must be rejected.

    A label without Hangul is split like the English path (``PurchaseOrder`` →
    ``Purchase Order``). A label with any Hangul, mixed ones such as
    ``고객 Order`` or ``VAT 금액`` included, only has its whitespace collapsed.
    """
    cleaned = " ".join(nfc(name).split())
    if cleaned.casefold() in _INVALID:
        return None
    if not _LABEL_RE.match(cleaned) or not _HAS_WORD_RE.search(cleaned):
        return None
    if not _HANGUL_RE.search(cleaned):
        return english_name_from_physical(cleaned)
    return cleaned


def _split_physical(name: str, word_chars: str) -> str:
    """Upstream ``to_term_name`` splitting with a configurable word alphabet."""
    separated = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", name.strip())
    separated = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", separated)
    parts = re.split(rf"[^{word_chars}]+", separated)
    return " ".join(
        part if part.isupper() else part.capitalize() for part in parts if part
    )


def term_name_from_physical(table_name: str) -> str:
    """Fallback Term name that keeps Hangul in physical names.

    ``고객`` stays ``고객``, ``tb_주문`` becomes ``Tb 주문`` and ``CUST_NM`` gives
    ``CUST NM`` exactly as upstream. Never empty for a non-blank name: a name
    made only of separators falls back to itself.
    """
    name = nfc(table_name)
    return _split_physical(name, "A-Za-z0-9가-힣") or name.strip()


def english_name_from_physical(table_name: str) -> str:
    """Upstream's ASCII-only fallback name (``Purchase Orders``), possibly empty."""
    return _split_physical(table_name, "A-Za-z0-9")


def fallback_display_name(spec: ColumnAttributeSpec) -> str:
    """Display name to use when the LLM label is missing or rejected.

    A short label-like column comment (``거래처명``) beats the camel-cased
    physical name (``custNm``).
    """
    comment = (spec.description or "").split(_DESCRIPTION_SUFFIX_SEP, 1)[0]
    label = normalize_label(comment)
    if label and len(label) <= _MAX_COMMENT_LABEL_LEN:
        return label
    return spec.name


def _english_name(raw: str) -> str:
    cleaned = " ".join(raw.split())
    if not _ENGLISH_NAME_RE.match(cleaned):
        return ""
    return english_name_from_physical(cleaned)


def _english_names_by_term(
    raw_result: RawTableTermsResult | None,
) -> tuple[dict[str, str], str]:
    """LLM English names keyed by normalized Korean Term name, plus the first."""
    if raw_result is None:
        return {}, ""
    by_name: dict[str, str] = {}
    first = ""
    for raw_term in raw_result.terms:
        english = _english_name(getattr(raw_term, "english_name", "") or "")
        first = first or english
        label = normalize_label(raw_term.name)
        if label and english:
            by_name.setdefault(label, english)
    return by_name, first


def extend_term_synonyms(
    result: TableTermsResult,
    table_name: str,
    raw_result: RawTableTermsResult | None = None,
) -> None:
    """Add English and physical-name forms of the table to every Term's synonyms.

    Korean Term names are reachable from Korean questions; these keep English and
    physical-name questions reaching the same Term — through the attribute
    embedding text (embed.py appends Term synonyms) and through the ASCII
    whole-word synonym match in search.

    Order: aliases already present (stated in the description), the LLM's
    English business name, upstream's ASCII rendering of the physical name
    (skipped when the name has Hangul, which that rendering would drop), and
    the physical name itself.
    """
    english_by_name, first_english = _english_names_by_term(raw_result)
    physical = nfc(table_name).strip()
    ascii_form = (
        "" if _HANGUL_RE.search(physical) else english_name_from_physical(physical)
    )
    for term in result.terms:
        llm_english = english_by_name.get(term.name) or (
            first_english if len(result.terms) == 1 else ""
        )
        seen = {term.name.casefold()}
        merged: list[str] = []
        for synonym in [*term.synonyms, llm_english, ascii_form, physical]:
            key = synonym.strip().casefold()
            if key and key not in seen:
                seen.add(key)
                merged.append(synonym.strip())
        term.synonyms = merged
