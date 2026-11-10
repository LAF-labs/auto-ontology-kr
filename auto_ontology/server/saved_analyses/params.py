# SPDX-License-Identifier: Apache-2.0

"""Named parameters: definitions, value validation, and SQL literals.

A saved SQL refers to parameters as ``:name``. Each one is defined once on the
version::

    {"name": "start_date", "type": "date", "required": true,
     "default": "month_start(-1)"}

Types: ``date | datetime | int | number | string | bool | enum``, and
``list<T>`` for any of those, used only as ``col IN (:name)``.

Values are validated here and rendered as literals of the target dialect by
sqlglot. They never reach the SQL as caller-supplied text.
"""

from __future__ import annotations

import calendar
import datetime as dt
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlglot import exp

from auto_ontology.server.saved_analyses import config
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
SCALAR_TYPES = ("date", "datetime", "int", "number", "string", "bool", "enum")
_LIST_RE = re.compile(r"^list<(\w+)>$")
_RELATIVE_RE = re.compile(
    r"^(today|week_start|month_start|quarter_start|year_start)"
    r"(?:\(\s*([+-]?\d{1,4})\s*\))?$"
)
MAX_STRING_LENGTH = 1000
MAX_LIST_ITEMS = 1000
#: Integers beyond this cannot round-trip through a JavaScript number.
JS_SAFE_INTEGER = 2**53 - 1

_DEFINITION_KEYS = {
    "name",
    "type",
    "required",
    "default",
    "values",
    "min",
    "max",
    "label",
    "description",
}


def split_type(type_: str) -> tuple[str, bool]:
    """``"list<int>"`` -> ``("int", True)``; ``"date"`` -> ``("date", False)``."""
    match = _LIST_RE.match(type_)
    if match:
        return match.group(1), True
    return type_, False


# ---------------------------------------------------------------------------
# Relative dates
# ---------------------------------------------------------------------------


def _add_months(day: dt.date, months: int) -> dt.date:
    index = day.year * 12 + (day.month - 1) + months
    year, month = divmod(index, 12)
    last = calendar.monthrange(year, month + 1)[1]
    return dt.date(year, month + 1, min(day.day, last))


