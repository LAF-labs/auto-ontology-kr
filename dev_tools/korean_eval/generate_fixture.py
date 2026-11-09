# SPDX-License-Identifier: Apache-2.0

"""Generate the Korean SMB evaluation database (``korean_smb``).

A synthetic, deterministic retail/e-commerce company database shaped the way
Korean small and mid-sized companies actually keep their data:

* Legacy ``TB_*`` tables whose columns are English abbreviations
  (``CUST_NM``, ``ORD_DT``, ``PUR_PRC``) with the meaning only in Korean
  column comments (``고객명``, ``주문일자``, ``매입단가``).
* Tables and columns named in Korean (``직원.주민등록번호``, ``월별_매출목표``).
* One English table with no comments at all (``ad_spend``), so the meaning has
  to come from names and sample values.
* Korean literal values (``쿠팡``, ``배송완료``, ``서울특별시``), KRW amounts,
  code columns explained only in comments (``01:개인, 02:법인``), and dates
  stored as ``CHAR(8)`` ``YYYYMMDD`` and ``VARCHAR`` ``YYYY.MM.DD`` strings.
* Personal data columns (names, phone numbers, addresses, masked resident
  registration numbers) for PII detection. All values are fake; e-mail
  addresses use the reserved ``example.com`` / ``example.co.kr`` domains.
* Primary keys but no declared foreign keys, as in most real Korean SMB
  databases, so relationships have to be inferred.

Usage::

    python3 -I dev_tools/korean_eval/generate_fixture.py [--out DIR]

Writes ``korean_smb_postgres.sql`` and ``korean_smb_mysql.sql``. The same seed
always produces the same files.
"""

from __future__ import annotations

import argparse
import random
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

SEED = 20261109
START = date(2025, 1, 1)
END = date(2026, 10, 31)
# Orders placed this close to END are still in flight.
IN_FLIGHT_FROM = END - timedelta(days=2)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Col:
    name: str
    pg_type: str
    my_type: str
    comment: str | None = None
    not_null: bool = False


@dataclass(frozen=True)
class Table:
    name: str  # Postgres name; MySQL uses upper case for tb_* tables
    comment: str | None
    cols: tuple[Col, ...]
    pk: tuple[str, ...]

    def my_name(self) -> str:
        return self.name.upper() if self.name.startswith("tb_") else self.name

    def my_col(self, col: str) -> str:
        return col.upper() if self.name.startswith("tb_") else col


def _vc(n: int) -> tuple[str, str]:
    return f"VARCHAR({n})", f"VARCHAR({n})"


def _ch(n: int) -> tuple[str, str]:
    return f"CHAR({n})", f"CHAR({n})"


INT = ("INTEGER", "INT")
BIG = ("BIGINT", "BIGINT")
DATE = ("DATE", "DATE")

