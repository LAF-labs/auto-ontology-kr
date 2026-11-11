# SPDX-FileCopyrightText: Copyright (c) 2024-2026, NVIDIA CORPORATION & AFFILIATES.
# All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for the prewarmed chat worker's request loop."""

from typing import Any

from pytest import MonkeyPatch

from auto_ontology.server.chat import worker as worker_module


class _FakeQueue:
    """Queue stub: yields queued messages, then ends the loop like a closed pipe."""

    def __init__(self, items: list[Any] | None = None) -> None:
        self._items = list(items or [])
        self.puts: list[Any] = []

    def get(self) -> Any:
        if self._items:
            return self._items.pop(0)
        # The real loop returns when the pipe closes; this ends the test cleanly.
        raise EOFError

    def put(self, item: Any) -> None:
        self.puts.append(item)


def _run_loop(
    monkeypatch: MonkeyPatch,
    connector_batches: list[list[str]],
    *,
    evidence: str | None = None,
) -> dict:
    """Drive one ASK through ``_worker_loop`` and return the agent payload it built.

    ``connector_batches`` is what successive ``get_connectors()`` calls return, so a
    worker that booted before the store was reachable can be simulated with ``[[], [...]]``.
    """
    # Importing the agent module builds LLM clients at import time and lets an
    # EnvironmentError escape when no key is configured. Stub the factories before that
    # import is triggered below; the clients are never used, since stream_agent_response
    # is replaced too. (Patching the env instead is not enough — model config resolution
    # is cached, so an earlier import in the same session wins.)
    monkeypatch.setattr(
        "auto_ontology.utils.llm_invoke.get_llm_client", lambda *a, **k: None
    )
    monkeypatch.setattr(
        "auto_ontology.utils.llm_invoke.get_non_reasoning_llm_client",
        lambda *a, **k: None,
    )

    remaining = list(connector_batches)

    def fake_get_connectors() -> list[str]:
        return remaining.pop(0) if remaining else []

    captured: dict = {}

    def fake_stream(payload: dict) -> Any:
        captured.update(payload)
        return iter(())

    monkeypatch.setattr("auto_ontology.connectors.get_connectors", fake_get_connectors)
    monkeypatch.setattr(
        "auto_ontology.utils.get_data_objects_retriever", lambda: "data"
    )
    monkeypatch.setattr(
        "auto_ontology.utils.get_semantic_objects_retriever", lambda: "semantic"
    )
    monkeypatch.setattr(
        "auto_ontology.server.chat.settings_dal.fetch_acronyms", lambda: []
    )
    monkeypatch.setattr(
        "auto_ontology.server.chat.settings_dal.fetch_custom_prompts", lambda: ""
    )
    monkeypatch.setattr(
        "auto_ontology.retrieval.text_to_sql.main.stream_agent_response", fake_stream
    )

    in_q = _FakeQueue([(worker_module._MSG_ASK, ("q", None, None, None, [], evidence))])
    worker_module._worker_loop(in_q, _FakeQueue())
    return captured


def test_worker_reresolves_connectors_before_building_the_payload(
    monkeypatch: MonkeyPatch,
) -> None:
    """A worker that booted with no connections must heal on the next question.

    Regression: the payload was built from a reference captured *before* the lazy
    re-resolve, so rebinding the local did not reach it and every question kept
    failing with "missing required 'connectors'" until the pod restarted.
    """
    payload = _run_loop(monkeypatch, connector_batches=[[], ["healed-connector"]])

    assert payload["connectors"] == ["healed-connector"]


def test_worker_reuses_the_boot_connectors_when_they_are_present(
    monkeypatch: MonkeyPatch,
) -> None:
    """The healthy path must not re-resolve — that would query the store per question."""
    payload = _run_loop(monkeypatch, connector_batches=[["boot-connector"]])

    assert payload["connectors"] == ["boot-connector"]
    assert payload["question"] == "q"
    assert payload["evidence"] == ""


def test_worker_forwards_evidence_without_changing_question(
    monkeypatch: MonkeyPatch,
) -> None:
    payload = _run_loop(
        monkeypatch,
        connector_batches=[["boot-connector"]],
        evidence="status means accounts.status",
    )

    assert payload["question"] == "q"
    assert payload["processing_question"] == "q"
    assert payload["evidence"] == "status means accounts.status"


class _FakeWorker:
    """Stands in for ``PrewarmedWorker``: no subprocess, records kills."""

    def __init__(self) -> None:
        self.alive = True

    def is_alive(self) -> bool:
        return self.alive

    def drain_until_ready(self, timeout: float | None = None) -> bool:
        return True

    def kill(self) -> None:
        self.alive = False


def _pool(monkeypatch: Any, size: int | None) -> worker_module.WarmPool:
    """A pool whose spawns are synchronous and build ``_FakeWorker``s."""
    monkeypatch.setattr(worker_module, "PrewarmedWorker", _FakeWorker)
    monkeypatch.setattr(
        worker_module.WarmPool, "_spawn_async", worker_module.WarmPool._spawn_sync
    )
    return worker_module.WarmPool(size)


def test_pool_keeps_one_standby_by_default(monkeypatch: Any) -> None:
    monkeypatch.delenv("CHAT_WARM_WORKERS", raising=False)
    pool = _pool(monkeypatch, None)

    first, second = pool.acquire(), pool.acquire()
    pool.return_alive(first)
    pool.return_alive(second)

    assert first.is_alive()
    assert not second.is_alive()  # no room for a second spare


def test_pool_size_comes_from_the_environment(monkeypatch: Any) -> None:
    monkeypatch.setenv("CHAT_WARM_WORKERS", "3")
    pool = _pool(monkeypatch, None)

    warm = list(pool._standbys)
    acquired = [pool.acquire() for _ in range(3)]

    assert len(warm) == 3
    assert {id(w) for w in acquired} == {id(w) for w in warm}  # none cold-started
    for worker in acquired:
        pool.return_alive(worker)
    assert all(worker.is_alive() for worker in acquired)


def test_pool_skips_a_dead_standby_and_refresh_replaces_all(monkeypatch: Any) -> None:
    pool = _pool(monkeypatch, 2)
    dead, live = pool._standbys
    dead.kill()

    assert pool.acquire() is live

    pool.return_alive(live)
    pool.refresh()

    assert not live.is_alive()
    assert len(pool._standbys) == 2
    assert all(worker.is_alive() for worker in pool._standbys)


def test_bad_pool_size_falls_back_to_one(monkeypatch: Any) -> None:
    monkeypatch.setenv("CHAT_WARM_WORKERS", "many")

    assert worker_module._warm_pool_size() == 1
