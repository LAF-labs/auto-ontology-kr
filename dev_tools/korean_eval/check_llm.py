# SPDX-License-Identifier: Apache-2.0

"""Smoke-test the configured chat models before a full evaluation run.

Makes three small calls with the settings in ``.env`` and reports what came
back, so a wrong key, model id, temperature or effort setting shows up in
seconds instead of halfway through a compile:

1. plain text on the reasoning model with a small ``max_tokens`` (300), the
   smallest budget the pipeline uses;
2. structured output (tool calling) on the reasoning model;
3. structured output on the non-reasoning model.

Usage::

    uv run --no-sync python dev_tools/korean_eval/check_llm.py

Never prints the API keys.
"""

from __future__ import annotations

import sys
import time
from urllib.parse import urlparse

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from auto_ontology.env import load_env

load_env()

from auto_ontology.utils import llm_invoke  # noqa: E402  (needs the env loaded first)


class _Term(BaseModel):
    name: str = Field(..., description="Korean business term for the column")
    english_name: str = Field(..., description="Usual English business name")


_PROMPT = [
    SystemMessage(content="You name database columns for a Korean retail company."),
    HumanMessage(
        content="Column CUST_NM, comment '고객명', samples: 김민준, 이서연. Name it."
    ),
]


def _usage(response) -> str:
    meta = getattr(response, "response_metadata", {}) or {}
    usage = meta.get("token_usage") or {}
    details = usage.get("completion_tokens_details") or {}
    return (
        f"in={usage.get('prompt_tokens')} out={usage.get('completion_tokens')} "
        f"reasoning={details.get('reasoning_tokens')} model={meta.get('model_name')}"
    )


def main() -> int:
    print(
        "config:",
        f"model={llm_invoke._MODEL_NAME}",
        f"non_reasoning={llm_invoke._NON_REASONING_MODEL_NAME}",
        f"endpoint={urlparse(llm_invoke._BASE_URL or '').netloc}",
        f"gateway={llm_invoke._openai_compatible()}",
        f"effort={llm_invoke._reasoning_effort()}",
    )
    failures = 0

    def run(label: str, call) -> None:
        nonlocal failures
        started = time.monotonic()
        try:
            detail = call()
            print(f"ok   {label} ({time.monotonic() - started:.1f}s) {detail}")
        except Exception as exc:  # noqa: BLE001 — report every failure, keep going
            failures += 1
            print(f"FAIL {label}: {type(exc).__name__}: {str(exc)[:400]}")

    def plain() -> str:
        llm = llm_invoke.get_llm_client(max_tokens=300)
        response = llm.invoke(
            [HumanMessage(content="'매출액은'에서 조사를 뺀 단어만 답해.")]
        )
        return f"{str(response.content).strip()[:60]!r} {_usage(response)}"

    def structured(client) -> str:
        result = llm_invoke.safe_invoke_with_structured_output(client, _PROMPT, _Term)
        return f"{result!r}"

    run("text, max_tokens=300", plain)
    run(
        "structured, reasoning model",
        lambda: structured(llm_invoke.get_llm_client(max_tokens=1024)),
    )
    run(
        "structured, non-reasoning model",
        lambda: structured(llm_invoke.get_non_reasoning_llm_client(max_tokens=1024)),
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
