# SPDX-License-Identifier: Apache-2.0

"""Korean-mode evaluation runner (standard library only).

Steps, each resumable and writing into ``build/``::

    python3 -I dev_tools/korean_eval/run_eval.py gold    # gold answers from the fixture
    python3 -I dev_tools/korean_eval/run_eval.py ask     # ask the running app
    python3 -I dev_tools/korean_eval/run_eval.py score   # run predicted SQL, compare, report
    python3 -I dev_tools/korean_eval/run_eval.py terms   # check generated Korean Term names

``ask`` and ``terms`` talk to the app. With ``AUTO_ONTOLOGY_API_TOKEN`` (user
menu → API Tokens) they go through the web app on ``http://localhost:3000``;
without one, straight to FastAPI on ``http://localhost:3001``.
``AUTO_ONTOLOGY_URL`` overrides either.

SQL runs through ``psql --csv`` inside the fixture container by default
(``--psql`` overrides the command). Predicted SQL runs in a read-only
transaction with a statement timeout.

Scoring is execution-based and tolerant of presentation: a prediction is
correct when it returns the same number of rows and every gold column has a
distinct predicted column holding the same values (as a multiset, or as a
sequence for questions whose order matters). Extra columns, column order and
column names do not matter. Numbers of 1,000 or more compare as whole
numbers, smaller ones after rounding to 2 decimals.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import io
import json
import os
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from collections import Counter
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
DEFAULT_PSQL = "docker exec -i ko-eval-pg psql -U postgres -d korean_smb"
READ_ONLY_PREFIX = (
    "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;\n"
    "SET statement_timeout = '30s';\n"
)


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


QUESTIONS: list[dict] = _load("questions").QUESTIONS


# ---------------------------------------------------------------------------
# SQL execution
# ---------------------------------------------------------------------------


def run_sql(
    sql: str, psql: str, *, read_only: bool
) -> tuple[list[list[str | None]] | None, str]:
    """Rows (header dropped) or ``None`` plus the error text."""
    body = sql.strip().rstrip(";") + ";\n"
    if read_only:
        body = READ_ONLY_PREFIX + body
    cmd = [*shlex.split(psql), "--csv", "-q", "-v", "ON_ERROR_STOP=1"]
    try:
        proc = subprocess.run(
            cmd, input=body, capture_output=True, text=True, timeout=60
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    if proc.returncode != 0:
        return None, proc.stderr.strip()
    reader = list(csv.reader(io.StringIO(proc.stdout)))
    rows = [[cell if cell != "" else None for cell in row] for row in reader[1:]]
    return rows, ""


def _norm(cell: str | None) -> str | None:
    if cell is None:
        return None
    text = cell.strip()
    try:
        number = Decimal(text)
    except InvalidOperation:
        return text
    if not number.is_finite():
        return text
    # Large values (amounts, averages of amounts) compare as whole numbers so
    # "46333333" and "46333333.333" agree; small ones (rates, days) keep two
    # decimals.
    step = Decimal("1") if abs(number) >= 1000 else Decimal("0.01")
    rounded = number.quantize(step, rounding=ROUND_HALF_UP)
    return format(rounded.normalize(), "f")


def results_match(
    gold: list[list],
    pred: list[list],
    *,
    order_matters: bool,
    match_columns: list[int] | None = None,
) -> bool:
    if len(gold) != len(pred):
        return False
    if not gold:
        return True
    wanted = match_columns if match_columns is not None else range(len(gold[0]))
    gold_cols = [[_norm(r[i]) for r in gold] for i in wanted]
    pred_cols = [
        [_norm(r[i]) for r in pred] for i in range(len(pred[0]) if pred else 0)
    ]

    def same(a: list, b: list) -> bool:
        return a == b if order_matters else Counter(a) == Counter(b)

    used: set[int] = set()
    for gcol in gold_cols:
        hit = next(
            (
                j
                for j, pcol in enumerate(pred_cols)
                if j not in used and same(gcol, pcol)
            ),
            None,
        )
        if hit is None:
            return False
        used.add(hit)
    return True


# ---------------------------------------------------------------------------
# App API
# ---------------------------------------------------------------------------


def _api(path: str, *, body: dict | None = None, stream: bool = False):
    """Call the app. With ``AUTO_ONTOLOGY_API_TOKEN`` through the web app (3000),
    without it straight to FastAPI (3001), which serves stateless chat without
    a user."""
    token = os.environ.get("AUTO_ONTOLOGY_API_TOKEN")
    default = "http://localhost:3000" if token else "http://localhost:3001"
    base = os.environ.get("AUTO_ONTOLOGY_URL", default).rstrip("/")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["x-api-key"] = token
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        base + path,
        data=data,
        method="POST" if data else "GET",
        headers=headers,
    )
    response = urllib.request.urlopen(request, timeout=600)
    if stream:
        return response
    return json.load(response)


def ask_one(question: str, target_db: str | None) -> dict:
    """Run one question through ``/api/chat/completions`` and return the answer."""
    body: dict = {"question": question}
    if target_db:
        body["target_db"] = target_db
    result: dict = {
        "sql_code": None,
        "response": None,
        "error": None,
        "streamed_sql": None,
    }
    try:
        with _api("/api/chat/completions", body=body, stream=True) as response:
            for raw in response:
                line = raw.decode("utf-8").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[len("data:") :].strip()
                if payload == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                kind = event.get("type")
                if kind == "sql":
                    result["streamed_sql"] = event.get("sql")
                elif kind == "result":
                    answer = event.get("answer") or {}
                    result["sql_code"] = answer.get("sql_code")
                    result["response"] = answer.get("response")
                    break
                elif kind == "error":
                    result["error"] = event.get("message")
                    break
    except urllib.error.HTTPError as exc:
        result["error"] = (
            f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:500]}"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        result["error"] = str(exc)
    if not result["sql_code"]:
        result["sql_code"] = result["streamed_sql"]
    return result


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def _read(name: str) -> dict:
    path = BUILD / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _write(name: str, data: dict) -> None:
    BUILD.mkdir(exist_ok=True)
    (BUILD / name).write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def cmd_gold(args: argparse.Namespace) -> None:
    gold = {}
    failed = 0
    for q in QUESTIONS:
        rows, err = run_sql(q["gold_sql"], args.psql, read_only=True)
        if rows is None:
            failed += 1
            print(f"{q['id']} ERROR {err}")
            continue
        gold[q["id"]] = rows
        preview = rows[:3]
        print(f"{q['id']} {len(rows)} row(s) {preview}{' …' if len(rows) > 3 else ''}")
    _write("gold.json", gold)
    if failed:
        sys.exit(f"{failed} gold query(ies) failed")


def cmd_ask(args: argparse.Namespace) -> None:
    answers = {} if args.force else _read("answers.json")
    for q in QUESTIONS:
        if args.only and q["id"] not in args.only:
            continue
        if q["id"] in answers and not answers[q["id"]].get("error"):
            continue
        print(f"{q['id']} {q['question']}", flush=True)
        answers[q["id"]] = ask_one(q["question"], args.target_db)
        status = answers[q["id"]]["error"] or (answers[q["id"]]["sql_code"] or "")[:120]
        print(f"    → {status}", flush=True)
        _write("answers.json", answers)


def cmd_score(args: argparse.Namespace) -> None:
    gold = _read("gold.json")
    answers = _read("answers.json")
    if not gold:
        sys.exit("run `gold` first")
    results = []
    for q in QUESTIONS:
        answer = answers.get(q["id"])
        entry = {
            "id": q["id"],
            "question": q["question"],
            "tags": q["tags"],
            "correct": False,
        }
        if not answer:
            entry["reason"] = "not asked"
        elif not answer.get("sql_code"):
            entry["reason"] = f"no SQL ({answer.get('error') or 'no answer'})"
        else:
            rows, err = run_sql(answer["sql_code"], args.psql, read_only=True)
            if rows is None:
                entry["reason"] = f"SQL error: {err[:200]}"
            elif results_match(
                gold[q["id"]],
                rows,
                order_matters=q.get("order_matters", False),
                match_columns=q.get("match_columns"),
            ):
                entry["correct"] = True
            else:
                entry["reason"] = f"wrong result: {rows[:3]}"
            entry["sql"] = answer["sql_code"]
            entry["response"] = answer.get("response")
        results.append(entry)

    asked = [r for r in results if r.get("reason") != "not asked"]
    correct = sum(r["correct"] for r in asked)
    by_tag: dict[str, list[int]] = {}
    for r in asked:
        for tag in r["tags"]:
            hit = by_tag.setdefault(tag, [0, 0])
            hit[0] += r["correct"]
            hit[1] += 1

    lines = [
        "# Korean-mode evaluation",
        "",
        f"**Execution accuracy: {correct}/{len(asked)}**"
        + (f" ({correct / len(asked):.0%})" if asked else ""),
        "",
        "| Tag | Correct |",
        "|---|---|",
        *(f"| `{tag}` | {c}/{n} |" for tag, (c, n) in sorted(by_tag.items())),
        "",
        "| ID | Result | Question | Reason |",
        "|---|---|---|---|",
    ]
    for r in results:
        mark = "✅" if r["correct"] else "❌"
        reason = (r.get("reason") or "").replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {r['id']} | {mark} | {r['question']} | {reason} |")
    report = "\n".join(lines) + "\n"
    BUILD.mkdir(exist_ok=True)
    (BUILD / "report.md").write_text(report, encoding="utf-8")
    _write("results.json", {"results": results})
    print(report)


def cmd_terms(args: argparse.Namespace) -> None:
    expectations = _load("expectations").TERM_NAMES
    page = _api("/api/terms")
    terms = page.get("terms") or page.get("data") or []
    names = [str(t.get("name") or "") for t in terms]
    synonyms = {str(t.get("name") or ""): t.get("synonyms") or [] for t in terms}

    def squash(text: str) -> str:
        return "".join(text.split()).casefold()

    hits = 0
    lines = [
        "# Term names",
        "",
        "| Table | Expected (any) | Found | OK |",
        "|---|---|---|---|",
    ]
    for table, accepted in expectations.items():
        wanted = {squash(a) for a in accepted}
        found = [
            n
            for n in names
            if any(w in squash(n) for w in wanted)
            or any(squash(s) == squash(table) for s in synonyms.get(n, []))
        ]
        ok = any(any(w in squash(n) for w in wanted) for n in found)
        hits += ok
        lines.append(
            f"| `{table}` | {', '.join(accepted)} | {', '.join(found) or '—'} | {'✅' if ok else '❌'} |"
        )
    empty = [n for n in names if not n.strip()]
    lines += [
        "",
        f"**{hits}/{len(expectations)} tables got an accepted Korean Term name.**",
        f"Empty Term names: {len(empty)}. All Term names: {', '.join(sorted(names))}",
    ]
    report = "\n".join(lines) + "\n"
    BUILD.mkdir(exist_ok=True)
    (BUILD / "terms.md").write_text(report, encoding="utf-8")
    print(report)


def main() -> None:
    parser = argparse.ArgumentParser(description="Korean-mode evaluation runner")
    parser.add_argument(
        "--psql", default=os.environ.get("KOREAN_EVAL_PSQL", DEFAULT_PSQL)
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("gold").set_defaults(func=cmd_gold)
    ask = sub.add_parser("ask")
    ask.add_argument("--target-db", default="korean_smb")
    ask.add_argument("--only", nargs="*")
    ask.add_argument("--force", action="store_true", help="re-ask every question")
    ask.set_defaults(func=cmd_ask)
    sub.add_parser("score").set_defaults(func=cmd_score)
    sub.add_parser("terms").set_defaults(func=cmd_terms)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
