#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Run the Korean evaluation once per chat model, sequentially, with everything
# else held fixed (fixture, ingest, embeddings, effort). For each model:
# smoke-test -> compile -> restart FastAPI -> ask 30 questions -> score.
# Results land in build/runs/<model-slug>/ with the OpenRouter spend per step.
#
# Usage (from the repo root, after `pipeline.py ingest` and `run_eval.py gold`):
#   dev_tools/korean_eval/bakeoff.sh upstage/solar-pro4 qwen/qwen3.8-flash ...
#
# The model ids override REASONING_MODEL / NON_REASONING_MODEL from .env for the
# child processes only; .env is not modified.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVAL="$ROOT/dev_tools/korean_eval"
BUILD="$EVAL/build"
cd "$ROOT"

total() {
	uv run --no-sync python "$EVAL/pipeline.py" spend 2>/dev/null |
		sed -n 's/.*key total \$\([0-9.]*\).*/\1/p'
}

stop_server() {
	local pids
	pids=$(lsof -ti tcp:3001 -sTCP:LISTEN 2>/dev/null || true)
	[ -n "$pids" ] && kill $pids 2>/dev/null
	for _ in $(seq 1 30); do
		lsof -ti tcp:3001 -sTCP:LISTEN >/dev/null 2>&1 || return 0
		sleep 1
	done
}

start_server() {
	nohup uv run --no-sync python -m auto_ontology.server >"$1" 2>&1 &
	for _ in $(seq 1 90); do
		curl -sf -o /dev/null http://localhost:3001/api/health && return 0
		sleep 1
	done
	echo "server did not come up; see $1"
	return 1
}

for model in "$@"; do
	slug="${model//\//__}"
	out="$BUILD/runs/$slug"
	mkdir -p "$out"
	export REASONING_MODEL="$model" NON_REASONING_MODEL="$model"
	echo "=== $model ($(date +%H:%M:%S))"

	t0=$(total)
	if ! uv run --no-sync python "$EVAL/check_llm.py" >"$out/check.log" 2>&1; then
		echo "    smoke test failed, skipping: $(grep FAIL "$out/check.log" | head -1)"
		continue
	fi

	t1=$(total)
	uv run --no-sync python "$EVAL/pipeline.py" compile --log INFO >"$out/compile.log" 2>&1
	grep -h 'compiled\|Korean term quality' "$out/compile.log" | sed 's/^/    /'
	t2=$(total)

	stop_server
	start_server "$out/server.log" || continue
	rm -f "$BUILD/answers.json"
	python3 -I "$EVAL/run_eval.py" ask --target-db korean_smb >"$out/ask.log" 2>&1
	t3=$(total)

	python3 -I "$EVAL/run_eval.py" score >"$out/score.log" 2>&1
	python3 -I "$EVAL/run_eval.py" terms >"$out/terms.log" 2>&1
	for f in answers.json results.json report.md terms.md; do
		[ -f "$BUILD/$f" ] && mv "$BUILD/$f" "$out/$f"
	done
	python3 -I - "$out" "$t0" "$t1" "$t2" "$t3" "$model" <<'PY'
import json, sys
out, t0, t1, t2, t3, model = sys.argv[1:]
f = lambda a, b: round(float(b) - float(a), 4) if a and b else None
spend = {"smoke": f(t0, t1), "compile": f(t1, t2), "ask": f(t2, t3)}
json.dump({"model": model, "spend_usd": spend}, open(f"{out}/spend.json", "w"), indent=2)
print("    spend", spend)
PY
	grep -h 'Execution accuracy' "$out/report.md" 2>/dev/null | sed 's/^/    /'
done
echo "=== done ($(date +%H:%M:%S))"
