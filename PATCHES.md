<!--
SPDX-License-Identifier: Apache-2.0
-->

# 업스트림 파일 수정 기록 (`kr/product`)

이 포크가 NVIDIA/auto-ontology에서 온 파일을 고친 곳만 적는다. 새 기능은 새 파일에 두고, 아래 목록은 가능한 한 짧게 유지한다.
업스트림 커밋을 골라 가져올 때 충돌이 나면 여기부터 본다.

## 저장된 분석 API (2026-11-10)

| 파일 | 수정 | 업스트림을 가져올 때 |
| --- | --- | --- |
| `auto_ontology/dal/schema.py` | 맨 끝에 `saved_analyses.tables` import 3줄 | 파일 끝 충돌이면 이 3줄을 다시 맨 끝에 둔다 |
| `auto_ontology/server/__main__.py` | 라우터 import 3줄 + `include_router` 1줄 | 같은 위치에 다시 넣는다 |
| `helm/auto-ontology/values.yaml` | `backend.alembicRevision` → 이 포크의 head | 아래 "마이그레이션" 참고 |
| `docs/openapi/backend.json` | 재생성 | 충돌은 손으로 풀지 말고 `uv run python -m dev_tools.generate_backend_openapi` |
| `docs/openapi/auto-ontology-api.json`, `mcp/auto_ontology_mcp/auto-ontology-api.json` | 재생성 | `cd frontend && pnpm openapi` |

새 파일(충돌 없음): `alembic/versions/bca054972e72_add_saved_analyses.py`, `auto_ontology/dal/saved_analyses/`,
`auto_ontology/server/saved_analyses/`, `frontend/app/api/saved-analyses/`, `docs/saved-analyses.md`, `PATCHES.md`.

private 속성 의존(코드는 고치지 않았지만 업스트림이 바꾸면 깨짐): `executor.py`가
`PostgresDatabase._connection_string`, `MySQLDatabase._connect`, `MySQLDatabase._set_statement_timeout`,
`auto_ontology.connectors.mysql._TIMEOUT_ERRNOS`를 쓴다. 없어지면 그 커넥터는 읽기 전용 트랜잭션 없는 일반 경로로 돌아간다
(`_native_runner`가 `hasattr`로 확인). `_TIMEOUT_ERRNOS`가 없어지면 import 오류가 나므로 테스트가 잡는다.

### 마이그레이션

이 포크의 head는 `bca054972e72`(down: 업스트림 `99d4d343dd0b`). 업스트림이 새 마이그레이션을 추가하면 head가 둘이 되어
`dal/tests/test_migration_revision.py`가 실패한다. 그때:

```bash
uv run alembic merge -m "merge upstream" <upstream_head> bca054972e72
```

으로 merge revision을 만들고 `helm/auto-ontology/values.yaml`의 `alembicRevision`을 새 head로 바꾼다.

## 저장된 분석 계약 보완 (2026-11-10)

업스트림 파일은 새로 고치지 않았다. 바뀐 것은 이 포크의 새 파일(`auto_ontology/server/saved_analyses/`, `auto_ontology/dal/saved_analyses/store.py`,
`docs/saved-analyses.md`)과 재생성한 OpenAPI 세 파일뿐이다. 마이그레이션은 없다(head `bca054972e72` 그대로).

- 오류 본문에 HTTP 상태 `error.status` 추가(단건·`run-batch` 항목 모두).
- `last_success`를 실행 응답 `data`와 같은 형식으로(`analysis_id`, `name`, `version`, `status`, `source`, `sql`, `duration_ms`, `cache` 추가).
- `run-batch`에 전체 마감 `deadline_s`와 환경변수 `SAVED_ANALYSES_BATCH_DEADLINE_S`(120)·`SAVED_ANALYSES_BATCH_MAX_DEADLINE_S`(280).
- 목록 정렬을 `ORDER BY name COLLATE "C"`로 고정(저장소 collation과 무관).

## 분석 역할과 Custom Analyses 복사본 (2026-11-10)

| 파일 | 수정 | 업스트림을 가져올 때 |
| --- | --- | --- |
| `frontend/enums/auth.ts` | `Role`에 `AnalysisEditor`, `AnalysisReviewer` 추가 | 열거 끝에 다시 넣는다 |
| `frontend/auth/access.json` | admin `analysis`에 `verify` 추가, `analysis_editor`·`analysis_reviewer` 역할 추가 | 업스트림이 viewer 권한을 바꾸면 두 역할에도 같이 반영한다(둘 다 viewer + 분석 권한) |
| `frontend/auth/auth-access.ts` | `analysis` 어휘에 `verify`, 두 역할의 `roleAccess`·`roles` 항목, 설명 주석 | 같은 위치에 다시 넣는다 |
| `auto_ontology/server/users/access.json` | 재생성(`uv run python -m dev_tools.generate_permission_resource`) | 손으로 풀지 말고 재생성 |
| `docs/openapi/*.json`, `mcp/auto_ontology_mcp/auto-ontology-api.json` | 재생성 | 위와 같다 |

포크 파일만 바뀐 곳: `frontend/app/api/saved-analyses/**/route.ts`(verify·retire → `analysis:verify`, 새 `sync-custom-analyses`),
`auto_ontology/server/saved_analyses/custom_copy.py`(새 파일), `service.py`, `router.py`, `dal/saved_analyses/store.py`. 마이그레이션 없음(`custom_analysis_id` 칸은 `bca054972e72`에 이미 있다).

일부러 고치지 않은 업스트림 파일: 사용자·초대·그룹 UI(`frontend/app/settings/users/*`), 초대 스키마, 사용자 생성 훅(`frontend/auth/auth.ts`),
그룹 역할 제약(`user_group.role IN ('admin','viewer')`), 백엔드 역할 권한(`server/users/permissions.py`). 새 역할은 API(`admin/set-role`)로만 준다.
UI에서 그 사용자를 편집해 저장하면 viewer로 돌아간다(`docs/saved-analyses.md` §1).

## 가져온 커밋과 보정

- `fc43a826`(업스트림 CODE_OF_CONDUCT), `bb14d778`(kreview 실행 스크립트)를 cherry-pick했다.
  둘 다 SPDX 헤더가 없어 `dev_tools/tests/test_licensing.py`가 실패했다. `CODE_OF_CONDUCT.md`는 고치지 않고
  `CODE_OF_CONDUCT.md.license` 사이드카를 추가했다.
- 예시 데이터 전용 스크립트(`dev_tools/kreview_run/`, cherry-pick `32793b0d`와 보정 `ce3f3638`의 README 헤더)는 2026-11-10에 지웠다.
  제품 저장소에 예시 데이터 전용 코드를 두지 않는다. 예시 실행 스크립트는 이 저장소 밖(프로젝트의 `run/`, `examples/`)에 있다.
  `kr/korean-eval`에서 다시 가져올 때 `bb14d778`은 고르지 않는다.
