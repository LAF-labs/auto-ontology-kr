# SPDX-License-Identifier: Apache-2.0

"""Korean questions over ``korean_smb`` with gold SQL (Postgres dialect).

Each question is tagged with the Korean-environment traits it exercises, so a
score can be broken down by trait:

``comment``     the meaning lives only in a Korean column/table comment
``ko_ident``    Korean table or column names
``no_comment``  English table without comments; meaning from names/values
``literal``     a Korean literal value in the question (``쿠팡``, ``서울``)
``particle``    the key word carries a particle (``쿠팡에서``, ``카카오페이로``)
``code``        a code column explained only in its comment (``02:법인``)
``date_char8``  date stored as ``CHAR(8)`` ``YYYYMMDD``
``date_dot``    date stored as ``VARCHAR`` ``YYYY.MM.DD``
``krw``         money in KRW
``join``        needs a join the database does not declare
``english``     English question in Korean mode
``relative_date`` "지난달", "그 전달" (answered against today's date)
``ko_number``   amounts in Korean units ("3만원", "1억 원")
``spacing``     a literal written with different spacing ("스마트 스토어")
``alias``       a value or column named by an alias ("씨제이대한통운", "N페이", "VAT")
``common_code`` a code explained only by the shared code table (공통코드)
``romanized``   romanized-Korean names with no comments (georaecheo_nm)
``ordinal``     "두 번째로"
``weekday``     "주말(토·일)"

Gold SQL follows the business rule stated in the question; when a question
says nothing about cancelled/returned orders, all orders count.

``match_columns`` lists the gold columns a prediction must reproduce when the
rest only supports the answer (a top-5 list may omit the quantity it ranks by).
Default: every gold column.
"""

from __future__ import annotations

