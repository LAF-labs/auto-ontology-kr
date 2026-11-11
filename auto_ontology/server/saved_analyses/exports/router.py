# SPDX-License-Identifier: Apache-2.0

"""Export routes. Contract: ``docs/saved-analyses.md`` §15.

Reached through the Next.js gateway, which checks ``analysis:export`` on all
of them and forwards the caller as ``x-auto-ontology-user-id``, recorded as
the export's ``requested_by``.

The router carries its own lifespan, merged into the app's by
``include_router``: it runs the retention sweep in the background while the
server is up.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import APIRouter, FastAPI, Path, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from auto_ontology.server.identity import resolve_internal_user
from auto_ontology.server.pagination import LIMIT_QUERY, SKIP_QUERY
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
from auto_ontology.server.saved_analyses.exports import service, writer
from auto_ontology.server.saved_analyses.models import Envelope
from auto_ontology.server.saved_analyses.router import _ERRORS, ErrorEnvelope
from auto_ontology.server.models import ApiModel


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    sweeper = service.Sweeper()
    sweeper.start()
    try:
        yield
    finally:
        sweeper.stop()


router = APIRouter(lifespan=_lifespan)

_EXPORT_ERRORS: dict[int | str, dict[str, Any]] = {
    **_ERRORS,
    **{status: {"model": ErrorEnvelope} for status in (413, 500)},
}
_READ_ERRORS: dict[int | str, dict[str, Any]] = {404: {"model": ErrorEnvelope}}
_FILE_ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorEnvelope} for status in (404, 410)
}


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int | None = Field(
        default=None,
        gt=0,
        description="Omit for the latest verified version. A draft is refused.",
    )
    params: dict[str, Any] = Field(default_factory=dict)
    format: Literal["parquet", "csv"] = Field(
        default="parquet",
        description="parquet keeps column types; csv is plain text.",
    )


class ExportPage(ApiModel):
    data: list[Any]
    count: int
    total: int
    usage: dict[str, Any]


def _error(exc: SavedAnalysisError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=exc.payload())


@router.post(
    "/saved-analyses/{analysis_id}/export",
    status_code=201,
    response_model=Envelope,
    responses=_EXPORT_ERRORS,
)
def export_saved_analysis(
    request: Request, body: ExportRequest | None = None, analysis_id: str = Path()
) -> Any:
    """Write the full result of a verified version to a file.

    Parameters resolve as for a run. The answer describes the file (rows,
    bytes, sha256, columns) and where to fetch it; the file also lands in the
    configured export directory. Limits and daily quotas apply.
    """
    body = body or ExportRequest()
    try:
        return {
            "data": service.create_export(
                analysis_id,
                version=body.version,
                supplied_params=body.params,
                fmt=body.format,
                user_id=resolve_internal_user(request, required=False),
            )
        }
    except SavedAnalysisError as exc:
        return _error(exc)


@router.get("/saved-analysis-exports", response_model=ExportPage)
def list_saved_analysis_exports(
    skip: int = SKIP_QUERY, limit: int | None = LIMIT_QUERY
) -> Any:
    """Exports, newest first, with today's usage and the limits in force."""
    rows, total = service.list_exports(skip=skip, limit=limit or 50)
    return {"data": rows, "count": len(rows), "total": total, "usage": service.usage()}


@router.get(
    "/saved-analysis-exports/{export_id}",
    response_model=Envelope,
    responses=_READ_ERRORS,
)
def get_saved_analysis_export(export_id: str = Path()) -> Any:
    """One export's record: who, which version, parameters, rows, file state."""
    try:
        return {"data": service.payload(service.get_export(export_id))}
    except SavedAnalysisError as exc:
        return _error(exc)


@router.get(
    "/saved-analysis-exports/{export_id}/file",
    response_class=FileResponse,
    responses={
        200: {
            "description": "The exported file.",
            "content": {
                writer.CONTENT_TYPES["parquet"]: {
                    "schema": {"type": "string", "format": "binary"}
                },
                "text/csv": {"schema": {"type": "string", "format": "binary"}},
            },
        },
        **_FILE_ERRORS,
    },
)
def download_saved_analysis_export(export_id: str = Path()) -> Any:
    """The exported file itself. 410 once retention has deleted it."""
    try:
        row, path = service.file_for_download(export_id)
    except SavedAnalysisError as exc:
        return _error(exc)
    return FileResponse(
        path,
        media_type=writer.CONTENT_TYPES[row["format"]],
        filename=path.name,
        headers={
            "X-Export-Sha256": row["sha256"] or "",
            "Cache-Control": "private, no-store",
        },
    )
