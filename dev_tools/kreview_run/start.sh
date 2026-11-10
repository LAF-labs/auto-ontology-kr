#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Isolated auto-ontology instance for renewal_kreview (PII-masked prod copy).
#   MariaDB : docker ao-kreview-maria  (127.0.0.1:53307, db renewal_kreview, read-only user ao_reader)
#   Store   : docker ko-ci-store       (localhost:55433, db kreview_store)
#   Ports   : backend 3101, ingestion 3102  (the 3001/3002 instance is separate)
# Credentials and logs live outside the repo in $KREVIEW_HOME (default ~/Documents/ontology/kreview-run):
#   $KREVIEW_HOME/secrets/kreview.env exports CONNECTION_STRINGS, POSTGRES_DATABASE,
#   INGESTION_PORT=3102 and INGESTION_SERVICE_URL=http://localhost:3102.
# Usage: start.sh           -> start services; ingest/compile resume on their schedule
#        start.sh --reset   -> also wipe the semantic layer and recompile from scratch
#                              (then re-apply semantic_fk_fixes.sql)
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
KREVIEW_HOME="${KREVIEW_HOME:-$HOME/Documents/ontology/kreview-run}"
source "$KREVIEW_HOME/secrets/kreview.env"
LOG="$KREVIEW_HOME/run/logs"; mkdir -p "$LOG"
cd "$REPO"
docker start ao-kreview-maria >/dev/null
nohup uv run --no-sync python -m auto_ontology.ingestion_service > "$LOG/ingestion.log" 2>&1 &
nohup uv run --no-sync uvicorn auto_ontology.server.__main__:create_app --factory --host 127.0.0.1 --port 3101 > "$LOG/backend.log" 2>&1 &
until curl -s localhost:3102/semantic/status >/dev/null; do sleep 1; done
[ "$1" = "--reset" ] && curl -s -X POST 'localhost:3102/semantic/reset?database_name=renewal_kreview' && echo
echo "up. status: curl -s localhost:3101/api/semantic-compilation/status   logs: $LOG"
