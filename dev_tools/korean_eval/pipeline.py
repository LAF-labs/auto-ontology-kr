# SPDX-License-Identifier: Apache-2.0

"""Headless ingest / compile for the Korean evaluation, with OpenRouter spend.

Runs the same functions the ingestion service runs, in-process, against the
first entry of ``CONNECTION_STRINGS`` and the store in ``POSTGRES_*`` (both
from ``.env``)::

    uv run --no-sync python dev_tools/korean_eval/pipeline.py ingest
    uv run --no-sync python dev_tools/korean_eval/pipeline.py compile
    uv run --no-sync python dev_tools/korean_eval/pipeline.py spend

``ingest`` writes the catalog and its embeddings once; it does not depend on the
chat model. ``compile`` drops the semantic layer and rebuilds it with the chat
model configured now, so each model under test gets its own compile.

Every command prints how much the OpenRouter key spent while it ran, read from
OpenRouter's ``/api/v1/key`` before and after. Concurrent use of the same key
elsewhere would be counted too.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.request

from auto_ontology.env import load_env

load_env()


def openrouter_usage() -> float | None:
    """Credits the configured OpenRouter key has used so far, in USD."""
    key = os.environ.get("REASONING_API_KEY", "")
    if not key.startswith("sk-or-"):
        return None
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/key", headers={"Authorization": f"Bearer {key}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return float(json.load(response)["data"]["usage"])
    except Exception:  # noqa: BLE001 — spend is informational
        return None


def _database_name() -> tuple[str, str]:
    from auto_ontology.connectors.registry import create_connector

    first = os.environ.get("CONNECTION_STRINGS", "").split(",")[0].strip()
    if not first:
        sys.exit("CONNECTION_STRINGS is empty")
    connector = create_connector(first)
    name = connector.database_name
    connector.close()
    return first, name


def cmd_ingest(reset: bool) -> None:
    from auto_ontology.connectors.registry import create_connector
    from auto_ontology.ingestion_service.ingest import run_ingest

    url, name = _database_name()
    if reset:
        # Ingest never overwrites a stored description, so a catalog ingested
        # before a description change (comments, 공통코드 decoding) keeps the
        # old text until it is cleared.
        from auto_ontology.dal.reset import delete_all_data

        print(f"reset: {delete_all_data(name)}", flush=True)
    connector = create_connector(url)
    try:
        run_ingest(connector)
    finally:
        connector.close()


def cmd_compile() -> None:
    from auto_ontology.dal.reset import delete_semantic_layer
    from auto_ontology.semantic.compile import run_semantic_compilation
    from auto_ontology.utils import llm_invoke

    _, name = _database_name()
    print(
        f"compiling {name} with {llm_invoke._MODEL_NAME} "
        f"(non-reasoning {llm_invoke._NON_REASONING_MODEL_NAME}, "
        f"effort {llm_invoke._reasoning_effort()})",
        flush=True,
    )
    deleted = delete_semantic_layer(name)
    print(f"deleted previous semantic layer: {deleted}", flush=True)
    tables = run_semantic_compilation(name)
    print(f"compiled {tables} table(s)", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Korean eval: headless pipeline")
    parser.add_argument("cmd", choices=("ingest", "compile", "spend"))
    parser.add_argument("--log", default="WARNING")
    parser.add_argument(
        "--reset", action="store_true", help="ingest: drop the database's catalog first"
    )
    args = parser.parse_args()
    logging.basicConfig(
        level=args.log.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    before = openrouter_usage()
    started = time.monotonic()
    if args.cmd == "ingest":
        cmd_ingest(args.reset)
    elif args.cmd == "compile":
        cmd_compile()
    after = openrouter_usage()
    spent = (
        f"${after - before:.4f}" if before is not None and after is not None else "?"
    )
    total = f"${after:.4f}" if after is not None else "?"
    print(
        f"{args.cmd}: {time.monotonic() - started:.0f}s, "
        f"OpenRouter spend {spent} (key total {total})"
    )


if __name__ == "__main__":
    main()
