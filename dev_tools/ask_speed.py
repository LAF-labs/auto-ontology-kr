# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
# All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Time the question path (POST /api/chat/completions) for a set of questions.

    python -m dev_tools.ask_speed QUESTIONS.json --base-url http://127.0.0.1:3001 \
        [--api-key-file FILE] [--log FILE] [--concurrency N] [--only ID ...] [--out FILE]

QUESTIONS.json: ``{"target_db": "...", "questions": [{"id", "question"}, ...]}``.
With ``--log`` (the backend's log file, when questions run one at a time) each
result also carries the per-node and per-model-call timings the backend logged
while that question ran. Prints one JSON object per question.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

_NODE = re.compile(r"Node (\w+) took ([\d.]+)s")
_CALL = re.compile(
    r"LLM call output=(\S+) took=([\d.]+)s input_tokens=(\S+) "
    r"output_tokens=(\S+) reasoning_tokens=(\S+)"
)


def _int(text: str) -> int | None:
    return int(text) if text.isdigit() else None


def _log_breakdown(text: str) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []
    for line in text.splitlines():
        if (m := _CALL.search(line)) is not None:
            calls.append(
                {
                    "output": m[1],
                    "s": float(m[2]),
                    "in": _int(m[3]),
                    "out": _int(m[4]),
                    "reasoning": _int(m[5]),
                    "after_node": nodes[-1]["node"] if nodes else None,
                }
            )
        elif (m := _NODE.search(line)) is not None:
            nodes.append({"node": m[1], "s": float(m[2])})
    return {"nodes": nodes, "llm_calls": calls}


def ask(
    base_url: str,
    api_key: str | None,
    target_db: str | None,
    item: dict[str, Any],
    log: Path | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"question": item["question"]}
    if target_db:
        body["target_db"] = target_db
    headers = {"content-type": "application/json", "accept": "text/event-stream"}
    if api_key:
        headers["x-api-key"] = api_key
    offset = log.stat().st_size if log is not None else 0
    request = urllib.request.Request(
        f"{base_url}/api/chat/completions",
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    started = time.perf_counter()
    result: dict[str, Any] = {"id": item.get("id"), "question": item["question"]}
    steps: list[tuple[str, float]] = []
    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            result["first_byte_s"] = round(time.perf_counter() - started, 2)
            for raw in response:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload in ("", "[DONE]"):
                    continue
                event = json.loads(payload)
                now = round(time.perf_counter() - started, 2)
                if event.get("type") == "step":
                    steps.append((f"{event.get('node')}:{event.get('phase')}", now))
                elif event.get("type") == "error":
                    result["error"] = str(event.get("message"))[:300]
                elif event.get("type") == "result":
                    answer = event.get("answer") or {}
                    rows = answer.get("sql_response_from_db")
                    result["sql"] = answer.get("sql_code")
                    result["rows_sha"] = hashlib.sha256(
                        json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()
                    ).hexdigest()[:12]
                    result["rows_preview"] = json.dumps(rows, ensure_ascii=False)[:400]
                    result["response_preview"] = str(answer.get("response"))[:300]
    except Exception as exc:  # noqa: BLE001 — a failed question is a result too
        result["error"] = f"{type(exc).__name__}: {exc}"[:300]
    result["total_s"] = round(time.perf_counter() - started, 2)
    result["steps"] = steps
    if log is not None:
        time.sleep(0.3)
        with log.open("rb") as handle:
            handle.seek(offset)
            result.update(_log_breakdown(handle.read().decode("utf-8", "replace")))
        result["llm_calls_n"] = len(result["llm_calls"])
        result["llm_s"] = round(sum(c["s"] for c in result["llm_calls"]), 2)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("questions", type=Path)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--api-key-file", type=Path)
    parser.add_argument("--log", type=Path)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    spec = json.loads(args.questions.read_text())
    items = [q for q in spec["questions"] if not args.only or q.get("id") in args.only]
    api_key = args.api_key_file.read_text().strip() if args.api_key_file else None
    log = args.log if args.concurrency == 1 else None
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        results = list(
            pool.map(
                lambda q: ask(args.base_url, api_key, spec.get("target_db"), q, log),
                items,
            )
        )
    wall = round(time.perf_counter() - started, 2)
    lines = [json.dumps(r, ensure_ascii=False) for r in results]
    lines.append(json.dumps({"wall_s": wall, "concurrency": args.concurrency}))
    text = "\n".join(lines) + "\n"
    if args.out:
        args.out.write_text(text)
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
