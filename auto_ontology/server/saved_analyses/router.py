# SPDX-License-Identifier: Apache-2.0

"""Routes under ``/api/saved-analyses``. Contract: ``docs/saved-analyses.md``.

Reached through the Next.js gateway, which checks ``analysis:read`` for reads
and runs, ``analysis:manage`` for saves and status changes, and forwards the
caller as ``x-auto-ontology-user-id`` on the latter.

Errors are ``{"error": {"code", "status", "message", "details",
"last_success"}}`` with the status from :data:`errors.STATUS_BY_CODE`, which
the body repeats as ``status``; FastAPI's own 422 for a
malformed body keeps its usual ``{"detail": [...]}`` shape.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from auto_ontology.dal.saved_analyses.tables import STATUS_RETIRED, STATUS_VERIFIED
from auto_ontology.server.identity import resolve_internal_user
from auto_ontology.server.pagination import LIMIT_QUERY, SKIP_QUERY
from auto_ontology.server.saved_analyses import service
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
from auto_ontology.server.saved_analyses.models import (
    BatchRequest,
    Envelope,
    PageEnvelope,
    RunRequest,
    SavedAnalysisCreate,
    SavedAnalysisVersionCreate,
    StatusChange,
)

router = APIRouter()


class ErrorBody(BaseModel):
    code: str
    status: int = Field(
        description="The HTTP status this error is answered with. Also set on "
        "run-batch items, which arrive inside a 200."
    )
    message: str
    details: dict[str, Any] | None = None
    last_success: dict[str, Any] | None = Field(
        default=None,
        description="The last successful result for the same version and "
        "parameters, in the same shape as a run's data (cache.hit is true).",
    )


class ErrorEnvelope(BaseModel):
    error: ErrorBody


_ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorEnvelope} for status in (404, 409, 422, 429, 502, 504)
}


def _error(exc: SavedAnalysisError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=exc.payload())


@router.get("/saved-analyses", response_model=PageEnvelope)
def list_saved_analyses(
    query: str | None = Query(
        default=None, description="Substring of the name or description."
    ),
    status: Literal["verified", "draft"] | None = Query(
        default=None,
        description="verified: has a verified version. draft: has none.",
    ),
    skip: int = SKIP_QUERY,
    limit: int | None = LIMIT_QUERY,
) -> Any:
    """Saved analyses ordered by name in code point order, with their latest and latest verified version.

    The order does not depend on the store database's collation.
    """
    rows, total = service.list_analyses(
        search=query, status=status, skip=skip, limit=limit
    )
    return {"data": rows, "count": len(rows), "total": total}


@router.post(
    "/saved-analyses", status_code=201, response_model=Envelope, responses=_ERRORS
)
def create_saved_analysis(body: SavedAnalysisCreate, request: Request) -> Any:
    """Save a new analysis as version 1, status draft.

    The SQL is guarded, run once with the default (or ``sample_params``)
    values, and the observed result columns are fixed on the version. The
    response carries the detail plus a ``preview`` of that run.
    """
    try:
        return {
            "data": service.create_analysis(
                body.model_dump(), resolve_internal_user(request, required=False)
            )
        }
    except SavedAnalysisError as exc:
        return _error(exc)


@router.post("/saved-analyses/run-batch", response_model=Envelope, responses=_ERRORS)
def run_saved_analyses_batch(body: BatchRequest) -> Any:
    """Run several saved analyses in one call (one dashboard screen).

    ``data`` maps each item's ``key`` to ``{"data": …}`` or ``{"error": …}``.
    Identical items run once. The whole call answers within ``deadline_s``;
    items unfinished by then come back as ``timeout`` errors.
    """
    try:
        items = [item.model_dump() for item in body.items]
        return {
            "data": service.run_batch(items, body.max_age_s, deadline_s=body.deadline_s)
        }
    except SavedAnalysisError as exc:
        return _error(exc)


@router.post(
    "/saved-analyses/sync-custom-analyses", response_model=Envelope, responses=_ERRORS
)
def sync_saved_analyses_custom_copies(
    analysis_id: str | None = Query(
        default=None, description="Only this analysis. Omit for all of them."
    ),
) -> Any:
    """Re-register the Custom Analyses copy of each saved analysis.

    The copy mirrors the latest verified version so question answering can
    find it; verify and retire keep it current on their own. Run this after a
    semantic reset, which deletes Custom Analyses, or to retry a copy whose
    sync failed. ``data`` lists one result per analysis.
    """
    from auto_ontology.server.saved_analyses import custom_copy

    try:
        if analysis_id is not None:
            return {"data": [custom_copy.sync(analysis_id)]}
        return {"data": custom_copy.sync_all()}
    except SavedAnalysisError as exc:
        return _error(exc)


@router.get("/saved-analyses/{analysis_id}", response_model=Envelope, responses=_ERRORS)
def get_saved_analysis(
    analysis_id: str = Path(),
    version: int | None = Query(
        default=None,
        ge=1,
        description="Defaults to the latest verified version, else the latest.",
    ),
) -> Any:
    """One saved analysis with its version list and one version in full."""
    try:
        return {"data": service.get_detail(analysis_id, version)}
    except SavedAnalysisError as exc:
        return _error(exc)


@router.post(
    "/saved-analyses/{analysis_id}/versions",
    status_code=201,
    response_model=Envelope,
    responses=_ERRORS,
)
def create_saved_analysis_version(
    body: SavedAnalysisVersionCreate, request: Request, analysis_id: str = Path()
) -> Any:
    """Append a new draft version. Earlier versions are never changed."""
    try:
        return {
            "data": service.add_version(
                analysis_id,
                body.model_dump(),
                resolve_internal_user(request, required=False),
            )
        }
    except SavedAnalysisError as exc:
        return _error(exc)


@router.post(
    "/saved-analyses/{analysis_id}/versions/{version}/verify",
    response_model=Envelope,
    responses=_ERRORS,
)
def verify_saved_analysis_version(
    request: Request,
    body: StatusChange | None = None,
    analysis_id: str = Path(),
    version: int = Path(ge=1),
) -> Any:
    """Mark a draft version verified, recording who and when.

    A run without an explicit version uses the latest verified one, and its
    Custom Analyses copy is refreshed (``custom_analysis_sync`` in the answer).
    """
    try:
        return {
            "data": service.change_status(
                analysis_id,
                version,
                STATUS_VERIFIED,
                user_id=resolve_internal_user(request, required=False),
                note=body.note if body else None,
            )
        }
    except SavedAnalysisError as exc:
        return _error(exc)


@router.post(
    "/saved-analyses/{analysis_id}/versions/{version}/retire",
    response_model=Envelope,
    responses=_ERRORS,
)
def retire_saved_analysis_version(
    request: Request,
    body: StatusChange | None = None,
    analysis_id: str = Path(),
    version: int = Path(ge=1),
) -> Any:
    """Retire a version for good. It can no longer run.

    The Custom Analyses copy follows the latest verified version that is left,
    or is removed (``custom_analysis_sync`` in the answer).
    """
    try:
        return {
            "data": service.change_status(
                analysis_id,
                version,
                STATUS_RETIRED,
                user_id=resolve_internal_user(request, required=False),
                note=body.note if body else None,
            )
        }
    except SavedAnalysisError as exc:
        return _error(exc)


@router.post(
    "/saved-analyses/{analysis_id}/run", response_model=Envelope, responses=_ERRORS
)
def run_saved_analysis(
    body: RunRequest | None = None, analysis_id: str = Path()
) -> Any:
    """Run a saved analysis by id, or answer from the result cache.

    No LLM is involved. Errors carry ``last_success`` when an earlier run with
    the same version and parameters succeeded.
    """
    body = body or RunRequest()
    try:
        return {
            "data": service.run_analysis(
                analysis_id,
                version=body.version,
                supplied_params=body.params,
                max_age_s=body.max_age_s,
                row_limit=body.row_limit,
            )
        }
    except SavedAnalysisError as exc:
        return _error(exc)
