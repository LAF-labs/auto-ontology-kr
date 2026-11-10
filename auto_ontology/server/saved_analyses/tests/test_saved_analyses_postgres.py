# SPDX-License-Identifier: Apache-2.0

"""Saved analyses end to end against a real Postgres.

The store database doubles as the "customer" database: a throwaway schema
``sa_fixture_<id>`` holds the rows the analyses read, and a real
:class:`PostgresDatabase` connector points at it. Needs ``POSTGRES_*`` and a
migrated schema, like the other DAL suites; CI provides both.
"""

from __future__ import annotations

import os
import threading
import uuid
from decimal import Decimal
from typing import Any, Iterator

import pytest

pytest.importorskip("sqlalchemy")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from auto_ontology.dal import schema as s  # noqa: E402
from auto_ontology.dal.saved_analyses.tables import saved_analysis  # noqa: E402
from auto_ontology.dal.session import store  # noqa: E402
from auto_ontology.server.saved_analyses import executor, service  # noqa: E402
from auto_ontology.server.saved_analyses.errors import SavedAnalysisError  # noqa: E402
from auto_ontology.server.saved_analyses.router import router  # noqa: E402

PREFIX = f"sa_test_{uuid.uuid4().hex[:8]}"
FIXTURE = f"sa_fixture_{uuid.uuid4().hex[:8]}"


@pytest.fixture(scope="module", autouse=True)
def require_schema() -> None:
    if not os.environ.get("POSTGRES_USER"):
        pytest.skip("POSTGRES_* not set")
    try:
        store().query_read("SELECT 1 FROM saved_analysis LIMIT 1")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"saved_analysis table unavailable (alembic upgrade head): {exc}")


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
            status text NOT NULL,
            amount numeric(12, 2) NOT NULL,
            created date NOT NULL,
            big bigint NOT NULL
        );
        INSERT INTO {FIXTURE}.orders VALUES
            (1, 'kim',  'APPROVED', 100.10, '2026-09-15', 9007199254740993),
            (2, 'lee',  'APPROVED', 200.20, '2026-10-01', 1),
            (3, 'park', 'PENDING',   50.05, '2026-10-20', 2),
            (4, 'kim',  'APPROVED',  10.01, '2026-10-31', 3),
            (5, 'choi', 'APPROVED',   1.00, '2026-11-01', 4);
        CREATE TABLE {FIXTURE}.audit (note text);
        CREATE FUNCTION {FIXTURE}.sneaky_write() RETURNS int LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO {FIXTURE}.audit VALUES ('written'); RETURN 1; END $$;
        CREATE VIEW {FIXTURE}.totals AS
            SELECT customer, sum(amount) AS total FROM {FIXTURE}.orders GROUP BY customer;
        """
    )
    try:
        yield db
    finally:
        store().query_write(
            delete(saved_analysis).where(saved_analysis.c.name.like(f"{PREFIX}%"))
        )
        db.execute(f"DROP SCHEMA {FIXTURE} CASCADE")
        db.close()


@pytest.fixture(autouse=True)
def only_this_connector(monkeypatch: pytest.MonkeyPatch, connector: Any) -> None:
    import auto_ontology.connectors.registry as registry

    monkeypatch.setattr(registry, "get_connectors", lambda: [connector])


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Statements that actually reached the database."""
    seen: list[str] = []
    real = service.run_query

    def counting(connector: Any, sql: str, **kwargs: Any) -> Any:
        seen.append(sql)
        return real(connector, sql, **kwargs)

    monkeypatch.setattr(service, "run_query", counting)
    return seen


def _name() -> str:
    return f"{PREFIX}_{uuid.uuid4().hex[:6]}"


def _create(sql: str, params: list | None = None, **extra: Any) -> dict[str, Any]:
    body = {
        "name": _name(),
        "description": "test",
        "database_name": "auto_ontology",
        "sql": sql,
        "params": params or [],
        "column_hints": {},
        "sample_params": {},
        **extra,
    }
    return service.create_analysis(body, "user-1")


