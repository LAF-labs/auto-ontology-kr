<!--
SPDX-License-Identifier: Apache-2.0
-->

# 저장된 분석 API (Saved Analyses) — 계약 문서

이 포크(`kr/product`)에만 있는 API다. 대시보드는 SQL 대신 **분석 ID**를 가리키고, 이 API로 LLM 없이 실행한다.
하네스 쪽은 이 문서를 계약으로 쓴다. 문서와 코드가 다르면 코드가 버그다.

- 백엔드 코드: `auto_ontology/server/saved_analyses/`, 저장소: `auto_ontology/dal/saved_analyses/`
- 마이그레이션: `alembic/versions/bca054972e72_add_saved_analyses.py`
- 게이트웨이 라우트: `frontend/app/api/saved-analyses/**/route.ts`
- 기계용 스펙: `docs/openapi/auto-ontology-api.json`(게이트웨이), `docs/openapi/backend.json`(FastAPI)

## 1. 호출 경로와 인증

항상 Next.js 게이트웨이 `:3000`을 부른다. FastAPI `:3001`은 사설망 전용이다(`x-auto-ontology-user-id` 헤더를 검증 없이 믿는다).

```
x-api-key: auto_ontology_…          # 또는 Authorization: Bearer auto_ontology_…
Content-Type: application/json
```

| 메서드·경로 | 권한 | 용도 |
| --- | --- | --- |
| `GET  /api/saved-analyses` | `analysis:read` | 목록 |
| `POST /api/saved-analyses` | `analysis:manage` | 새 분석 저장(버전 1, draft) |
| `GET  /api/saved-analyses/{analysis_id}` | `analysis:read` | 단건 조회(버전 목록 + 한 버전 전체) |
| `POST /api/saved-analyses/{analysis_id}/versions` | `analysis:manage` | 새 draft 버전 추가 |
| `POST /api/saved-analyses/{analysis_id}/versions/{version}/verify` | `analysis:manage` | 검증 완료 표시(누가·언제 기록) |
| `POST /api/saved-analyses/{analysis_id}/versions/{version}/retire` | `analysis:manage` | 폐기(다시 실행 불가) |
| `POST /api/saved-analyses/{analysis_id}/run` | `analysis:read` | 실행(또는 캐시 응답) |
| `POST /api/saved-analyses/run-batch` | `analysis:read` | 여러 분석을 한 번에 실행(대시보드 한 화면) |

`analysis:read`는 viewer와 admin 모두, `analysis:manage`는 admin만 가진다. manage 경로는 호출자 id를
`created_by`·`verified_by`로 기록한다. 대시보드 런타임은 viewer 토큰, 분석 등록(수정 세션)은 admin 토큰을 쓰기를 권장한다.

게이트웨이 단계 오류는 본문 형식이 다르다: `401 {"error": "Unauthorized"}`, `403 {"error": "Forbidden"}`(문자열).

## 2. 개념

- **분석(analysis)**: 이름(고유), 설명, 실행할 DB(`database_name` = 커넥터의 `database_name`), 버전들.
- **버전(version)**: 1부터 증가. SQL·파라미터 정의·결과 컬럼 구조·상한은 **저장 후 바뀌지 않는다.** 바뀌는 것은 상태와 검증 기록뿐이다.
- **상태**: `draft` → `verified` → `retired`, 또는 `draft` → `retired`. 되돌릴 수 없다.
- **실행 버전 결정**: `version`을 생략하면 **최신 verified 버전**. 없으면 `409 not_verified`.
  `version`을 주면 draft도 실행된다(응답 `status`에 표시). retired는 `409 retired`.
- 대시보드 스펙은 `analysis_id`를 저장하고, 숫자를 고정하고 싶으면 `version`도 저장한다.

## 3. 저장 — `POST /api/saved-analyses`

