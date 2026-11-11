# SPDX-License-Identifier: Apache-2.0

"""Bulk exports end to end against a real Postgres.

Like ``test_saved_analyses_postgres``, the store database doubles as the
customer database: a throwaway schema holds the rows the analyses read. Each
test gets its own export directory and generous quotas, so the shared export
log (other tests, other runs) cannot push a test over a daily limit unless the
test sets one on purpose relative to today's usage.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import tracemalloc
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator

import pytest

pytest.importorskip("sqlalchemy")
pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from auto_ontology.dal.saved_analyses import exports as export_log  # noqa: E402
from auto_ontology.dal.saved_analyses.tables import (  # noqa: E402
    saved_analysis,
    saved_analysis_version,
)
from auto_ontology.dal.session import store  # noqa: E402
from auto_ontology.server.saved_analyses import service  # noqa: E402
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError  # noqa: E402
from auto_ontology.server.saved_analyses.exports import (  # noqa: E402
    service as exports,
)
from auto_ontology.server.saved_analyses.exports import stream  # noqa: E402
from auto_ontology.server.saved_analyses.exports.router import (  # noqa: E402
    router as export_router,
)

PREFIX = f"sa_export_{uuid.uuid4().hex[:8]}"
FIXTURE = f"sa_export_fixture_{uuid.uuid4().hex[:8]}"


@pytest.fixture(scope="module", autouse=True)
def require_schema() -> None:
    if not os.environ.get("POSTGRES_USER"):
        pytest.skip("POSTGRES_* not set")
    try:
        store().query_read("SELECT 1 FROM saved_analysis_export LIMIT 1")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"saved_analysis_export unavailable (alembic upgrade head): {exc}")


@pytest.fixture(scope="module")
def connector(require_schema: None) -> Iterator[Any]:
    from auto_ontology.connectors.postgres import PostgresDatabase
    from auto_ontology.infra.postgres import get_postgres_connection_string

    db = PostgresDatabase(get_postgres_connection_string())
    db.execute(
        f"""
        CREATE SCHEMA {FIXTURE};
        CREATE TABLE {FIXTURE}.orders (
            id int PRIMARY KEY,
            customer text NOT NULL,
            amount numeric(12, 2) NOT NULL,
            created date NOT NULL,
            at timestamptz NOT NULL,
            local_at timestamp NOT NULL,
            paid boolean,
            big bigint NOT NULL,
            ratio double precision,
            tags jsonb
        );
        INSERT INTO {FIXTURE}.orders VALUES
            (1, 'kim',  100.10, '2026-09-15', '2026-09-15 09:00+09', '2026-09-15 09:00', true,  9007199254740993, 0.5, '{{"a": 1}}'),
            (2, 'lee',  200.20, '2026-10-01', '2026-10-01 10:00+09', '2026-10-01 10:00', false, 1, NULL, '[1, 2]'),
            (3, 'park',  50.05, '2026-10-20', '2026-10-20 11:00+09', '2026-10-20 11:00', NULL,  2, 1.25, NULL),
            (4, 'kim',   10.01, '2026-10-31', '2026-10-31 12:00+09', '2026-10-31 12:00', true,  3, 2.0, '"s"'),
            (5, '최',     1.00, '2026-11-01', '2026-11-01 13:00+09', '2026-11-01 13:00', true,  4, -1.0, '{{}}');
        CREATE TABLE {FIXTURE}.audit (note text);
        CREATE FUNCTION {FIXTURE}.maybe_write(mode text) RETURNS int LANGUAGE plpgsql AS $$
        BEGIN
            IF mode = 'write' THEN INSERT INTO {FIXTURE}.audit VALUES ('written'); END IF;
            RETURN 1;
        END $$;
        """
    )
    try:
        yield db
    finally:
        store().query_write(
            delete(saved_analysis).where(saved_analysis.c.name.like(f"{PREFIX}%"))
        )
        store().query_write(
            delete(export_log.saved_analysis_export).where(
                export_log.saved_analysis_export.c.analysis_name.like(f"{PREFIX}%")
            )
        )
        db.execute(f"DROP SCHEMA {FIXTURE} CASCADE")
        db.close()


@pytest.fixture(autouse=True)
def only_this_connector(monkeypatch: pytest.MonkeyPatch, connector: Any) -> None:
    import auto_ontology.connectors.registry as registry

    monkeypatch.setattr(registry, "get_connectors", lambda: [connector])


@pytest.fixture(autouse=True)
def export_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Path]:
    path = tmp_path / "exports"
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_DIR", str(path))
    # Far above what the shared log can hold, so only tests that mean to hit a
    # quota do.
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_DAILY_MAX_COUNT", "1000000")
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_DAILY_MAX_ROWS", "1000000000")
    yield path


@pytest.fixture(autouse=True)
def no_embeddings(monkeypatch: pytest.MonkeyPatch) -> None:
    import auto_ontology.vdb as vdb
    from auto_ontology.server.custom_analyses import service as ca_service

    class _FakeVdb:
        def delete_by_id(self, _id: str) -> None:
            pass

    monkeypatch.setattr(ca_service, "_embed_analysis", lambda _id: None)
    monkeypatch.setattr(vdb, "get_semantic_vdb", lambda: _FakeVdb())


def _analysis(
    sql: str, params: list | None = None, *, verify: bool = True
) -> dict[str, Any]:
    detail = service.create_analysis(
        {
            "name": f"{PREFIX}_{uuid.uuid4().hex[:6]}",
            "description": "export test",
            "database_name": "auto_ontology",
            "sql": sql,
            "params": params or [],
            "column_hints": {},
            "sample_params": {},
            "row_limit": 10,
        },
        "author",
    )
    if verify:
        service.change_status(detail["id"], 1, "verified", user_id="rev", note=None)
    return detail


def _export(analysis_id: str, **kwargs: Any) -> dict[str, Any]:
    kwargs.setdefault("version", None)
    kwargs.setdefault("supplied_params", {})
    kwargs.setdefault("fmt", "parquet")
    kwargs.setdefault("user_id", "exporter-1")
    return exports.create_export(analysis_id, **kwargs)


ALL_TYPES = f"""
SELECT id, customer, amount, created, at, local_at, paid, big, ratio, tags,
       sum(amount) OVER (ORDER BY id) AS running_total