TABLES: tuple[Table, ...] = (
    Table(
        "tb_cust",
        "고객 마스터",
        (
            Col("cust_cd", *_vc(10), "고객코드", True),
            Col("cust_nm", *_vc(100), "고객명", True),
            Col("cust_gb", *_ch(2), "고객구분(01:개인, 02:법인)", True),
            Col("biz_no", *_vc(12), "사업자등록번호"),
            Col("ceo_nm", *_vc(50), "대표자명"),
            Col("hp_no", *_vc(13), "휴대폰번호"),
            Col("email", *_vc(100), "이메일"),
            Col("zip_cd", *_ch(5), "우편번호"),
            Col("addr", *_vc(200), "주소"),
            Col("addr_dtl", *_vc(100), "상세주소"),
            Col("grade_cd", *_vc(10), "회원등급"),
            Col("reg_dt", *_ch(8), "가입일자(YYYYMMDD)", True),
            Col("use_yn", *_ch(1), "사용여부(Y/N)", True),
        ),
        ("cust_cd",),
    ),
    Table(
        "tb_cate",
        "상품 카테고리",
        (
            Col("cate_cd", *_vc(6), "카테고리코드", True),
            Col("cate_nm", *_vc(50), "카테고리명", True),
            Col("up_cate_cd", *_vc(6), "상위카테고리코드"),
        ),
        ("cate_cd",),
    ),
    Table(
        "tb_item",
        "상품 마스터",
        (
            Col("item_cd", *_vc(10), "상품코드", True),
            Col("item_nm", *_vc(100), "상품명", True),
            Col("cate_cd", *_vc(6), "카테고리코드", True),
            Col("spec", *_vc(50), "규격"),
            Col("unit", *_vc(10), "단위"),
            Col("sale_prc", *INT, "판매단가(부가세 포함)", True),
            Col("pur_prc", *INT, "매입단가", True),
            Col("tax_gb", *_ch(1), "과세구분(1:과세, 2:면세)", True),
            Col("reg_dt", *DATE, "등록일"),
            Col("use_yn", *_ch(1), "사용여부(Y/N)", True),
        ),
        ("item_cd",),
    ),
    Table(
        "tb_ord_m",
        "주문 마스터",
        (
            Col("ord_no", *_vc(20), "주문번호", True),
            Col("ord_dt", *DATE, "주문일자", True),
            Col("cust_cd", *_vc(10), "고객코드", True),
            Col("chnl_cd", *_vc(20), "판매채널", True),
            Col("ord_stat", *_vc(10), "주문상태", True),
            Col("tot_amt", *INT, "총주문금액", True),
            Col("dc_amt", *INT, "할인금액", True),
            Col("dlv_fee", *INT, "배송비", True),
            Col("pay_amt", *INT, "결제금액", True),
            Col("pay_mthd", *_vc(20), "결제수단", True),
        ),
        ("ord_no",),
    ),
    Table(
        "tb_ord_d",
        "주문 상세",
        (
            Col("ord_no", *_vc(20), "주문번호", True),
            Col("ord_seq", *INT, "주문순번", True),
            Col("item_cd", *_vc(10), "상품코드", True),
            Col("ord_qty", *INT, "주문수량", True),
            Col("unit_prc", *INT, "판매단가", True),
            Col("supply_amt", *INT, "공급가액", True),
            Col("vat_amt", *INT, "부가세", True),
        ),
        ("ord_no", "ord_seq"),
    ),
    Table(
        "tb_dlv",
        "배송 정보",
        (
            Col("ord_no", *_vc(20), "주문번호", True),
            Col("dlv_co", *_vc(20), "택배사", True),
            Col("invc_no", *_vc(20), "송장번호", True),
            Col("rcv_nm", *_vc(50), "수령인명", True),
            Col("rcv_hp", *_vc(13), "수령인 연락처", True),
            Col("rcv_addr", *_vc(300), "배송지 주소", True),
            Col("ship_dt", *_vc(10), "출고일자", True),
            Col("cmpl_dt", *_vc(10), "배송완료일자"),
        ),
        ("ord_no",),
    ),
    Table(
        "tb_stock",
        "재고 현황",
        (
            Col("wh_cd", *_vc(4), "창고코드", True),
            Col("item_cd", *_vc(10), "상품코드", True),
            Col("stock_qty", *INT, "현재고수량", True),
            Col("safe_qty", *INT, "안전재고수량", True),
            Col("base_dt", *_ch(8), "기준일자", True),
        ),
        ("wh_cd", "item_cd"),
    ),
    Table(
        "직원",
        "직원 정보",
        (
            Col("사번", *_vc(8), None, True),
            Col("성명", *_vc(50), None, True),
            Col("부서명", *_vc(30), None, True),
            Col("직급", *_vc(10), None, True),
            Col("주민등록번호", *_ch(14), None, True),
            Col("휴대전화", *_vc(13), None),
            Col("입사일자", *DATE, None, True),
            Col("연봉", *BIG, None, True),
        ),
        ("사번",),
    ),
    Table(
        "월별_매출목표",
        None,
        (
            Col("목표연월", *_ch(7), None, True),
            Col("판매채널", *_vc(20), None, True),
            Col("목표금액", *BIG, None, True),
        ),
        ("목표연월", "판매채널"),
    ),
    Table(
        "ad_spend",
        None,
        (
            Col("spend_date", *DATE, None, True),
            Col("channel", *_vc(20), None, True),
            Col("campaign_name", *_vc(100), None, True),
            Col("cost", *INT, None, True),
            Col("impressions", *INT, None, True),
            Col("clicks", *INT, None, True),
            Col("conversions", *INT, None, True),
        ),
        ("spend_date", "channel", "campaign_name"),
    ),
    # Shared code table, the usual Korean SI pattern: code values in other
    # tables are only explained by a (grp_cd, cd) row here.
    Table(
        "tb_comm_cd",
        "공통코드",
        (
            Col("grp_cd", *_vc(20), "코드그룹", True),
            Col("cd", *_vc(10), "코드", True),
            Col("cd_nm", *_vc(50), "코드명", True),
            Col("sort_ord", *INT, "정렬순서"),
            Col("use_yn", *_ch(1), "사용여부(Y/N)", True),
        ),
        ("grp_cd", "cd"),
    ),
    Table(
        "tb_rtn",
        "반품 내역",
        (
            Col("rtn_no", *_vc(20), "반품번호", True),
            Col("ord_no", *_vc(20), "주문번호", True),
            Col("rtn_dt", *DATE, "반품접수일", True),
            Col("rtn_rsn_cd", *_vc(10), "반품사유코드(공통코드 RTN_RSN)", True),
            Col("rtn_amt", *INT, "환불금액", True),
        ),
        ("rtn_no",),
    ),
    # Romanized-Korean names and no comments at all, as many in-house systems
    # are built: 거래처 (supplier) and 매입 (purchase).
    Table(
        "tb_georaecheo",
        None,
        (
            Col("georaecheo_cd", *_vc(10), None, True),
            Col("georaecheo_nm", *_vc(100), None, True),
            Col("saeopja_no", *_vc(12), None, True),
            Col("daepyo_nm", *_vc(50), None),
            Col("jiyeok", *_vc(20), None),
            Col("sayong_yn", *_ch(1), None, True),
        ),
        ("georaecheo_cd",),
    ),
    Table(
        "tb_maeip",
        None,
        (
            Col("maeip_no", *_vc(20), None, True),
            Col("maeip_ilja", *_ch(8), None, True),
            Col("georaecheo_cd", *_vc(10), None, True),
            Col("sangpum_cd", *_vc(10), None, True),
            Col("maeip_suryang", *INT, None, True),
            Col("maeip_danga", *INT, None, True),
            Col("maeip_geumaek", *BIG, None, True),
        ),
        ("maeip_no",),
    ),
)