```json
{
  "name": "월별 승인된 리뷰 증빙 수",
  "description": "승인일 기준, 기간은 [start_date, end_date)",
  "database_name": "renewal_kreview",
  "sql": "SELECT COUNT(review_proof_id) AS approved_count\nFROM review_proofs\nWHERE approved_at >= :start_date AND approved_at < :end_date\n  AND status IN (:statuses)",
  "params": [
    {"name": "start_date", "type": "date", "required": true, "default": "month_start(-1)", "label": "시작일"},
    {"name": "end_date",   "type": "date", "default": "month_start(0)"},
    {"name": "statuses",   "type": "list<enum>", "values": ["APPROVED", "PENDING"], "default": ["APPROVED"]}
  ],
  "column_hints": {"approved_count": {"role": "measure", "unit": "건", "label": "승인 건수"}},
  "row_limit": 5000,
  "timeout_s": 30,
  "cache_ttl_s": 3600,
  "sample_params": {}
}
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `name` | 예 | 1–200자, 전체에서 고유. 중복이면 `409 name_conflict` |
| `description` | | 최대 5000자 |
| `database_name` | 예 | 등록된 연결 중 하나. 없으면 `422 unknown_database`(`details.available`에 목록) |
| `sql` | 예 | 단일 SELECT/WITH/UNION. 파라미터는 `:이름`. 4절 규칙 |
| `params` | | 파라미터 정의 목록. 5절 |
| `column_hints` | | 결과 컬럼별 `role`(`dimension`·`measure`·`time`), `unit`(≤32자), `label`, `description`. 타입은 줄 수 없다(실행해서 관찰한다). 결과에 없는 컬럼 이름이면 `422 invalid_definition` |
| `row_limit` | | 이 버전의 행 상한. 기본 5000, 최대 50000 |
| `timeout_s` | | 실행 시간 상한(초). 기본 30, 최대 300 |
| `cache_ttl_s` | | 결과 캐시 유효 시간(초). 기본 3600, 최대 604800(7일). 0이면 캐시하지 않음 |
| `sample_params` | | 저장 시 검증 실행에 쓸 값. 기본값 없는 required 파라미터에 필요 |

요청 본문에 모르는 키가 있으면 FastAPI 기본 422(`{"detail": [...]}`)가 난다. 오타를 조용히 무시하지 않기 위해서다.

**저장할 때 하는 일**: (1) SQL 가드(4절), (2) 자리표시자와 정의가 정확히 일치하는지 확인(정의 없는 자리표시자, 쓰지 않는 정의 모두 거부),
(3) 기본값(+`sample_params`)으로 **한 번 실제 실행**, (4) 관찰한 결과 컬럼 이름·타입을 버전에 고정(같은 이름 컬럼이 둘이면 `422 duplicate_columns`),
(5) 참조 테이블 목록 저장(6절).

`201` 응답은 단건 조회(§4)와 같은 `data`에 `preview`를 더한다.

```json
{
  "data": {
    "id": "6d1c…", "name": "월별 승인된 리뷰 증빙 수", "...": "…단건 조회와 같음…",
    "preview": {
      "params": {"start_date": "2026-10-01", "end_date": "2026-11-01", "statuses": ["APPROVED"]},
      "columns": [{"name": "approved_count", "type": "integer", "role": "measure", "unit": "건", "label": "승인 건수", "description": null}],
      "rows": [[1234]],
      "row_count": 1,
      "truncated": false,
      "duration_ms": 41,
      "read_only_transaction": true,
      "sql": "SELECT COUNT(review_proof_id) …\nLIMIT 5001",
      "unresolved_tables": []
    }
  }
}
```

`preview.rows`는 최대 100행만 담는다(`row_count`는 실제 행 수). `unresolved_tables`는 카탈로그에서 id를 찾지 못한 테이블이다(저장은 된다. 6절).

새 버전: `POST /api/saved-analyses/{analysis_id}/versions`. 본문은 위에서 `name`, `database_name`을 뺀 것이다.
`description`을 주면 분석 설명을 바꾼다. 응답은 새 버전 기준의 단건 조회 + `preview`, `201`. 새 버전은 draft이므로
**verify 하기 전까지 버전 없는 실행은 이전 verified 버전을 계속 쓴다.**

## 4. SQL 규칙

허용: 단일 문장, 최상위가 `SELECT`, `WITH … SELECT`, `UNION/INTERSECT/EXCEPT`, 또는 괄호로 감싼 쿼리. 끝의 `;`과 주석은 괜찮다.

거부(`422 forbidden_statement`): 여러 문장, `INSERT/UPDATE/DELETE/MERGE`, DDL(`CREATE/DROP/ALTER/TRUNCATE`), `GRANT/REVOKE`, `COPY`, `SET`,
트랜잭션 제어, `SELECT … INTO`, `FOR UPDATE/SHARE`, 쓰기 CTE(`WITH d AS (DELETE …)`), `EXPLAIN`·`VACUUM` 등 파서가 명령으로 보는 것,
`$1`·`@var` 같은 위치·세션 변수, 그리고 부작용·파일·네트워크·문자열 SQL 실행 함수
(`pg_sleep`, `set_config`, `nextval`, `query_to_xml`, `dblink*`, `lo_*`, `pg_read_file`, `sleep`, `benchmark`, `load_file`, `get_lock`,
`read_csv`·`read_parquet` 등. 전체 목록은 `sqltext.FORBIDDEN_FUNCTIONS`), 파일 경로처럼 보이는 테이블 이름. 파싱 실패는 `422 parse_error`.

자리표시자: `:이름`(영문자·숫자·밑줄, 영문자나 밑줄로 시작). 콜론 앞에 공백이나 연산자·괄호·쉼표가 있어야 한다(`= :x`, `(:x)`, `>=:x`).
`?`, `%s` 같은 이름 없는 자리표시자와 `obj:field` 같은 JSON 경로 콜론은 `422 unsupported_placeholder`. 문자열 리터럴과 주석 안의 `:x`는 무시된다.
같은 이름을 여러 번 써도 된다. `list<…>` 파라미터는 `컬럼 IN (:이름)` 형태로만 쓸 수 있다.

**실행되는 SQL은 저장한 텍스트 그대로다.** 자리표시자 위치만 리터럴로 바꾸고, 행 상한을 덧붙인다. 상한은 최상위에 `LIMIT`/`OFFSET`이 없으면
끝에 `\nLIMIT n+1`을 붙이고, 있으면 `SELECT * FROM (\n원문\n) AS _saved_analysis_rows\nLIMIT n+1`로 감싼다. 응답의 `sql`이 실제로 실행한 문장이다.

## 5. 파라미터

정의 키: `name`, `type`, `required`(기본 false), `default`, `values`(enum 전용), `min`, `max`(date·datetime·int·number 전용), `label`, `description`.
`default`가 없으면 `required: true`여야 한다.

| type | 요청 값 | 정규화된 값(응답 `params`, 캐시 키) | SQL 리터럴 |
| --- | --- | --- | --- |
| `date` | `"2026-10-01"` 또는 상대 날짜 | `"2026-10-01"` | `CAST('2026-10-01' AS DATE)` |
| `datetime` | ISO 8601(`"2026-10-01T09:00:00"`, 오프셋 있으면 서버 시간대로 변환) 또는 상대 날짜(자정) | `"2026-10-01T09:00:00"` | `CAST('2026-10-01 09:00:00' AS TIMESTAMP)`(MySQL은 `DATETIME`) |
| `int` | 정수 또는 정수 문자열, ±(2^53−1) 이내 | `7` | `7`, 음수는 `(-7)` |
| `number` | 숫자 또는 숫자 문자열 | `"0.5"`(문자열) | `0.5`, 음수는 괄호 |
| `string` | 문자열 ≤1000자, NUL 불가 | 그대로 | 방언에 맞게 이스케이프한 문자열 |
| `enum` | `values` 중 하나 | 그대로 | 문자열 리터럴 |
| `bool` | `true`/`false` | 그대로 | `TRUE`/`FALSE` |
| `list<T>` | 1–1000개 배열 | 배열 | `a, b, c` |

상대 날짜: `today`, `today(-7)`, `week_start(0)`(월요일), `month_start(-1)`, `quarter_start(0)`, `year_start(-1)`. 괄호 안은 그 단위의 오프셋이다.
기준 시간대는 `SAVED_ANALYSES_TIMEZONE`(기본 `Asia/Seoul`). 상대 날짜는 요청 값으로도 쓸 수 있고, 실행 시점에 구체 날짜로 바뀐 뒤 캐시 키가 된다.

잘못된 값은 실행 전에 `422 invalid_params`로 거부한다. `details.params`에 파라미터별 이유가 있다:
`{"params": {"statuses": "'DELETED' is not one of ['APPROVED', 'PENDING']", "extra": "is not a parameter of this analysis"}}`.

## 6. 참조 테이블

저장 시 SQL의 AST에서 기본 테이블을 뽑는다(CTE 이름과 `generate_series` 같은 테이블 함수 제외). `version.tables`에
`{"database_name", "schema_name", "table_name", "table_id"}`로 저장한다. `table_id`는 저장 시점의 카탈로그 id이고, 찾지 못하면 `null`이다.
재수집하면 카탈로그 id가 바뀌므로 **권한 판정은 이름(DB·스키마·테이블)으로 한다.** 저장할 때 실제로 실행하므로 테이블이 존재한다는 것은 이미 확인된다.
`schema_name`이 `null`이면 SQL에 스키마 없이 썼고 카탈로그에서도 하나로 정하지 못한 경우다.

## 7. 조회

`GET /api/saved-analyses?query=&status=&skip=&limit=` — 이름순. `query`는 이름·설명 부분 일치, `status=verified`는 verified 버전이 있는 것,
`status=draft`는 없는 것. `limit`은 최대 100, 생략하면 전부.

```json
{"data": [{"id": "…", "name": "…", "description": "…", "database_name": "renewal_kreview",
           "latest_version": 2, "latest_verified_version": 1,
           "created": "2026-11-10T07:00:00Z", "created_by": "…", "updated": "2026-11-10T08:00:00Z"}],
 "count": 1, "total": 1}