MONTHLY = f"""
SELECT count(*) AS orders, sum(amount) AS total
FROM {FIXTURE}.orders
WHERE created >= :start_date AND created < :end_date AND status IN (:statuses)
"""
MONTHLY_PARAMS = [
    {"name": "start_date", "type": "date", "default": "2026-10-01"},
    {"name": "end_date", "type": "date", "default": "2026-11-01"},
    {
        "name": "statuses",
        "type": "list<enum>",
        "values": ["APPROVED", "PENDING"],
        "default": ["APPROVED"],
    },
]


def _verified(
    sql: str = MONTHLY, params: list | None = None, **extra: Any
) -> dict[str, Any]:
    detail = _create(sql, MONTHLY_PARAMS if params is None else params, **extra)
    service.change_status(
        detail["id"], 1, "verified", user_id="reviewer", note="checked by hand"
    )
    return detail


# ---------------------------------------------------------------------------
# Save
# ---------------------------------------------------------------------------


def test_save_fixes_typed_columns_and_returns_a_preview() -> None:
    detail = _create(
        f"SELECT id, customer, amount, created, big FROM {FIXTURE}.orders ORDER BY id",
        column_hints={"amount": {"unit": "KRW", "label": "금액"}},
    )
    version = detail["version"]
    assert version["status"] == "draft"
    assert [(c["name"], c["type"], c["role"]) for c in version["columns"]] == [
        ("id", "integer", "measure"),
        ("customer", "string", "dimension"),
        ("amount", "decimal", "measure"),
        ("created", "date", "time"),
        ("big", "integer", "measure"),
    ]
    assert version["columns"][2]["unit"] == "KRW"
    preview = detail["preview"]
    assert preview["read_only_transaction"] is True
    # Decimals and integers beyond 2**53 are strings: no digit is lost.
    assert preview["rows"][0] == [1, "kim", "100.10", "2026-09-15", "9007199254740993"]
    assert preview["row_count"] == 5 and preview["truncated"] is False


def test_save_records_referenced_tables_and_resolves_catalog_ids() -> None:
    db_id = store().query_write(
        s.catalog_database.insert()
        .values(name="auto_ontology")
        .returning(s.catalog_database.c.id)
    )[0]["id"]
    try:
        schema_id = store().query_write(
            s.catalog_schema.insert()
            .values(database_id=db_id, name=FIXTURE)
            .returning(s.catalog_schema.c.id)
        )[0]["id"]
        table_id = store().query_write(
            s.catalog_table.insert()
            .values(schema_id=schema_id, name="orders")
            .returning(s.catalog_table.c.id)
        )[0]["id"]
        detail = _create(
            f"WITH o AS (SELECT * FROM {FIXTURE}.orders) "
            f"SELECT o.customer, t.total FROM o JOIN {FIXTURE}.totals t ON t.customer = o.customer"
        )
        tables = {
            (t["schema_name"], t["table_name"]): t["table_id"]
            for t in detail["version"]["tables"]
        }
        assert tables == {(FIXTURE, "orders"): table_id, (FIXTURE, "totals"): None}
        assert detail["preview"]["unresolved_tables"] == [f"{FIXTURE}.totals"]
    finally:
        store().query_write(
            delete(s.catalog_database).where(s.catalog_database.c.id == db_id)
        )


@pytest.mark.parametrize(
    ("sql", "code"),
    [
        (f"DELETE FROM {FIXTURE}.orders", "forbidden_statement"),
        (f"UPDATE {FIXTURE}.orders SET amount = 0", "forbidden_statement"),
        (f"DROP TABLE {FIXTURE}.orders", "forbidden_statement"),
        (f"SELECT 1 AS a; DELETE FROM {FIXTURE}.orders", "forbidden_statement"),
        (f"SELECT id, id FROM {FIXTURE}.orders", "duplicate_columns"),
        (f"SELECT * FROM {FIXTURE}.orders WHERE id = :undefined", "invalid_definition"),
        (f"SELECT * FROM {FIXTURE}.nope", "db_error"),
    ],
)
def test_save_rejects(sql: str, code: str) -> None:
    with pytest.raises(SavedAnalysisError) as info:
        _create(sql)
    assert info.value.code == code