# ---------------------------------------------------------------------------
# Value pools
# ---------------------------------------------------------------------------

SURNAMES = "김이박최정강조윤장임한오서신권황안송류홍"
GIVEN = (
    "민준 서준 도윤 예준 시우 하준 주원 지호 지후 준우 서연 서윤 지우 서현 "
    "민서 하은 하윤 윤서 지유 지민 채원 수빈 지원 은서 현우 성민 영호 정희 "
    "미경 영숙 상철 동현 혜진 수정 경민 재원 유진 다은 태윤 승현"
).split()

COMPANIES = (
    "(주)한빛유통",
    "주식회사 다온상사",
    "(주)푸른식품",
    "해솔무역(주)",
    "(주)정우마트",
    "주식회사 새봄컴퍼니",
    "(주)바른생활",
    "(주)온누리상회",
    "주식회사 미래리테일",
    "(주)하나로도매",
    "(주)청솔케어",
    "주식회사 가온코스메틱",
)

# (시도, 시군구, 도로명, 우편번호 앞 2자리)
REGIONS = (
    ("서울특별시", "강남구", "테헤란로", "06"),
    ("서울특별시", "송파구", "올림픽로", "05"),
    ("서울특별시", "마포구", "월드컵북로", "03"),
    ("서울특별시", "영등포구", "여의대로", "07"),
    ("서울특별시", "노원구", "동일로", "01"),
    ("경기도", "성남시 분당구", "판교역로", "13"),
    ("경기도", "수원시 영통구", "광교중앙로", "16"),
    ("경기도", "고양시 일산동구", "중앙로", "10"),
    ("경기도", "용인시 수지구", "포은대로", "16"),
    ("인천광역시", "연수구", "센트럴로", "22"),
    ("부산광역시", "해운대구", "센텀중앙로", "48"),
    ("부산광역시", "부산진구", "중앙대로", "47"),
    ("대구광역시", "수성구", "달구벌대로", "42"),
    ("대전광역시", "유성구", "대학로", "34"),
    ("광주광역시", "서구", "상무중앙로", "61"),
    ("울산광역시", "남구", "삼산로", "44"),
    ("세종특별자치시", "한누리대로", "한누리대로", "30"),
    ("강원특별자치도", "춘천시", "중앙로", "24"),
    ("충청북도", "청주시 흥덕구", "가경로", "28"),
    ("전북특별자치도", "전주시 완산구", "효자로", "54"),
    ("경상남도", "창원시 성산구", "중앙대로", "51"),
    ("제주특별자치도", "제주시", "노형로", "63"),
)
REGION_WEIGHTS = (9, 6, 5, 4, 3, 6, 5, 4, 4, 4, 4, 3, 3, 3, 2, 2, 1, 1, 2, 1, 2, 1)

