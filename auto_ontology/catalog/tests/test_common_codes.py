# SPDX-License-Identifier: Apache-2.0

"""공통코드 decoding: finding code tables, choosing a group, annotating."""

from __future__ import annotations

from typing import Any

import pandas as pd

from auto_ontology.catalog.common_codes import (
    annotate_common_codes,
    choose_group,
    find_code_tables,
)

_GROUPS = {
    ("tb_comm_cd", "WH"): {"WH01": "이천 물류센터", "WH02": "부산 물류센터"},
    ("tb_comm_cd", "RTN_RSN"): {"01": "단순변심", "02": "상품불량", "03": "오배송"},
    ("tb_comm_cd", "CHNL"): {"01": "스마트스토어", "02": "쿠팡"},
}


def _columns(rows: list[tuple[str, str, str, str | None]]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "table_schema": "public",
                "table_name": t,
                "column_name": c,
                "data_type": dt,
                "description": d,
            }
            for t, c, dt, d in rows
        ]
    )


def test_code_tables_are_found_by_name_or_comment() -> None:
    columns = _columns(
        [
            ("tb_comm_cd", "grp_cd", "varchar", "코드그룹"),
            ("tb_comm_cd", "cd", "varchar", "코드"),
            ("tb_comm_cd", "cd_nm", "varchar", "코드명"),
            ("code_master", "col1", "varchar", "코드그룹"),
            ("code_master", "col2", "varchar", "코드"),
            ("code_master", "col3", "varchar", "코드명"),
            ("tb_item", "item_cd", "varchar", "상품코드"),
        ]
    )
    found = {spec["table"]: spec for spec in find_code_tables(columns)}
    assert set(found) == {"tb_comm_cd", "code_master"}
    assert found["code_master"] == {
        "schema": "public",
        "table": "code_master",
        "group": "col1",
        "code": "col2",
        "name": "col3",
    }


def test_a_unique_covering_group_is_chosen() -> None:
    assert choose_group("wh_cd", {"WH01", "WH02"}, _GROUPS) == ("tb_comm_cd", "WH")


def test_shared_codes_need_the_column_name_to_decide() -> None:
    """01/02 sit in several groups; the column name picks one."""
    assert choose_group("rtn_rsn_cd", {"01", "02"}, _GROUPS) == (
        "tb_comm_cd",
        "RTN_RSN",
    )
    # cust_gb shares no token with any group: undecidable, so left alone.
    assert choose_group("cust_gb", {"01", "02"}, _GROUPS) is None


def test_values_outside_every_group_are_not_decoded() -> None:
    assert choose_group("wh_cd", {"WH01", "WH09"}, _GROUPS) is None


class _Connector:
    dialect = "postgres"

    def __init__(self, distinct: dict[str, list[str]]) -> None:
        self.distinct = distinct
        self.sql: list[str] = []

    def execute(self, sql: str, *_: Any, **__: Any) -> pd.DataFrame:
        self.sql.append(sql)
        if '"cd_nm" AS n' in sql:
            rows = [
                (g, c, n) for (_, g), codes in _GROUPS.items() for c, n in codes.items()
            ]
            return pd.DataFrame(rows, columns=["g", "c", "n"])
        column = sql.split("SELECT DISTINCT ", 1)[1].split(" AS v", 1)[0].strip('"')
        return pd.DataFrame({"v": self.distinct.get(column, [])})


def test_annotation_appends_after_the_comment_label() -> None:
    columns = _columns(
        [
            ("tb_comm_cd", "grp_cd", "varchar", "코드그룹"),
            ("tb_comm_cd", "cd", "varchar", "코드"),
            ("tb_comm_cd", "cd_nm", "varchar", "코드명"),
            ("tb_stock", "wh_cd", "varchar", "창고코드"),
            ("tb_stock", "stock_qty", "integer", "현재고수량"),
            ("tb_cust", "cust_gb", "char", "고객구분"),
        ]
    )
    connector = _Connector({"wh_cd": ["WH01", "WH02"], "cust_gb": ["01", "02"]})

    out = annotate_common_codes(connector, columns).set_index("column_name")

    assert out.loc["wh_cd", "description"] == (
        "창고코드 — 공통코드 WH: WH01=이천 물류센터, WH02=부산 물류센터 "
        "(tb_comm_cd.grp_cd = 'WH')"
    )
    assert out.loc["cust_gb", "description"] == "고객구분"
    assert out.loc["stock_qty", "description"] == "현재고수량"
    # Integer columns are never sampled.
    assert not any("stock_qty" in sql for sql in connector.sql)


def test_annotation_is_idempotent() -> None:
    columns = _columns(
        [
            ("tb_comm_cd", "grp_cd", "varchar", None),
            ("tb_comm_cd", "cd", "varchar", None),
            ("tb_comm_cd", "cd_nm", "varchar", None),
            ("tb_stock", "wh_cd", "varchar", "창고코드"),
        ]
    )
    connector = _Connector({"wh_cd": ["WH01", "WH02"]})
    once = annotate_common_codes(connector, columns)
    twice = annotate_common_codes(connector, once)
    assert once.equals(twice)
