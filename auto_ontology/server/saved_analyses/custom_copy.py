# SPDX-License-Identifier: Apache-2.0

"""The searchable copy of a saved analysis in Custom Analyses.

Question answering (NL-to-SQL few-shot, answerability candidates) reads Custom
Analyses, not saved analyses. So the latest verified version of each saved
analysis is mirrored there as one Custom Analysis, and its id is recorded on
that version (``saved_analysis_version.custom_analysis_id``).

The saved analysis stays the original. The copy is disposable: a semantic
reset deletes it, a person may edit or delete it on the Custom Analyses page,
and :func:`sync` puts it back to match the original. A copy is recognised as
ours by the first line of its SQL, ``-- saved-analysis <id> v<version>``, so a
copy whose id was lost (a failed write between the two stores) is adopted
rather than duplicated.

The copied SQL has the version's parameter defaults bound in (relative dates
resolved on the day of the sync), so the example runs as written; the comment
line names the values. A version with a required parameter that has no
default keeps its ``:placeholders``.

A failed sync never fails the request that triggered it (verify, retire): the
result says what went wrong, and the copy is retried by the next sync.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from auto_ontology.dal.saved_analyses import store
from auto_ontology.server.saved_analyses import params, service
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
from auto_ontology.server.sql_utils import SqlParseError

logger = logging.getLogger(__name__)

STATUS_REGISTERED = "registered"
STATUS_STALE = "stale"
STATUS_MISSING = "missing"
STATUS_NONE = "none"


def _marker_prefix(analysis_id: str) -> str:
    return f"-- saved-analysis {analysis_id} "


def _ca_dal() -> Any:
    from auto_ontology.dal import custom_analyses

    return custom_analyses


def _ca_service() -> Any:
    from auto_ontology.server.custom_analyses import service as ca_service

    return ca_service


def copy_content(
    analysis: dict[str, Any], version_row: dict[str, Any]
) -> tuple[str, str, str]:
    """``(name, description, sql)`` the copy of *version_row* should have."""
    header = f"{_marker_prefix(analysis['id'])}v{version_row['version']}"
    sql = version_row["sql"].strip()
    try:
        connector = service.get_connector(analysis["database_name"])
        values = params.resolve_values(version_row["params"], {})
        bound, _ = service.prepare_sql(
            version_row["sql"], connector.dialect, version_row["params"], values, 1
        )
        sql = bound.strip()
        shown = ", ".join(
            f"{name}={json.dumps(value, ensure_ascii=False)}"
            for name, value in params.to_json(values).items()
        )
        if shown:
            header += f"; parameters bound to their defaults: {shown}"
    except SavedAnalysisError:
        header += "; parameters left as :placeholders"
    return analysis["name"], (analysis["description"] or "").strip(), f"{header}\n{sql}"


def _exists(custom_analysis_id: str) -> bool:
    return _ca_dal().get_custom_analysis_by_id(custom_analysis_id) is not None


def copy_state(analysis_id: str, latest_verified_version: int | None) -> dict[str, Any]:
    """Where the copy stands, for the detail response.

    ``registered``: the copy exists and is of the latest verified version.
    ``stale``: it exists but is of an older version (a sync failed or is due).
    ``missing``: its id is recorded but the row is gone (semantic reset, or
    deleted by hand). ``none``: no copy recorded.
    """
    links = store.custom_analysis_links(analysis_id)
    if not links:
        return {"id": None, "version": None, "status": STATUS_NONE}
    link = links[-1]
    if not _exists(link["custom_analysis_id"]):
        status = STATUS_MISSING
    elif link["version"] == latest_verified_version:
        status = STATUS_REGISTERED
    else:
        status = STATUS_STALE
    return {
        "id": link["custom_analysis_id"],
        "version": link["version"],
        "status": status,
    }


def _adoptable(analysis_id: str, name: str) -> str | None:
    """A Custom Analysis named *name* that is our copy by its SQL marker."""
    dal = _ca_dal()
    hit = dal.find_analysis_by_name(name, exclude_id=None)
    if hit is None:
        return None
    rows = dal.fetch_custom_analyses_with_sql([hit["id"]])
    if rows and rows[0]["sql"].startswith(_marker_prefix(analysis_id)):
        return hit["id"]
    return None


def sync(analysis_id: str) -> dict[str, Any]:
    """Make the copy match the latest verified version, or remove it.

    Returns ``{analysis_id, version, custom_analysis_id, action, error}`` with
    ``action`` one of ``created``, ``updated``, ``unchanged``, ``removed``,
    ``none`` (nothing verified, nothing to remove) or ``error``.
    """
    analysis = store.get_analysis(analysis_id)
    if analysis is None:
        raise SavedAnalysisError("not_found", f"No saved analysis {analysis_id!r}")
    target = analysis["latest_verified_version"]
    result: dict[str, Any] = {
        "analysis_id": analysis_id,
        "version": target,
        "custom_analysis_id": None,
        "action": "none",
        "error": None,
    }
    ca = _ca_service()
    try:
        live = [
            link["custom_analysis_id"]
            for link in store.custom_analysis_links(analysis_id)
            if _exists(link["custom_analysis_id"])
        ]
        if target is None:
            for custom_analysis_id in live:
                ca.delete_custom_analysis(custom_analysis_id)
            store.set_custom_analysis_link(analysis_id, None, None)
            result["action"] = "removed" if live else "none"
            return result

        version_row = store.get_version(analysis_id, target)
        name, description, sql = copy_content(analysis, version_row)
        keep = live[-1] if live else _adoptable(analysis_id, name)
        if keep is not None:
            current = _ca_dal().fetch_custom_analyses_with_sql([keep])
            if current and (
                current[0]["name"],
                current[0]["description"],
                current[0]["sql"],
            ) == (name, description, sql.strip()):
                result["action"] = "unchanged"
            elif ca.update_custom_analysis(keep, name, description, sql) is None:
                keep = None
            else:
                result["action"] = "updated"
        if keep is None:
            keep = ca.create_custom_analysis(name, description, sql)["id"]
            result["action"] = "created"
        for extra in live:
            if extra != keep:
                ca.delete_custom_analysis(extra)
        store.set_custom_analysis_link(analysis_id, target, keep)
        result["custom_analysis_id"] = keep
        return result
    except Exception as exc:  # noqa: BLE001 - the copy must not fail verify/retire
        dal = _ca_dal()
        if isinstance(exc, dal.CustomAnalysisNameConflict):
            code = "name_conflict"
        elif isinstance(exc, dal.CustomAnalysisSqlConflict):
            code = "sql_conflict"
        elif isinstance(exc, SqlParseError):  # CustomAnalysisSqlError included
            # Typically: the SQL names no table the catalog knows yet.
            code = "sql_error"
        else:
            code = "failed"
            logger.exception(
                "Could not sync the Custom Analyses copy of %s", analysis_id
            )
        result["action"] = "error"
        result["error"] = {"code": code, "message": str(exc)[:1000]}
        return result


def sync_all() -> list[dict[str, Any]]:
    """:func:`sync` every saved analysis, oldest first."""
    return [sync(analysis_id) for analysis_id in store.all_analysis_ids()]
