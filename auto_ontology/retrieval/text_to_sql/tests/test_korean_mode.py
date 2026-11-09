# SPDX-License-Identifier: Apache-2.0

"""``AUTO_ONTOLOGY_LANGUAGE=ko`` across the retrieval steps, without a model.

Each test runs the same call in English and Korean mode: English must look
exactly as upstream ships it, Korean must carry the Korean behaviour.
"""

from __future__ import annotations

import importlib
from types import ModuleType, SimpleNamespace
from typing import cast

import pytest

from auto_ontology.retrieval import language_directives as ld
from auto_ontology.retrieval.entity_coverage.prompts import (
    create_question_extraction_prompt,
)
from auto_ontology.retrieval.interactive import clarify, merge
from auto_ontology.retrieval.text_to_sql.agents import information_agent
from auto_ontology.retrieval.text_to_sql.agents.evidence_refinement import (
    _question_contains_literal,
)
from auto_ontology.retrieval.text_to_sql.agents.question_intent import (
    create_question_intent_prompt,
)
from auto_ontology.retrieval.text_to_sql.prompts import (
    create_follow_up_resolution_prompt,
)
from auto_ontology.retrieval.text_to_sql.state import TextToSQLPayload
from auto_ontology.retrieval.text_to_sql.value_anchors import (
    split_schema_named_anchors,
)

_KO_QUESTION = "거래처별 지난달 매출액은?"


