# SPDX-FileCopyrightText: Copyright (c) 2024-2026, NVIDIA CORPORATION & AFFILIATES.
# All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""User-facing labels for LangGraph node names.

Lives next to ``text_to_sql_graph.py`` (the source of truth for node names)
rather than in ``auto_ontology.server.chat`` so the agent pipeline itself — e.g.
``main.py``'s ``stream_agent_response`` when it builds the final
``thoughts`` summary — can use the same labels without depending on the
server layer. ``auto_ontology.server.chat.helpers`` re-exports this for the router.

1-to-1 with the agent classes instantiated inside ``create_graph``. Unknown
nodes fall through to the raw node_name in callers so we never display a
blank thinking step.
"""

from __future__ import annotations

from auto_ontology.utils.language import is_korean

NODE_LABELS: dict[str, str] = {
    "question_intent": "Classifying the question",
    "question_extraction": "Understanding the question",
    "prepare_prediction_graph": "Preparing prediction",
    "kumo_predict": "Preparing prediction",
    "retrieve_candidates": "Retrieving candidates",
    "information_agent": "Answering from metadata",
    "prepare_candidates": "Preparing candidates",
    "refine_evidence": "Refining evidence",
    "precheck_combined": "Checking joins and filter values",
    "construct_sql_from_candidates": "Constructing SQL",
    "reconstruct_sql": "Reconstructing SQL",
    "validate_sql_values": "Validating filter values",
    "validate_sql_query": "Validating SQL and intent",
    "execute_sql_query": "Executing SQL",
    "check_empty_like_result": "Checking results",
    "check_value_repair": "Checking values",
    "format_and_respond": "Formatting response",
    "unconstructable_sql_response": "SQL could not be constructed",
}

KOREAN_NODE_LABELS: dict[str, str] = {
    "question_intent": "질문 유형 분류 중",
    "question_extraction": "질문 이해 중",
    "prepare_prediction_graph": "예측 준비 중",
    "kumo_predict": "예측 준비 중",
    "retrieve_candidates": "후보 검색 중",
    "information_agent": "메타데이터로 답변 중",
    "prepare_candidates": "후보 정리 중",
    "refine_evidence": "근거 다듬는 중",
    "precheck_combined": "조인과 필터 값 확인 중",
    "construct_sql_from_candidates": "SQL 작성 중",
    "reconstruct_sql": "SQL 다시 작성 중",
    "validate_sql_values": "필터 값 검증 중",
    "validate_sql_query": "SQL과 의도 검증 중",
    "execute_sql_query": "SQL 실행 중",
    "check_empty_like_result": "결과 확인 중",
    "check_value_repair": "값 확인 중",
    "format_and_respond": "답변 정리 중",
    "unconstructable_sql_response": "SQL을 만들 수 없음",
}


def node_label(node_name: str) -> str:
    """Label for *node_name* in the deployment language; the raw name if unknown."""
    labels = KOREAN_NODE_LABELS if is_korean() else NODE_LABELS
    return labels.get(node_name, NODE_LABELS.get(node_name, node_name))


__all__ = ["KOREAN_NODE_LABELS", "NODE_LABELS", "node_label"]
