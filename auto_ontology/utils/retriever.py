# SPDX-FileCopyrightText: Copyright (c) 2024-2026, NVIDIA CORPORATION & AFFILIATES.
# All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Vector search over a pgvector collection, and the app's two singletons."""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import Future
from typing import Any

from auto_ontology.utils.embedding import EmbedParams, embed_texts, get_embed_params
from auto_ontology.vdb import get_data_vdb, get_semantic_vdb
from auto_ontology.vdb.postgres import PostgresVDB

logger = logging.getLogger(__name__)

# A search embeds one short string, so it should answer in seconds; the
# ingest-sized default would let one stalled request hold a question for ten
# minutes before ``_query_with_retry`` ever got to see the failure. That loop
# is the only retry on this path -- the client's own are off -- so a dead
# endpoint costs three 60s attempts, not three times six.
_DEFAULT_QUERY_TIMEOUT_S = 60.0


def _query_timeout_s() -> float:
    """Seconds one query embedding may take: ``EMBED_QUERY_TIMEOUT_S``, default 60.

    A healthy endpoint answers a query in about a second, so on a hosted
    endpoint a much lower value (8-10) turns the occasional stalled request
    into a quick retry instead of a minute added to the question.
    """
    raw = os.environ.get("EMBED_QUERY_TIMEOUT_S", "").strip()
    if not raw:
        return _DEFAULT_QUERY_TIMEOUT_S
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if value <= 0:
        logger.warning(
            "EMBED_QUERY_TIMEOUT_S=%r is not a positive number; using %.0fs",
            raw,
            _DEFAULT_QUERY_TIMEOUT_S,
        )
        return _DEFAULT_QUERY_TIMEOUT_S
    return value


_DEFAULT_QUERY_CACHE_SIZE = 256


def _query_cache_size() -> int:
    """Query vectors kept for reuse: ``EMBED_QUERY_CACHE_SIZE``, default 256.

    0 turns reuse off. A vector of 2048 floats is about 65 KB as a Python list,
    so the default holds roughly 16 MB per process.
    """
    raw = os.environ.get("EMBED_QUERY_CACHE_SIZE", "").strip()
    if not raw:
        return _DEFAULT_QUERY_CACHE_SIZE
    try:
        value = int(raw)
    except ValueError:
        value = -1
    if value < 0:
        logger.warning(
            "EMBED_QUERY_CACHE_SIZE=%r is not a non-negative integer; using %d",
            raw,
            _DEFAULT_QUERY_CACHE_SIZE,
        )
        return _DEFAULT_QUERY_CACHE_SIZE
    return value