@pytest.fixture
def korean(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")


@pytest.fixture
def english(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AUTO_ONTOLOGY_LANGUAGE", raising=False)


# --- directives ---------------------------------------------------------------


def test_directives_are_empty_in_english(english: None) -> None:
    assert ld.answer_language_directive() == ""
    assert ld.extraction_language_directive() == ""
    assert ld.rewrite_language_directive() == ""
    assert ld.clarify_language_directive() == ""
    assert ld.calendar_window_phrases() == ()


def test_unknown_language_falls_back_to_english(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "jp")
    assert ld.answer_language_directive() == ""


def test_answer_directive_overrides_english_and_keeps_code(korean: None) -> None:
    text = ld.answer_language_directive()
    assert "Korean" in text
    assert "even where an instruction or a field description elsewhere asks for" in (
        " ".join(text.split())
    )
    # Without this clause a Korean answer instruction also turned SQL aliases
    # Korean (`AS 매출액`) in a model probe.
    assert "column aliases (keep them ASCII snake_case)" in " ".join(text.split())


# --- prompts --------------------------------------------------------------------


def test_extraction_prompt(english: None, monkeypatch: pytest.MonkeyPatch) -> None:
    english_prompt = create_question_extraction_prompt(_KO_QUESTION)
    assert "## Korean questions" not in english_prompt

    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")
    korean_prompt = create_question_extraction_prompt(_KO_QUESTION)
    assert "## Korean questions" in korean_prompt
    assert '"매출액은" → "매출액"' in korean_prompt
    # The English prompt is a prefix-and-suffix of the Korean one: only the
    # block is inserted, nothing upstream is rewritten.
    block = ld.extraction_language_directive()
    assert korean_prompt.replace(block, "") == english_prompt
    assert korean_prompt.rstrip().endswith(_KO_QUESTION)


def test_intent_prompt(english: None, monkeypatch: pytest.MonkeyPatch) -> None:
    english_prompt = create_question_intent_prompt(_KO_QUESTION)
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")
    korean_prompt = create_question_intent_prompt(_KO_QUESTION)
    block = ld.rewrite_language_directive()
    assert block and block in korean_prompt
    assert korean_prompt.replace(block, "") == english_prompt


def test_follow_up_prompt(english: None, monkeypatch: pytest.MonkeyPatch) -> None:
    kwargs = {"question": "작년은?", "conversation_history": "Q: 올해 매출은?"}
    english_prompt = create_follow_up_resolution_prompt(**kwargs)
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")
    korean_prompt = create_follow_up_resolution_prompt(**kwargs)
    block = ld.rewrite_language_directive()
    assert block in korean_prompt
    assert korean_prompt.replace(block, "") == english_prompt


def test_information_agent_prompt(
    english: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = ({"question": "매출액은 어떻게 계산되나요?"}, [])
    english_prompt = information_agent._render_prompt(*args, tool_calls_remaining=3)
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")
    korean_prompt = information_agent._render_prompt(*args, tool_calls_remaining=3)
    assert korean_prompt == english_prompt + ld.answer_language_directive()


@pytest.mark.parametrize("language", ["en", "ko"])
def test_clarify_and_merge_prompts(
    monkeypatch: pytest.MonkeyPatch, language: str
) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", language)
    seen: list[str] = []

    def capture(_llm: object, prompt: str) -> str:
        seen.append(prompt)
        return "답변"

    monkeypatch.setattr(clarify, "safe_invoke_text", capture)
    monkeypatch.setattr(merge, "safe_invoke_text", capture)
    clarify._generate_forced_question("매출액", "정의 필요", llm=None)
    merge.merge_clarification("매출액은?", {"q": "정의?", "a": "합계"}, llm=None)

    forced, merged = seen
    if language == "ko":
        assert forced.endswith(ld.clarify_language_directive())
        assert merged.endswith(ld.rewrite_language_directive())
    else:
        assert "Korean" not in forced and "Korean" not in merged


@pytest.fixture
def main_module(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    monkeypatch.setattr(
        "auto_ontology.utils.llm_invoke.get_llm_client", lambda *a, **k: object()
    )
    monkeypatch.setattr(
        "auto_ontology.utils.llm_invoke.get_non_reasoning_llm_client",
        lambda *a, **k: object(),
    )
    return importlib.import_module("auto_ontology.retrieval.text_to_sql.main")


@pytest.mark.parametrize("language", ["en", "ko"])
def test_main_system_prompt_carries_the_answer_language(
    main_module: ModuleType, monkeypatch: pytest.MonkeyPatch, language: str
) -> None:
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", language)
    payload = {
        "question": _KO_QUESTION,
        "data_retriever": object(),
        "connectors": [SimpleNamespace(dialect="postgres", database_name="db")],
    }
    state = main_module._build_state(cast(TextToSQLPayload, payload))
    system = state["messages"][0].content
    # Every SQL-generation and reconstruction turn starts from these messages.
    if language == "ko":
        assert system.endswith(ld.answer_language_directive())
    else:
        assert system.startswith("Today's date is:")
        assert "Answer language" not in system


def test_calendar_phrases(korean: None) -> None:
    phrases = ld.calendar_window_phrases()
    assert any(phrase in _KO_QUESTION for phrase in phrases)
    assert not any(phrase in "2024년 1월 매출" for phrase in phrases)


# --- value anchors and evidence literals ---------------------------------------


def _anchor(phrase: str) -> dict:
    return {
        "phrase": phrase,
        "kind": "value",
        "tbl": "거래처",
        "col": "지역",
        "stored_value": phrase,
    }


_KO_TABLES = [{"name": "매출", "columns": [{"name": "서울 매출액"}, {"name": "지역"}]}]


def test_korean_anchor_naming_a_korean_column(korean: None) -> None:
    # "서울 매출액" is a column; the phrase names schema, not a filter value.
    kept, naming_schema = split_schema_named_anchors(
        [_anchor("서울 매출액"), _anchor("부산")], _KO_TABLES
    )
    assert [a["phrase"] for a in naming_schema] == ["서울 매출액"]
    assert [a["phrase"] for a in kept] == ["부산"]


def test_korean_anchor_is_kept_in_english_mode(english: None) -> None:
    # Upstream tokenizes Hangul to nothing, so it never judges such a phrase.
    kept, naming_schema = split_schema_named_anchors(
        [_anchor("서울 매출액")], _KO_TABLES
    )
    assert naming_schema == []
    assert len(kept) == 1


def test_korean_anchor_does_not_match_inside_a_longer_word(korean: None) -> None:
    kept, naming_schema = split_schema_named_anchors([_anchor("서울")], _KO_TABLES)
    # Whole words: "서울" is a word of "서울 매출액", so it is schema-named.
    assert naming_schema and not kept
    kept, naming_schema = split_schema_named_anchors(
        [_anchor("매출")], [{"name": "t", "columns": [{"name": "월매출액"}]}]
    )
    assert kept and not naming_schema


@pytest.mark.parametrize(
    ("question", "literal", "korean_expected", "english_expected"),
    [
        ("서울에서 판매된 주문", "'서울'", True, False),
        ("서울의 매출", "'서울'", True, False),
        ("서울 매출", "'서울'", True, True),
        ("서울특별시 매출", "'서울'", False, False),
        ("'Northwind' 브랜드를 구매한 고객", "'Northwind'", True, True),
        ("Northwind를 구매한 고객", "'Northwind'", True, False),
        # Particles the stripping list leaves out are fine after a known value.
        ("서울만 보여줘", "'서울'", True, False),
        ("서울하고 부산", "'서울'", True, False),
        ("서울이랑 부산", "'서울'", True, False),
        ("상태가 완료인 주문", "'완료'", True, False),
        ("쿠팡도 포함해서", "'쿠팡'", True, False),
        # A number may carry a counter, then a particle.
        ("2024년 매출", "2024", True, False),
        ("2024년에 가입한", "2024", True, False),
        ("주문이 3건 이상", "3", True, False),
        # Still a different word.
        ("완료된 주문", "'완료'", False, False),
    ],
)
def test_question_contains_literal_with_particles(
    monkeypatch: pytest.MonkeyPatch,
    question: str,
    literal: str,
    korean_expected: bool,
    english_expected: bool,
) -> None:
    monkeypatch.delenv("AUTO_ONTOLOGY_LANGUAGE", raising=False)
    assert _question_contains_literal(question, literal) is english_expected
    monkeypatch.setenv("AUTO_ONTOLOGY_LANGUAGE", "ko")
    assert _question_contains_literal(question, literal) is korean_expected