def test_the_read_only_transaction_stops_a_write_the_guard_cannot_see(
    connector: Any,
) -> None:
    # The guard knows nothing about this user-defined function; the database
    # refuses the INSERT inside it because the transaction is read-only.
    with pytest.raises(SavedAnalysisError) as info:
        _create(f"SELECT {FIXTURE}.sneaky_write() AS w")
    assert info.value.code == "forbidden_statement"
    assert (
        connector.execute(f"SELECT count(*) AS n FROM {FIXTURE}.audit").iloc[0, 0] == 0
    )


def test_names_are_unique() -> None:
    detail = _create(f"SELECT 1 AS one FROM {FIXTURE}.orders LIMIT 1")
    with pytest.raises(SavedAnalysisError) as info:
        service.create_analysis(
            {
                "name": detail["name"],
                "database_name": "auto_ontology",
                "sql": "SELECT 1 AS one",
                "params": [],
            },
            None,
        )
    assert info.value.code == "name_conflict"


def test_unknown_database() -> None:
    with pytest.raises(SavedAnalysisError) as info:
        service.create_analysis(
            {"name": _name(), "database_name": "nope", "sql": "SELECT 1 AS a"}, None
        )
    assert info.value.code == "unknown_database"


# ---------------------------------------------------------------------------
# Status and versions
# ---------------------------------------------------------------------------


def test_drafts_run_only_by_number_and_retired_never() -> None:
    detail = _create(MONTHLY, MONTHLY_PARAMS)
    with pytest.raises(SavedAnalysisError) as info:
        service.run_analysis(detail["id"])
    assert info.value.code == "not_verified"
    assert service.run_analysis(detail["id"], version=1)["status"] == "draft"

    verified = service.change_status(
        detail["id"], 1, "verified", user_id="reviewer", note="ok"
    )
    assert verified["version"]["verified_by"] == "reviewer"
    assert verified["latest_verified_version"] == 1
    assert service.run_analysis(detail["id"])["version"] == 1

    with pytest.raises(SavedAnalysisError) as info:
        service.change_status(detail["id"], 1, "verified", user_id="x", note=None)
    assert info.value.code == "invalid_status_transition"

    service.change_status(detail["id"], 1, "retired", user_id="x", note="replaced")
    for version in (None, 1):
        with pytest.raises(SavedAnalysisError) as info:
            service.run_analysis(detail["id"], version=version)
        assert info.value.code in ("not_verified", "retired")


def test_versions_are_immutable() -> None:
    detail = _verified()
    v1_sql = detail["version"]["sql"]
    v2 = service.add_version(
        detail["id"],
        {
            "sql": f"SELECT count(*) AS orders FROM {FIXTURE}.orders",
            "params": [],
            "description": "v2",
        },
        "user-2",
    )
    assert v2["version"]["version"] == 2 and v2["version"]["status"] == "draft"
    assert v2["latest_version"] == 2 and v2["latest_verified_version"] == 1
    assert service.get_detail(detail["id"], 1)["version"]["sql"] == v1_sql
    # No version given: still the verified v1, not the newer draft.
    assert service.run_analysis(detail["id"])["version"] == 1
    assert service.get_detail(detail["id"])["version"]["version"] == 1


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def test_parameters_are_bound_and_the_numbers_match_a_hand_query(
    connector: Any,
) -> None:
    detail = _verified()
    result = service.run_analysis(
        detail["id"],
        supplied_params={
            "start_date": "2026-10-01",
            "end_date": "2026-11-01",
            "statuses": ["APPROVED", "PENDING"],
        },
    )
    expected = connector.execute(
        f"SELECT count(*) AS n, sum(amount) AS t FROM {FIXTURE}.orders "
        "WHERE created >= '2026-10-01' AND created < '2026-11-01'"
    )
    assert result["rows"] == [
        [int(expected.iloc[0, 0]), format(Decimal(expected.iloc[0, 1]), "f")]
    ]
    assert result["rows"] == [[3, "260.26"]]
    assert result["params"] == {
        "start_date": "2026-10-01",
        "end_date": "2026-11-01",
        "statuses": ["APPROVED", "PENDING"],
    }
    assert "CAST('2026-10-01' AS DATE)" in result["sql"]
    assert "IN ('APPROVED', 'PENDING')" in result["sql"]
    assert result["source"] == {
        "database_name": "auto_ontology",
        "tables": [f"{FIXTURE}.orders"],
    }

    defaults = service.run_analysis(detail["id"])
    assert defaults["rows"] == [[2, "210.21"]]  # APPROVED only


