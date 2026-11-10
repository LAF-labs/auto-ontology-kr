# SPDX-License-Identifier: Apache-2.0

"""Ask the isolated auto-ontology backend (:3101) questions and print SQL + answer.

Usage: python3 dev_tools/kreview_run/ask.py "질문1" "질문2" ...   (stateless; no conversation persisted)
"""

import json
import sys
import time
import urllib.request

URL = "http://127.0.0.1:3101/api/chat/completions"


def ask(question: str) -> dict:
    body = json.dumps({"question": question, "target_db": "renewal_kreview"}).encode()
    req = urllib.request.Request(
        URL, data=body, headers={"content-type": "application/json"}
    )
    out: dict = {"question": question, "sql": None, "answer": None, "error": None}
    start = time.time()
    with urllib.request.urlopen(req, timeout=600) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                payload = json.loads(data)
            except json.JSONDecodeError:
                continue
            kind = payload.get("type") if isinstance(payload, dict) else None
            if kind == "sql":
                out["sql"] = payload.get("sql")
            elif kind == "result":
                ans = payload.get("answer") or {}
                out["sql"] = ans.get("sql_code") or out["sql"]
                out["answer"] = ans.get("response")
                rows = ans.get("sql_response_from_db") or []
                out["rows"] = json.loads(rows[0])[:10] if rows else None
            elif kind == "error" or (
                isinstance(payload, dict) and payload.get("error")
            ):
                out["error"] = payload
    out["seconds"] = round(time.time() - start, 1)
    return out


if __name__ == "__main__":
    for q in sys.argv[1:]:
        try:
            r = ask(q)
        except Exception as exc:  # noqa: BLE001 - report and continue with the next question
            r = {"question": q, "error": repr(exc)}
        print(json.dumps(r, ensure_ascii=False, indent=2), flush=True)