QUESTIONS: list[dict] = [
    {
        "id": "q01",
        "question": "2026년 9월에 판매채널별 주문 건수를 알려줘. 취소된 주문은 빼고.",
        "tags": ["comment", "literal", "particle"],
        "gold_sql": """
            SELECT chnl_cd, COUNT(*) AS cnt
            FROM tb_ord_m
            WHERE ord_dt >= '2026-09-01' AND ord_dt < '2026-10-01'
              AND ord_stat <> '취소'
            GROUP BY chnl_cd
        """,
    },
    {
        "id": "q02",
        "question": "쿠팡에서 2026년 3분기에 취소·반품을 제외한 결제금액 합계는 얼마인가요?",
        "tags": ["comment", "literal", "particle", "krw"],
        "gold_sql": """
            SELECT SUM(pay_amt)
            FROM tb_ord_m
            WHERE chnl_cd = '쿠팡'
              AND ord_dt >= '2026-07-01' AND ord_dt < '2026-10-01'
              AND ord_stat NOT IN ('취소', '반품')
        """,
    },
    {
        "id": "q03",
        "question": "VIP 등급 고객은 몇 명인가요?",
        "tags": ["comment", "literal", "particle"],
        "gold_sql": "SELECT COUNT(*) FROM tb_cust WHERE grade_cd = 'VIP'",
    },
    {
        "id": "q04",
        "question": "주소가 서울인 고객은 몇 명이야?",
        "tags": ["comment", "literal", "particle"],
        "gold_sql": "SELECT COUNT(*) FROM tb_cust WHERE addr LIKE '서울%'",
    },
    {
        "id": "q05",
        "question": "2025년에 가입한 법인 고객은 몇 곳인가요?",
        "tags": ["comment", "code", "date_char8"],
        "gold_sql": """
            SELECT COUNT(*) FROM tb_cust
            WHERE cust_gb = '02' AND reg_dt BETWEEN '20250101' AND '20251231'
        """,
    },
    {
        "id": "q06",
        "question": "2026년 10월에 출고된 주문은 몇 건인가요?",
        "tags": ["comment", "date_dot"],
        "gold_sql": "SELECT COUNT(*) FROM tb_dlv WHERE ship_dt LIKE '2026.10.%'",
    },
    {
        "id": "q07",
        "question": "2026년 주문 기준으로, 주문일부터 배송완료일까지 평균 며칠 걸렸나요? 소수 둘째 자리까지.",
        "tags": ["comment", "date_dot", "join"],
        "gold_sql": """
            SELECT ROUND(AVG(TO_DATE(d.cmpl_dt, 'YYYY.MM.DD') - m.ord_dt), 2)
            FROM tb_ord_m m JOIN tb_dlv d ON d.ord_no = m.ord_no
            WHERE m.ord_dt >= '2026-01-01' AND m.ord_dt < '2027-01-01'
              AND d.cmpl_dt IS NOT NULL
        """,
    },
    {
        "id": "q08",
        "question": "택배사별 배송 건수를 보여줘.",
        "tags": ["comment", "particle"],
        "gold_sql": "SELECT dlv_co, COUNT(*) FROM tb_dlv GROUP BY dlv_co",
    },
    {
        "id": "q09",
        "question": "2026년 상반기 대분류 카테고리별 공급가액 합계를 알려줘. 취소·반품 주문은 제외해줘.",
        "tags": ["comment", "join", "krw"],
        "gold_sql": """
            SELECT top.cate_nm, SUM(d.supply_amt)
            FROM tb_ord_d d
            JOIN tb_ord_m m ON m.ord_no = d.ord_no
            JOIN tb_item i ON i.item_cd = d.item_cd
            JOIN tb_cate sub ON sub.cate_cd = i.cate_cd
            JOIN tb_cate top ON top.cate_cd = sub.up_cate_cd
            WHERE m.ord_dt >= '2026-01-01' AND m.ord_dt < '2026-07-01'
              AND m.ord_stat NOT IN ('취소', '반품')
            GROUP BY top.cate_nm
        """,
    },
    {
        "id": "q10",
        # Only the item names must match; the quantity/margin column is optional.
        "match_columns": [0],
        "question": "2026년에 수량 기준으로 가장 많이 팔린 상품 5개는? 취소·반품은 제외.",
        "tags": ["comment", "join"],
        "order_matters": True,
        "gold_sql": """
            SELECT i.item_nm, SUM(d.ord_qty) AS qty
            FROM tb_ord_d d
            JOIN tb_ord_m m ON m.ord_no = d.ord_no
            JOIN tb_item i ON i.item_cd = d.item_cd
            WHERE m.ord_dt >= '2026-01-01' AND m.ord_dt < '2027-01-01'
              AND m.ord_stat NOT IN ('취소', '반품')
            GROUP BY i.item_nm
            ORDER BY qty DESC, i.item_nm
            LIMIT 5
        """,
    },
    {
        "id": "q11",
        "question": "면세 상품은 몇 개야?",
        "tags": ["comment", "code"],
        "gold_sql": "SELECT COUNT(*) FROM tb_item WHERE tax_gb = '2'",
    },
    {
        "id": "q12",
        "question": "현재고가 안전재고보다 적은 상품을 창고별로 보여줘.",
        "tags": ["comment", "join", "particle"],
        "gold_sql": """
            SELECT s.wh_cd, i.item_nm
            FROM tb_stock s JOIN tb_item i ON i.item_cd = s.item_cd
            WHERE s.stock_qty < s.safe_qty
        """,
    },
    {
        "id": "q13",
        "question": "부서별 평균 연봉은 얼마인가요?",
        "tags": ["ko_ident", "krw"],
        "gold_sql": 'SELECT "부서명", AVG("연봉") FROM "직원" GROUP BY "부서명"',
    },
    {
        "id": "q14",
        "question": "2020년 이전에 입사한 직원은 몇 명이에요?",
        "tags": ["ko_ident", "particle"],
        "gold_sql": """SELECT COUNT(*) FROM "직원" WHERE "입사일자" < '2020-01-01'""",
    },
    {
        "id": "q15",
        "question": "2026년 9월 판매채널별 매출 목표 달성률(%)을 알려줘. 매출은 취소·반품 제외 결제금액 기준, 소수 첫째 자리까지.",
        "tags": ["ko_ident", "comment", "join", "krw"],
        "gold_sql": """
            SELECT t."판매채널",
                   ROUND(SUM(m.pay_amt) * 100.0 / t."목표금액", 1)
            FROM "월별_매출목표" t
            JOIN tb_ord_m m
              ON m.chnl_cd = t."판매채널"
             AND TO_CHAR(m.ord_dt, 'YYYY-MM') = t."목표연월"
            WHERE t."목표연월" = '2026-09'
              AND m.ord_stat NOT IN ('취소', '반품')
            GROUP BY t."판매채널", t."목표금액"
        """,
    },
    {
        "id": "q16",
        "question": "2026년 9월 네이버 검색광고 비용은 총 얼마인가요?",
        "tags": ["no_comment", "krw"],
        "gold_sql": """
            SELECT SUM(cost) FROM ad_spend
            WHERE channel = 'naver_sa'
              AND spend_date >= '2026-09-01' AND spend_date < '2026-10-01'
        """,
    },
    {
        "id": "q17",
        "question": "2026년 3분기 광고 채널별 클릭당 비용(CPC)을 원 단위로 반올림해서 알려줘.",
        "tags": ["no_comment", "krw"],
        "gold_sql": """
            SELECT channel, ROUND(SUM(cost)::numeric / SUM(clicks), 0)
            FROM ad_spend
            WHERE spend_date >= '2026-07-01' AND spend_date < '2026-10-01'
            GROUP BY channel
        """,
    },
    {
        "id": "q18",
        "question": "추석 캠페인에 쓴 광고비는 전부 얼마야?",
        "tags": ["no_comment", "literal", "particle", "krw"],
        "gold_sql": "SELECT SUM(cost) FROM ad_spend WHERE campaign_name LIKE '%추석%'",
    },
    {
        "id": "q19",
        "question": "반품률이 가장 높은 판매채널은 어디인가요?",
        "tags": ["comment", "literal"],
        "gold_sql": """
            SELECT chnl_cd
            FROM tb_ord_m
            GROUP BY chnl_cd
            ORDER BY AVG(CASE WHEN ord_stat = '반품' THEN 1.0 ELSE 0 END) DESC
            LIMIT 1
        """,
    },
    {
        "id": "q20",
        "question": "취소된 주문을 빼면, 주문한 적이 있는 고객 한 명당 평균 주문 횟수는 몇 번이에요? 소수 둘째 자리까지.",
        "tags": ["comment", "literal", "particle"],
        "gold_sql": """
            SELECT ROUND(COUNT(*)::numeric / COUNT(DISTINCT cust_cd), 2)
            FROM tb_ord_m WHERE ord_stat <> '취소'
        """,
    },
    {
        "id": "q21",
        "question": "2026년에 가입한 고객 중 한 번이라도 주문한 고객은 몇 명인가요?",
        "tags": ["comment", "date_char8", "join"],
        "gold_sql": """
            SELECT COUNT(DISTINCT c.cust_cd)
            FROM tb_cust c JOIN tb_ord_m m ON m.cust_cd = c.cust_cd
            WHERE c.reg_dt LIKE '2026%'
        """,
    },
    {
        "id": "q22",
        "question": "2026년 주문 중 할인을 받은 주문의 비율은 몇 %인가요? 소수 첫째 자리까지.",
        "tags": ["comment"],
        "gold_sql": """
            SELECT ROUND(AVG(CASE WHEN dc_amt > 0 THEN 100.0 ELSE 0 END), 1)
            FROM tb_ord_m
            WHERE ord_dt >= '2026-01-01' AND ord_dt < '2027-01-01'
        """,
    },
    {
        "id": "q23",
        "question": "배송비를 낸 주문의 평균 결제금액은? 원 단위로 반올림.",
        "tags": ["comment", "particle", "krw"],
        "gold_sql": "SELECT ROUND(AVG(pay_amt), 0) FROM tb_ord_m WHERE dlv_fee > 0",
    },
    {
        "id": "q24",
        "question": "카카오페이로 결제한 주문은 몇 건이에요?",
        "tags": ["comment", "literal", "particle"],
        "gold_sql": "SELECT COUNT(*) FROM tb_ord_m WHERE pay_mthd = '카카오페이'",
    },
    {
        "id": "q25",
        # Only the item names must match; the quantity/margin column is optional.
        "match_columns": [0],
        "question": "판매단가 대비 매입단가 기준 마진율이 가장 낮은 상품 5개를 알려줘.",
        "tags": ["comment"],
        "order_matters": True,
        "gold_sql": """
            SELECT item_nm,
                   ROUND((sale_prc - pur_prc)::numeric / sale_prc * 100, 1) AS margin
            FROM tb_item
            ORDER BY (sale_prc - pur_prc)::numeric / sale_prc, item_nm
            LIMIT 5
        """,
    },
    {
        "id": "q26",
        "question": "How many orders were cancelled in 2026?",
        "tags": ["english", "comment", "literal"],
        "gold_sql": """
            SELECT COUNT(*) FROM tb_ord_m
            WHERE ord_stat = '취소'
              AND ord_dt >= '2026-01-01' AND ord_dt < '2027-01-01'
        """,
    },
    {
        "id": "q27",
        "question": "주문 1건당 평균 몇 종류의 상품이 들어 있나요? 소수 둘째 자리까지.",
        "tags": ["comment", "join"],
        "gold_sql": """
            SELECT ROUND(COUNT(*)::numeric / COUNT(DISTINCT ord_no), 2) FROM tb_ord_d
        """,
    },
    {
        "id": "q28",
        "question": "1월부터 10월까지 총 결제금액을 2025년과 2026년으로 비교해줘. 취소·반품 제외.",
        "tags": ["comment", "krw"],
        "gold_sql": """
            SELECT EXTRACT(YEAR FROM ord_dt)::int AS yr, SUM(pay_amt)
            FROM tb_ord_m
            WHERE EXTRACT(MONTH FROM ord_dt) BETWEEN 1 AND 10
              AND ord_stat NOT IN ('취소', '반품')
            GROUP BY yr
        """,
    },
    {
        "id": "q29",
        "question": "경기도에 사는 고객들의 2026년 주문금액 합계는? 취소·반품 제외, 총주문금액 기준.",
        "tags": ["comment", "literal", "particle", "join", "krw"],
        "gold_sql": """
            SELECT SUM(m.tot_amt)
            FROM tb_ord_m m JOIN tb_cust c ON c.cust_cd = m.cust_cd
            WHERE c.addr LIKE '경기도%'
              AND m.ord_dt >= '2026-01-01' AND m.ord_dt < '2027-01-01'
              AND m.ord_stat NOT IN ('취소', '반품')
        """,
    },
    {
        "id": "q30",
        "question": "CJ대한통운으로 보낸 배송 중 아직 배송완료되지 않은 건은 몇 건이야?",
        "tags": ["comment", "literal", "particle"],
        "gold_sql": """
            SELECT COUNT(*) FROM tb_dlv
            WHERE dlv_co = 'CJ대한통운' AND cmpl_dt IS NULL
        """,
    },
    # --- Harder Korean cases -------------------------------------------------
    {
        "id": "q31",
        "question": "지난달 스마트 스토어 주문 건수는? 취소 제외.",
        "tags": ["relative_date", "spacing", "literal"],
        "gold_sql": """
            SELECT COUNT(*) FROM tb_ord_m
            WHERE chnl_cd = '스마트스토어' AND ord_stat <> '취소'
              AND ord_dt >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
              AND ord_dt < date_trunc('month', CURRENT_DATE)
        """,
    },
    {
        "id": "q32",
        "question": "지난달이랑 그 전달 결제금액 합계를 비교해줘. 취소·반품 제외.",
        "tags": ["relative_date", "krw"],
        "gold_sql": """
            SELECT date_trunc('month', ord_dt)::date AS month, SUM(pay_amt)
            FROM tb_ord_m
            WHERE ord_stat NOT IN ('취소', '반품')
              AND ord_dt >= date_trunc('month', CURRENT_DATE) - INTERVAL '2 month'
              AND ord_dt < date_trunc('month', CURRENT_DATE)
            GROUP BY 1
        """,
        # The month label may be written any way; the two sums are the answer.
        "match_columns": [1],
    },
    {
        "id": "q33",
        "question": "결제금액이 3만원 이상인 주문은 몇 건이야?",
        "tags": ["ko_number", "krw"],
        "gold_sql": "SELECT COUNT(*) FROM tb_ord_m WHERE pay_amt >= 30000",
    },
    {
        "id": "q34",
        "question": "총주문금액이 10만원 넘는 주문 중에 할인 받은 건 몇 건이야?",
        "tags": ["ko_number", "krw"],
        "gold_sql": """
            SELECT COUNT(*) FROM tb_ord_m WHERE tot_amt > 100000 AND dc_amt > 0
        """,
    },
    {
        "id": "q35",
        "question": "지금까지 결제금액이 1억 원 넘게 나온 판매채널은 어디야? 취소·반품 제외.",
        "tags": ["ko_number", "krw"],
        "gold_sql": """
            SELECT chnl_cd FROM tb_ord_m
            WHERE ord_stat NOT IN ('취소', '반품')
            GROUP BY chnl_cd
            HAVING SUM(pay_amt) > 100000000
        """,
    },
    {
        "id": "q36",
        "question": "상품불량으로 반품된 건은 몇 건이야?",
        "tags": ["common_code", "literal", "particle"],
        "gold_sql": """
            SELECT COUNT(*) FROM tb_rtn r
            JOIN tb_comm_cd c ON c.grp_cd = 'RTN_RSN' AND c.cd = r.rtn_rsn_cd
            WHERE c.cd_nm = '상품불량'
        """,
    },
    {
        "id": "q37",
        "question": "반품 사유별 환불금액 합계를 알려줘.",
        "tags": ["common_code", "krw"],
        "gold_sql": """
            SELECT c.cd_nm, SUM(r.rtn_amt) FROM tb_rtn r
            JOIN tb_comm_cd c ON c.grp_cd = 'RTN_RSN' AND c.cd = r.rtn_rsn_cd
            GROUP BY c.cd_nm
        """,
    },
    {
        "id": "q38",
        "question": "부산 물류센터의 현재고 수량 합계는?",
        "tags": ["common_code", "literal", "particle"],
        "gold_sql": """
            SELECT SUM(s.stock_qty) FROM tb_stock s
            JOIN tb_comm_cd c ON c.grp_cd = 'WH' AND c.cd = s.wh_cd
            WHERE c.cd_nm = '부산 물류센터'
        """,
    },
    {
        "id": "q39",
        "question": "2026년 매입금액이 가장 많은 거래처 3곳은?",
        "tags": ["romanized", "date_char8", "join"],
        "order_matters": True,
        "match_columns": [0],
        "gold_sql": """
            SELECT g.georaecheo_nm, SUM(m.maeip_geumaek) AS amt
            FROM tb_maeip m JOIN tb_georaecheo g ON g.georaecheo_cd = m.georaecheo_cd
            WHERE m.maeip_ilja LIKE '2026%'
            GROUP BY g.georaecheo_nm
            ORDER BY amt DESC, g.georaecheo_nm
            LIMIT 3
        """,
    },
    {
        "id": "q40",
        "question": "대표자가 김씨인 거래처는 몇 곳이야?",
        "tags": ["romanized", "literal"],
        "gold_sql": "SELECT COUNT(*) FROM tb_georaecheo WHERE daepyo_nm LIKE '김%'",
    },
    {
        "id": "q41",
        "question": "거래 중인 거래처를 지역별로 몇 곳씩인지 알려줘.",
        "tags": ["romanized", "code"],
        "gold_sql": """
            SELECT jiyeok, COUNT(*) FROM tb_georaecheo
            WHERE sayong_yn = 'Y' GROUP BY jiyeok
        """,
    },
    {
        "id": "q42",
        "question": "2026년 9월 VAT 합계는 얼마야?",
        "tags": ["alias", "comment", "join", "krw"],
        "gold_sql": """
            SELECT SUM(d.vat_amt) FROM tb_ord_d d
            JOIN tb_ord_m m ON m.ord_no = d.ord_no
            WHERE m.ord_dt >= '2026-09-01' AND m.ord_dt < '2026-10-01'
        """,
    },
    {
        "id": "q43",
        "question": "씨제이대한통운으로 보낸 배송은 몇 건이야?",
        "tags": ["alias", "literal", "particle"],
        "gold_sql": "SELECT COUNT(*) FROM tb_dlv WHERE dlv_co = 'CJ대한통운'",
    },
    {
        "id": "q44",
        "question": "N페이로 결제한 주문은 몇 건이야?",
        "tags": ["alias", "literal", "particle"],
        "gold_sql": "SELECT COUNT(*) FROM tb_ord_m WHERE pay_mthd = '네이버페이'",
    },
    {
        "id": "q45",
        "question": "고객 주소의 시도 기준으로, 주문이 두 번째로 많은 지역은 어디야? 취소 제외.",
        "tags": ["ordinal", "join", "literal"],
        "gold_sql": """
            SELECT split_part(c.addr, ' ', 1)
            FROM tb_ord_m m JOIN tb_cust c ON c.cust_cd = m.cust_cd
            WHERE m.ord_stat <> '취소'
            GROUP BY 1
            ORDER BY COUNT(*) DESC
            OFFSET 1 LIMIT 1
        """,
    },
    {
        "id": "q46",
        "question": "2026년에 가입한 고객은 가입하고 첫 주문까지 평균 며칠 걸렸어? 소수 첫째 자리까지.",
        "tags": ["date_char8", "join"],
        "gold_sql": """
            SELECT ROUND(AVG(first_dt - TO_DATE(c.reg_dt, 'YYYYMMDD')), 1)
            FROM tb_cust c
            JOIN (SELECT cust_cd, MIN(ord_dt) AS first_dt FROM tb_ord_m GROUP BY cust_cd) f
              ON f.cust_cd = c.cust_cd
            WHERE c.reg_dt LIKE '2026%'
        """,
    },
    {
        "id": "q47",
        "question": "2026년 주문 중 주말(토·일)에 들어온 주문 비율은 몇 %야? 소수 첫째 자리까지.",
        "tags": ["weekday"],
        "gold_sql": """
            SELECT ROUND(AVG(CASE WHEN EXTRACT(ISODOW FROM ord_dt) IN (6, 7)
                                  THEN 100.0 ELSE 0 END), 1)
            FROM tb_ord_m
            WHERE ord_dt >= '2026-01-01' AND ord_dt < '2027-01-01'
        """,
    },
    {
        "id": "q48",
        "question": "바다수산에서 2026년에 매입한 금액은 모두 얼마야?",
        "tags": ["company_form", "romanized", "literal", "particle", "krw"],
        "gold_sql": """
            SELECT SUM(m.maeip_geumaek)
            FROM tb_maeip m JOIN tb_georaecheo g ON g.georaecheo_cd = m.georaecheo_cd
            WHERE g.georaecheo_nm = '(주)바다수산' AND m.maeip_ilja LIKE '2026%'
        """,
    },
    {
        "id": "q49",
        "question": "부산센터 재고 수량 합계는?",
        "tags": ["short_form", "common_code", "literal"],
        "gold_sql": """
            SELECT SUM(s.stock_qty) FROM tb_stock s
            JOIN tb_comm_cd c ON c.grp_cd = 'WH' AND c.cd = s.wh_cd
            WHERE c.cd_nm = '부산 물류센터'
        """,
    },
    {
        "id": "q50",
        "question": "결제금액이 5만원 이상 10만원 미만인 주문은 몇 건이야?",
        "tags": ["ko_number", "operator", "krw"],
        "gold_sql": """
            SELECT COUNT(*) FROM tb_ord_m
            WHERE pay_amt >= 50000 AND pay_amt < 100000
        """,
    },
]