# (대분류코드, 대분류명, ((중분류코드, 중분류명, 과세구분, 가격범위, 상품명들), ...))
CATEGORIES = (
    (
        "10",
        "식품",
        (
            (
                "1010",
                "가공식품",
                "1",
                (3900, 19900),
                "국산 참기름|들기름|김자반|현미 누룽지|수제 그래놀라|저당 딸기잼|"
                "통밀 파스타|유기농 두유|곤약 젤리|떡국떡",
            ),
            (
                "1020",
                "신선식품",
                "2",
                (9900, 49900),
                "제주 감귤|성주 참외|고창 수박|국내산 한우 불고기|무항생제 계란|"
                "햇사과|샤인머스캣|친환경 쌈채소|완도 전복|영광 굴비",
            ),
            (
                "1030",
                "건강식품",
                "1",
                (19900, 89000),
                "홍삼정 스틱|프로바이오틱스|루테인|비타민C|오메가3|"
                "콜라겐 젤리|멀티비타민|밀크씨슬|흑마늘즙|석류즙",
            ),
        ),
    ),
    (
        "20",
        "생활용품",
        (
            (
                "2010",
                "주방용품",
                "1",
                (5900, 59000),
                "스텐 냄비|실리콘 주걱|원목 도마|밀폐용기 세트|전기 주전자|"
                "프라이팬|수세미|키친타월|위생장갑|보온 텀블러",
            ),
            (
                "2020",
                "욕실용품",
                "1",
                (3900, 29900),
                "샴푸|트리트먼트|바디워시|치약|칫솔 세트|"
                "샤워기 필터|발매트|면도기|핸드워시|입욕제",
            ),
            (
                "2030",
                "청소용품",
                "1",
                (2900, 39900),
                "섬유유연제|세탁세제|주방세제|물티슈|청소포|"
                "락스|유리세정제|탈취제|제습제|다용도 세정제",
            ),
        ),
    ),
    (
        "30",
        "화장품",
        (
            (
                "3010",
                "스킨케어",
                "1",
                (12000, 68000),
                "수분 크림|진정 토너|비타민 세럼|선크림|클렌징 폼|"
                "아이크림|시트 마스크|각질 패드|미스트|앰플",
            ),
            (
                "3020",
                "메이크업",
                "1",
                (9900, 45000),
                "쿠션 파운데이션|립틴트|아이섀도 팔레트|마스카라|컨실러|"
                "블러셔|아이라이너|프라이머|립밤|메이크업 픽서",
            ),
        ),
    ),
)
SPECS = {
    "1010": ("300g", "500g", "1kg"),
    "1020": ("1kg", "2kg", "5kg"),
    "1030": ("30포", "60정", "90정"),
    "2010": ("1개", "3종 세트", "대형"),
    "2020": ("500ml", "1L", "3개입"),
    "2030": ("2L", "3L", "10개입"),
    "3010": ("50ml", "100ml", "30매"),
    "3020": ("1개", "2종 세트", "리필"),
}

CHANNELS = ("스마트스토어", "쿠팡", "자사몰")
CHANNEL_WEIGHTS = (45, 35, 20)
PAY_METHODS = {
    "스마트스토어": (("네이버페이", 70), ("신용카드", 30)),
    "쿠팡": (("쿠팡페이", 65), ("신용카드", 35)),
    "자사몰": (
        ("신용카드", 45),
        ("카카오페이", 25),
        ("네이버페이", 15),
        ("계좌이체", 15),
    ),
}
COURIERS = (("CJ대한통운", 50), ("한진택배", 20), ("롯데택배", 20), ("우체국택배", 10))
GRADES = (("일반", 60), ("실버", 22), ("골드", 12), ("VIP", 6))
DEPTS = ("영업팀", "마케팅팀", "물류팀", "경영지원팀", "고객지원팀")
RANKS = (
    ("사원", 32_000_000),
    ("주임", 36_000_000),
    ("대리", 42_000_000),
    ("과장", 52_000_000),
    ("차장", 62_000_000),
    ("부장", 75_000_000),
)

AD_CHANNELS = ("naver_sa", "coupang_ads", "meta")
# Korean holidays that drive gift-set demand (설날, 추석).
HOLIDAYS = (date(2025, 1, 29), date(2025, 10, 6), date(2026, 2, 17), date(2026, 9, 25))


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def _pick(rng: random.Random, weighted) -> str:
    values, weights = zip(*weighted)
    return rng.choices(values, weights=weights)[0]


def _person(rng: random.Random) -> str:
    return rng.choice(SURNAMES) + rng.choice(GIVEN)


def _phone(rng: random.Random) -> str:
    return f"010-{rng.randint(2000, 9999)}-{rng.randint(0, 9999):04d}"


def _address(rng: random.Random) -> tuple[str, str, str]:
    sido, sigungu, road, zip2 = rng.choices(REGIONS, weights=REGION_WEIGHTS)[0]
    zip_cd = f"{zip2}{rng.randint(0, 999):03d}"
    if sido == sigungu or sigungu == road:
        addr = f"{sido} {road} {rng.randint(1, 300)}"
    else:
        addr = f"{sido} {sigungu} {road} {rng.randint(1, 300)}"
    dtl = rng.choice(
        (
            f"{rng.randint(101, 120)}동 {rng.randint(101, 2504)}호",
            f"{rng.randint(1, 12)}층",
            f"{rng.randint(101, 999)}호",
        )
    )
    return zip_cd, addr, dtl


def _rand_date(rng: random.Random, lo: date, hi: date) -> date:
    return lo + timedelta(days=rng.randint(0, (hi - lo).days))


