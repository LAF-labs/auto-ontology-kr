<!--
SPDX-License-Identifier: Apache-2.0
-->

# 저장된 분석 API (Saved Analyses) — 계약 문서

이 포크(`kr/product`)에만 있는 API다. 대시보드는 SQL 대신 **분석 ID**를 가리키고, 이 API로 LLM 없이 실행한다.
하네스 쪽은 이 문서를 계약으로 쓴다. 문서와 코드가 다르면 코드가 버그다.

- 백엔드 코드: `auto_ontology/server/saved_analyses/`, 저장소: `auto_ontology/dal/saved_analyses/`
- 마이그레이션: `alembic/versions/bca054972e72_add_saved_analyses.py`, 추출 기록 `alembic/versions/ab61dd2e7541_add_saved_analysis_exports.py`
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
| `POST /api/saved-analyses/{analysis_id}/versions/{version}/verify` | `analysis:verify` | 검증 완료 표시(누가·언제 기록). Custom Analyses 복사본 갱신(14절) |
| `POST /api/saved-analyses/{analysis_id}/versions/{version}/retire` | `analysis:verify` | 폐기(다시 실행 불가). 복사본 갱신 또는 제거 |
| `POST /api/saved-analyses/sync-custom-analyses?analysis_id=` | `analysis:manage` | Custom Analyses 복사본 다시 등록(14절) |
| `POST /api/saved-analyses/{analysis_id}/run` | `analysis:read` | 실행(또는 캐시 응답) |
| `POST /api/saved-analyses/run-batch` | `analysis:read` | 여러 분석을 한 번에 실행(대시보드 한 화면) |
| `POST /api/saved-analyses/{analysis_id}/export` | `analysis:export` | verified 버전의 전체 결과를 파일로(15절) |
| `GET  /api/saved-analysis-exports` | `analysis:export` | 추출 기록 목록 + 오늘 사용량·상한 |
| `GET  /api/saved-analysis-exports/{export_id}` | `analysis:export` | 추출 기록 하나 |
| `GET  /api/saved-analysis-exports/{export_id}/file` | `analysis:export` | 추출 파일 내려받기 |

manage 경로는 호출자 id를 `created_by`·`verified_by`로 기록한다. 대시보드 런타임은 viewer 토큰, 분석 등록(수정 세션)은 admin 토큰을 쓰기를 권장한다.

게이트웨이 단계 오류는 본문 형식이 다르다(`401 {"error": "Unauthorized"}`, `403 {"error": "Forbidden"}`). 게이트웨이가 돌려줄 수 있는 오류 형식 전체는 10절 끝에 있다.

### 역할별 권한

게이트웨이는 호출자 사용자의 **역할**(`admin`, `viewer`, `analysis_editor`, `analysis_reviewer`, `analysis_exporter`)로만 판정한다(`frontend/auth/with-auth.ts`, `frontend/auth/permissions.ts`).
API 토큰은 자기 권한이 없다. 요청마다 토큰 주인의 현재 역할을 다시 읽으므로 역할을 바꾸거나 사용자를 막으면 바로 반영된다(`frontend/auth/api-token.ts`).
역할별 권한의 원본은 `frontend/auth/access.json`이다.

| 권한 | admin | analysis_reviewer | analysis_editor | analysis_exporter | viewer | 여는 경로(대시보드·에이전트 도구가 쓰는 것) |
| --- | --- | --- | --- | --- | --- | --- |
| `analysis:read` | 있음 | 있음 | 있음 | 있음 | 있음 | 저장된 분석 목록·단건·`run`·`run-batch` |
| `analysis:manage` | 있음 | 있음 | 있음 | **없음** | **없음** | 저장(초안)·새 버전(초안)·복사본 재등록 |
| `analysis:verify` | 있음 | 있음 | **없음** | **없음** | **없음** | verify·retire |
| `analysis:export` | 있음 | **없음** | **없음** | 있음 | **없음** | 추출(15절). 결과 전체가 DB 밖으로 나가므로 따로 둔다 |
| `catalog:read` | 있음 | 있음 | 있음 | 있음 | 있음 | `POST /api/search/global-search`(+`/count`), `GET /api/terms`, `GET /api/terms/{term_id}` 등 카탈로그·용어 조회 |
| `chat:use` | 있음 | 있음 | 있음 | 있음 | 있음 | `POST /api/chat/completions`, `POST /api/question-entity-coverage` |
| `conversation:write` | 있음 | 있음 | 있음 | 있음 | 있음 | `chat/completions`에 `conversation_id`를 줄 때 추가로 필요, `POST /api/chat/cancel` |
| `apiToken:manage` | 있음 | 있음 | 있음 | 있음 | 있음 | `/api/api-tokens`(자기 토큰만, 브라우저 세션 전용. 아래) |
| 연결·사용자·설정·카탈로그 쓰기 등 | 있음 | 없음 | 없음 | 없음 | 없음 | |

viewer의 권한 전체: `analysis:read`, `catalog:read`, `chat:use`, `conversation:read/write`, `acronym:read`, `prompt:read`, `connection:read`,
`zone:read`, `tag:read`, `apiToken:manage`. 따라서 **viewer 토큰 하나로 대시보드(`analysis:read`)와 에이전트의 검색(`catalog:read`)·질문(`chat:use`)을 모두 부를 수 있다.**
대시보드용과 에이전트용 viewer 토큰을 나눠도 권한 범위는 같다(대시보드용 토큰도 LLM 비용이 드는 채팅을 부를 수 있다). 나누는 이득은 따로 폐기할 수 있다는 것뿐이다.

