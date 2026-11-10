# SPDX-License-Identifier: Apache-2.0

"""Request and response models for ``/api/saved-analyses``.

Requests forbid unknown keys, so a misspelt field fails loudly instead of being
ignored. Responses allow extra keys, like every model in
:mod:`auto_ontology.server.models`, so adding a field is not a breaking change.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from auto_ontology.server.models import ApiModel


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ColumnHint(_Request):
    role: Literal["dimension", "measure", "time"] | None = None
    unit: str | None = Field(default=None, max_length=32)
    label: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class VersionFields(_Request):
    sql: str = Field(min_length=1, max_length=100_000)
    params: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Parameter definitions; see docs/saved-analyses.md.",
    )
    column_hints: dict[str, ColumnHint] = Field(
        default_factory=dict,
        description="Per result column: role, unit, label. Types are observed, not given.",
    )
    row_limit: int | None = Field(default=None, gt=0)
    timeout_s: int | None = Field(default=None, gt=0)
    cache_ttl_s: int | None = Field(default=None, ge=0)
    sample_params: dict[str, Any] = Field(
        default_factory=dict,
        description="Values for the save-time run, for required parameters without a default.",
    )


class SavedAnalysisCreate(VersionFields):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    database_name: str = Field(
        min_length=1, description="connector.database_name to run on"
    )


class SavedAnalysisVersionCreate(VersionFields):
    description: str | None = Field(
        default=None,
        max_length=5000,
        description="Replaces the analysis description when given.",
    )


class StatusChange(_Request):
    note: str | None = Field(default=None, max_length=5000)


class RunRequest(_Request):
    version: int | None = Field(
        default=None, gt=0, description="Omit for the latest verified version."
    )
    params: dict[str, Any] = Field(default_factory=dict)
    max_age_s: int | None = Field(
        default=None,
        ge=0,
        description="Oldest cached result acceptable, in seconds; 0 forces a fresh run.",
    )
    row_limit: int | None = Field(
        default=None, gt=0, description="At most the version's row_limit."
    )


class BatchItem(RunRequest):
    key: str = Field(min_length=1, max_length=200)
    analysis_id: str = Field(min_length=1)


class BatchRequest(_Request):
    items: list[BatchItem] = Field(min_length=1)
    max_age_s: int | None = Field(
        default=None, ge=0, description="Default for items that omit it."
    )
    deadline_s: int | None = Field(
        default=None,
        gt=0,
        description="Seconds the whole batch may take; items unfinished by then "
        "answer timeout. Defaults to SAVED_ANALYSES_BATCH_DEADLINE_S, at most "
        "SAVED_ANALYSES_BATCH_MAX_DEADLINE_S.",
    )


class Envelope(ApiModel):
    data: Any


class PageEnvelope(ApiModel):
    data: list[Any]
    count: int
    total: int