def _demand(day: date) -> float:
    factor = 1.0
    for holiday in HOLIDAYS:
        lead = (holiday - day).days
        if 0 <= lead <= 14:
            factor *= 2.0
    if day.month == 11:
        factor *= 1.3
    if day.year == 2026:
        factor *= 1.25
    if day.weekday() >= 5:
        factor *= 0.8
    return factor


def generate() -> dict[str, list[tuple]]:
    rng = random.Random(SEED)
    rows: dict[str, list[tuple]] = {t.name: [] for t in TABLES}

    # Categories and items ------------------------------------------------
    items: list[dict] = []
    for top_cd, top_nm, subs in CATEGORIES:
        rows["tb_cate"].append((top_cd, top_nm, None))
        for sub_cd, sub_nm, tax_gb, (lo, hi), names in subs:
            rows["tb_cate"].append((sub_cd, sub_nm, top_cd))
            for base in names.split("|"):
                for spec in rng.sample(SPECS[sub_cd], k=rng.choice((1, 1, 2))):
                    sale = rng.randrange(lo, hi, 100) // 100 * 100 + 0
                    sale = sale - (sale % 1000) + rng.choice((0, 900, 500))
                    margin = rng.uniform(0.18, 0.55)
                    pur = int(sale * (1 - margin) / 1.1) // 10 * 10
                    items.append(
                        {
                            "item_cd": f"P{len(items) + 1:05d}",
                            "item_nm": f"{base} {spec}",
                            "cate_cd": sub_cd,
                            "spec": spec,
                            "unit": "세트" if "세트" in spec else "개",
                            "sale_prc": sale,
                            "pur_prc": pur,
                            "tax_gb": tax_gb,
                            "popularity": rng.paretovariate(1.3),
                        }
                    )
    for item in items:
        reg = _rand_date(rng, date(2023, 1, 1), date(2026, 6, 30))
        use_yn = "N" if rng.random() < 0.05 else "Y"
        rows["tb_item"].append(
            (
                item["item_cd"],
                item["item_nm"],
                item["cate_cd"],
                item["spec"],
                item["unit"],
                item["sale_prc"],
                item["pur_prc"],
                item["tax_gb"],
                reg,
                use_yn,
            )
        )

    # Customers -----------------------------------------------------------
    customers: list[dict] = []
    for i in range(420):
        corp = rng.random() < 0.15
        reg = _rand_date(rng, date(2023, 1, 1), END)
        if rng.random() < 0.55:
            reg = _rand_date(rng, date(2023, 1, 1), date(2024, 12, 31))
        zip_cd, addr, dtl = _address(rng)
        name = rng.choice(COMPANIES) if corp else _person(rng)
        customers.append(
            {
                "cust_cd": "",
                "name": name,
                "corp": corp,
                "reg": reg,
                "hp": _phone(rng),
                "addr": addr,
                "dtl": dtl,
                "zip": zip_cd,
                "weight": rng.paretovariate(1.5),
            }
        )
    customers.sort(key=lambda c: c["reg"])
    for i, cust in enumerate(customers, start=1):
        cust["cust_cd"] = f"C{i:06d}"
        domain = "example.co.kr" if cust["corp"] else "example.com"
        rows["tb_cust"].append(
            (
                cust["cust_cd"],
                cust["name"],
                "02" if cust["corp"] else "01",
                f"{rng.randint(100, 899)}-{rng.randint(10, 99)}-{rng.randint(0, 99999):05d}"
                if cust["corp"]
                else None,
                _person(rng) if cust["corp"] else None,
                cust["hp"],
                f"user{i:04d}@{domain}",
                cust["zip"],
                cust["addr"],
                cust["dtl"],
                _pick(rng, GRADES),
                cust["reg"].strftime("%Y%m%d"),
                "N" if rng.random() < 0.04 else "Y",
            )
        )

    # Orders --------------------------------------------------------------
    active_items = [it for it in items]
    item_weights = [it["popularity"] for it in active_items]
    seq_by_day: dict[date, int] = {}
    day = START
    while day <= END:
        eligible = [c for c in customers if c["reg"] <= day]
        n_orders = max(0, int(rng.gauss(5.5 * _demand(day), 1.8)))
        for _ in range(n_orders):
            cust = rng.choices(eligible, weights=[c["weight"] for c in eligible])[0]
            seq_by_day[day] = seq_by_day.get(day, 0) + 1
            ord_no = f"O{day:%Y%m%d}{seq_by_day[day]:04d}"
            chnl = _pick(rng, zip(CHANNELS, CHANNEL_WEIGHTS))
            pay = _pick(rng, PAY_METHODS[chnl])

            n_lines = rng.choices((1, 2, 3, 4), weights=(50, 28, 15, 7))[0]
            picked = []
            for item in rng.choices(active_items, weights=item_weights, k=n_lines * 2):
                if item not in picked:
                    picked.append(item)
                if len(picked) == n_lines:
                    break
            tot = 0
            for seq, item in enumerate(picked, start=1):
                qty = rng.choices((1, 2, 3, 5), weights=(70, 18, 8, 4))[0]
                if cust["corp"]:
                    qty *= rng.choice((2, 5, 10))
                line = item["sale_prc"] * qty
                if item["tax_gb"] == "1":
                    supply = round(line / 1.1)
                    vat = line - supply
                else:
                    supply, vat = line, 0
                rows["tb_ord_d"].append(
                    (ord_no, seq, item["item_cd"], qty, item["sale_prc"], supply, vat)
                )
                tot += line

            r = rng.random()
            dc = 0
            if r < 0.15:
                dc = rng.choice((1000, 2000, 3000, 5000))
            elif r < 0.25:
                dc = tot // 10 // 10 * 10
            dc = min(dc, tot)
            fee = 0 if tot >= 50000 or cust["corp"] else 3000
            pay_amt = tot - dc + fee

            if day >= IN_FLIGHT_FROM:
                stat = rng.choice(("결제완료", "배송중"))
            else:
                r = rng.random()
                stat = "취소" if r < 0.05 else "반품" if r < 0.08 else "배송완료"
            rows["tb_ord_m"].append(
                (ord_no, day, cust["cust_cd"], chnl, stat, tot, dc, fee, pay_amt, pay)
            )

            if stat in ("결제완료", "취소"):
                continue
            ship = day + timedelta(days=rng.choice((0, 1, 1, 2)))
            if stat == "배송중":
                cmpl = None
            else:
                cmpl = ship + timedelta(
                    days=rng.choices((1, 2, 3, 4), weights=(55, 30, 10, 5))[0]
                )
                cmpl = min(cmpl, END)
            if rng.random() < 0.8:
                rcv_nm, rcv_hp = (
                    (cust["name"] if not cust["corp"] else _person(rng)),
                    cust["hp"],
                )
                rcv_addr = f"{cust['addr']} {cust['dtl']}"
            else:
                rcv_nm, rcv_hp = _person(rng), _phone(rng)
                _, a, d = _address(rng)
                rcv_addr = f"{a} {d}"
            courier = _pick(rng, COURIERS)
            rows["tb_dlv"].append(
                (
                    ord_no,
                    courier,
                    f"{rng.randint(10**11, 10**12 - 1)}",
                    rcv_nm,
                    rcv_hp,
                    rcv_addr,
                    ship.strftime("%Y.%m.%d"),
                    cmpl.strftime("%Y.%m.%d") if cmpl else None,
                )
            )
        day += timedelta(days=1)

    # Stock snapshot -------------------------------------------------------
    for item in items:
        for wh in ("WH01", "WH02"):
            if wh == "WH02" and rng.random() < 0.4:
                continue
            safe = rng.choice((10, 20, 30, 50))
            qty = rng.randint(0, safe * 6)
            if rng.random() < 0.12:
                qty = rng.randint(0, safe - 1)
            rows["tb_stock"].append(
                (wh, item["item_cd"], qty, safe, END.strftime("%Y%m%d"))
            )

    # Employees ------------------------------------------------------------
    for i in range(1, 25):
        rank, base = rng.choice(RANKS)
        hired = _rand_date(rng, date(2012, 3, 1), date(2026, 9, 1))
        birth = _rand_date(rng, date(1970, 1, 1), date(2001, 12, 31))
        gender = rng.choice((1, 2)) if birth.year < 2000 else rng.choice((3, 4))
        rows["직원"].append(
            (
                f"E{2000 + i:05d}",
                _person(rng),
                rng.choice(DEPTS),
                rank,
                f"{birth:%y%m%d}-{gender}******",
                _phone(rng),
                hired,
                base + rng.randint(-3, 6) * 1_000_000,
            )
        )

    # Monthly sales targets ------------------------------------------------
    monthly: dict[tuple[str, str], int] = {}
    for o in rows["tb_ord_m"]:
        if o[4] in ("취소", "반품"):
            continue
        key = (o[1].strftime("%Y-%m"), o[3])
        monthly[key] = monthly.get(key, 0) + o[8]
    month = date(2025, 1, 1)
    while month <= date(2026, 12, 1):
        ym = month.strftime("%Y-%m")
        for chnl in CHANNELS:
            actual = monthly.get((ym, chnl))
            if actual is None:
                actual = monthly.get(
                    ((month.replace(year=month.year - 1)).strftime("%Y-%m"), chnl),
                    10_000_000,
                )
                actual = int(actual * 1.25)
            target = int(actual * rng.uniform(0.9, 1.2)) // 100_000 * 100_000
            rows["월별_매출목표"].append((ym, chnl, target))
        month = (month.replace(day=28) + timedelta(days=4)).replace(day=1)

    # Ad spend -------------------------------------------------------------
    day = START
    while day <= END:
        campaigns = ["상시 브랜드 검색"]
        for holiday in HOLIDAYS:
            lead = (holiday - day).days
            if 0 <= lead <= 21:
                campaigns.append(
                    "설 선물세트 기획전"
                    if holiday.month <= 2
                    else "추석 선물세트 기획전"
                )
        if day.month == 11:
            campaigns.append("블랙프라이데이 특가")
        if day.month in (3, 4, 9):
            campaigns.append("신상품 런칭")
        for ch in AD_CHANNELS:
            for camp in campaigns:
                if ch == "coupang_ads" and camp == "상시 브랜드 검색":
                    camp = "쿠팡 상품광고 상시"
                base = {"naver_sa": 60_000, "coupang_ads": 45_000, "meta": 30_000}[ch]
                if camp != "상시 브랜드 검색" and camp != "쿠팡 상품광고 상시":
                    base *= 1.8
                cost = int(rng.gauss(base * _demand(day), base * 0.2)) // 10 * 10
                cost = max(cost, 1000)
                cpc = {"naver_sa": 420, "coupang_ads": 310, "meta": 260}[
                    ch
                ] * rng.uniform(0.8, 1.25)
                clicks = max(1, int(cost / cpc))
                impressions = clicks * rng.randint(25, 90)
                conversions = int(clicks * rng.uniform(0.01, 0.05))
                rows["ad_spend"].append(
                    (day, ch, camp, cost, impressions, clicks, conversions)
                )
        day += timedelta(days=1)

    _generate_korean_si_tables(rows)
    return rows