**분석 역할 셋(이 포크에서 추가)**: `analysis_editor` = viewer + `analysis:manage`, `analysis_reviewer` = `analysis_editor` + `analysis:verify`,
`analysis_exporter` = viewer + `analysis:export`(15절. 저장·검증은 못 한다).
둘 다 연결·사용자·설정·카탈로그를 바꿀 수 없다. 저장과 verify를 다른 권한으로 나눈 것은, 초안을 만드는 에이전트의 토큰(editor)으로는
검증을 할 수 없고, 사람이 누른 검증만 다른 토큰(reviewer)으로 보내게 하려는 것이다. **이 분리는 토큰을 쥔 쪽이 지켜야 한다.**
Auto-ontology는 요청이 사람의 클릭에서 왔는지 알 수 없다. reviewer 토큰이 에이전트가 쓴 코드(예: 같은 origin 위젯 JS)가 닿는 경로에 있으면 분리는 의미가 없다.
`verified_by`에는 reviewer 토큰 주인 계정이 기록된다(누가 눌렀는지는 호출 측이 `note`에 남길 수 있다).

역할 부여: Better Auth의 사용자 생성 훅(`frontend/auth/auth.ts`)은 새 사용자를 admin이나 viewer로만 저장한다. 그래서 viewer로 만든 뒤
admin이 `POST /api/auth/admin/set-role {"userId", "role": "analysis_editor"}`로 바꾼다. 웹 UI의 사용자·초대·그룹 화면은 두 역할만 알아서
새 역할 사용자를 "Viewer"로 표시하고, **UI에서 그 사용자를 편집해 저장하면 viewer로 돌아간다**. 초대(`/api/invitations`)와 그룹도 admin·viewer만 받는다.
백엔드(Python)의 역할별 권한(`server/users/permissions.py`)도 admin·viewer만 알아서, 새 역할 계정은 백엔드가 판정하는 쓰기(용어 수정 등)를 할 수 없다(viewer와 같다).

### API 토큰 발급