class _QueryVectorCache:
    """Search-time query vectors, reused by exact text and embedding setup.

    One question embeds the same short strings several times: each extracted
    entity is searched once per label (ColumnAttribute, CustomAnalysis, ...),
    again to rank hub siblings and again to find extra tables, and those
    searches run in parallel. A request already in flight for a key is shared
    with the threads that ask for it meanwhile, so the endpoint sees one call
    per distinct string. Failures are not kept: the next caller tries again.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._done: OrderedDict[tuple, list[float] | None] = OrderedDict()
        self._inflight: dict[tuple, Future] = {}

    def get(
        self, key: tuple, compute: Callable[[], list[float] | None]
    ) -> list[float] | None:
        size = _query_cache_size()
        if size == 0:
            return compute()
        with self._lock:
            if key in self._done:
                self._done.move_to_end(key)
                return self._done[key]
            future = self._inflight.get(key)
            owner = future is None
            if owner:
                future = Future()
                self._inflight[key] = future
        if not owner:
            return future.result()
        try:
            vector = compute()
        except BaseException as exc:
            with self._lock:
                self._inflight.pop(key, None)
            future.set_exception(exc)
            raise
        with self._lock:
            self._inflight.pop(key, None)
            self._done[key] = vector
            while len(self._done) > size:
                self._done.popitem(last=False)
        future.set_result(vector)
        return vector

    def clear(self) -> None:
        with self._lock:
            self._done.clear()


_query_vectors = _QueryVectorCache()


class Retriever:
    """Embed a query and run a k-NN search against one :class:`PostgresVDB`.

    ``vdb_kwargs["vdb"]`` is part of the interface, not an implementation
    detail: :func:`~auto_ontology.retrieval.data_access.semantic_search.search_semantic_index`
    reads the store's ``metadata_filter_format`` off it to decide how to build
    the ``where`` filter.
    """

    def __init__(self, vdb: PostgresVDB, embed_params: EmbedParams) -> None:
        self.vdb_kwargs: dict[str, Any] = {"vdb": vdb}
        self.embed_params = embed_params

    @property
    def vdb(self) -> PostgresVDB:
        return self.vdb_kwargs["vdb"]

    def _embed_query(self, text: str) -> list[float] | None:
        started = time.perf_counter()
        vector = embed_texts(
            [text],
            self.embed_params,
            "query",
            timeout=_query_timeout_s(),
            retries=0,
        )[0]
        logger.info("Query embedding took %.2fs", time.perf_counter() - started)
        return vector

    def query(
        self,
        text: str,
        top_k: int = 10,
        vdb_kwargs: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """The *top_k* nearest rows to *text*, best first.

        Each hit is ``{"text", "metadata", "_distance"}``, with ``metadata``
        the row's full stored metadata. ``vdb_kwargs["where"]``, when given,
        is the store's metadata filter. Raises when the query cannot be
        embedded, with the endpoint's HTTP status in the message, so callers
        can tell a transient failure from an empty result.
        """
        params = self.embed_params
        key = (
            getattr(params, "model_name", None),
            getattr(params, "embed_invoke_url", None),
            getattr(params, "dimensions", None),
            text.strip() if isinstance(text, str) else text,
        )
        vector = _query_vectors.get(
            key,
            lambda: self._embed_query(text),
        )
        if vector is None:
            raise ValueError("Cannot search for a blank query.")
        where = (vdb_kwargs or {}).get("where")
        hits = self.vdb.retrieval([vector], top_k=top_k, where=where)[0]
        return [
            {
                "text": (hit.get("text") or "").strip(),
                "metadata": hit.get("metadata") or {},
                "_distance": float(hit.get("_distance", 0.0)),
            }
            for hit in hits[:top_k]
        ]


_data_retriever: Retriever | None = None
_semantic_retriever: Retriever | None = None


def get_data_objects_retriever() -> Retriever:
    """Singleton retriever for the tabular / data-layer collection."""
    global _data_retriever
    if _data_retriever is None:
        _data_retriever = Retriever(get_data_vdb(), get_embed_params())
    return _data_retriever


def get_semantic_objects_retriever() -> Retriever:
    """Singleton retriever for the semantic-layer (taxonomies) collection."""
    global _semantic_retriever
    if _semantic_retriever is None:
        _semantic_retriever = Retriever(get_semantic_vdb(), get_embed_params())
    return _semantic_retriever


def _close_retriever_vdb(retriever: Retriever | None) -> None:
    if retriever is None:
        return
    try:
        retriever.vdb.close()
    except Exception:
        logger.exception("Failed to close PostgresVDB on retriever cleanup")


def close_retrievers() -> None:
    """Dispose singleton retriever VDB pools so CLI/debug processes can exit.

    ``PGEngine`` keeps a background asyncio loop and ThreadPoolExecutor workers,
    so a process that never disposes them exits later than it should. Calling
    this explicitly is the tidy path; ``PostgresVDB.close`` bounds the wait and
    skips it outright once the loop thread is gone, so neither route can wedge
    at shutdown the way it once did.
    """
    global _data_retriever, _semantic_retriever
    _close_retriever_vdb(_data_retriever)
    _close_retriever_vdb(_semantic_retriever)
    _data_retriever = None
    _semantic_retriever = None
