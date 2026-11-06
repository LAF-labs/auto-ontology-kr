# SPDX-License-Identifier: Apache-2.0

"""Language the ontology is written in and questions are answered in.

``AUTO_ONTOLOGY_LANGUAGE`` selects it. Unset or ``en`` keeps the upstream
behaviour exactly; ``ko`` turns on Korean term names, Korean-aware search and
Korean answers. Callers branch on :func:`ontology_language` or
:func:`is_korean` and must leave the ``en`` path unchanged.
"""

from __future__ import annotations

import os

DEFAULT_LANGUAGE = "en"
SUPPORTED_LANGUAGES = ("en", "ko")


def ontology_language() -> str:
    """Configured language code, falling back to ``en`` for unknown values."""
    value = os.environ.get("AUTO_ONTOLOGY_LANGUAGE", "").strip().lower()
    return value if value in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE


def is_korean() -> bool:
    """Whether the Korean code paths are active."""
    return ontology_language() == "ko"