`POST /api/api-tokens`(본문 `{"name": "…", "expires_in_days": 1–365}`, `name` ≤64자, `expires_in_days`를 빼면 만료 없음)는
**로그인한 브라우저 세션(쿠키)으로만** 부를 수 있다. 목록(`GET`)과 폐기(`DELETE /api/api-tokens/{id}`)도 같다.
API 토큰으로 부르면 `403 {"error": "API tokens must be managed from a signed-in session, not with an API token."}`
(`frontend/lib/apiTokens.ts`의 `requireSessionCaller`). 토큰은 발급한 사용자의 역할을 따르고, 평문은 발급 응답에만 한 번 나온다.
그래서 viewer 토큰은 (1) admin이 viewer 사용자를 만들고 (2) 그 사용자로 로그인해 (3) 토큰을 발급하는 순서로 만든다. 사람이 UI에서 하거나,
스크립트라면 Better Auth 로그인 경로를 거쳐 세션 쿠키를 얻어야 한다(Better Auth는 `origin` 헤더를 요구한다).

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
  "name": "월별 승인된 주문 수",
  "description": "승인일 기준, 기간은 [start_date, end_date)",
  "database_name": "shop",
  "sql": "SELECT COUNT(order_id) AS approved_count\nFROM orders\nWHERE approved_at >= :start_date AND approved_at < :end_date\n  AND status IN (:statuses)",
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
    "id": "6d1c…", "name": "월별 승인된 주문 수", "...": "…단건 조회와 같음…",
    "preview": {
      "params": {"start_date": "2026-10-01", "end_date": "2026-11-01", "statuses": ["APPROVED"]},
      "columns": [{"name": "approved_count", "type": "integer", "role": "measure", "unit": "건", "label": "승인 건수", "description": null}],
      "rows": [[1234]],
      "row_count": 1,
      "truncated": false,
      "duration_ms": 41,
      "read_only_transaction": true,
      "sql": "SELECT COUNT(order_id) …\nLIMIT 5001",
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

`GET /api/saved-analyses?query=&status=&skip=&limit=` — 이름의 **유니코드 코드포인트순**(Postgres `COLLATE "C"`).
저장소 DB의 기본 collation과 상관없이 어느 배포에서나 같은 순서다: 숫자 → 영문 대문자 → 영문 소문자 → 한글(가나다순). `query`는 이름·설명 부분 일치, `status=verified`는 verified 버전이 있는 것,
`status=draft`는 없는 것. `limit`은 최대 100, 생략하면 전부.

```json
{"data": [{"id": "…", "name": "…", "description": "…", "database_name": "shop",
           "latest_version": 2, "latest_verified_version": 1,
           "created": "2026-11-10T07:00:00Z", "created_by": "…", "updated": "2026-11-10T08:00:00Z"}],
 "count": 1, "total": 1}
```

`GET /api/saved-analyses/{analysis_id}?version=` — `version`을 생략하면 최신 verified, 없으면 최신 버전.

```json
{
  "data": {
    "id": "…", "name": "…", "description": "…", "database_name": "shop",
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
      "tables": [{"database_name": "shop", "schema_name": "shop", "table_name": "orders", "table_id": "…"}],
      "verified_by": "…", "verified_at": "…", "verification_note": "재무 보고서와 대조", "created": "…", "created_by": "…"
    }
  }
}
```

단건 조회 `data`에는 `custom_analysis`(Custom Analyses 복사본 상태, 14절)도 있다:
`{"id": "…" | null, "version": 1 | null, "status": "registered" | "stale" | "missing" | "none"}`.

상태 변경: `POST …/versions/{version}/verify`, `POST …/versions/{version}/retire`, 본문 `{"note": "…"}`(선택). 응답은 그 버전 기준의 단건 조회에
`custom_analysis_sync`(복사본 동기화 결과, 14절)를 더한 것이다.
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
    "analysis_id": "…", "name": "월별 승인된 주문 수", "version": 1, "status": "verified",
    "params": {"start_date": "2026-10-01", "end_date": "2026-11-01", "statuses": ["APPROVED"]},
    "columns": [{"name": "approved_count", "type": "integer", "role": "measure", "unit": "건", "label": "승인 건수", "description": null}],
    "rows": [[1234]],
    "row_count": 1,
    "truncated": false,
    "executed_at": "2026-11-10T07:12:03.123456Z",
    "duration_ms": 412,
    "cache": {"hit": true, "shared": false, "expires_at": "2026-11-10T08:12:03.123456Z"},
    "source": {"database_name": "shop", "tables": ["shop.orders"]},
    "sql": "SELECT COUNT(order_id) AS approved_count\nFROM orders\nWHERE approved_at >= CAST('2026-10-01' AS DATE) …\nLIMIT 5001"
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
  항목 오류의 `error.status`가 그 오류를 단건으로 불렀을 때의 HTTP 상태다(10절 표와 같다).

```json
{"data": {"w1": {"data": { …단건 실행의 data… }},
          "w2": {"error": {"code": "timeout", "status": 504, "message": "…", "details": {"timeout_s": 30}, "last_success": { … }}}}}
```

**전체 마감 `deadline_s`**(선택, 정수 초): 요청 전체가 이 시간 안에 응답한다. 생략하면 `SAVED_ANALYSES_BATCH_DEADLINE_S`(기본 120),
최대 `SAVED_ANALYSES_BATCH_MAX_DEADLINE_S`(기본 280). 최대를 넘으면 요청 전체가 `422 invalid_params`(`details.deadline_s`에 최대값).

```json
{"items": [ … ], "max_age_s": 3600, "deadline_s": 60}
```

- 마감까지 끝나지 않은 항목은 `{"error": {"code": "timeout", "status": 504, "details": {"deadline_s": 60}, "last_success": …}}`다.
  실행 시간 상한(`details.timeout_s`)과는 `details`의 키로 구별한다. `last_success`는 단건과 같은 규칙으로 채운다.
- 마감 때 **아직 시작하지 않은 항목은 실행하지 않는다.** 실행 중이던 항목은 응답에서만 빠지고 DB에서는 자기 `timeout_s`까지 계속 돈다.
  그 결과는 캐시에 들어가므로, 조금 뒤 같은 요청을 다시 보내면 캐시로 받을 수 있다(마감으로 끊긴 항목은 실패로 기록하지 않는다).
- 최대값 280초는 게이트웨이(Node `fetch`)가 백엔드 응답 헤더를 기다리는 300초보다 짧게 잡은 것이다. 호출 측 HTTP 타임아웃은 `deadline_s`보다 길게 둔다.

## 10. 오류 형식

FastAPI가 만드는 이 API의 오류는 모두 다음 형식이다.

```json
{"error": {"code": "schema_mismatch", "status": 409, "message": "사람이 읽을 설명(영어)", "details": { … } | null, "last_success": { … } | null}}
```

`status`는 이 오류의 HTTP 상태(아래 표)다. 단건 응답에서는 HTTP 상태와 같고, `run-batch` 항목에서는 200 안에서 그 항목의 상태를 알려준다.

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
| 410 | `export_expired` | 추출 파일이 보존 기간이 지나 지워짐(15절) | `deleted_at` |
| 413 | `export_too_large` | 추출 한 번의 행 수·파일 크기 상한 초과 | `max_rows` 또는 `max_bytes` |
| 422 | `export_unsupported` | 추출할 수 없는 연결(Postgres·MySQL/MariaDB가 아님) | `database_name` |
| 429 | `export_quota_exceeded` | 오늘의 추출 횟수·총 행 수 한도 초과 | `day_start`, `exports_today`, `rows_today`, `daily_max_exports`, `daily_max_rows`, (진행 중 초과면) `rows_left_today` |
| 500 | `export_failed` | 파일 쓰기 실패, 값이 컬럼 타입으로 변환되지 않음, 서버가 추출 중 멈춤 | |

`last_success`는 **같은 버전·같은 파라미터**로 이전에 성공한 결과가 있으면 채워진다. 위젯은 이것을 "마지막 성공값"으로 보여줄 수 있다.
형식은 **실행 응답의 `data`(8절)와 같다.** 그래서 `name`·`version`·`status`·`source`·`sql`로 "어느 분석, 어느 버전의 언제 값인지" 말할 수 있다.

```json
{"analysis_id": "…", "name": "월별 승인된 주문 수", "version": 1, "status": "verified",
 "params": { … }, "columns": [ … ], "rows": [[1200]], "row_count": 1, "truncated": false,
 "executed_at": "2026-11-10T06:12:03Z", "duration_ms": 380,
 "cache": {"hit": true, "shared": false, "expires_at": "2026-11-10T07:12:03Z"},
 "source": {"database_name": "shop", "tables": ["shop.orders"]}, "sql": "SELECT …\nLIMIT 5001"}
```

- `executed_at`은 그 값을 DB에서 읽은 시각, `cache.hit`은 항상 `true`, `cache.expires_at`은 이미 지났을 수 있다.
- `status`는 **버전 상태**(`verified`/`draft`)다. 바깥 `error.status`(HTTP 상태, 정수)와 다르다.
- 예전 형식의 필드(`columns`, `rows`, `row_count`, `truncated`, `executed_at`, `params`)는 이름과 뜻이 그대로다.

실패한 실행은 결과 캐시의 마지막 성공값을 지우지 않는다(오류 코드와 시각만 기록). `busy`는 기록하지 않는다.

### 게이트웨이가 돌려주는 오류 형식(네 가지 + 텍스트)

`:3000` 게이트웨이를 부르는 클라이언트는 다음을 모두 처리해야 한다. 상태 코드만으로는 형식을 알 수 없다(422는 1·3·4 모두 가능).

| # | 본문 | 어디서 | 예 |
| --- | --- | --- | --- |
| 1 | `{"error": {"code", "status", "message", "details", "last_success"}}` | 저장된 분석 경로의 백엔드 오류(위 표) | `409 not_verified` |
| 2 | `{"error": "<문장>"}` | 게이트웨이 인증·권한(`withPermission`), 토큰 관리 경로의 입력 오류 | `401 {"error": "Unauthorized"}`, `403 {"error": "Forbidden"}`, `400 {"error": "A token name is required."}` |
| 3 | `{"detail": [{"loc", "msg", "type", …}]}` | FastAPI 요청 본문·쿼리 검증 | 저장된 분석의 모르는 키, `deadline_s: 0` |
| 4 | `{"detail": "<문장>"}` | FastAPI `HTTPException`(저장된 분석 외 경로) | 채팅 `409`(semantic 레이어 없음, 같은 대화의 실행이 진행 중), 검색 `422`(지원하지 않는 `objects`·`text_match_option`), 답변 가능 여부 `422`(흐름 실패, LLM 미설정) |

JSON이 아닌 본문도 있다: `POST /api/chat/completions`는 `conversation_id`를 줬는데 `conversation:write`가 없으면 `403 Forbidden`(text),
백엔드에 연결하지 못하면 `502 Backend connection failed`(text/plain)다. 그 밖의 프록시 경로(`proxyToBackend`)는 백엔드에 연결하지 못하면
처리되지 않은 예외로 Next.js `500`이 되고 본문 형식은 정해져 있지 않다.

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
| `SAVED_ANALYSES_BATCH_DEADLINE_S` | 120 | `run-batch` 전체 마감(요청이 `deadline_s`를 생략했을 때) |
| `SAVED_ANALYSES_BATCH_MAX_DEADLINE_S` | 280 | 요청 `deadline_s`의 최대. 기본 마감도 이 값을 넘지 않는다 |
| `SAVED_ANALYSES_TIMEZONE` | `Asia/Seoul` | 상대 날짜 기준 시간대 |

상한이 바뀌어도 이미 저장된 버전의 `row_limit`·`timeout_s`·`cache_ttl_s`는 그대로다(버전 불변).

**캐시**: 키는 (분석, 버전, 정규화한 파라미터의 sha256). Postgres 저장소의 `saved_analysis_run` 테이블에 있으므로 재시작해도 남는다.
같은 키의 동시 요청은 한 프로세스 안에서 한 번만 실행된다(백엔드는 단일 uvicorn 프로세스로 돈다. 여러 프로세스로 늘리면 중복 실행이 생길 수 있지만 틀린 결과는 나오지 않는다).

## 12. 하지 않는 것(이번 범위 밖)

- 분석 삭제 API. 대시보드가 참조할 수 있으므로 retire만 둔다.
- Custom Analyses(NL-to-SQL few-shot)로의 복사본 등록. 버전 테이블에 `custom_analysis_id` 칸만 마련해 두었다.
- 사용자별 권한 판정. 재료(버전별 참조 테이블)만 저장한다.
- MCP 도구 노출.

## 13. 에이전트 도구가 함께 쓰는 게이트웨이 경로(저장된 분석 밖)

이 절은 저장된 분석 API가 아니라, 하네스의 에이전트 도구가 같은 토큰으로 부르는 기존 경로의 동작을 코드 기준으로 적은 것이다.
이 포크가 바꾸지 않은 업스트림 동작이라 업스트림을 가져오면 달라질 수 있다. 권한은 1절 표, 오류 형식은 10절 끝을 본다.

### 용어 검색 — 권장: `POST /api/search/global-search` (`catalog:read`)

```json
{"search_term": "매출", "filters": {"objects": ["Term"], "synonyms": true, "description": false}}
```

- 이름(+ `synonyms`가 켜져 있으면 Term의 별칭, `description`을 켜면 설명)에 **검색어의 모든 토큰이 부분 문자열로 들어 있는 것**을 찾는다.
  `text_match_option`은 `"contains"`만 된다. 검색어는 앞뒤 공백을 빼고 2자 이상. 결과는 최대 200개이고, 이름이 모든 토큰을 담은 것, 별칭으로 걸린 Term, 짧은 이름 순이다
  (`auto_ontology/server/search/router.py`, `service.py`).
- `filters.objects` 허용 값(`auto_ontology/dal/search.py`의 `SEARCH_OBJECT_TYPES`): `Database`, `Schema`, `Table`, `View`, `Column`, `CustomAnalysis`,
  `Term`, `ColumnAttribute`, `SqlAttribute`, `PqlAnalysis`, `Tag`. 생략하거나 `null`이면 전부. 모르는 값이면 `422 {"detail": "Unsupported search object type(s): …"}`.
  저장된 분석은 검색 대상이 아니다(목록 `query`로 찾는다).
- `filters.tags`(태그 id 목록, 태그 없는 것은 `"(blanks)"`)와 `filters.data`(DB·스키마 id 목록, 결과를 Table·View·Column으로 좁힌다)도 있다.
- 대안 `GET /api/terms?query=&skip=&limit=`는 **용어 이름만** 대소문자 무시 부분 일치로 찾는다(별칭·설명은 보지 않는다). 이름순, `limit`은 최대 100이고 생략하면 전부.
  용어 이름을 정확히 모를 때는 별칭까지 보는 global-search가 낫다.

### 답변 가능 여부 — `POST /api/question-entity-coverage` (`chat:use`)

```json
{"question": "지난달 스토어별 신청 수", "max_distance": 0.75}
```

응답 `{"data": {"coverage": 0.6667, "candidates": [{"label": "ColumnAttribute", "attribute": "…", "term": "…", "id": "…"}, …]}}`.
코드(`auto_ontology/retrieval/entity_coverage/agents/coverage.py`)에서 확인되는 뜻은 여기까지다.

- LLM이 질문에서 엔터티(개념)를 뽑고, 엔터티마다 semantic 후보를 벡터 검색한다. `max_distance`(기본 0.75, L2 거리, 작을수록 가깝다)를 넘는 후보는 버린다.
- `coverage` = **남은 ColumnAttribute 후보가 하나라도 있는 엔터티 수 ÷ 뽑힌 엔터티 수**(소수 넷째 자리 반올림). 엔터티가 하나도 없으면 `0.0`.
  SqlAttribute·CustomAnalysis 후보는 `candidates`에는 나오지만 `coverage`에는 세지 않는다. `candidates`는 거리순이다.
- **몇 점부터 "답할 수 있다"는 기준값은 코드에 없다.** 1.0은 엔터티마다 비슷한 컬럼 속성이 있다는 뜻일 뿐 SQL이 만들어진다는 보장이 아니고,
  0은 SqlAttribute나 CustomAnalysis로 답할 수 있는 질문이나 엔터티를 못 뽑은 질문에서도 나온다. 판단 재료로만 쓰고, 기준값은 호출 측이 정해 측정해야 한다.
- LLM 호출이 들어가고, 프로세스 전체에서 한 번에 하나씩만 돈다(`server/metadata/service.py`의 `_run_lock`). 흐름이 실패하면 `422 {"detail": "…"}`.

### 채팅 결과 `sql_response_from_db`의 행 형식 — `POST /api/chat/completions` (`chat:use`)

SSE로 오는 채팅 결과의 `sql_response_from_db`는 실행 경로에 따라 형식이 다르다(코드 기준, 실제 스택에서는 확인하지 않았다).

- 일반 NL-to-SQL 경로(`retrieval/text_to_sql/agents/sql_execution.py`): **원소 하나짜리 배열이고, 그 원소는 JSON 문자열**이다.
  문자열은 pandas `DataFrame.to_json(orient="records", date_format="iso")`, 즉 **컬럼 이름을 키로 하는 객체의 배열**이다.
  예: `["[{\"store\":\"A\",\"n\":3},{\"store\":\"B\",\"n\":1}]"]`. 결과가 비면 `["[]"]`. 같은 이름 컬럼은 직렬화 전에 `ID`, `ID__2`처럼 이름을 바꿔 겹치지 않게 한다.
  값 타입은 pandas 직렬화를 따르므로 저장된 분석처럼 decimal 문자열·정수 정밀도가 보장되지 않는다. 행 상한도 없다(MCP `ask_question`만 100행으로 자른다).
- Kumo 예측 경로(`retrieval/kumo/predictor.py`): 문자열로 감싸지 않은 **객체의 배열**.
- SQL을 실행하지 않은 답(만들 수 없는 질문, 정보성 답, 실패): `null`.

클라이언트는 "배열이고 첫 원소가 문자열이면 JSON으로 한 번 더 파싱, 객체 배열이면 그대로, null이면 표 없음"으로 읽는다
(웹 UI는 이 값을 문자열로 만든 뒤 `frontend/lib/parseSqlResponse.ts`에서 JSON 표, 마크다운 표, CSV 순으로 시도한다).

## 14. Custom Analyses 복사본

질문 경로(NL-to-SQL few-shot, 답변 가능 여부 후보)는 저장된 분석이 아니라 Custom Analyses를 읽는다. 그래서 각 저장된 분석의
**최신 verified 버전**을 Custom Analysis 하나로 복사해 두고, 그 id를 해당 버전의 `custom_analysis_id`에 기록한다
(`auto_ontology/server/saved_analyses/custom_copy.py`). 원본은 저장된 분석이고 복사본은 언제든 다시 만들 수 있다.

- **언제**: verify와 retire가 끝날 때마다(둘 다 최신 verified 버전을 바꿀 수 있다). 새 verified 버전이 생기면 같은 복사본 id의 내용을 바꾸고,
  최신 verified를 retire하면 남은 verified 중 최신으로 바꾸고, verified가 하나도 남지 않으면 복사본을 지운다. draft 저장·새 버전은 복사본을 건드리지 않는다.
- **내용**: 이름 = 분석 이름, 설명 = 분석 설명, SQL = 버전 SQL에 **파라미터 기본값을 넣은 것**(상대 날짜는 동기화한 날 기준)이고
  첫 줄에 `-- saved-analysis <analysis_id> v<version>; parameters bound to their defaults: start_date="2026-10-01", …` 주석이 붙는다.
  기본값 없는 required 파라미터가 있으면 `:자리표시자`를 그대로 두고 주석에 `parameters left as :placeholders`라고 적는다.
  복사본은 Custom Analyses 생성 경로를 그대로 타므로 임베딩 모델을 한 번 부른다(verify 응답이 그만큼 느려진다).
- **실패해도 verify·retire는 성공한다.** 결과는 응답의 `custom_analysis_sync`에 있다:
  `{"analysis_id", "version", "custom_analysis_id", "action": "created" | "updated" | "unchanged" | "removed" | "none" | "error", "error": {"code", "message"} | null}`.
  `error.code`: `name_conflict`(같은 이름의 다른 Custom Analysis가 있다. 그 행은 건드리지 않는다), `sql_conflict`(같은 SQL 텍스트를 다른 Custom Analysis가 쓴다),
  `sql_error`(Custom Analyses 검증 실패. 대개 SQL이 카탈로그에 있는 테이블·컬럼을 하나도 가리키지 않을 때, 예: `SELECT count(*) FROM t`만 있는 SQL), `failed`(그 밖, 임베딩 실패 등).
- **semantic reset이 복사본을 지운다**(Custom Analyses는 semantic 레이어에 속한다). 원본은 남고, 단건 조회의 `custom_analysis.status`가 `missing`이 된다.
  사람이 Custom Analyses 화면에서 복사본을 지워도 같다. 화면에서 고친 내용은 다음 동기화가 원본에 맞게 덮어쓴다.
- **다시 등록**: `POST /api/saved-analyses/sync-custom-analyses`(전부) 또는 `?analysis_id=…`(하나), `analysis:manage`. `data`는 분석별 `custom_analysis_sync` 결과의 목록이다.
  내용이 같으면 `unchanged`라서 다시 불러도 안전하다. 복사본 id를 잃은 경우(두 저장소 사이 쓰기가 중간에 실패)에도 SQL 첫 줄 표지로 찾아 다시 쓴다.

## 15. 대량 추출 — `POST /api/saved-analyses/{analysis_id}/export`

verified 버전의 **전체 결과**를 파일로 쓴다. 실행 API(8절)는 대시보드용이라 버전 `row_limit`(최대 50000)만큼만 돌려주지만, 추출은 그 상한을 따르지 않고
아래 추출 상한까지 읽는다. 데이터 사이언스 작업(예측, 세그먼트)을 하는 실행 환경이 이 파일을 읽는다. 에이전트가 DB에 직접 접속하는 경로는 없다.

- 코드: `auto_ontology/server/saved_analyses/exports/`(`config`, `stream`, `writer`, `service`, `router`), 기록 `auto_ontology/dal/saved_analyses/exports.py`
- 게이트웨이: `frontend/app/api/saved-analyses/[analysis_id]/export/route.ts`, `frontend/app/api/saved-analysis-exports/**/route.ts`. 파일은 `frontend/auth/proxy-backend-stream.ts`로 메모리에 올리지 않고 흘려보낸다.
- 권한: 네 경로 모두 `analysis:export`(admin, `analysis_exporter`). viewer·editor·reviewer에는 없다(1절 표).

### 요청

```json
{"version": 3, "params": {"start_date": "2026-01-01"}, "format": "parquet"}
```

| 필드 | 기본값 | 뜻 |
| --- | --- | --- |
| `version` | 최신 verified | **draft는 거부**(`409 not_verified`, `details: {"version", "status": "draft"}`). verified가 없으면 `409 not_verified`, retired는 `409 retired` |
| `params` | `{}` | 실행과 같은 규칙(5절). 잘못되면 `422 invalid_params` |
| `format` | `parquet` | `parquet`(타입 보존) 또는 `csv`. 그 밖은 FastAPI `422 {"detail": [...]}` |

본문을 생략하면 최신 verified 버전을 기본 파라미터로 Parquet로 쓴다. 모르는 키는 422다.

### 응답 `201 {"data": export}`

```json
{"export_id": "6f1c…", "analysis_id": "…", "name": "주문 상세", "version": 3,
 "params": {"start_date": "2026-01-01"}, "format": "parquet", "state": "ready",
 "columns": [{"name": "id", "type": "integer", "role": "measure", "unit": null, "label": null, "description": null}, …],
 "row_count": 182344, "byte_size": 3912455, "sha256": "…",
 "requested_by": "<토큰 주인 user id>", "created_at": "2026-11-11T03:00:00Z", "finished_at": "2026-11-11T03:00:04Z",
 "duration_ms": 4120, "expires_at": "2026-11-12T03:00:04Z", "deleted_at": null,
 "file": {"name": "6f1c….parquet", "content_type": "application/vnd.apache.parquet",
          "download_path": "/api/saved-analysis-exports/6f1c…/file", "description_name": "6f1c….json"},
 "error": null, "source": {"database_name": "shop"}, "sql": "SELECT …\nLIMIT 1000001"}
```

- 동기 호출이다. 파일이 다 쓰인 뒤에 답한다(실행 시간 상한 안).
- `state`: `running` | `ready` | `failed` | `expired`. 응답으로 오는 것은 `ready`뿐이고, 실패하면 오류 형식(10절)으로 답한다. 실패한 시도도 기록에 `failed`로 남는다(`error.code`, 그때까지 읽은 `row_count`).
- `columns`는 버전에 고정된 컬럼 구조다. 결과 컬럼이 그것과 다르면 `409 schema_mismatch`.
- `sql`은 실제로 실행된 문장(파라미터를 넣고 `LIMIT 상한+1`을 붙인 것)이다.

### 다른 경로

| 경로 | 응답 |
| --- | --- |
| `GET /api/saved-analysis-exports?skip=&limit=` | `{"data": [export…], "count", "total", "usage": {"day_start", "timezone", "exports", "rows", "limits": {"max_rows", "max_bytes", "timeout_s", "daily_max_exports", "daily_max_rows", "retention_s", "formats"}}}`. 최신순, `limit` 기본 50 |
| `GET /api/saved-analysis-exports/{export_id}` | `{"data": export}`. 없으면 `404 not_found` |
| `GET /api/saved-analysis-exports/{export_id}/file` | 파일 바이트. `Content-Type`(`application/vnd.apache.parquet` 또는 `text/csv; charset=utf-8`), `Content-Length`, `X-Export-Sha256`. 보존 기간이 지나 지워졌으면 `410 export_expired`, `failed`·`running`이면 `404 not_found`(`details.state`) |

### 실행 보장

- **가드와 트랜잭션은 실행과 같다**: 같은 SQL 가드(4절)를 저장된 문장, 파라미터를 넣은 문장, 상한을 붙인 문장에 다시 적용하고,
  전용 연결의 `READ ONLY` 트랜잭션 안에서 읽은 뒤 항상 롤백한다. 가드가 모르는 함수 안의 쓰기도 DB가 막는다(`422 forbidden_statement`).
- **연결 종류**: Postgres와 MySQL/MariaDB만 된다. 둘만 결과를 나눠 읽으면서 읽기 전용 트랜잭션을 걸 수 있다. 그 밖은 `422 export_unsupported`.
- **메모리**: 결과를 `SAVED_ANALYSES_EXPORT_CHUNK_ROWS`(10000)행씩 읽고 쓴다. Postgres는 서버 쪽 커서(`FETCH`), MySQL은 버퍼 없는 커서다.
  한 번에 한 묶음만 메모리에 있다(Parquet는 묶음 하나가 row group 하나).
- **원자성**: 파일은 숨김 이름 `.<export_id>.<format>.partial`로 쓰고, 끝나면 `<export_id>.<format>`으로 이름을 바꾼다. 그다음 설명 파일 `<export_id>.json`을 같은 방식으로 쓴다.
  디렉터리를 읽는 쪽은 반쯤 쓴 파일을 보지 않는다. 실패하면 부분 파일을 지운다.
- **동시 실행**: 한 프로세스에서 `SAVED_ANALYSES_EXPORT_MAX_CONCURRENCY`(1)개. 넘으면 `429 busy`. 실행 중에는 실행 API와 같은 DB별 슬롯 하나를 쓴다(대시보드 실행에 슬롯 하나가 남는다).

### 상한과 한도 (환경변수, 양의 정수가 아니면 기본값)

| 환경변수 | 기본값 | 넘으면 |
| --- | --- | --- |
| `SAVED_ANALYSES_EXPORT_MAX_ROWS` | 1000000 | `413 export_too_large`, `details.max_rows`. 문장에 `LIMIT 상한+1`이 붙어 DB가 일찍 멈춘다 |
| `SAVED_ANALYSES_EXPORT_MAX_BYTES` | 268435456 (256 MiB) | `413 export_too_large`, `details.max_bytes`. 묶음마다 검사 |
| `SAVED_ANALYSES_EXPORT_TIMEOUT_S` | 120 | `504 timeout`, `details.timeout_s`. 조회·읽기·쓰기 전체의 벽시계 시간. Postgres는 `FETCH`마다 남은 시간을 `statement_timeout`으로 다시 건다. 게이트웨이 대기 한도(약 300초 [추정])보다 작게 둔다 |
| `SAVED_ANALYSES_EXPORT_DAILY_MAX_COUNT` | 50 | `429 export_quota_exceeded`. 오늘 시작한 추출 수(성공·실패 모두) |
| `SAVED_ANALYSES_EXPORT_DAILY_MAX_ROWS` | 5000000 | `429 export_quota_exceeded`. 오늘 읽은 행 수(실패한 시도가 읽은 행도 센다). 남은 한도가 행 상한보다 작으면 그만큼만 읽고, 넘으면 `details.rows_left_today` |
| `SAVED_ANALYSES_EXPORT_MAX_CONCURRENCY` | 1 | `429 busy` |
| `SAVED_ANALYSES_EXPORT_RETENTION_S` | 86400 | 파일이 지워진다(`410 export_expired`). 기록은 남는다 |
| `SAVED_ANALYSES_EXPORT_CHUNK_ROWS` | 10000 | (상한 아님) 한 번에 읽는 행 수 |
| `SAVED_ANALYSES_EXPORT_SWEEP_INTERVAL_S` | 600 | (상한 아님) 보존 정리 주기 |
| `SAVED_ANALYSES_EXPORT_DIR` | `<시스템 임시 폴더>/auto-ontology-exports` | 파일을 두는 디렉터리. 배포에서는 꼭 정한다 |
| `SAVED_ANALYSES_EXPORT_FILE_MODE` | `640`(8진수) | 파일 권한. 디렉터리는 처음 만들 때 `750` |

- 하루 한도는 **이 백엔드를 쓰는 모든 호출자를 합친 것**이다(회사 하나에 스택 하나). 하루는 `SAVED_ANALYSES_TIMEZONE`의 자정부터다.
- 시작 전에 거부된 요청(권한, draft, 파라미터, 한도, `busy`)은 기록에 남지 않고 한도에도 세지 않는다.
- 한도 판정은 프로세스 안 잠금으로 한다. 백엔드를 여러 프로세스로 띄우면 동시에 들어온 요청이 한도를 조금 넘을 수 있다.

### 기록

`saved_analysis_export` 테이블에 시작한 추출마다 한 행: `id`, `analysis_id`, `analysis_name`, `version`, `database_name`, `params`(정규화한 값), `params_hash`,
`format`, `state`, `requested_by`(게이트웨이가 넘긴 user id = API 토큰의 주인), `sql`, `columns`, `row_count`, `byte_size`, `sha256`, `file_name`, `error_code`, `error`,
`created`, `finished`, `duration_ms`, `expires_at`, `deleted_at`. 분석과 외래 키가 없어서 분석이 바뀌어도 기록은 남는다. 백엔드 로그에도 시작·끝을 한 줄씩 적는다.

### 파일 형식

**Parquet**(zstd 압축). 각 필드의 메타데이터 `auto_ontology.type`에 계약 타입이, 스키마 메타데이터 `auto_ontology.export`에 추출 설명(JSON: `export_id`, `analysis_id`, `name`, `version`, `params`, `format`, `columns`, `requested_by`, `source`)이 있다.

| 계약 타입 | Parquet/Arrow |
| --- | --- |
| `integer` | int64 (MySQL `BIGINT UNSIGNED`는 uint64) |
| `number` | float64 |
| `decimal` | `decimal128(p, s)`. Postgres `numeric(p, s)`는 그 정밀도, MySQL/MariaDB는 (38, 첫 값의 소수 자릿수. MySQL은 컬럼마다 자릿수가 고정이다). **정밀도가 없는 Postgres `numeric`(`sum()`·`avg()` 결과 등)은 반올림하지 않고 정확한 십진 문자열**로 쓴다(필드 메타데이터는 `decimal`) |
| `bool` | bool |
| `date` | date32 |
| `datetime` | timestamp[us]. Postgres `timestamptz`는 timestamp[us, UTC] |
| `json` | JSON 문자열 |
| `string` | 문자열 |

값이 컬럼 타입에 맞지 않으면(예: 정해진 자릿수보다 긴 소수) 조용히 바꾸지 않고 `500 export_failed`로 멈춘다.

**CSV**: UTF-8, 머리글 한 줄, 줄바꿈 `\n`. NULL은 빈 칸, decimal은 정확한 십진 문자열, 날짜·시각은 ISO 8601, bool은 `true`/`false`, JSON은 JSON 문자열.
타입은 파일에 없고 응답·설명 파일의 `columns`에 있다(빈 칸과 빈 문자열은 구별되지 않는다). 타입이 중요하면 Parquet를 쓴다.

### 실행 환경이 파일을 읽는 법

같은 호스트의 실행 환경(네트워크 차단 컨테이너)은 `SAVED_ANALYSES_EXPORT_DIR`을 **읽기 전용으로 마운트**해 `<export_id>.parquet`을 읽는다. API를 부를 필요가 없다.

```bash
# Linux 호스트 예(macOS의 stat은 -f %g)
docker run --rm --network none -v "$SAVED_ANALYSES_EXPORT_DIR:/data:ro" --group-add "$(stat -c %g "$SAVED_ANALYSES_EXPORT_DIR")" <image> \
  python -c "import pandas as pd; df = pd.read_parquet('/data/<export_id>.parquet'); print(df.dtypes)"
```

- 파일은 `640`이라 소유자 그룹으로 읽는다(위 `--group-add`). 맞지 않는 환경이면 `SAVED_ANALYSES_EXPORT_FILE_MODE=644`.
- `<export_id>.json`에 응답과 같은 설명(행 수, `sha256`, `columns`)이 있다. 읽기 전에 `sha256`을 맞춰 볼 수 있다.
- 다른 호스트에서는 게이트웨이 `GET …/file`로 받는다(`analysis:export` 토큰).
- 보존 기간이 지나면 파일과 설명 파일이 지워진다. 실행 환경은 필요한 동안 자기 작업 공간에 복사해 둔다.

### 보존

`expires_at`(쓴 시각 + `SAVED_ANALYSES_EXPORT_RETENTION_S`)이 지난 파일은 정리 작업이 지우고 기록을 `expired`로 바꾼다. 정리는 추출 요청마다, 그리고 서버가 떠 있는 동안
`SAVED_ANALYSES_EXPORT_SWEEP_INTERVAL_S`마다 돈다. 디렉터리에 추출 이름 형식(`<uuid>.parquet|csv|json`, `.<uuid>….partial`)의 파일이 보존 기간 + 실행 시간 상한보다 오래되었으면
기록과 관계없이 지운다. 서버가 추출 중에 멈춰 `running`으로 남은 기록은 `failed`(`export_failed`)로 닫는다.