SUPPLIERS = (
    ("(주)한결식품", "경기"),
    ("청정농산", "전남"),
    ("(주)바다수산", "부산"),
    ("한빛생활산업(주)", "경기"),
    ("(주)미소케미칼", "충북"),
    ("더좋은주방", "서울"),
    ("(주)라온코스메틱", "서울"),
    ("뷰티랩코리아", "경기"),
    ("(주)건강한하루", "강원"),
    ("제주감귤영농조합", "제주"),
    ("대성유통(주)", "대구"),
    ("(주)새한포장", "인천"),
)
RETURN_REASONS = (
    ("01", "단순변심", 45),
    ("02", "상품불량", 25),
    ("03", "오배송", 15),
    ("04", "배송지연", 15),
)
WAREHOUSES = (("WH01", "이천 물류센터"), ("WH02", "부산 물류센터"))


def _generate_korean_si_tables(rows: dict[str, list[tuple]]) -> None:
    """Common codes, returns, suppliers and purchases.

    Drawn from their own seeded generator after everything else, so adding
    them leaves every earlier table -- and every earlier gold answer -- as it was.
    """
    rng = random.Random(SEED + 1)

    for order, (cd, nm, _) in enumerate(RETURN_REASONS, start=1):
        rows["tb_comm_cd"].append(("RTN_RSN", cd, nm, order, "Y"))
    for order, (cd, nm) in enumerate(WAREHOUSES, start=1):
        rows["tb_comm_cd"].append(("WH", cd, nm, order, "Y"))
    for order, chnl in enumerate(CHANNELS, start=1):
        rows["tb_comm_cd"].append(("CHNL", f"{order:02d}", chnl, order, "Y"))

    shipped = {d[0]: d for d in rows["tb_dlv"]}
    for seq, order in enumerate(
        (o for o in rows["tb_ord_m"] if o[4] == "반품"), start=1
    ):
        ord_no, ord_dt, pay_amt = order[0], order[1], order[8]
        dlv = shipped.get(ord_no)
        done = (
            date(*map(int, dlv[7].split(".")))
            if dlv is not None and dlv[7]
            else ord_dt + timedelta(days=4)
        )
        rtn_dt = min(done + timedelta(days=rng.randint(1, 7)), END)
        reason = rng.choices(
            [r[0] for r in RETURN_REASONS], weights=[r[2] for r in RETURN_REASONS]
        )[0]
        rows["tb_rtn"].append(
            (f"R{rtn_dt:%Y%m%d}{seq:04d}", ord_no, rtn_dt, reason, pay_amt)
        )

    for i, (name, region) in enumerate(SUPPLIERS, start=1):
        rows["tb_georaecheo"].append(
            (
                f"G{i:04d}",
                name,
                f"{rng.randint(100, 899)}-{rng.randint(10, 99)}-{rng.randint(0, 99999):05d}",
                _person(rng),
                region,
                "N" if i == len(SUPPLIERS) else "Y",
            )
        )

    supplier_of = {}
    for item in rows["tb_item"]:
        supplier_of[item[0]] = f"G{rng.randint(1, len(SUPPLIERS) - 1):04d}"
    purchase_price = {item[0]: item[6] for item in rows["tb_item"]}
    day, seq = START, 0
    while day <= END:
        if day.weekday() < 5:
            for item_cd in rng.sample(sorted(supplier_of), k=rng.randint(0, 2)):
                seq += 1
                qty = rng.choice((20, 30, 50, 100, 200))
                price = (
                    int(purchase_price[item_cd] * rng.uniform(0.95, 1.05)) // 10 * 10
                )
                rows["tb_maeip"].append(
                    (
                        f"M{day:%Y%m%d}{seq:05d}",
                        day.strftime("%Y%m%d"),
                        supplier_of[item_cd],
                        item_cd,
                        qty,
                        price,
                        qty * price,
                    )
                )
        day += timedelta(days=1)