```

`GET /api/saved-analyses/{analysis_id}?version=` — `version`을 생략하면 최신 verified, 없으면 최신 버전.

```json
{
  "data": {
    "id": "…", "name": "…", "description": "…", "database_name": "renewal_kreview",
    "latest_version": 2, "latest_verified_version": 1, "created": "…", "created_by": "…", "updated": "…",
    "versions": [
      {"version": 1, "status": "verified", "created": "…", "created_by": "…", "verified_at": "…", "verified_by": "…"},
      {"version": 2, "status": "draft", "created": "…", "created_by": "…", "verified_at": null, "verified_by": null}
    ],
    "version": {
      "version": 1, "status": "verified",
      "sql": "…:start_date…", "params": [ … 정의 … ],
      "columns": [{"name": "approved_count", "type": "integer", "role": "measure", "unit": "건", "label": "승인 건수", "description": null}],
      "row_limit": 5000, "timeout_s": 30, "cache_ttl_s": 3600,
      "tables": [{"database_name": "renewal_kreview", "schema_name": "renewal_kreview", "table_name": "review_proofs", "table_id": "…"}],
      "verified_by": "…", "verified_at": "…", "verification_note": "재무 보고서와 대조", "created": "…", "created_by": "…"
    }
  }
}
```

상태 변경: `POST …/versions/{version}/verify`, `POST …/versions/{version}/retire`, 본문 `{"note": "…"}`(선택). 응답은 그 버전 기준의 단건 조회.
허용되지 않는 전이(verified를 다시 verify, retired를 바꾸기 등)는 `409 invalid_status_transition`.

## 8. 실행 — `POST /api/saved-analyses/{analysis_id}/run`

```json
{"version": 1, "params": {"start_date": "2026-10-01", "end_date": "2026-11-01"}, "max_age_s": 3600, "row_limit": 1000}
```

모두 선택이다. 본문을 비우면(`{}` 또는 본문 없음) 최신 verified 버전을 기본값으로 실행한다.

| 필드 | 설명 |
| --- | --- |
| `version` | 생략하면 최신 verified |
| `params` | 생략한 파라미터는 기본값 |
| `max_age_s` | 받아들일 캐시의 최대 나이(초). 생략하면 버전의 `cache_ttl_s` 안이면 캐시. `0`이면 항상 새로 실행 |
| `row_limit` | 응답 행 수. 버전의 `row_limit`을 넘으면 `422 invalid_params` |

`200` 응답:

```json
{
  "data": {
    "analysis_id": "…", "name": "월별 승인된 리뷰 증빙 수", "version": 1, "status": "verified",
    "params": {"start_date": "2026-10-01", "end_date": "2026-11-01", "statuses": ["APPROVED"]},
    "columns": [{"name": "approved_count", "type": "integer", "role": "measure", "unit": "건", "label": "승인 건수", "description": null}],
    "rows": [[1234]],
    "row_count": 1,
    "truncated": false,
    "executed_at": "2026-11-10T07:12:03.123456Z",
    "duration_ms": 412,
    "cache": {"hit": true, "shared": false, "expires_at": "2026-11-10T08:12:03.123456Z"},
    "source": {"database_name": "renewal_kreview", "tables": ["renewal_kreview.review_proofs"]},
    "sql": "SELECT COUNT(review_proof_id) AS approved_count\nFROM review_proofs\nWHERE approved_at >= CAST('2026-10-01' AS DATE) …\nLIMIT 5001"
  }
}
```

- `columns`는 저장 시 고정한 구조이고, `rows`는 그 순서를 따르는 배열의 배열이다.
- 값 직렬화: `integer`는 JSON 정수(단, ±(2^53−1)을 넘으면 **문자열**), `number`는 JSON 실수(NaN·무한대는 `null`), `decimal`은 **문자열**(`"260.26"`, 자릿수 보존),
  `date`는 `"YYYY-MM-DD"`, `datetime`은 ISO 8601(타임존 있는 컬럼은 오프셋 포함), `bool`, `json`(배열·JSON 컬럼), `string`. 바이너리는 UTF-8로 읽히면 문자열, 아니면 `"base64:…"`.
- 컬럼 타입: `integer | number | decimal | string | date | datetime | bool | json | unknown`. `unknown`은 Postgres·MySQL 외 커넥터에서 전부 null인 컬럼에만 나온다.
- `truncated`: 버전 `row_limit`(또는 요청 `row_limit`)보다 행이 많았다는 뜻. 그 이상은 잘린다.
- `cache.hit`: 저장된 결과를 돌려줬는지. `cache.shared`: 같은 요청이 동시에 와서, 먼저 시작한 실행의 결과를 같이 받았는지.
- `executed_at`은 그 숫자를 DB에서 실제로 읽은 시각이다(캐시 응답이면 과거 시각).
- 실행할 때마다 결과 컬럼 이름·타입을 고정 구조와 비교한다. 다르면 `409 schema_mismatch`이고 캐시를 갱신하지 않는다.

## 9. 일괄 실행 — `POST /api/saved-analyses/run-batch`

```json
{
  "items": [
    {"key": "w1", "analysis_id": "…", "params": {"start_date": "month_start(-1)"}},
    {"key": "w2", "analysis_id": "…", "version": 3, "row_limit": 10, "max_age_s": 0}
  ],
  "max_age_s": 3600
}
```

- 항목 필드는 단건 실행과 같고 `key`(1–200자, 요청 안에서 고유)와 `analysis_id`가 더해진다. 최상위 `max_age_s`는 항목이 생략했을 때의 기본값이다.
- 최대 50개. 넘거나 `key`가 중복되면 요청 전체가 `422 invalid_params`.
- 요청이 똑같은 항목은 한 번만 실행한다. 동시에 최대 4개를 실행한다(DB별 상한은 따로 적용).
- 항목 하나의 실패가 다른 항목을 막지 않는다. HTTP는 `200`이고, 각 값이 단건 응답과 같은 `{"data": …}` 또는 `{"error": …}`다.

```json
{"data": {"w1": {"data": { …단건 실행의 data… }},
          "w2": {"error": {"code": "timeout", "message": "…", "details": {"timeout_s": 30}, "last_success": { … }}}}}