FROM {FIXTURE}.orders
WHERE id >= :min_id
ORDER BY id
"""
MIN_ID = [{"name": "min_id", "type": "int", "default": 1}]


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Types and files
# ---------------------------------------------------------------------------


def test_parquet_export_keeps_types_and_every_row(export_dir: Path) -> None:
    detail = _analysis(ALL_TYPES, MIN_ID)
    data = _export(detail["id"])

    assert data["state"] == "ready" and data["row_count"] == 5
    assert data["requested_by"] == "exporter-1" and data["params"] == {"min_id": 1}
    assert data["version"] == 1 and data["format"] == "parquet"
    path = export_dir / data["file"]["name"]
    assert data["file"]["name"] == f"{data['export_id']}.parquet"
    assert data["file"]["download_path"].endswith(f"/{data['export_id']}/file")
    assert data["byte_size"] == path.stat().st_size and data["sha256"] == _sha(path)
    assert oct(path.stat().st_mode & 0o777) == "0o640"
    # Only the finished file and its description; no partials left.
    assert sorted(p.name for p in export_dir.iterdir()) == sorted(
        [path.name, f"{data['export_id']}.json"]
    )

    table = pq.read_table(path)
    types = {f.name: f.type for f in table.schema}
    assert types["id"] == pa.int32() or types["id"] == pa.int64()
    assert types["customer"] == pa.string()
    assert types["amount"] == pa.decimal128(12, 2)
    assert types["created"] == pa.date32()
    assert types["at"] == pa.timestamp("us", tz="UTC")
    assert types["local_at"] == pa.timestamp("us")
    assert types["paid"] == pa.bool_()
    assert types["big"] == pa.int64()
    assert types["ratio"] == pa.float64()
    # Unconstrained numeric (a window sum): exact text, typed in metadata.
    assert types["running_total"] == pa.string()
    meta = {f.name: f.metadata[b"auto_ontology.type"].decode() for f in table.schema}
    assert meta["running_total"] == "decimal" and meta["tags"] == "json"

    rows = table.to_pylist()
    assert [r["id"] for r in rows] == [1, 2, 3, 4, 5]
    assert rows[0]["amount"] == Decimal("100.10")
    assert rows[0]["big"] == 9007199254740993  # beyond 2**53, exact
    assert rows[0]["created"] == dt.date(2026, 9, 15)
    assert rows[0]["at"] == dt.datetime(2026, 9, 15, 0, 0, tzinfo=dt.timezone.utc)
    assert rows[0]["local_at"] == dt.datetime(2026, 9, 15, 9, 0)
    assert rows[2]["paid"] is None and rows[1]["ratio"] is None
    assert json.loads(rows[0]["tags"]) == {"a": 1} and rows[2]["tags"] is None
    assert rows[4]["customer"] == "최"
    assert rows[4]["running_total"] == "361.36"

    described = json.loads(table.schema.metadata[b"auto_ontology.export"])
    assert described["export_id"] == data["export_id"]
    assert described["params"] == {"min_id": 1}
    sidecar = json.loads((export_dir / f"{data['export_id']}.json").read_text())
    assert sidecar["sha256"] == data["sha256"] and sidecar["row_count"] == 5

    record = export_log.get(data["export_id"])
    assert record is not None
    assert (record["requested_by"], record["analysis_id"], record["version"]) == (
        "exporter-1",
        detail["id"],
        1,
    )
    assert record["params"] == {"min_id": 1} and record["row_count"] == 5


def test_export_ignores_the_versions_dashboard_row_limit() -> None:
    # The version caps runs at 10 rows; an export reads all of them.
    detail = _analysis("SELECT g AS n FROM generate_series(1, 25) AS g ORDER BY g", [])
    with pytest.raises(SavedAnalysisError):
        service.run_analysis(detail["id"], row_limit=11)
    data = _export(detail["id"])
    assert data["row_count"] == 25


def test_csv_export(export_dir: Path) -> None:
    detail = _analysis(ALL_TYPES, MIN_ID)
    data = _export(detail["id"], fmt="csv", supplied_params={"min_id": 4})
    path = export_dir / data["file"]["name"]
    assert path.suffix == ".csv" and data["row_count"] == 2
    lines = path.read_text("utf-8").splitlines()
    assert lines[0] == (
        "id,customer,amount,created,at,local_at,paid,big,ratio,tags,running_total"
    )
    assert lines[1].startswith("4,kim,10.01,2026-10-31,2026-10-31T03:00:00+00:00,")
    assert ",true,3,2.0," in lines[1]
    assert lines[2].split(",")[1] == "최" and lines[2].endswith(",{},11.01")
    assert data["params"] == {"min_id": 4}
    assert [c["name"] for c in data["columns"]][:3] == ["id", "customer", "amount"]


def test_empty_result_still_writes_a_typed_file(export_dir: Path) -> None:
    detail = _analysis(ALL_TYPES, MIN_ID)
    data = _export(detail["id"], supplied_params={"min_id": 999})
    table = pq.read_table(export_dir / data["file"]["name"])
    assert table.num_rows == 0 and data["row_count"] == 0
    assert table.schema.field("amount").type == pa.decimal128(12, 2)


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


def test_drafts_and_retired_versions_are_not_exported() -> None:
    draft = _analysis(ALL_TYPES, MIN_ID, verify=False)
    with pytest.raises(SavedAnalysisError) as info:
        _export(draft["id"])
    assert info.value.code == "not_verified" and info.value.status == 409
    with pytest.raises(SavedAnalysisError) as info:
        _export(draft["id"], version=1)
    assert info.value.code == "not_verified"
    assert info.value.details == {"version": 1, "status": "draft"}

    verified = _analysis(ALL_TYPES, MIN_ID)
    service.add_version(
        verified["id"],
        {"sql": ALL_TYPES, "params": MIN_ID, "column_hints": {}, "sample_params": {}},
        "author",
    )
    with pytest.raises(SavedAnalysisError) as info:
        _export(verified["id"], version=2)
    assert info.value.code == "not_verified"
    assert _export(verified["id"])["version"] == 1  # latest verified

    service.change_status(verified["id"], 1, "retired", user_id="rev", note=None)
    with pytest.raises(SavedAnalysisError) as info:
        _export(verified["id"], version=1)
    assert info.value.code == "retired"


def test_parameters_are_validated_like_a_run() -> None:
    detail = _analysis(ALL_TYPES, MIN_ID)
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"], supplied_params={"min_id": "x"})
    assert info.value.code == "invalid_params"
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"], supplied_params={"nope": 1})
    assert info.value.code == "invalid_params"


def test_the_sql_guard_applies_to_exports() -> None:
    # A verified version whose SQL the guard refuses can only exist if it was
    # written to the store directly; the export guards it again anyway.
    detail = _analysis("SELECT 1 AS one", [])
    store().query_write(
        saved_analysis_version.update()
        .where(saved_analysis_version.c.analysis_id == detail["id"])
        .values(sql=f"DELETE FROM {FIXTURE}.audit RETURNING note AS one")
    )
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"])
    assert info.value.code == "forbidden_statement"


def test_exports_run_in_a_read_only_transaction(connector: Any) -> None:
    # The guard does not know what a function does; the transaction does.
    detail = _analysis(
        f"SELECT {FIXTURE}.maybe_write(:mode) AS one",
        [
            {
                "name": "mode",
                "type": "enum",
                "values": ["read", "write"],
                "default": "read",
            }
        ],
    )
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"], supplied_params={"mode": "write"})
    assert info.value.code == "forbidden_statement"
    rows = connector.execute(f"SELECT count(*) AS n FROM {FIXTURE}.audit")
    assert int(rows.iloc[0]["n"]) == 0
    record = export_log.list_recent(skip=0, limit=1)[0][0]
    assert record["analysis_id"] == detail["id"] and record["state"] == "failed"
    assert record["error_code"] == "forbidden_statement"


def test_other_connectors_are_not_offered(monkeypatch: pytest.MonkeyPatch) -> None:
    from auto_ontology.connectors.sqlite import SQLiteDatabase

    detail = _analysis("SELECT 1 AS one", [])
    chinook = Path(__file__).parents[4] / "dev_tools/fixtures/sql/chinook.sqlite"
    lite = SQLiteDatabase(f"sqlite:///{chinook}")
    assert stream.supports(lite) is False
    monkeypatch.setattr(service, "get_connector", lambda _name: lite)
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"])
    assert info.value.code == "export_unsupported" and info.value.status == 422


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

SERIES = (
    "SELECT g AS n, repeat('x', 100) AS pad FROM generate_series(1, :n) AS g ORDER BY g"
)
N = [{"name": "n", "type": "int", "default": 10, "min": 1, "max": 2000000}]


def _files(path: Path) -> list[str]:
    return sorted(p.name for p in path.iterdir()) if path.exists() else []


def test_row_cap_refuses_and_leaves_no_file(
    monkeypatch: pytest.MonkeyPatch, export_dir: Path
) -> None:
    detail = _analysis(SERIES, N)
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_MAX_ROWS", "100")
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_CHUNK_ROWS", "30")
    assert _export(detail["id"], supplied_params={"n": 100})["row_count"] == 100
    before = _files(export_dir)
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"], supplied_params={"n": 101})
    assert info.value.code == "export_too_large" and info.value.status == 413
    assert info.value.details == {"max_rows": 100}
    assert _files(export_dir) == before
    record = export_log.list_recent(skip=0, limit=1)[0][0]
    assert record["state"] == "failed" and record["error_code"] == "export_too_large"
    # The statement itself is capped at max + 1.
    assert record["sql"].rstrip().endswith("101")
    assert record["row_count"] == 101


def test_byte_cap_refuses(monkeypatch: pytest.MonkeyPatch, export_dir: Path) -> None:
    detail = _analysis(SERIES, N)
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_MAX_BYTES", "20000")
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_CHUNK_ROWS", "50")
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"], fmt="csv", supplied_params={"n": 1000})
    assert info.value.code == "export_too_large"
    assert info.value.details == {"max_bytes": 20000}
    assert _files(export_dir) == []


def test_time_limit_cancels_the_export(monkeypatch: pytest.MonkeyPatch) -> None:
    detail = _analysis(
        "SELECT count(*) AS n FROM generate_series(1, :n) AS a CROSS JOIN generate_series(1, 1000) AS b",
        [{"name": "n", "type": "int", "default": 1, "min": 1, "max": 100000000}],
    )
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_TIMEOUT_S", "1")
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"], supplied_params={"n": 50000000})
    assert info.value.code == "timeout" and info.value.status == 504
    assert info.value.details == {"timeout_s": 1}


def test_daily_export_count(monkeypatch: pytest.MonkeyPatch) -> None:
    detail = _analysis(SERIES, N)
    used, _ = export_log.usage_since(exports.day_start())
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_DAILY_MAX_COUNT", str(used + 1))
    _export(detail["id"])
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"])
    assert info.value.code == "export_quota_exceeded" and info.value.status == 429
    assert info.value.details["daily_max_exports"] == used + 1
    assert info.value.details["exports_today"] == used + 1
    # A refusal before starting is not an export: the count did not move.
    assert export_log.usage_since(exports.day_start())[0] == used + 1


def test_daily_row_quota(monkeypatch: pytest.MonkeyPatch, export_dir: Path) -> None:
    detail = _analysis(SERIES, N)
    _, rows = export_log.usage_since(exports.day_start())
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_DAILY_MAX_ROWS", str(rows + 15))
    assert _export(detail["id"], supplied_params={"n": 10})["row_count"] == 10
    # 5 rows left today: a 6-row result is refused mid-stream.
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"], supplied_params={"n": 6})
    assert info.value.code == "export_quota_exceeded"
    assert info.value.details["rows_left_today"] == 5
    # The failed attempt read 6 rows, which count; nothing is left now.
    with pytest.raises(SavedAnalysisError) as info:
        _export(detail["id"], supplied_params={"n": 1})
    assert info.value.code == "export_quota_exceeded"


def test_day_starts_at_local_midnight(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAVED_ANALYSES_TIMEZONE", "Asia/Seoul")
    now = dt.datetime(2026, 11, 11, 16, 30, tzinfo=dt.timezone.utc)  # 01:30 KST
    assert exports.day_start(now) == dt.datetime(
        2026, 11, 11, 15, 0, tzinfo=dt.timezone.utc
    )


def test_one_export_at_a_time() -> None:
    detail = _analysis(SERIES, N)
    with exports._export_slot():
        with pytest.raises(SavedAnalysisError) as info:
            _export(detail["id"])
    assert info.value.code == "busy" and info.value.status == 429
    assert _export(detail["id"])["state"] == "ready"


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------


def test_retention_deletes_the_file_and_keeps_the_record(
    monkeypatch: pytest.MonkeyPatch, export_dir: Path
) -> None:
    detail = _analysis(SERIES, N)
    data = _export(detail["id"])
    path = export_dir / data["file"]["name"]
    assert path.exists()
    exports.sweep()  # not yet due
    assert path.exists()

    later = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=2)
    result = exports.sweep(later)
    assert result["expired"] >= 1
    assert not path.exists() and not (export_dir / f"{data['export_id']}.json").exists()
    record = exports.payload(exports.get_export(data["export_id"]))
    assert record["state"] == "expired" and record["file"] is None
    assert record["row_count"] == data["row_count"]
    with pytest.raises(SavedAnalysisError) as info:
        exports.file_for_download(data["export_id"])
    assert info.value.code == "export_expired" and info.value.status == 410


def test_sweep_removes_stray_files(export_dir: Path) -> None:
    export_dir.mkdir(parents=True, exist_ok=True)
    stray = export_dir / f".{uuid.uuid4()}.parquet.partial"
    stray.write_bytes(b"x")
    keep = export_dir / "not-an-export.txt"
    keep.write_bytes(b"x")
    old = dt.datetime.now().timestamp() - 3 * 24 * 3600
    os.utime(stray, (old, old))
    os.utime(keep, (old, old))
    exports.sweep()
    assert not stray.exists() and keep.exists()


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------


def _peak_bytes(analysis_id: str, n: int, fmt: str) -> int:
    pool = pa.default_memory_pool()
    tracemalloc.start()
    try:
        before_arrow = pool.bytes_allocated()
        data = _export(analysis_id, supplied_params={"n": n}, fmt=fmt)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert data["row_count"] == n
    assert pool.bytes_allocated() - before_arrow < 1 << 20  # nothing left behind
    return peak


@pytest.mark.parametrize("fmt", ["parquet", "csv"])
def test_memory_stays_flat_as_the_result_grows(
    monkeypatch: pytest.MonkeyPatch, fmt: str
) -> None:
    monkeypatch.setenv("SAVED_ANALYSES_EXPORT_CHUNK_ROWS", "5000")
    detail = _analysis(SERIES, N)
    small = _peak_bytes(detail["id"], 20_000, fmt)
    large = _peak_bytes(detail["id"], 400_000, fmt)
    # Twenty times the rows. Holding them would take ~20x the memory (400k
    # rows of ~110 bytes is >60 MB of Python objects); chunking keeps the peak
    # where it was.
    assert large < small * 1.5 + (2 << 20), (small, large)
    assert large < 32 << 20, large


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(export_router, prefix="/api")
    return TestClient(app)


def test_http_contract(client: TestClient) -> None:
    detail = _analysis(ALL_TYPES, MIN_ID)
    created = client.post(
        f"/api/saved-analyses/{detail['id']}/export",
        json={"params": {"min_id": 2}},
        headers={"x-auto-ontology-user-id": "token-owner"},
    )
    assert created.status_code == 201, created.text
    data = created.json()["data"]
    assert data["requested_by"] == "token-owner" and data["row_count"] == 4

    got = client.get(f"/api/saved-analysis-exports/{data['export_id']}")
    assert got.status_code == 200 and got.json()["data"]["sha256"] == data["sha256"]

    file = client.get(data["file"]["download_path"])
    assert file.status_code == 200
    assert file.headers["content-type"] == "application/vnd.apache.parquet"
    assert file.headers["x-export-sha256"] == data["sha256"]
    assert hashlib.sha256(file.content).hexdigest() == data["sha256"]
    assert pa.BufferReader  # the bytes are a Parquet file
    assert pq.read_table(pa.BufferReader(file.content)).num_rows == 4

    listed = client.get("/api/saved-analysis-exports?limit=5").json()
    assert listed["data"][0]["export_id"] == data["export_id"]
    assert listed["usage"]["exports"] >= 1
    assert listed["usage"]["limits"]["max_rows"] == 1_000_000

    draft = _analysis(ALL_TYPES, MIN_ID, verify=False)
    refused = client.post(f"/api/saved-analyses/{draft['id']}/export", json={})
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "not_verified"
    assert refused.json()["error"]["status"] == 409

    bad = client.post(
        f"/api/saved-analyses/{detail['id']}/export", json={"format": "xlsx"}
    )
    assert bad.status_code == 422 and "detail" in bad.json()
    missing = client.get(f"/api/saved-analysis-exports/{uuid.uuid4()}")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"
