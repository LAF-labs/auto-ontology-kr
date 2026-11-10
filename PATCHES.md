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

## 가져온 커밋과 보정

- `fc43a826`(업스트림 CODE_OF_CONDUCT), `bb14d778`(kreview 실행 스크립트)를 cherry-pick했다.
  둘 다 SPDX 헤더가 없어 `dev_tools/tests/test_licensing.py`가 실패했다. `CODE_OF_CONDUCT.md`는 고치지 않고
  `CODE_OF_CONDUCT.md.license` 사이드카를 추가했고, 이 포크 파일인 `dev_tools/kreview_run/README.md`에는 헤더를 넣었다.
