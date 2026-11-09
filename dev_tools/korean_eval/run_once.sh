#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# One evaluation pass with the chat model in .env: ingest, compile, restart
# FastAPI, ask (optionally only some questions), score. Output and the
# OpenRouter spend per step go to build/runs/<label>/.
#
# Usage (repo root):
#   dev_tools/korean_eval/run_once.sh <label> [question ids...]
#   dev_tools/korean_eval/run_once.sh hard q31 q32 q33

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVAL="$ROOT/dev_tools/korean_eval"
BUILD="$EVAL/build"
LABEL="${1:?label}"
shift
OUT="$BUILD/runs/$LABEL"
mkdir -p "$OUT"
cd "$ROOT"

total() {
	uv run --no-sync python "$EVAL/pipeline.py" spend 2>/dev/null |
		sed -n 's/.*key total \$\([0-9.]*\).*/\1/p'
}

t0=$(total)
uv run --no-sync python "$EVAL/pipeline.py" ingest --reset --log INFO >"$OUT/ingest.log" 2>&1
grep -h 'Data ingestion finished' "$OUT/ingest.log" | sed 's/^.*INFO/   /'
uv run --no-sync python "$EVAL/pipeline.py" compile --log INFO >"$OUT/compile.log" 2>&1
grep -h 'compiled\|Korean term quality' "$OUT/compile.log" | sed 's/^.*INFO/   /'
t1=$(total)

pids=$(lsof -ti tcp:3001 -sTCP:LISTEN 2>/dev/null || true)
[ -n "$pids" ] && kill $pids && sleep 2
nohup uv run --no-sync python -m auto_ontology.server >"$OUT/server.log" 2>&1 &
for _ in $(seq 1 90); do
	curl -sf -o /dev/null http://localhost:3001/api/health && break
	sleep 1
done

rm -f "$BUILD/answers.json"
if [ "$#" -gt 0 ]; then
	python3 -I "$EVAL/run_eval.py" ask --target-db korean_smb --only "$@" >"$OUT/ask.log" 2>&1
else
	python3 -I "$EVAL/run_eval.py" ask --target-db korean_smb >"$OUT/ask.log" 2>&1
fi
t2=$(total)
python3 -I "$EVAL/run_eval.py" score >"$OUT/score.log" 2>&1
python3 -I "$EVAL/run_eval.py" terms >"$OUT/terms.log" 2>&1
for f in answers.json results.json report.md terms.md; do
	[ -f "$BUILD/$f" ] && mv "$BUILD/$f" "$OUT/$f"
done
lsof -ti tcp:3001 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
echo "   spend: ingest+compile \$$(python3 -c "print(round($t1-$t0,4))") ask \$$(python3 -c "print(round($t2-$t1,4))")"
grep -h 'Execution accuracy\|tables got' "$OUT/report.md" "$OUT/terms.md" 2>/dev/null | sed 's/^/   /'
