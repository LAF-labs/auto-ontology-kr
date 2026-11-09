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

Gold SQL follows the business rule stated in the question; when a question
says nothing about cancelled/returned orders, all orders count.
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
        "question": "취소된 주문을 빼면 고객 한 명당 평균 주문 횟수는 몇 번이에요? 소수 둘째 자리까지.",
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
]
