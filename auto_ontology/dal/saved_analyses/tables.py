# SPDX-License-Identifier: Apache-2.0

"""Tables for saved analyses, declared on the shared :data:`METADATA`.

Imported at the bottom of :mod:`auto_ontology.dal.schema` so Alembic's
autogenerate and ``alembic check`` see them like every other table.

Deliberately **not** connected to the catalog or to ``custom_analysis`` by
foreign keys. Both are wiped or re-keyed by resets and re-ingests (catalog ids
are fresh uuids per ingest, a semantic reset deletes every custom analysis), and
a dashboard's analysis must outlive all of that. Referenced tables are stored
by *name* for the same reason, with the catalog id kept only as a hint.
"""

from __future__ import annotations

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Table,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from auto_ontology.dal.schema import METADATA, _id

#: Lifecycle of one version. ``draft`` runs only when asked for by number;
#: ``verified`` is what a run without a version resolves to; ``retired`` never
#: runs again. The SQL, parameters and columns of a version never change.
STATUS_DRAFT = "draft"
STATUS_VERIFIED = "verified"
STATUS_RETIRED = "retired"
STATUSES = (STATUS_DRAFT, STATUS_VERIFIED, STATUS_RETIRED)

RUN_OK = "ok"
RUN_ERROR = "error"

saved_analysis = Table(
    "saved_analysis",
    METADATA,
    _id(),
    Column("name", Text, nullable=False, unique=True),
    Column("description", Text, nullable=True),
    # The connector the SQL runs on, matched against `connector.database_name`.
    Column("database_name", Text, nullable=False),
    Column("latest_version", Integer, nullable=False),
    Column(
        "created", DateTime(timezone=True), nullable=False, server_default=func.now()
    ),
    Column("created_by", Text, nullable=True),
    Column(
        "updated", DateTime(timezone=True), nullable=False, server_default=func.now()
    ),
)

saved_analysis_version = Table(
    "saved_analysis_version",
    METADATA,
    Column(
        "analysis_id",
        Text,
        ForeignKey(saved_analysis.c.id, ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("version", Integer, primary_key=True),
    # The SQL exactly as saved, with `:name` placeholders. Bound by text
    # substitution so what a person verified is what runs.
    Column("sql", Text, nullable=False),
    Column("params", JSONB, nullable=False),
    # Result columns observed when the version was saved; every run is checked
    # against them.
    Column("columns", JSONB, nullable=False),
    Column("row_limit", Integer, nullable=False),
    Column("timeout_s", Integer, nullable=False),
    Column("cache_ttl_s", Integer, nullable=False),
    Column("status", Text, nullable=False),
    Column("verified_by", Text, nullable=True),
    Column("verified_at", DateTime(timezone=True), nullable=True),
    Column("verification_note", Text, nullable=True),
    # Optional retrieval copy in Custom Analyses. No FK: a semantic reset
    # deletes those rows and must not take this version with it.
    Column("custom_analysis_id", Text, nullable=True),
    Column(
        "created", DateTime(timezone=True), nullable=False, server_default=func.now()
    ),
    Column("created_by", Text, nullable=True),
    CheckConstraint("status IN ('draft', 'verified', 'retired')", name="status_valid"),
    CheckConstraint("row_limit > 0", name="row_limit_positive"),
    CheckConstraint("timeout_s > 0", name="timeout_positive"),
    CheckConstraint("cache_ttl_s >= 0", name="cache_ttl_nonnegative"),
)

# Tables a version reads, for permission checks: an analysis is visible only
# when every table it references is. Names are the durable key; `table_id` is
# the catalog id at save time and may go stale after a re-ingest.
saved_analysis_version__table = Table(
    "saved_analysis_version__table",
    METADATA,
    Column("analysis_id", Text, primary_key=True),
    Column("version", Integer, primary_key=True),
    Column("database_name", Text, primary_key=True),
    # '' rather than NULL for an unqualified reference, so it can sit in the key.
    Column("schema_name", Text, primary_key=True),
    Column("table_name", Text, primary_key=True),
    Column("table_id", Text, nullable=True),
    ForeignKeyConstraint(
        ["analysis_id", "version"],
        [saved_analysis_version.c.analysis_id, saved_analysis_version.c.version],
        ondelete="CASCADE",
        name="fk_saved_analysis_version__table_version",
    ),
)

# One row per (version, bound parameters): the cache and the last good result.
# A failed run overwrites `status`/`error` only, so `rows` keeps the last
# success for widgets to fall back on.
saved_analysis_run = Table(
    "saved_analysis_run",
    METADATA,
    Column("analysis_id", Text, primary_key=True),
    Column("version", Integer, primary_key=True),
    Column("params_hash", Text, primary_key=True),
    Column("params", JSONB, nullable=False),
    Column("status", Text, nullable=False),
    Column("error_code", Text, nullable=True),
    Column("error", Text, nullable=True),
    Column("attempted_at", DateTime(timezone=True), nullable=False),
    # The fields below describe the last *successful* run and stay put on failure.
    Column("columns", JSONB, nullable=True),
    Column("rows", JSONB, nullable=True),
    Column("row_count", Integer, nullable=True),
    Column("truncated", Boolean, nullable=True),
    Column("sql", Text, nullable=True),
    Column("executed_at", DateTime(timezone=True), nullable=True),
    Column("duration_ms", Integer, nullable=True),
    Column("expires_at", DateTime(timezone=True), nullable=True),
    ForeignKeyConstraint(
        ["analysis_id", "version"],
        [saved_analysis_version.c.analysis_id, saved_analysis_version.c.version],
        ondelete="CASCADE",
        name="fk_saved_analysis_run_version",
    ),
    CheckConstraint("status IN ('ok', 'error')", name="status_valid"),
)

Index(
    "ix_saved_analysis_version__table_table",
    saved_analysis_version__table.c.database_name,
    saved_analysis_version__table.c.schema_name,
    saved_analysis_version__table.c.table_name,
)

__all__ = [
    "RUN_ERROR",
    "RUN_OK",
    "STATUSES",
    "STATUS_DRAFT",
    "STATUS_RETIRED",
    "STATUS_VERIFIED",
    "saved_analysis",
    "saved_analysis_run",
    "saved_analysis_version",
    "saved_analysis_version__table",
]

# The export log lives in its own module; imported here so it registers on
# METADATA wherever these tables do.
from auto_ontology.dal.saved_analyses import exports as _exports  # noqa: E402,F401