def resolve_relative_date(text: str, today: dt.date | None = None) -> dt.date | None:
    """Resolve ``today(-7)``, ``month_start(-1)``… or return None if not one.

    The offset counts the function's own unit: days for ``today``, weeks for
    ``week_start`` (weeks start on Monday), months, quarters, years. ``today``
    is the date in :func:`config.timezone`.
    """
    match = _RELATIVE_RE.match(text.strip())
    if not match:
        return None
    fn, offset_text = match.group(1), match.group(2)
    offset = int(offset_text) if offset_text else 0
    if today is None:
        today = dt.datetime.now(config.timezone()).date()
    if fn == "today":
        return today + dt.timedelta(days=offset)
    if fn == "week_start":
        monday = today - dt.timedelta(days=today.weekday())
        return monday + dt.timedelta(weeks=offset)
    if fn == "month_start":
        return _add_months(today.replace(day=1), offset)
    if fn == "quarter_start":
        first = today.replace(month=(today.month - 1) // 3 * 3 + 1, day=1)
        return _add_months(first, 3 * offset)
    return dt.date(today.year + offset, 1, 1)


# ---------------------------------------------------------------------------
# Scalar coercion: one value of one scalar type -> its canonical Python form
# ---------------------------------------------------------------------------


class _Invalid(ValueError):
    pass


def _coerce_scalar(type_: str, value: Any, definition: dict[str, Any]) -> Any:
    if value is None:
        raise _Invalid("must not be null")
    if type_ == "date":
        if isinstance(value, dt.datetime):
            raise _Invalid("expects a date (YYYY-MM-DD), got a datetime")
        if isinstance(value, dt.date):
            return value
        if not isinstance(value, str):
            raise _Invalid("expects a date string (YYYY-MM-DD or month_start(-1)…)")
        relative = resolve_relative_date(value)
        if relative is not None:
            return relative
        try:
            return dt.date.fromisoformat(value.strip())
        except ValueError:
            raise _Invalid(f"{value!r} is not a date (YYYY-MM-DD)") from None
    if type_ == "datetime":
        if isinstance(value, dt.datetime):
            parsed = value
        elif isinstance(value, str):
            relative = resolve_relative_date(value)
            if relative is not None:
                return dt.datetime.combine(relative, dt.time())
            try:
                parsed = dt.datetime.fromisoformat(value.strip())
            except ValueError:
                raise _Invalid(f"{value!r} is not an ISO 8601 datetime") from None
        else:
            raise _Invalid("expects an ISO 8601 datetime string")
        if parsed.tzinfo is not None:
            # Stored timestamps are compared as wall-clock time in the
            # configured zone; an offset on the input is honoured by converting.
            parsed = parsed.astimezone(config.timezone()).replace(tzinfo=None)
        return parsed
    if type_ == "int":
        if isinstance(value, bool):
            raise _Invalid("expects an integer, got a boolean")
        if isinstance(value, int):
            result = value
        elif isinstance(value, float) and value.is_integer():
            result = int(value)
        elif isinstance(value, str) and re.fullmatch(r"\s*[+-]?\d+\s*", value):
            result = int(value)
        else:
            raise _Invalid(f"{value!r} is not an integer")
        if abs(result) > JS_SAFE_INTEGER:
            raise _Invalid("is outside the safe integer range")
        return result
    if type_ == "number":
        if isinstance(value, bool):
            raise _Invalid("expects a number, got a boolean")
        try:
            result = Decimal(str(value).strip())
        except (InvalidOperation, ValueError):
            raise _Invalid(f"{value!r} is not a number") from None
        if not result.is_finite():
            raise _Invalid("must be finite")
        return result
    if type_ in ("string", "enum"):
        if not isinstance(value, str):
            raise _Invalid("expects a string")
        if len(value) > MAX_STRING_LENGTH:
            raise _Invalid(f"is longer than {MAX_STRING_LENGTH} characters")
        if "\x00" in value:
            raise _Invalid("must not contain NUL characters")
        if type_ == "enum" and value not in (definition.get("values") or []):
            raise _Invalid(f"{value!r} is not one of {definition.get('values')}")
        return value
    if type_ == "bool":
        if isinstance(value, bool):
            return value
        raise _Invalid("expects true or false")
    raise _Invalid(f"unknown type {type_!r}")


def _check_bounds(type_: str, value: Any, definition: dict[str, Any]) -> None:
    if type_ not in ("date", "datetime", "int", "number"):
        return
    for key, ok in (("min", lambda v, b: v >= b), ("max", lambda v, b: v <= b)):
        bound = definition.get(key)
        if bound is None:
            continue
        bound_value = _coerce_scalar(type_, bound, definition)
        if not ok(value, bound_value):
            raise _Invalid(f"must be {'>=' if key == 'min' else '<='} {bound}")


def coerce(definition: dict[str, Any], value: Any) -> Any:
    """Validate *value* for *definition* and return its canonical Python form."""
    scalar, is_list = split_type(definition["type"])
    if not is_list:
        result = _coerce_scalar(scalar, value, definition)
        _check_bounds(scalar, result, definition)
        return result
    if not isinstance(value, list):
        raise _Invalid("expects a list")
    if not value:
        raise _Invalid("must not be an empty list")
    if len(value) > MAX_LIST_ITEMS:
        raise _Invalid(f"has more than {MAX_LIST_ITEMS} items")
    items = []
    for item in value:
        coerced = _coerce_scalar(scalar, item, definition)
        _check_bounds(scalar, coerced, definition)
        items.append(coerced)
    return items


# ---------------------------------------------------------------------------
# Definitions
# ---------------------------------------------------------------------------


def validate_definitions(definitions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Check a version's parameter definitions and return them normalised.

    Raises ``invalid_definition``. A parameter needs a default or
    ``required: true``: an optional parameter with no value would leave a
    placeholder in the SQL with nothing to bind.
    """
    seen: set[str] = set()
    normalised: list[dict[str, Any]] = []
    for index, raw in enumerate(definitions):
        where = f"params[{index}]"
        if not isinstance(raw, dict):
            raise SavedAnalysisError("invalid_definition", f"{where} must be an object")
        unknown = set(raw) - _DEFINITION_KEYS
        if unknown:
            raise SavedAnalysisError(
                "invalid_definition", f"{where} has unknown keys {sorted(unknown)}"
            )
        name = raw.get("name")
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise SavedAnalysisError(
                "invalid_definition",
                f"{where}.name must match {NAME_RE.pattern}",
            )
        if name in seen:
            raise SavedAnalysisError(
                "invalid_definition", f"parameter {name!r} is defined twice"
            )
        seen.add(name)
        type_ = raw.get("type")
        scalar, _ = split_type(type_) if isinstance(type_, str) else (None, False)
        if scalar not in SCALAR_TYPES:
            raise SavedAnalysisError(
                "invalid_definition",
                f"{name}: type must be one of {list(SCALAR_TYPES)} or list<…>",
            )
        definition = {
            "name": name,
            "type": type_,
            "required": bool(raw.get("required", False)),
            "default": raw.get("default"),
        }
        for key in ("label", "description"):
            if raw.get(key) is not None:
                definition[key] = str(raw[key])
        if scalar == "enum":
            values = raw.get("values")
            if (
                not isinstance(values, list)
                or not values
                or not all(isinstance(v, str) for v in values)
            ):
                raise SavedAnalysisError(
                    "invalid_definition",
                    f"{name}: enum needs a non-empty list of string values",
                )
            definition["values"] = list(values)
        elif raw.get("values") is not None:
            raise SavedAnalysisError(
                "invalid_definition", f"{name}: values is only for enum"
            )
        for key in ("min", "max"):
            if raw.get(key) is None:
                continue
            if scalar not in ("date", "datetime", "int", "number"):
                raise SavedAnalysisError(
                    "invalid_definition",
                    f"{name}: {key} is only for date, datetime, int, number",
                )
            try:
                _coerce_scalar(scalar, raw[key], definition)
            except _Invalid as exc:
                raise SavedAnalysisError(
                    "invalid_definition", f"{name}.{key} {exc}"
                ) from None
            definition[key] = raw[key]
        if definition["default"] is None and not definition["required"]:
            raise SavedAnalysisError(
                "invalid_definition", f"{name}: give a default or set required: true"
            )
        if definition["default"] is not None:
            try:
                coerce(definition, definition["default"])
            except _Invalid as exc:
                raise SavedAnalysisError(
                    "invalid_definition", f"{name}.default {exc}"
                ) from None
        normalised.append(definition)
    return normalised


def resolve_values(
    definitions: list[dict[str, Any]], supplied: dict[str, Any] | None
) -> dict[str, Any]:
    """Apply defaults to *supplied* and validate every value.

    Returns ``{name: canonical value}`` for every defined parameter. Raises
    ``invalid_params`` naming each bad parameter.
    """
    supplied = dict(supplied or {})
    by_name = {d["name"]: d for d in definitions}
    problems: dict[str, str] = {}
    for name in supplied:
        if name not in by_name:
            problems[name] = "is not a parameter of this analysis"
    resolved: dict[str, Any] = {}
    for name, definition in by_name.items():
        if name in supplied and supplied[name] is not None:
            value = supplied[name]
        elif definition.get("default") is not None:
            value = definition["default"]
        else:
            problems[name] = "is required"
            continue
        try:
            resolved[name] = coerce(definition, value)
        except _Invalid as exc:
            problems[name] = str(exc)
    if problems:
        message = "; ".join(f"{k} {v}" for k, v in sorted(problems.items()))
        raise SavedAnalysisError(
            "invalid_params",
            f"Invalid parameters: {message}",
            details={"params": problems},
        )
    return resolved


# ---------------------------------------------------------------------------
# JSON form (for echoing back and for the cache key) and SQL literals
# ---------------------------------------------------------------------------


def _scalar_json(value: Any) -> Any:
    if isinstance(value, dt.datetime):
        return value.isoformat(
            timespec="seconds" if not value.microsecond else "microseconds"
        )
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value.normalize(), "f") if value != 0 else "0"
    return value


def to_json(values: dict[str, Any]) -> dict[str, Any]:
    """Canonical JSON-safe form of resolved values."""
    return {
        name: [_scalar_json(v) for v in value]
        if isinstance(value, list)
        else _scalar_json(value)
        for name, value in values.items()
    }


def _scalar_literal(scalar: str, value: Any, dialect: str) -> str:
    if scalar == "date":
        node = exp.cast(
            exp.Literal.string(value.isoformat()), exp.DataType.build("date")
        )
        return node.sql(dialect=dialect)
    if scalar == "datetime":
        text = value.isoformat(
            sep=" ", timespec="seconds" if not value.microsecond else "microseconds"
        )
        node = exp.cast(exp.Literal.string(text), exp.DataType.build("timestamp"))
        return node.sql(dialect=dialect)
    if scalar in ("int", "number"):
        text = str(value) if scalar == "int" else _scalar_json(value)
        # Parenthesised when negative: `a - :n` with n = -5 must not become
        # `a - -5`, which every dialect reads as `a` followed by a comment.
        return f"({text})" if text.startswith("-") else text
    if scalar in ("string", "enum"):
        return exp.Literal.string(value).sql(dialect=dialect)
    if scalar == "bool":
        return exp.Boolean(this=bool(value)).sql(dialect=dialect)
    raise ValueError(f"unknown type {scalar!r}")


def to_sql_literal(definition: dict[str, Any], value: Any, dialect: str) -> str:
    """The SQL text that replaces ``:name``. Lists render as ``a, b, c``."""
    scalar, is_list = split_type(definition["type"])
    if is_list:
        return ", ".join(_scalar_literal(scalar, v, dialect) for v in value)
    return _scalar_literal(scalar, value, dialect)