```

## 10. 오류 형식

FastAPI가 만드는 이 API의 오류는 모두 다음 형식이다.

```json
{"error": {"code": "schema_mismatch", "message": "사람이 읽을 설명(영어)", "details": { … } | null, "last_success": { … } | null}}
```

| HTTP | code | 상황 | `details` |
| --- | --- | --- | --- |
| 404 | `not_found` | 분석·버전 없음 | |
| 409 | `name_conflict` | 같은 이름의 분석이 있음 | |
| 409 | `not_verified` | 버전 없이 실행했는데 verified 버전이 없음 | `latest_version` |
| 409 | `retired` | retired 버전 실행 | |
| 409 | `invalid_status_transition` | 허용되지 않는 상태 변경 | |
| 409 | `schema_mismatch` | 결과 컬럼이 고정 구조와 다름 | `expected`, `actual` |
| 422 | `unknown_database` | 그 이름의 연결이 없음 | `available` |
| 422 | `invalid_definition` | 파라미터 정의·상한·컬럼 힌트·자리표시자 대응 오류 | |
| 422 | `invalid_params` | 파라미터 값 오류, `row_limit` 초과, 배치 형식 오류 | `params` 또는 `row_limit` |
| 422 | `parse_error` | SQL 파싱 실패, 빈 SQL | |
| 422 | `forbidden_statement` | SQL 가드 위반, 또는 DB가 읽기 전용 트랜잭션 안의 쓰기를 거부 | `statement`·`node`·`function` 중 하나 |
| 422 | `unsupported_placeholder` | 이름 없는 자리표시자, 위치를 확정할 수 없는 콜론 | |
| 422 | `duplicate_columns` | 결과에 같은 이름 컬럼이 둘 이상(저장 시) | `columns` |
| 429 | `busy` | DB별 동시 실행 상한에서 대기 시간 초과 | `database_name`, `waited_s` |
| 502 | `db_error` | DB가 오류를 냄(테이블 없음, 권한 없음, 연결 실패 등) | |
| 504 | `timeout` | 실행 시간 상한 초과로 취소됨 | `timeout_s` |

`last_success`는 **같은 버전·같은 파라미터**로 이전에 성공한 결과가 있으면 채워진다. 위젯은 이것을 "마지막 성공값"으로 보여줄 수 있다.

```json
{"columns": [ … ], "rows": [[1200]], "row_count": 1, "truncated": false, "executed_at": "2026-11-10T06:12:03Z", "params": { … }}
```

실패한 실행은 결과 캐시의 마지막 성공값을 지우지 않는다(오류 코드와 시각만 기록). `busy`는 기록하지 않는다.

그 밖의 형식: 본문 스키마 오류는 FastAPI 기본 `422 {"detail": [...]}`, 게이트웨이 인증 오류는 `401/403 {"error": "…"}`(문자열).

## 11. 실행 보장과 상한

**읽기 전용**: Postgres와 MySQL/MariaDB는 실행마다 새 연결을 열어 `READ ONLY` 트랜잭션 안에서 실행하고 항상 롤백한다
(Postgres `SET TRANSACTION READ ONLY` + 트랜잭션 범위 `statement_timeout`, MySQL `START TRANSACTION READ ONLY` + 세션 `max_execution_time`/MariaDB `max_statement_time`).
그래서 가드가 모르는 사용자 정의 함수 안의 쓰기도 DB가 거부한다(`forbidden_statement`). 응답 `preview.read_only_transaction`이 이 경로를 탔는지 알려준다.
그 밖의 커넥터(DuckDB, SQLite, Snowflake, Databricks, Trino, ClickHouse 등)는 기존 커넥터 `execute(…, timeout_s=)`로 실행한다. 이때 방어선은 SQL 가드,
커넥터 설정(DuckDB는 read_only로 연다), 그리고 SELECT 권한만 가진 DB 계정이다. 어떤 경우에도 **DB 계정 권한이 첫 번째 방어선**이다.

**상한 기본값**(환경변수로 바꾼다. 양의 정수가 아니면 기본값):

| 환경변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `SAVED_ANALYSES_DEFAULT_ROW_LIMIT` | 5000 | 버전 `row_limit` 기본값 |
| `SAVED_ANALYSES_MAX_ROW_LIMIT` | 50000 | 버전 `row_limit` 최대 |
| `SAVED_ANALYSES_DEFAULT_TIMEOUT_S` | 30 | 버전 `timeout_s` 기본값 |
| `SAVED_ANALYSES_MAX_TIMEOUT_S` | 300 | 버전 `timeout_s` 최대 |
| `SAVED_ANALYSES_DEFAULT_CACHE_TTL_S` | 3600 | 버전 `cache_ttl_s` 기본값 |
| `SAVED_ANALYSES_MAX_CACHE_TTL_S` | 604800 | 버전 `cache_ttl_s` 최대 |
| `SAVED_ANALYSES_MAX_CONCURRENCY_PER_DB` | 2 | DB(`database_name`)별 동시 실행 수 |
| `SAVED_ANALYSES_QUEUE_TIMEOUT_S` | 10 | 실행 슬롯을 기다리는 최대 시간. 넘으면 `429 busy` |
| `SAVED_ANALYSES_BATCH_MAX_ITEMS` | 50 | `run-batch` 항목 수 최대 |
| `SAVED_ANALYSES_BATCH_PARALLELISM` | 4 | `run-batch` 동시 실행 수 |
| `SAVED_ANALYSES_TIMEZONE` | `Asia/Seoul` | 상대 날짜 기준 시간대 |

상한이 바뀌어도 이미 저장된 버전의 `row_limit`·`timeout_s`·`cache_ttl_s`는 그대로다(버전 불변).

**캐시**: 키는 (분석, 버전, 정규화한 파라미터의 sha256). Postgres 저장소의 `saved_analysis_run` 테이블에 있으므로 재시작해도 남는다.
같은 키의 동시 요청은 한 프로세스 안에서 한 번만 실행된다(백엔드는 단일 uvicorn 프로세스로 돈다. 여러 프로세스로 늘리면 중복 실행이 생길 수 있지만 틀린 결과는 나오지 않는다).

## 12. 하지 않는 것(이번 범위 밖)

- 대량 추출(CSV·Parquet 파일 생성)과 그 일일 한도.
- 분석 삭제 API. 대시보드가 참조할 수 있으므로 retire만 둔다.
- Custom Analyses(NL-to-SQL few-shot)로의 복사본 등록. 버전 테이블에 `custom_analysis_id` 칸만 마련해 두었다.
- 사용자별 권한 판정. 재료(버전별 참조 테이블)만 저장한다.
- MCP 도구 노출.