# ---------------------------------------------------------------------------
# SQL rendering
# ---------------------------------------------------------------------------


def _lit(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, date):
        return f"'{value.isoformat()}'"
    return "'" + str(value).replace("'", "''") + "'"


def _pg_ident(name: str) -> str:
    # Lower-case ASCII and Hangul identifiers are valid unquoted in Postgres;
    # quote anyway so the file never depends on that.
    return f'"{name}"'


def _my_ident(name: str) -> str:
    return f"`{name}`"


def render_postgres(rows: dict[str, list[tuple]]) -> str:
    out = [
        "-- Korean SMB evaluation fixture (generated by generate_fixture.py; do not edit)",
        "SET client_encoding = 'UTF8';",
        "BEGIN;",
    ]
    for t in TABLES:
        cols = []
        for c in t.cols:
            cols.append(
                f"  {_pg_ident(c.name)} {c.pg_type}{' NOT NULL' if c.not_null else ''}"
            )
        cols.append(f"  PRIMARY KEY ({', '.join(_pg_ident(p) for p in t.pk)})")
        out.append(f"DROP TABLE IF EXISTS {_pg_ident(t.name)};")
        out.append(f"CREATE TABLE {_pg_ident(t.name)} (\n" + ",\n".join(cols) + "\n);")
        if t.comment:
            out.append(f"COMMENT ON TABLE {_pg_ident(t.name)} IS {_lit(t.comment)};")
        for c in t.cols:
            if c.comment:
                out.append(
                    f"COMMENT ON COLUMN {_pg_ident(t.name)}.{_pg_ident(c.name)} IS {_lit(c.comment)};"
                )
    for t in TABLES:
        out.extend(_inserts(t, rows[t.name], _pg_ident, lambda n: n, t.name))
    out.append("COMMIT;")
    out.append("ANALYZE;")
    return "\n".join(out) + "\n"