def test_invalid_params_are_rejected_before_running(calls: list[str]) -> None:
    detail = _verified()
    calls.clear()
    with pytest.raises(SavedAnalysisError) as info:
        service.run_analysis(
            detail["id"], supplied_params={"statuses": ["DELETED"], "extra": 1}
        )
    assert info.value.code == "invalid_params"
    assert set(info.value.details["params"]) == {"statuses", "extra"}
    assert calls == []


def test_cache_hits_until_max_age_or_new_params(calls: list[str]) -> None:
    detail = _verified()
    calls.clear()
    first = service.run_analysis(detail["id"])
    second = service.run_analysis(detail["id"], max_age_s=3600)
    assert first["cache"]["hit"] is False and second["cache"]["hit"] is True
    assert (
        second["executed_at"] == first["executed_at"]
        and second["rows"] == first["rows"]
    )
    assert len(calls) == 1

    fresh = service.run_analysis(detail["id"], max_age_s=0)
    assert fresh["cache"]["hit"] is False and len(calls) == 2

    # Same values spelt differently share a key; different values do not.
    service.run_analysis(detail["id"], supplied_params={"start_date": "2026-10-01"})
    assert len(calls) == 2
    service.run_analysis(detail["id"], supplied_params={"start_date": "2026-09-01"})
    assert len(calls) == 3


def test_cache_expires_with_the_version_ttl(calls: list[str]) -> None:
    detail = _verified(cache_ttl_s=0)
    calls.clear()
    service.run_analysis(detail["id"])
    service.run_analysis(detail["id"])
    assert len(calls) == 2


def test_row_limit_truncates_and_cannot_be_raised() -> None:
    detail = _verified(
        f"SELECT id FROM {FIXTURE}.orders ORDER BY id", params=[], row_limit=3
    )
    full = service.run_analysis(detail["id"])
    assert (
        full["rows"] == [[1], [2], [3]]
        and full["truncated"] is True
        and full["row_count"] == 3
    )
    assert "LIMIT 4" in full["sql"]
    smaller = service.run_analysis(detail["id"], row_limit=2)
    assert smaller["rows"] == [[1], [2]] and smaller["truncated"] is True
    with pytest.raises(SavedAnalysisError) as info:
        service.run_analysis(detail["id"], row_limit=10)
    assert info.value.code == "invalid_params"


def test_timeout() -> None:
    detail = _verified(
        "SELECT count(*) AS n FROM generate_series(1, :n) AS g",
        params=[{"name": "n", "type": "int", "default": 10, "max": 2_000_000_000}],
        timeout_s=1,
    )
    with pytest.raises(SavedAnalysisError) as info:
        service.run_analysis(detail["id"], supplied_params={"n": 1_000_000_000})
    assert info.value.code == "timeout" and info.value.status == 504


