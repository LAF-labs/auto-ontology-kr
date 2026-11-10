# SPDX-License-Identifier: Apache-2.0

"""Saved SQL as text: parse, guard, bind placeholders, cap rows, list tables.

**The SQL that runs is the saved text, not sqlglot's regeneration of it.**
sqlglot parses for checking only; placeholders are replaced at their exact
character positions and the row cap is appended or wrapped around the original
text. Regenerating would be simpler, but a round trip through the AST can
change SQL (a postgres ``ORDER BY`` written for mysql gains a ``CASE`` for null
ordering, for one), and a dashboard number must come from the statement a
person verified.

Placeholders are found twice, in the token stream (positions) and in the AST
(meaning), and both must agree, so that ``obj:field`` JSON access or a colon
in an odd place is rejected rather than guessed at.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import sqlglot
from sqlglot import exp
from sqlglot.dialects.dialect import Dialect
from sqlglot.errors import ParseError, TokenError
from sqlglot.tokens import TokenType

from auto_ontology.server.saved_analyses.errors import SavedAnalysisError

#: Node types that make a statement more than a read. Checked over the whole
#: tree, so a data-modifying CTE (`WITH d AS (DELETE …) SELECT …`) is caught too.
_FORBIDDEN_NODE_NAMES = (
    "Insert",
    "Update",
    "Delete",
    "Merge",
    "Create",
    "Drop",
    "Alter",
    "AlterTable",
    "TruncateTable",
    "Command",
    "Set",
    "Copy",
    "Pragma",
    "Transaction",
    "Commit",
    "Rollback",
    "Use",
    "Grant",
    "Revoke",
    "Lock",  # SELECT … FOR UPDATE / FOR SHARE
    "Into",  # SELECT … INTO new_table
    "LoadData",
    "Analyze",
    "Kill",
    "Refresh",
    "Cache",
    "Uncache",
    "Describe",
    "Show",
    "Summarize",
    "Attach",
    "Detach",
    "Export",
    "Install",
    "Parameter",  # $1, @var, @var := …
)
_FORBIDDEN_NODES = tuple(
    getattr(exp, name) for name in _FORBIDDEN_NODE_NAMES if hasattr(exp, name)
)

#: Functions with side effects, file or network access, or that run SQL given
#: as a string. Matched case-insensitively on the bare function name.
FORBIDDEN_FUNCTIONS = frozenset(
    {
        # postgres
        "pg_sleep",
        "pg_sleep_for",
        "pg_sleep_until",
        "pg_terminate_backend",
        "pg_cancel_backend",
        "pg_reload_conf",
        "pg_rotate_logfile",
        "pg_read_file",
        "pg_read_binary_file",
        "pg_ls_dir",
        "pg_stat_file",
        "pg_advisory_lock",
        "pg_advisory_xact_lock",
        "pg_advisory_lock_shared",
        "pg_try_advisory_lock",
        "pg_notify",
        "set_config",
        "nextval",
        "setval",
        "query_to_xml",
        "query_to_xml_and_xmlschema",
        "query_to_xmlschema",
        "cursor_to_xml",
        "table_to_xml",
        "database_to_xml",
        "schema_to_xml",
        "lo_import",
        "lo_export",
        "lo_unlink",
        "lo_create",
        "lo_from_bytea",
        "lo_put",
        "dblink",
        "dblink_exec",
        "dblink_connect",
        # mysql / mariadb
        "sleep",
        "benchmark",
        "load_file",
        "get_lock",
        "release_lock",
        "release_all_locks",
        "sys_exec",
        "sys_eval",
        # duckdb / sqlite / generic file readers
        "read_csv",
        "read_csv_auto",
        "read_parquet",
        "parquet_scan",
        "read_json",
        "read_json_auto",
        "read_json_objects",
        "read_ndjson",
        "read_text",
        "read_blob",
        "glob",
        "sniff_csv",
        "load_extension",
        "readfile",
        "writefile",
        "url",
        "s3",
        "file",
        "input",
    }
)
_FORBIDDEN_FUNCTION_PREFIXES = ("dblink", "lo_", "pg_read", "pg_ls_", "pg_file")

_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
#: Tokens after which an adjacent ``:x`` is a JSON path or cast, not a placeholder.
_VALUE_END_TOKENS = {
    TokenType.VAR,
    TokenType.IDENTIFIER,
    TokenType.NUMBER,
    TokenType.STRING,
    TokenType.R_PAREN,
    TokenType.R_BRACKET,
    TokenType.R_BRACE,
}


@dataclass(frozen=True)
class PlaceholderSpan:
    name: str
    start: int  # index of ':'
    end: int  # index one past the name


@dataclass(frozen=True)
class TableRef:
    catalog: str
    schema: str
    name: str


def _forbidden(message: str, **details: object) -> SavedAnalysisError:
    return SavedAnalysisError("forbidden_statement", message, details=details or None)


def parse_single(sql: str, dialect: str) -> exp.Expression:
    """Parse *sql* as exactly one statement, or raise ``parse_error``/``forbidden_statement``."""
    if not sql or not sql.strip():
        raise SavedAnalysisError("parse_error", "SQL is empty")
    try:
        statements = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except (ParseError, TokenError) as exc:
        raise SavedAnalysisError(
            "parse_error", f"SQL could not be parsed: {exc}"
        ) from None
    if len(statements) != 1:
        raise _forbidden(
            f"Exactly one statement is allowed; found {len(statements)}",
            statements=len(statements),
        )
    return statements[0]


def _function_name(node: exp.Func) -> str:
    if isinstance(node, exp.Anonymous):
        return str(node.name or "").lower()
    return node.sql_name().lower()


def check_read_only(tree: exp.Expression) -> None:
    """Raise ``forbidden_statement`` unless *tree* is a single side-effect-free query."""
    top = tree
    while isinstance(top, (exp.Subquery, exp.Paren)):
        top = top.this
    if not isinstance(top, (exp.Select, exp.SetOperation)):
        raise _forbidden(
            f"Only SELECT queries are allowed; got {type(top).__name__.upper()}",
            statement=type(top).__name__,
        )
    for node in tree.walk():
        if isinstance(node, _FORBIDDEN_NODES):
            raise _forbidden(
                f"{type(node).__name__.upper()} is not allowed in a saved analysis",
                node=type(node).__name__,
            )
        if isinstance(node, exp.Func):
            name = _function_name(node)
            if name in FORBIDDEN_FUNCTIONS or name.startswith(
                _FORBIDDEN_FUNCTION_PREFIXES
            ):
                raise _forbidden(f"Function {name}() is not allowed", function=name)
        if isinstance(node, exp.Table) and isinstance(node.this, exp.Identifier):
            # DuckDB reads `FROM '/path/file.csv'` as a file scan.
            if (
                any(ch in node.name for ch in "/\\")
                or node.this.quoted
                and "." in node.name
            ):
                raise _forbidden(f"Table {node.name!r} looks like a file path")


def placeholders(sql: str, dialect: str, tree: exp.Expression) -> list[PlaceholderSpan]:
    """Every ``:name`` placeholder in *sql*, by position.

    Raises ``unsupported_placeholder`` for anonymous placeholders (``?``,
    ``%s``) and whenever the tokens and the AST disagree about which colons are
    placeholders.
    """
    try:
        tokens = Dialect.get_or_raise(dialect).tokenize(sql)
    except TokenError as exc:
        raise SavedAnalysisError(
            "parse_error", f"SQL could not be tokenised: {exc}"
        ) from None

    spans: list[PlaceholderSpan] = []
    for index, token in enumerate(tokens):
        if token.token_type != TokenType.COLON or index + 1 >= len(tokens):
            continue
        following = tokens[index + 1]
        if following.start != token.end + 1 or not _NAME_RE.match(following.text):
            continue
        if index > 0:
            previous = tokens[index - 1]
            if (
                previous.end + 1 == token.start
                and previous.token_type in _VALUE_END_TOKENS
            ):
                continue  # obj:field, arr[1]:x
        spans.append(PlaceholderSpan(following.text, token.start, following.end + 1))

    ast_names: list[str] = []
    for node in tree.find_all(exp.Placeholder):
        if not node.name or node.name == "?":
            raise SavedAnalysisError(
                "unsupported_placeholder",
                "Anonymous placeholders (?, %s) are not supported; use :name",
            )
        ast_names.append(node.name)

    if sorted(ast_names) != sorted(s.name for s in spans):
        raise SavedAnalysisError(
            "unsupported_placeholder",
            "Could not locate every :name placeholder unambiguously. Write "
            "placeholders as ` = :name` with a space or operator before the "
            "colon, and avoid `:` JSON path syntax in saved analyses.",
            details={"ast": sorted(ast_names), "tokens": sorted(s.name for s in spans)},
        )
    return spans


def check_list_placements(tree: exp.Expression, list_params: set[str]) -> None:
    """A ``list<…>`` parameter may only be the sole member of an ``IN (…)``."""
    if not list_params:
        return
    for node in tree.find_all(exp.Placeholder):
        if node.name not in list_params:
            continue
        parent = node.parent
        if not (
            isinstance(parent, exp.In)
            and node.arg_key == "expressions"
            and len(parent.expressions) == 1
        ):
            raise SavedAnalysisError(
                "invalid_definition",
                f"List parameter :{node.name} must be used as `column IN (:{node.name})`",
            )


def bind(sql: str, spans: list[PlaceholderSpan], literals: dict[str, str]) -> str:
    """Replace each placeholder span with its literal, right to left."""
    out = sql
    for span in sorted(spans, key=lambda s: s.start, reverse=True):
        out = out[: span.start] + literals[span.name] + out[span.end :]
    return out


def _strip_trailing(sql: str, dialect: str) -> str:
    """*sql* without trailing semicolons and comments, so text can follow it."""
    tokens = [t for t in Dialect.get_or_raise(dialect).tokenize(sql)]
    while tokens and tokens[-1].token_type == TokenType.SEMICOLON:
        tokens.pop()
    if not tokens:
        return sql
    return sql[: tokens[-1].end + 1]


def apply_row_limit(sql: str, dialect: str, tree: exp.Expression, limit: int) -> str:
    """Cap *sql* at *limit* rows without rewriting it.

    No top-level ``LIMIT``/``OFFSET``/``FETCH``: ``LIMIT n`` is appended on a new
    line, keeping any ``ORDER BY``. Otherwise the original is wrapped in
    ``SELECT * FROM (…) AS _saved_analysis_rows LIMIT n``.
    """
    body = _strip_trailing(sql, dialect)
    top = tree
    has_own_limit = any(top.args.get(key) for key in ("limit", "offset", "fetch"))
    if not has_own_limit and isinstance(top, (exp.Select, exp.SetOperation)):
        return f"{body}\nLIMIT {int(limit)}"
    return f"SELECT * FROM (\n{body}\n) AS _saved_analysis_rows\nLIMIT {int(limit)}"


def referenced_tables(tree: exp.Expression) -> list[TableRef]:
    """Base tables *tree* reads, CTE names and table functions excluded."""
    cte_names = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}
    seen: dict[tuple[str, str, str], TableRef] = {}
    for table in tree.find_all(exp.Table):
        if not isinstance(table.this, exp.Identifier):
            continue  # generate_series(...), unnest(...)
        name, schema, catalog = table.name, table.db or "", table.catalog or ""
        if not schema and not catalog and name.lower() in cte_names:
            continue
        key = (catalog, schema, name)
        seen.setdefault(key, TableRef(catalog, schema, name))
    return sorted(seen.values(), key=lambda t: (t.catalog, t.schema, t.name))


def output_names(tree: exp.Expression) -> list[str]:
    """Column names a query declares, when knowable without running it."""
    top = tree
    while isinstance(top, (exp.Subquery, exp.Paren)):
        top = top.this
    if isinstance(top, exp.SetOperation):
        top = top.left
        while isinstance(top, (exp.Subquery, exp.Paren, exp.SetOperation)):
            top = top.this if not isinstance(top, exp.SetOperation) else top.left
    if isinstance(top, exp.Select):
        return list(top.named_selects)
    return []
