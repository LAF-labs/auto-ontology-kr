# SPDX-License-Identifier: Apache-2.0

"""Export a verified saved analysis's full result to a file.

An export resolves the version and parameters exactly like a run, checks the
same SQL guard, and caps the statement with ``LIMIT max+1`` so the database
stops early. Rows are streamed in chunks (:mod:`.stream`) into a Parquet or
CSV file (:mod:`.writer`) written under a hidden partial name and renamed into
place only when complete, so a reader of the directory never sees half a file.
A JSON description with the same id sits next to it.

**Limits** (:mod:`.config`): rows and bytes per export, wall-clock time per
export, and per calendar day the number of exports and the rows they read,
counted over every caller. Going over is an error in the contract's format;
the partial file is deleted and the attempt is logged as ``failed``.

**Log**: every export that starts is a row in ``saved_analysis_export``
(:mod:`auto_ontology.dal.saved_analyses.exports`): who, which analysis and
version, the bound parameters, rows, bytes, checksum, outcome.

**Retention**: a ready file is deleted ``SAVED_ANALYSES_EXPORT_RETENTION_S``
after it was written, by :func:`sweep`, which runs on every export call and
periodically while the server is up.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from auto_ontology.dal.saved_analyses import exports as log
from auto_ontology.dal.saved_analyses.tables import STATUS_VERIFIED
from auto_ontology.server.saved_analyses import config as run_config
from auto_ontology.server.saved_analyses import params, service
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
from auto_ontology.server.saved_analyses.exports import config, stream, writer

logger = logging.getLogger(__name__)

DOWNLOAD_PATH = "/api/saved-analysis-exports/{export_id}/file"
_FILE_NAME = re.compile(
    r"^\.?(?P<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"\.(parquet|csv|json)(\.partial)?$"
)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(value: dt.datetime | None) -> str | None:
    return service._iso(value)


# ---------------------------------------------------------------------------
# Concurrency and quotas
# ---------------------------------------------------------------------------

_active_lock = threading.Lock()
_active = 0
_quota_lock = threading.Lock()


@contextmanager
def _export_slot() -> Iterator[None]:
    global _active
    limit = config.setting("SAVED_ANALYSES_EXPORT_MAX_CONCURRENCY")
    with _active_lock:
        if _active >= limit:
            raise SavedAnalysisError(
                "busy",
                "Another export is running; retry when it has finished.",
                details={"exports_running": _active, "max_concurrency": limit},
            )
        _active += 1
    try:
        yield
    finally:
        with _active_lock:
            _active -= 1


def day_start(now: dt.datetime | None = None) -> dt.datetime:
    """Midnight today in ``SAVED_ANALYSES_TIMEZONE``, as a UTC instant."""
    zone = run_config.timezone()
    local = (now or _now()).astimezone(zone)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight.astimezone(dt.timezone.utc)


def limits() -> dict[str, Any]:
    return {
        "max_rows": config.setting("SAVED_ANALYSES_EXPORT_MAX_ROWS"),
        "max_bytes": config.setting("SAVED_ANALYSES_EXPORT_MAX_BYTES"),
        "timeout_s": config.setting("SAVED_ANALYSES_EXPORT_TIMEOUT_S"),
        "daily_max_exports": config.setting("SAVED_ANALYSES_EXPORT_DAILY_MAX_COUNT"),
        "daily_max_rows": config.setting("SAVED_ANALYSES_EXPORT_DAILY_MAX_ROWS"),
        "retention_s": config.setting("SAVED_ANALYSES_EXPORT_RETENTION_S"),
        "formats": list(writer.FORMATS),
    }


def usage() -> dict[str, Any]:
    since = day_start()
    exports, rows = log.usage_since(since)
    return {
        "day_start": _iso(since),
        "timezone": str(run_config.timezone()),
        "exports": exports,
        "rows": rows,
        "limits": limits(),
    }


# ---------------------------------------------------------------------------
# Payload
# ---------------------------------------------------------------------------


def payload(row: dict[str, Any]) -> dict[str, Any]:
    ready = row["state"] == log.EXPORT_READY
    return {
        "export_id": row["id"],
        "analysis_id": row["analysis_id"],
        "name": row["analysis_name"],
        "version": row["version"],
        "params": row["params"],
        "format": row["format"],
        "state": row["state"],
        "columns": row["columns"],
        "row_count": row["row_count"],
        "byte_size": row["byte_size"],
        "sha256": row["sha256"],
        "requested_by": row["requested_by"],
        "created_at": _iso(row["created"]),
        "finished_at": _iso(row["finished"]),
        "duration_ms": row["duration_ms"],
        "expires_at": _iso(row["expires_at"]),
        "deleted_at": _iso(row["deleted_at"]),
        "file": {
            "name": row["file_name"],
            "content_type": writer.CONTENT_TYPES[row["format"]],
            "download_path": DOWNLOAD_PATH.format(export_id=row["id"]),
            "description_name": f"{row['id']}.json",
        }
        if ready
        else None,
        "error": {"code": row["error_code"], "message": row["error"]}
        if row["error_code"]
        else None,
        "source": {"database_name": row["database_name"]},
        "sql": row["sql"],
    }


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


def _paths(export_id: str, fmt: str) -> tuple[Path, Path, Path, Path]:
    base = config.export_dir()
    return (
        base / f".{export_id}.{fmt}.partial",
        base / f"{export_id}.{fmt}",
        base / f".{export_id}.json.partial",
        base / f"{export_id}.json",
    )


def _unlink(*paths: Path) -> None:
    for path in paths:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning("Could not delete export file %s", path, exc_info=True)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_private(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, config.file_mode())
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(path, config.file_mode())


def file_path(row: dict[str, Any]) -> Path | None:
    if row["state"] != log.EXPORT_READY or not row["file_name"]:
        return None
    return config.export_dir() / row["file_name"]


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def _resolve_verified(
    analysis_id: str, version: int | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    analysis, row = service._resolve_version(analysis_id, version)
    if row["status"] != STATUS_VERIFIED:
        raise SavedAnalysisError(
            "not_verified",
            f"Version {row['version']} of {analysis['name']!r} is a draft; only "
            "verified versions are exported.",
            details={"version": row["version"], "status": row["status"]},
        )
    return analysis, row


def create_export(
    analysis_id: str,
    *,
    version: int | None,
    supplied_params: dict[str, Any] | None,
    fmt: str,
    user_id: str | None,
) -> dict[str, Any]:
    """Export the full result of a verified version. Returns the export payload."""
    try:
        sweep()
    except Exception:  # noqa: BLE001 - retention must not block an export
        logger.exception("Export retention sweep failed")
    if fmt not in writer.FORMATS:
        raise SavedAnalysisError(
            "invalid_params",
            f"format must be one of {list(writer.FORMATS)}",
            details={"format": list(writer.FORMATS)},
        )
    analysis, version_row = _resolve_verified(analysis_id, version)
    definitions = version_row["params"]
    values = params.resolve_values(definitions, supplied_params)
    values_json = params.to_json(values)
    connector = service.get_connector(analysis["database_name"])
    if not stream.supports(connector):
        raise SavedAnalysisError(
            "export_unsupported",
            "Exports run only on Postgres and MySQL/MariaDB connections, which can "
            "stream a result inside a read-only transaction.",
            details={"database_name": analysis["database_name"]},
        )

    with _export_slot():
        max_rows = config.setting("SAVED_ANALYSES_EXPORT_MAX_ROWS")
        with _quota_lock:
            since = day_start()
            exports_today, rows_today = log.usage_since(since)
            daily_count = config.setting("SAVED_ANALYSES_EXPORT_DAILY_MAX_COUNT")
            daily_rows = config.setting("SAVED_ANALYSES_EXPORT_DAILY_MAX_ROWS")
            quota_details = {
                "day_start": _iso(since),
                "exports_today": exports_today,
                "rows_today": rows_today,
                "daily_max_exports": daily_count,
                "daily_max_rows": daily_rows,
            }
            if exports_today >= daily_count:
                raise SavedAnalysisError(
                    "export_quota_exceeded",
                    f"Today's {daily_count} exports are used up.",
                    details=quota_details,
                )
            remaining = daily_rows - rows_today
            if remaining <= 0:
                raise SavedAnalysisError(
                    "export_quota_exceeded",
                    f"Today's {daily_rows} exported rows are used up.",
                    details=quota_details,
                )
            cap = min(max_rows, remaining)
            _, executed = service.prepare_sql(
                version_row["sql"], connector.dialect, definitions, values, cap + 1
            )
            export_id = str(uuid.uuid4())
            log.start(
                export_id=export_id,
                analysis_id=analysis["id"],
                analysis_name=analysis["name"],
                version=version_row["version"],
                database_name=analysis["database_name"],
                params=values_json,
                params_hash=service.params_hash(values_json),
                fmt=fmt,
                requested_by=user_id,
                sql=executed,
                columns=version_row["columns"],
            )
        logger.info(
            "Export %s started by %s: analysis %s v%s params %s format %s",
            export_id,
            user_id,
            analysis["id"],
            version_row["version"],
            json.dumps(values_json, ensure_ascii=False, default=str),
            fmt,
        )
        return _run_export(
            export_id,
            analysis,
            version_row,
            connector,
            executed,
            fmt=fmt,
            cap=cap,
            cap_is_daily=cap < max_rows,
            values_json=values_json,
            user_id=user_id,
            quota_details=quota_details,
        )


def _run_export(
    export_id: str,
    analysis: dict[str, Any],
    version_row: dict[str, Any],
    connector: Any,
    executed: str,
    *,
    fmt: str,
    cap: int,
    cap_is_daily: bool,
    values_json: dict[str, Any],
    user_id: str | None,
    quota_details: dict[str, Any],
) -> dict[str, Any]:
    timeout_s = config.setting("SAVED_ANALYSES_EXPORT_TIMEOUT_S")
    max_bytes = config.setting("SAVED_ANALYSES_EXPORT_MAX_BYTES")
    chunk_rows = config.setting("SAVED_ANALYSES_EXPORT_CHUNK_ROWS")
    partial, final, desc_partial, desc_final = _paths(export_id, fmt)
    description: dict[str, Any] = {
        "export_id": export_id,
        "analysis_id": analysis["id"],
        "name": analysis["name"],
        "version": version_row["version"],
        "params": values_json,
        "format": fmt,
        "columns": version_row["columns"],
        "requested_by": user_id,
        "source": service._source(analysis, version_row),
    }
    rows_read = 0
    started = time.monotonic()
    out: writer.ParquetExportWriter | writer.CsvExportWriter | None = None
    try:
        with service.database_slot(analysis["database_name"]):
            deadline = time.monotonic() + timeout_s
            with stream.open_stream(
                connector,
                executed,
                deadline=deadline,
                timeout_s=timeout_s,
                chunk_rows=chunk_rows,
            ) as opened:
                observed = [{"name": c.name, "type": c.type} for c in opened.columns]
                if not service.columns_match(version_row["columns"], observed):
                    raise SavedAnalysisError(
                        "schema_mismatch",
                        "The result columns no longer match the ones fixed when "
                        "this version was saved.",
                        details={
                            "expected": [
                                {"name": c["name"], "type": c["type"]}
                                for c in version_row["columns"]
                            ],
                            "actual": observed,
                        },
                    )
                description["dialect_family"] = opened.dialect_family
                fd = os.open(
                    partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, config.file_mode()
                )
                os.close(fd)
                out = writer.open_writer(fmt, partial, opened.columns, description)
                for chunk in opened.chunks:
                    if rows_read + len(chunk) > cap:
                        rows_read += len(chunk)
                        if cap_is_daily:
                            raise SavedAnalysisError(
                                "export_quota_exceeded",
                                f"The result has more rows than are left of today's "
                                f"quota ({cap}).",
                                details={**quota_details, "rows_left_today": cap},
                            )
                        raise SavedAnalysisError(
                            "export_too_large",
                            f"The result has more than {cap} rows, the most one "
                            "export may hold.",
                            details={"max_rows": cap},
                        )
                    out.write(chunk)
                    rows_read += len(chunk)
                    if out.bytes_written() > max_bytes:
                        raise SavedAnalysisError(
                            "export_too_large",
                            f"The file grew past {max_bytes} bytes, the most one "
                            "export may hold.",
                            details={"max_bytes": max_bytes},
                        )
                    if time.monotonic() > deadline:
                        raise SavedAnalysisError(
                            "timeout",
                            f"The export ran longer than its {timeout_s:g}s limit "
                            "and was cancelled.",
                            details={"timeout_s": timeout_s},
                        )
                try:
                    out.close()
                except OSError as exc:
                    raise SavedAnalysisError(
                        "export_failed", f"The file could not be written: {exc}"
                    ) from exc
                out = None
        size = partial.stat().st_size
        if size > max_bytes:
            raise SavedAnalysisError(
                "export_too_large",
                f"The file grew past {max_bytes} bytes, the most one export may hold.",
                details={"max_bytes": max_bytes},
            )
        sha = _sha256(partial)
        os.chmod(partial, config.file_mode())
        os.replace(partial, final)
    except SavedAnalysisError as exc:
        _fail(export_id, out, partial, final, rows_read, started, exc)
        raise
    except OSError as exc:
        error = SavedAnalysisError(
            "export_failed", f"The file could not be written: {exc}"
        )
        _fail(export_id, out, partial, final, rows_read, started, error)
        raise error from exc
    except Exception as exc:
        logger.exception("Export %s failed unexpectedly", export_id)
        error = SavedAnalysisError("export_failed", f"Unexpected error: {exc}")
        _fail(export_id, out, partial, final, rows_read, started, error)
        raise error from exc

    duration_ms = int((time.monotonic() - started) * 1000)
    retention_s = config.setting("SAVED_ANALYSES_EXPORT_RETENTION_S")
    expires_at = _now() + dt.timedelta(seconds=retention_s)
    log.finish_ready(
        export_id,
        row_count=rows_read,
        byte_size=size,
        sha256=sha,
        file_name=final.name,
        duration_ms=duration_ms,
        expires_at=expires_at,
    )
    row = log.get(export_id)
    assert row is not None
    data = payload(row)
    try:
        sidecar = {**data, "dialect_family": description.get("dialect_family")}
        _write_private(
            desc_partial,
            json.dumps(sidecar, ensure_ascii=False, indent=2, default=str).encode(),
        )
        os.replace(desc_partial, desc_final)
    except OSError:
        logger.warning("Could not write the description of export %s", export_id)
    logger.info(
        "Export %s ready: %s rows, %s bytes, %s ms",
        export_id,
        rows_read,
        size,
        duration_ms,
    )
    return data


def _fail(
    export_id: str,
    out: Any,
    partial: Path,
    final: Path,
    rows_read: int,
    started: float,
    exc: SavedAnalysisError,
) -> None:
    if out is not None:
        out.abort()
    _unlink(partial, final)
    try:
        log.finish_failed(
            export_id,
            row_count=rows_read,
            error_code=exc.code,
            error=exc.message,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except Exception:  # noqa: BLE001 - the original error matters more
        logger.exception("Could not record failed export %s", export_id)
    logger.info("Export %s failed: %s after %s rows", export_id, exc.code, rows_read)


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


def get_export(export_id: str) -> dict[str, Any]:
    row = log.get(export_id)
    if row is None:
        raise SavedAnalysisError("not_found", f"No export {export_id!r}")
    return row


def file_for_download(export_id: str) -> tuple[dict[str, Any], Path]:
    row = get_export(export_id)
    if row["state"] == log.EXPORT_EXPIRED:
        raise SavedAnalysisError(
            "export_expired",
            "This export's file was deleted when its retention ended; export again.",
            details={"deleted_at": _iso(row["deleted_at"])},
        )
    path = file_path(row)
    if path is None:
        raise SavedAnalysisError(
            "not_found",
            f"Export {export_id!r} has no file (state {row['state']}).",
            details={"state": row["state"]},
        )
    if not path.is_file():
        log.mark_expired(export_id)
        raise SavedAnalysisError(
            "export_expired", "This export's file is no longer on disk; export again."
        )
    return row, path


def list_exports(*, skip: int, limit: int) -> tuple[list[dict[str, Any]], int]:
    rows, total = log.list_recent(skip=skip, limit=limit)
    return [payload(r) for r in rows], total


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------


def sweep(now: dt.datetime | None = None) -> dict[str, int]:
    """Delete files past retention and close exports a dead process left running.

    Also removes any file in the export directory that is named like an
    export and is older than retention plus the export timeout, whatever the
    log says, so retention holds even for files the log no longer knows.
    """
    now = now or _now()
    expired = 0
    for row in log.due_for_deletion(now):
        if row["file_name"]:
            base = config.export_dir()
            _unlink(base / row["file_name"], base / f"{row['id']}.json")
        log.mark_expired(row["id"])
        expired += 1

    timeout_s = config.setting("SAVED_ANALYSES_EXPORT_TIMEOUT_S")
    interrupted = 0
    with _active_lock:
        running_here = _active
    if running_here == 0:
        cutoff = now - dt.timedelta(seconds=timeout_s + 60)
        for row in log.stale_running(cutoff):
            log.finish_failed(
                row["id"],
                row_count=0,
                error_code="export_failed",
                error="The server stopped before this export finished.",
                duration_ms=0,
            )
            interrupted += 1

    retention_s = config.setting("SAVED_ANALYSES_EXPORT_RETENTION_S")
    oldest = now.timestamp() - retention_s - timeout_s
    removed = 0
    base = config.export_dir()
    for entry in os.scandir(base):
        if not entry.is_file() or not _FILE_NAME.match(entry.name):
            continue
        try:
            if entry.stat().st_mtime < oldest:
                _unlink(Path(entry.path))
                removed += 1
        except FileNotFoundError:
            continue
    if expired or interrupted or removed:
        logger.info(
            "Export sweep: %s expired, %s interrupted, %s stray files removed",
            expired,
            interrupted,
            removed,
        )
    return {"expired": expired, "interrupted": interrupted, "removed": removed}


class Sweeper:
    """Runs :func:`sweep` every ``SAVED_ANALYSES_EXPORT_SWEEP_INTERVAL_S``."""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._loop, name="saved-analysis-export-sweep", daemon=True
        )
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                sweep()
            except Exception:  # noqa: BLE001 - keep sweeping
                logger.exception("Export retention sweep failed")
            self._stop.wait(config.setting("SAVED_ANALYSES_EXPORT_SWEEP_INTERVAL_S"))

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