def render_mysql(rows: dict[str, list[tuple]]) -> str:
    out = [
        "-- Korean SMB evaluation fixture (generated by generate_fixture.py; do not edit)",
        "SET NAMES utf8mb4;",
        "SET FOREIGN_KEY_CHECKS = 0;",
    ]
    for t in TABLES:
        cols = []
        for c in t.cols:
            comment = f" COMMENT {_lit(c.comment)}" if c.comment else ""
            cols.append(
                f"  {_my_ident(t.my_col(c.name))} {c.my_type}"
                f"{' NOT NULL' if c.not_null else ''}{comment}"
            )
        cols.append(
            f"  PRIMARY KEY ({', '.join(_my_ident(t.my_col(p)) for p in t.pk)})"
        )
        table_comment = f" COMMENT={_lit(t.comment)}" if t.comment else ""
        out.append(f"DROP TABLE IF EXISTS {_my_ident(t.my_name())};")
        out.append(
            f"CREATE TABLE {_my_ident(t.my_name())} (\n"
            + ",\n".join(cols)
            + f"\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci{table_comment};"
        )
    for t in TABLES:
        out.extend(_inserts(t, rows[t.name], _my_ident, t.my_col, t.my_name()))
    return "\n".join(out) + "\n"


def _inserts(
    t: Table, data: list[tuple], ident, col_name, table_name: str
) -> list[str]:
    cols = ", ".join(ident(col_name(c.name)) for c in t.cols)
    out = []
    for i in range(0, len(data), 500):
        chunk = data[i : i + 500]
        values = ",\n".join(
            "(" + ", ".join(_lit(v) for v in row) + ")" for row in chunk
        )
        out.append(f"INSERT INTO {ident(table_name)} ({cols}) VALUES\n{values};")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "build")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    rows = generate()
    (args.out / "korean_smb_postgres.sql").write_text(
        render_postgres(rows), encoding="utf-8"
    )
    (args.out / "korean_smb_mysql.sql").write_text(render_mysql(rows), encoding="utf-8")
    for t in TABLES:
        print(f"{t.name:>12}: {len(rows[t.name]):>6} rows")
    print(f"written to {args.out}")


if __name__ == "__main__":
    main()
