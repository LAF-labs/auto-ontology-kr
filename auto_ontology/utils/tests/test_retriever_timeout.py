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
