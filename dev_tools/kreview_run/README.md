<!--
SPDX-License-Identifier: Apache-2.0
-->

# kreview_run

운영 DB 덤프의 `renewal_kreview`를 개인정보 마스킹한 사본으로 auto-ontology를 돌릴 때 쓰는 스크립트입니다.
덤프, 마스킹된 데이터, 접속 정보, 로그는 저장소에 넣지 않습니다. 모두 `$KREVIEW_HOME`(기본값 `~/Documents/ontology/kreview-run`)에 둡니다.

| 파일 | 용도 |
| --- | --- |
| `mask_pii.sql` | 덤프를 별도 MariaDB에 올린 뒤 실행합니다. 같은 값은 같은 가명으로 바꾸므로 테이블 간 조인이 유지됩니다. 마스킹하지 않은 데이터를 LLM으로 보내지 마세요. |
| `start.sh` / `stop.sh` | 분리된 인스턴스(백엔드 :3101, 인제스트 :3102)를 띄우고 내립니다. `--reset`을 주면 처음부터 다시 컴파일합니다. |
| `semantic_fk_fixes.sql` | 데이터로 확인한 semantic FK 수정(잘못된 엣지 1개 삭제, 누락된 엣지 10개 추가)입니다. store DB(`kreview_store`)에 실행하며, `--reset`으로 다시 컴파일한 뒤에는 다시 적용해야 합니다. |
| `ask.py` | `:3101`에 자연어 질문을 보내고 생성된 SQL, 답변, 결과 행을 JSON으로 출력합니다. |
