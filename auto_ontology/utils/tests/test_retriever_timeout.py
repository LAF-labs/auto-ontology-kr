# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
# All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""The search-time query-embedding timeout setting."""

import pytest

from auto_ontology.utils import retriever


def test_query_timeout_defaults_to_sixty_seconds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("EMBED_QUERY_TIMEOUT_S", raising=False)

    assert retriever._query_timeout_s() == 60.0


def test_query_timeout_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EMBED_QUERY_TIMEOUT_S", "8")

    assert retriever._query_timeout_s() == 8.0


@pytest.mark.parametrize("value", ["soon", "0", "-3"])
def test_bad_query_timeout_keeps_the_default(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("EMBED_QUERY_TIMEOUT_S", value)

    assert retriever._query_timeout_s() == 60.0


def test_query_passes_the_timeout_to_the_embed_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, object] = {}

    def fake_embed_texts(texts, params, input_type, *, timeout, retries):  # noqa: ANN001, ANN202
        seen.update(timeout=timeout, retries=retries)
        return [[0.0]]

    class _Vdb:
        def retrieval(self, vectors, top_k, where):  # noqa: ANN001, ANN202
            return [[]]

    monkeypatch.setenv("EMBED_QUERY_TIMEOUT_S", "9")
    monkeypatch.setattr(retriever, "embed_texts", fake_embed_texts)

    assert retriever.Retriever(_Vdb(), object()).query("q") == []
    assert seen == {"timeout": 9.0, "retries": 0}


class _CountingEmbed:
    def __init__(self, fail_first: int = 0) -> None:
        self.calls: list[str] = []
        self.fail_first = fail_first

    def __call__(self, texts, params, input_type, *, timeout, retries):  # noqa: ANN001, ANN204
        self.calls.append(texts[0])
        if len(self.calls) <= self.fail_first:
            raise TimeoutError("stalled")
        return [[float(len(texts[0]))]]


class _RecordingVdb:
    def __init__(self) -> None:
        self.vectors: list[list[float]] = []

    def retrieval(self, vectors, top_k, where):  # noqa: ANN001, ANN202
        self.vectors.extend(vectors)
        return [[]]


def _params(model: str = "m") -> object:
    from auto_ontology.utils.embedding import EmbedParams

    return EmbedParams(model, "http://unused")


def test_the_same_query_text_is_embedded_once(monkeypatch: pytest.MonkeyPatch) -> None:
    embed = _CountingEmbed()
    monkeypatch.setattr(retriever, "embed_texts", embed)
    vdb = _RecordingVdb()
    search = retriever.Retriever(vdb, _params())

    search.query("매출")
    search.query(" 매출 ", top_k=3, vdb_kwargs={"where": {"label": "Table"}})
    search.query("주문")

    assert embed.calls == ["매출", "주문"]
    assert vdb.vectors == [[2.0], [2.0], [2.0]]


def test_another_embedding_setup_does_not_reuse_vectors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    embed = _CountingEmbed()
    monkeypatch.setattr(retriever, "embed_texts", embed)

    retriever.Retriever(_RecordingVdb(), _params("a")).query("q")
    retriever.Retriever(_RecordingVdb(), _params("b")).query("q")

    assert embed.calls == ["q", "q"]


def test_a_failed_embedding_is_not_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    embed = _CountingEmbed(fail_first=1)
    monkeypatch.setattr(retriever, "embed_texts", embed)
    search = retriever.Retriever(_RecordingVdb(), _params())

    with pytest.raises(TimeoutError):
        search.query("q")
    search.query("q")

    assert embed.calls == ["q", "q"]


def test_cache_size_zero_turns_reuse_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EMBED_QUERY_CACHE_SIZE", "0")
    embed = _CountingEmbed()
    monkeypatch.setattr(retriever, "embed_texts", embed)
    search = retriever.Retriever(_RecordingVdb(), _params())

    search.query("q")
    search.query("q")

    assert embed.calls == ["q", "q"]


def test_concurrent_searches_share_one_request(monkeypatch: pytest.MonkeyPatch) -> None:
    import threading
    from concurrent.futures import ThreadPoolExecutor

    release = threading.Event()
    calls: list[str] = []

    def slow_embed(texts, params, input_type, *, timeout, retries):  # noqa: ANN001, ANN202
        calls.append(texts[0])
        release.wait(5)
        return [[1.0]]

    monkeypatch.setattr(retriever, "embed_texts", slow_embed)
    search = retriever.Retriever(_RecordingVdb(), _params())

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(search.query, "q") for _ in range(4)]
        threading.Timer(0.2, release.set).start()
        results = [f.result(timeout=10) for f in futures]

    assert calls == ["q"]
    assert results == [[], [], [], []]
