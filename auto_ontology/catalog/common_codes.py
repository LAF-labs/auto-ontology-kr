# SPDX-License-Identifier: Apache-2.0

"""Decode 공통코드 (shared code table) values into column descriptions.

Korean in-house systems keep the meaning of nearly every code column in one
shared table -- ``TB_COMM_CD(GRP_CD, CD, CD_NM)`` or a variant -- and store only
the code elsewhere: ``TB_STOCK.WH_CD = 'WH02'`` is 부산 물류센터 only by way of
``TB_COMM_CD`` row ``('WH', 'WH02', '부산 물류센터')``. Nothing declares that
link, so a question about 부산 물류센터 has nothing to match and the model
guesses a code.

At ingest (Korean mode only) this module finds such tables, reads their rows,
and for every code-like column whose distinct values all belong to exactly one
group appends the decoding to the column's description::

    창고코드 — 공통코드 WH: WH01=이천 물류센터, WH02=부산 물류센터
    (tb_comm_cd.grp_cd = 'WH')

The ``" — "`` separator is the one descriptions already use for appended
context, so label extraction keeps reading only ``창고코드``.

A column is left alone whenever the group is not certain: values outside every
group, or several groups that fit equally well (``01``/``02`` codes occur in
almost every group). A wrong decoding is worse than none.

Ingest keeps a description that is already stored, so the decoding lands on a
column's first ingest; a catalog ingested earlier needs its data layer reset
to pick it up.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any

import pandas as pd

if TYPE_CHECKING:
    from auto_ontology.connectors.base import SQLDatabase

logger = logging.getLogger(__name__)

SEPARATOR = " — "
MARKER = "공통코드 "


def has_code_annotation(description: str | None) -> bool:
    """Whether *description* carries a decoded 공통코드 note from this module."""
    return SEPARATOR + MARKER in (description or "")


# Column roles of a shared code table, by name or by comment label.
_GROUP_NAMES = re.compile(
    r"^(?:grp_?cd|grp_?code|group_?cd|group_?code|cd_?grp(?:_?id)?|code_?grp|"
    r"code_?group|comm_?grp_?cd|cmm_?grp_?cd|com_?grp_?cd|upr_?cd|"
    r"코드그룹|그룹코드|코드그룹id)$"
)
_CODE_NAMES = re.compile(
    r"^(?:cd|code|comm_?cd|cmm_?cd|com_?cd|dtl_?cd|cd_?val|code_?value|"
    r"코드|상세코드|코드값)$"
)
_NAME_NAMES = re.compile(
    r"^(?:cd_?nm|code_?nm|cd_?name|code_?name|comm_?cd_?nm|cmm_?cd_?nm|"
    r"com_?cd_?nm|dtl_?cd_?nm|코드명|상세코드명|코드이름)$"
)
_LABEL_ALIASES = {
    "코드그룹": "group",
    "그룹코드": "group",
    "코드": "code",
    "코드명": "name",
}

# A column whose name or comment says it holds a code.
_CODE_COLUMN_NAME = re.compile(
    r"(?:_cd|_code|_gb|_gbn|_tp|_type|_stat|_sts|_div|_cls)$"
)
_CODE_COLUMN_LABEL = re.compile(r"(?:코드|구분|유형|상태|종류)")
_TEXT_TYPES = ("char", "text", "string", "varchar")

# More distinct values than this is not a code list.
_MAX_DISTINCT = 50
# Codes shown in a description; the rest are summarized.
_MAX_SHOWN = 20
# Rows read from a code table.
_MAX_CODE_ROWS = 5000
# Name tokens too generic to tie a column to a group.
_GENERIC_TOKENS = {
    "cd",
    "code",
    "gb",
    "gbn",
    "tp",
    "type",
    "stat",
    "sts",
    "div",
    "cls",
    "no",
}


def _label(description: Any) -> str:
    if not isinstance(description, str):
        return ""
    head = description.split(SEPARATOR, 1)[0]
    return re.sub(r"\s+", "", re.sub(r"\([^)]*\)", "", head))


def _role(name: str, description: Any) -> str | None:
    lowered = name.lower()
    if _GROUP_NAMES.fullmatch(lowered):
        return "group"
    if _NAME_NAMES.fullmatch(lowered):
        return "name"
    if _CODE_NAMES.fullmatch(lowered):
        return "code"
    return _LABEL_ALIASES.get(_label(description))


def find_code_tables(columns: pd.DataFrame) -> list[dict[str, str]]:
    """Tables with a group, a code and a code-name column, with those names."""
    found: list[dict[str, str]] = []
    if columns is None or columns.empty:
        return found
    for (schema, table), cols in columns.groupby(
        ["table_schema", "table_name"], observed=True
    ):
        roles: dict[str, str] = {}
        for row in cols.itertuples(index=False):
            role = _role(str(row.column_name), getattr(row, "description", None))
            if role and role not in roles:
                roles[role] = str(row.column_name)
        if {"group", "code", "name"} <= roles.keys():
            found.append({"schema": str(schema), "table": str(table), **roles})
    return found


def _quote(identifier: str, dialect: str) -> str:
    if dialect in ("mysql", "mariadb"):
        return "`" + identifier.replace("`", "``") + "`"
    return '"' + identifier.replace('"', '""') + '"'


def _qualified(schema: str, table: str, dialect: str) -> str:
    return f"{_quote(schema, dialect)}.{_quote(table, dialect)}"


def read_code_groups(
    connector: SQLDatabase, code_tables: list[dict[str, str]]
) -> dict[tuple[str, str], dict[str, str]]:
    """``{(table, group): {code: name}}`` from every code table found."""
    groups: dict[tuple[str, str], dict[str, str]] = {}
    dialect = connector.dialect
    for spec in code_tables:
        sql = (
            f"SELECT {_quote(spec['group'], dialect)} AS g, "
            f"{_quote(spec['code'], dialect)} AS c, "
            f"{_quote(spec['name'], dialect)} AS n "
            f"FROM {_qualified(spec['schema'], spec['table'], dialect)} "
            f"LIMIT {_MAX_CODE_ROWS}"
        )
        try:
            rows = connector.execute(sql)
        except Exception:  # noqa: BLE001 — decoding is best-effort
            logger.warning("공통코드: could not read %s", spec["table"], exc_info=True)
            continue
        for row in rows.itertuples(index=False):
            if row.g is None or row.c is None or row.n is None:
                continue
            groups.setdefault((spec["table"], str(row.g).strip()), {})[
                str(row.c).strip()
            ] = str(row.n).strip()
    return groups


def _tokens(text: str) -> set[str]:
    return {t for t in re.split(r"[\W_]+", text.lower()) if t} - _GENERIC_TOKENS


def choose_group(
    column_name: str,
    values: set[str],
    groups: dict[tuple[str, str], dict[str, str]],
) -> tuple[str, str] | None:
    """The one group that holds every value, or ``None`` when that is unclear."""
    if not values:
        return None
    covering = [key for key, codes in groups.items() if values <= codes.keys()]
    if len(covering) == 1:
        return covering[0]
    if len(covering) > 1:
        wanted = _tokens(column_name)
        named = [key for key in covering if _tokens(key[1]) & wanted]
        if len(named) == 1:
            return named[0]
    return None


def _is_code_column(name: str, data_type: Any, description: Any) -> bool:
    if not any(t in str(data_type or "").lower() for t in _TEXT_TYPES):
        return False
    return bool(
        _CODE_COLUMN_NAME.search(name.lower())
        or _CODE_COLUMN_LABEL.search(_label(description))
    )


def _distinct_values(
    connector: SQLDatabase, schema: str, table: str, column: str
) -> set[str] | None:
    dialect = connector.dialect
    col = _quote(column, dialect)
    sql = (
        f"SELECT DISTINCT {col} AS v FROM {_qualified(schema, table, dialect)} "
        f"WHERE {col} IS NOT NULL LIMIT {_MAX_DISTINCT + 1}"
    )
    try:
        frame = connector.execute(sql)
    except Exception:  # noqa: BLE001 — decoding is best-effort
        logger.debug("공통코드: could not sample %s.%s", table, column, exc_info=True)
        return None
    values = {str(v).strip() for v in frame["v"].tolist() if str(v).strip()}
    return values if 0 < len(values) <= _MAX_DISTINCT else None


def describe(group: tuple[str, str], codes: dict[str, str], group_column: str) -> str:
    """``공통코드 WH: WH01=이천 물류센터, … (tb_comm_cd.grp_cd = 'WH')``."""
    table, name = group
    shown = sorted(codes.items())[:_MAX_SHOWN]
    pairs = ", ".join(f"{code}={label}" for code, label in shown)
    more = f" 외 {len(codes) - len(shown)}개" if len(codes) > len(shown) else ""
    return f"{MARKER}{name}: {pairs}{more} ({table}.{group_column} = '{name}')"


def annotate_common_codes(
    connector: SQLDatabase, columns: pd.DataFrame
) -> pd.DataFrame:
    """*columns* with 공통코드 decodings appended to code columns' descriptions."""
    code_tables = find_code_tables(columns)
    if not code_tables:
        return columns
    groups = read_code_groups(connector, code_tables)
    if not groups:
        return columns
    group_column = {spec["table"]: spec["group"] for spec in code_tables}
    code_table_names = {spec["table"] for spec in code_tables}

    out = columns.copy()
    if "description" not in out.columns:
        out["description"] = pd.NA
    out["description"] = out["description"].astype("object")
    decoded = 0
    for index, row in out.iterrows():
        table, column = str(row["table_name"]), str(row["column_name"])
        description = row["description"] if pd.notna(row["description"]) else None
        if table in code_table_names or SEPARATOR + MARKER in (description or ""):
            continue
        if not _is_code_column(column, row.get("data_type"), description):
            continue
        values = _distinct_values(connector, str(row["table_schema"]), table, column)
        if values is None:
            continue
        group = choose_group(column, values, groups)
        if group is None:
            continue
        note = describe(group, groups[group], group_column[group[0]])
        out.at[index, "description"] = (
            f"{description}{SEPARATOR}{note}" if description else note
        )
        decoded += 1
    if decoded:
        logger.info("공통코드: decoded %d code column(s)", decoded)
    return out


__all__ = [
    "annotate_common_codes",
    "choose_group",
    "describe",
    "find_code_tables",
    "read_code_groups",
]