def test_busy_when_the_database_has_no_free_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    detail = _verified()
    monkeypatch.setenv("SAVED_ANALYSES_MAX_CONCURRENCY_PER_DB", "1")
    monkeypatch.setenv("SAVED_ANALYSES_QUEUE_TIMEOUT_S", "1")
    with service.database_slot("auto_ontology"):
        with pytest.raises(SavedAnalysisError) as info:
            service.run_analysis(detail["id"], max_age_s=0)
    assert info.value.code == "busy" and info.value.status == 429
    assert service.run_analysis(detail["id"], max_age_s=0)["cache"]["hit"] is False


def test_identical_concurrent_runs_execute_once(calls: list[str]) -> None:
    detail = _verified(
        "SELECT sum(g) AS s FROM generate_series(1, :n) AS g",
        params=[{"name": "n", "type": "int", "default": 3_000_000}],
    )
    calls.clear()
    barrier = threading.Barrier(3)
    results: list[dict[str, Any]] = []

    def run() -> None:
        barrier.wait()
        results.append(service.run_analysis(detail["id"], max_age_s=0))

    threads = [threading.Thread(target=run) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(calls) == 1
    assert {r["executed_at"] for r in results} == {results[0]["executed_at"]}
    assert sorted(r["cache"]["shared"] for r in results) == [False, True, True]


def test_schema_mismatch_keeps_the_last_success(connector: Any) -> None:
    view = f"{FIXTURE}.mismatch_{uuid.uuid4().hex[:6]}"
    connector.execute(
        f"CREATE VIEW {view} AS SELECT customer, amount FROM {FIXTURE}.orders"
    )
    detail = _verified(
        f"SELECT customer, amount FROM {view} ORDER BY customer, amount", params=[]
    )
    good = service.run_analysis(detail["id"])
    connector.execute(
        f"DROP VIEW {view}; CREATE VIEW {view} AS SELECT customer, amount::text AS amount FROM {FIXTURE}.orders"
    )
    with pytest.raises(SavedAnalysisError) as info:
        service.run_analysis(detail["id"], max_age_s=0)
    assert info.value.code == "schema_mismatch"
    last = info.value.last_success
    assert last["rows"] == good["rows"] and last["executed_at"] == good["executed_at"]

    connector.execute(f"DROP VIEW {view}")
    with pytest.raises(SavedAnalysisError) as info:
        service.run_analysis(detail["id"], max_age_s=0)
    assert info.value.code == "db_error"
    assert info.value.last_success["rows"] == good["rows"]


def test_batch_runs_identical_items_once_and_isolates_errors(calls: list[str]) -> None:
    detail = _verified()
    calls.clear()
    out = service.run_batch(
        [
            {
                "key": "w1",
                "analysis_id": detail["id"],
                "params": {"start_date": "2026-09-01"},
            },
            {
                "key": "w2",
                "analysis_id": detail["id"],
                "params": {"start_date": "2026-09-01"},
            },
            {
                "key": "w3",
                "analysis_id": detail["id"],
                "params": {"statuses": ["nope"]},
            },
            {"key": "w4", "analysis_id": "missing"},
        ],
        default_max_age_s=0,
    )
    assert list(out) == ["w1", "w2", "w3", "w4"]
    assert out["w1"] == out["w2"] and out["w1"]["data"]["rows"] == [[3, "310.31"]]
    assert out["w3"]["error"]["code"] == "invalid_params"
    assert out["w4"]["error"]["code"] == "not_found"
    assert len(calls) == 1

    with pytest.raises(SavedAnalysisError) as info:
        service.run_batch(
            [{"key": "a", "analysis_id": "x"}, {"key": "a", "analysis_id": "y"}], None
        )
    assert info.value.code == "invalid_params"


# ---------------------------------------------------------------------------
# HTTP shape
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    return TestClient(app)


def test_http_contract(client: TestClient) -> None:
    created = client.post(
        "/api/saved-analyses",
        json={
            "name": _name(),
            "database_name": "auto_ontology",
            "sql": MONTHLY,
            "params": MONTHLY_PARAMS,
            "column_hints": {"total": {"unit": "KRW"}},
        },
        headers={"x-auto-ontology-user-id": "admin-1"},
    )
    assert created.status_code == 201, created.text
    analysis = created.json()["data"]
    assert analysis["created_by"] == "admin-1"
    analysis_id = analysis["id"]

    not_verified = client.post(f"/api/saved-analyses/{analysis_id}/run", json={})
    assert not_verified.status_code == 409
    assert not_verified.json()["error"]["code"] == "not_verified"

    verified = client.post(
        f"/api/saved-analyses/{analysis_id}/versions/1/verify",
        json={"note": "matches the finance report"},
        headers={"x-auto-ontology-user-id": "admin-1"},
    )
    assert (
        verified.status_code == 200
        and verified.json()["data"]["version"]["verified_by"] == "admin-1"
    )

    run = client.post(
        f"/api/saved-analyses/{analysis_id}/run",
        json={"params": {"start_date": "2026-10-01"}},
    )
    assert run.status_code == 200
    data = run.json()["data"]
    assert data["rows"] == [[2, "210.21"]]
    assert data["columns"][1] == {
        "name": "total",
        "type": "decimal",
        "role": "measure",
        "unit": "KRW",
        "label": None,
        "description": None,
    }

    # No body at all: latest verified version, default parameters.
    bare = client.post(f"/api/saved-analyses/{analysis_id}/run")
    assert bare.status_code == 200 and bare.json()["data"]["rows"] == [[2, "210.21"]]

    listing = client.get(
        "/api/saved-analyses", params={"query": analysis["name"], "status": "verified"}
    )
    assert listing.status_code == 200 and listing.json()["total"] == 1

    assert (
        client.get(f"/api/saved-analyses/{analysis_id}").json()["data"]["version"][
            "version"
        ]
        == 1
    )

    bad = client.post(
        f"/api/saved-analyses/{analysis_id}/run",
        json={"params": {"start_date": "yesterday"}},
    )
    assert bad.status_code == 422
    assert set(bad.json()["error"]) == {"code", "message", "details", "last_success"}

    missing = client.get("/api/saved-analyses/does-not-exist")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"

    forbidden = client.post(
        "/api/saved-analyses",
        json={
            "name": _name(),
            "database_name": "auto_ontology",
            "sql": f"DELETE FROM {FIXTURE}.orders",
        },
    )
    assert (
        forbidden.status_code == 422
        and forbidden.json()["error"]["code"] == "forbidden_statement"
    )

    typo = client.post(f"/api/saved-analyses/{analysis_id}/run", json={"parmas": {}})
    assert typo.status_code == 422 and "detail" in typo.json()

    batch = client.post(
        "/api/saved-analyses/run-batch",
        json={"items": [{"key": "kpi", "analysis_id": analysis_id}], "max_age_s": 3600},
    )
    # Same version and values as the run above, so it comes from the cache.
    assert (
        batch.status_code == 200
        and batch.json()["data"]["kpi"]["data"]["cache"]["hit"] is True
    )

    retired = client.post(f"/api/saved-analyses/{analysis_id}/versions/1/retire")
    assert retired.status_code == 200
    assert retired.json()["data"]["version"]["status"] == "retired"
    again = client.post(f"/api/saved-analyses/{analysis_id}/versions/1/verify")
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "invalid_status_transition"


def test_executor_serialises_values() -> None:
    import datetime as dt

    assert (
        executor.to_json_value(Decimal("1234567890123456789.01"))
        == "1234567890123456789.01"
    )
    assert executor.to_json_value(2**60) == str(2**60)
    assert executor.to_json_value(float("nan")) is None
    assert (
        executor.to_json_value(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc))
        == "2026-01-01T00:00:00+00:00"
    )
    assert executor.to_json_value(b"\xff") == "base64:/w=="
