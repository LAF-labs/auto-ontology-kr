# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
# All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from collections.abc import Iterator

import pytest

from auto_ontology.utils import retriever


@pytest.fixture(autouse=True)
def _fresh_query_vectors() -> Iterator[None]:
    """Query vectors one test embeds must not answer another test's search."""
    retriever._query_vectors.clear()
    yield
    retriever._query_vectors.clear()
