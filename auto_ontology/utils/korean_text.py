# SPDX-License-Identifier: Apache-2.0

"""Lightweight Korean word handling for lexical matching.

Korean attaches particles and endings to the word they follow, so the question
"매출액은 얼마인가요" never contains the glossary word "매출액" as a separate
token. Matching code that splits on spaces or ``[a-z0-9]+`` therefore needs
the bare word back.

This is a rule-based particle stripper, not a morphological analyser: it
removes one known particle or copula ending from the end of a Hangul-final
token, once, longest suffix first. Two guards keep it from eating nouns that
merely end in a particle-like syllable:

* A purely Hangul stem must keep at least two syllables, so ``단가``, ``국가``,
  ``길이`` and ``회의`` are left alone. A few one-syllable nouns (``수``,
  ``값``) are the exception.
* ``도`` and ``만`` are not stripped on their own: ``만족도``, ``빈도`` and
  ``100만`` are far more common in data questions than the particles.

Stripping can still over-reach (``판매가`` -> ``판매``). Callers that need the
original word as well use :func:`token_variants`.
"""

from __future__ import annotations

import re

#: Hangul syllables as a character-class fragment.
HANGUL = "가-힣"

_HANGUL_RE = re.compile(f"[{HANGUL}]")
_WORD_RE = re.compile(f"[a-z0-9{HANGUL}]+")

#: Particles, plural/per suffixes and copula endings, stripped once from the
#: end of a token. Order does not matter; the longest match wins.
_SUFFIXES: tuple[str, ...] = (
    # copula / interrogative endings on a noun ("얼마인가요", "무엇입니까")
    "이었나요",
    "였나요",
    "인가요",
    "입니까",
    "이에요",
    "예요",
    "일까요",
    "인지",
    # compound particles
    "에서부터",
    "으로부터",
    "로부터",
    "에게서",
    "에서는",
    "에서도",
    "에서의",
    "으로는",
    "으로도",
    "으로서",
    "으로써",
    "이라는",
    "라는",
    "이란",
    "에서",
    "에게",
    "한테",
    "까지",
    "부터",
    "마다",
    "처럼",
    "보다",
    "이나",
    "에는",
    "에도",
    "에의",
    "으로",
    "와의",
    "과의",
    # "per" and plural, alone and with a particle ("고객별로", "고객들의")
    "별로",
    "별로는",
    "별은",
    "별의",
    "별",
    "들의",
    "들은",
    "들이",
    "들을",
    "들도",
    "들에",
    "들과",
    "들로",
    "들",
    # single-syllable particles
    "의",
    "은",
    "는",
    "이",
    "가",
    "을",
    "를",
    "에",
    "와",
    "과",
    "로",
)

_SUFFIXES_LONGEST_FIRST: tuple[str, ...] = tuple(
    sorted(set(_SUFFIXES), key=len, reverse=True)
)

#: Regex alternation of every suffix, longest first, for "word followed by an
#: optional particle" patterns.
PARTICLE_PATTERN = "|".join(re.escape(s) for s in _SUFFIXES_LONGEST_FIRST)


def contains_hangul(text: str) -> bool:
    """Whether *text* has at least one Hangul syllable."""
    return bool(_HANGUL_RE.search(text))


#: One-syllable nouns common in data questions ("고객 수를", "값이"). Only
#: these may lose a particle down to a single syllable.
_SHORT_NOUNS = frozenset({"수", "값", "날", "달", "건", "명"})


def _stem_is_long_enough(stem: str) -> bool:
    if not stem:
        return False
    if all(_HANGUL_RE.fullmatch(ch) for ch in stem):
        return len(stem) >= 2 or stem in _SHORT_NOUNS
    # A Latin or digit stem ("roas" in "ROAS가", "2024년" in "2024년에")
    # cannot be confused with a Hangul noun, so any length is fine.
    return stem[-1].isalnum()


def strip_particle(token: str) -> str:
    """*token* without one trailing Korean particle or ending, if it has one.

    Tokens that do not end in a Hangul syllable come back unchanged, so this is
    safe to apply to every token of a mixed-script query.
    """
    if not token or not _HANGUL_RE.fullmatch(token[-1]):
        return token
    for suffix in _SUFFIXES_LONGEST_FIRST:
        if token.endswith(suffix):
            stem = token[: -len(suffix)]
            if _stem_is_long_enough(stem):
                return stem
    return token


def word_tokens(text: str) -> list[str]:
    """Lowercased ``[a-z0-9]`` and Hangul runs of *text*, particles left on."""
    return _WORD_RE.findall(text.lower())


def stemmed_word_tokens(text: str) -> list[str]:
    """:func:`word_tokens` with one particle stripped from each token."""
    return [strip_particle(token) for token in word_tokens(text)]


def token_variants(token: str) -> tuple[str, ...]:
    """*token* and, when it differs, its particle-stripped stem."""
    stem = strip_particle(token)
    return (token,) if stem == token else (token, stem)


__all__ = [
    "HANGUL",
    "PARTICLE_PATTERN",
    "contains_hangul",
    "stemmed_word_tokens",
    "strip_particle",
    "token_variants",
    "word_tokens",
]
