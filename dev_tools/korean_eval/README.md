<!--
SPDX-License-Identifier: Apache-2.0
-->

# 한국어 평가 세트 (`korean_eval`)

한국 중소기업 DB에서 한국어 모드가 얼마나 잘 동작하는지 재는 도구입니다.
가상 유통사 DB(`korean_smb`, 14개 테이블)와 한국어 질문 47개, 정답 SQL, 채점기로 구성됩니다.
q01–q30은 기본, q31–q47은 더 어려운 한국어 사례입니다.
고객사 DB 없이 같은 조건으로 반복 측정할 수 있어서, 패치 전후를 숫자로 비교할 때 씁니다.

## 무엇을 시험하나

| 특징 | 예 |
|---|---|
| 영문 약어 컬럼 + 한글 주석 | `TB_ITEM.PUR_PRC` → `매입단가` |
| 한글 테이블·컬럼명 | `직원.주민등록번호`, `월별_매출목표` |
| 주석 없는 영문 테이블 | `ad_spend.channel = 'naver_sa'` |
| 주석에만 설명된 코드값 | `CUST_GB` `01:개인, 02:법인`, `TAX_GB` `1:과세, 2:면세` |
| 문자열 날짜 | `REG_DT` `CHAR(8)` `YYYYMMDD`, `SHIP_DT` `YYYY.MM.DD` |
| 한글 값 + 조사 | "쿠팡에서", "카카오페이로", "서울인" |
| 개인정보 컬럼 | 이름, 휴대폰, 주소, 마스킹된 주민등록번호 (모두 가짜 값) |
| 선언되지 않은 관계 | PK만 있고 FK는 없음 (실제 국내 중소기업 DB처럼) |
| 공통코드 테이블 | `TB_RTN.RTN_RSN_CD` → `TB_COMM_CD(grp_cd='RTN_RSN')` |
| 로마자 한국어 이름, 주석 없음 | `TB_GEORAECHEO.GEORAECHEO_NM`, `TB_MAEIP.MAEIP_ILJA` |
| 상대 날짜·한국어 금액 단위 | "지난달", "3만원 이상", "1억 원 넘게" |
| 띄어쓰기·별칭 | "스마트 스토어", "씨제이대한통운", "N페이", "VAT" |

질문마다 태그가 붙어 있어 결과를 특징별 정답률로도 볼 수 있습니다(`questions.py` 상단 참고).

## 1. 픽스처 DB 만들기

```bash
python3 -I dev_tools/korean_eval/generate_fixture.py
```

`build/korean_smb_postgres.sql`, `build/korean_smb_mysql.sql`가 생깁니다. 시드가 고정이라 항상 같은 데이터입니다.

```bash
docker run -d --name ko-eval-pg -e POSTGRES_PASSWORD=koeval -e POSTGRES_DB=korean_smb -p 55432:5432 postgres:17
docker exec -i ko-eval-pg psql -q -U postgres -d korean_smb < dev_tools/korean_eval/build/korean_smb_postgres.sql
```

MySQL/MariaDB 커넥터(주석 수집 등)를 시험할 때만:

```bash
docker run -d --name ko-eval-maria -e MARIADB_ROOT_PASSWORD=koeval -e MARIADB_DATABASE=korean_smb -p 53306:3306 mariadb:11.6.2
docker exec -i ko-eval-maria mariadb -uroot -pkoeval --default-character-set=utf8mb4 korean_smb < dev_tools/korean_eval/build/korean_smb_mysql.sql
```

## 2. 정답 만들기

```bash
python3 -I dev_tools/korean_eval/run_eval.py gold
```

## 3. 앱에 연결하고 컴파일

0. 모델 설정을 확인합니다. OpenRouter로 Claude Haiku 5.5를 쓰는 예:

   ```
   LLM_OPENAI_COMPATIBLE=1
   LLM_REASONING_EFFORT=low
   REASONING_ENDPOINT=https://openrouter.ai/api/v1
   REASONING_MODEL=anthropic/claude-haiku-5.5
   NON_REASONING_ENDPOINT=https://openrouter.ai/api/v1
   NON_REASONING_MODEL=anthropic/claude-haiku-5.5
   ```

   임베딩·리랭킹(`EMBED_*`, `RERANK_*`)은 NVIDIA 키를 그대로 씁니다. 벡터 저장소가 2048차원으로 고정돼 있어
   `nemotron-3.5-embed-1b`가 아닌 임베딩 모델은 그대로 쓸 수 없습니다. 키를 넣은 뒤 아래로 30초 안에 점검합니다.

   ```bash
   uv run --no-sync python dev_tools/korean_eval/check_llm.py
   ```

1. `.env`에 `AUTO_ONTOLOGY_LANGUAGE=ko`를 넣고 스택을 띄웁니다.
2. 연결 문자열 `postgresql://postgres:koeval@host.docker.internal:55432/korean_smb`로 연결합니다.
   앱을 도커 밖에서 돌리면 `localhost:55432`.
3. 시맨틱 레이어를 컴파일합니다.
4. 사용자 메뉴 → **API Tokens**에서 토큰을 만듭니다.

## 한 번에 돌리기

```bash
dev_tools/korean_eval/run_once.sh <이름> [q31 q32 ...]   # 수집 → 컴파일 → 질문 → 채점, build/runs/<이름>/
```

모델 비교가 필요할 때만 `bakeoff.sh <model> ...`을 씁니다.

## 4. 질문하고 채점하기

```bash
export AUTO_ONTOLOGY_API_TOKEN=...
python3 -I dev_tools/korean_eval/run_eval.py ask      # 이어서 실행 가능, --only q01 q02, --force
python3 -I dev_tools/korean_eval/run_eval.py score    # build/report.md
python3 -I dev_tools/korean_eval/run_eval.py terms    # build/terms.md: 테이블별 한국어 Term 이름
```

`score`는 앱이 만든 SQL을 픽스처 DB에서 **읽기 전용 트랜잭션**으로 다시 실행해 정답과 비교합니다.
행 수가 같고 정답의 모든 열이 예측 결과의 서로 다른 열과 값이 같으면 정답입니다.
열 이름·순서·추가 열은 따지지 않고, 1,000 이상의 숫자는 정수로, 그보다 작은 숫자는 소수 둘째 자리로 맞춰 비교합니다.

## 주의

- 결과는 LLM과 임베딩 모델에 따라 달라집니다. 비교할 때는 모델을 고정하고, 같은 커밋에서 두세 번 돌려 편차를 확인하세요.
- `build/`는 생성물이라 커밋하지 않습니다.
- 개인정보 판정 기대값(`expectations.PII_COLUMNS`)은 지금은 UI에서 눈으로 확인합니다.
