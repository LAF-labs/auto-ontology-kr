# SPDX-License-Identifier: Apache-2.0

"""Write result chunks to a Parquet or CSV file, one chunk in memory at a time.

**Parquet** (the default) keeps column types:

=========  ==========================================================
contract   Arrow / Parquet type
=========  ==========================================================
integer    int64 (uint64 for MySQL ``BIGINT UNSIGNED``)
number     float64
decimal    decimal128(p, s) when the scale is known, else exact text
bool       bool
date       date32
datetime   timestamp[us] (``timestamptz``: timestamp[us, UTC])
json       text holding JSON
string     text
=========  ==========================================================

The scale of a decimal is known when the driver reports it (Postgres
``numeric(p, s)``) or, on MySQL/MariaDB, from the first value: MySQL sends a
column's decimals with that column's fixed scale. An unconstrained Postgres
``numeric`` (``sum()``, ``avg()`` of a numeric) has no fixed scale, so it is
written as exact decimal text rather than rounded. Each field carries its
contract type in its metadata under ``auto_ontology.type``, and the file's
schema metadata carries the whole export description under
``auto_ontology.export`` (JSON).

**CSV** is UTF-8 with a header row. NULL is an empty field; decimals are
exact text, datetimes ISO 8601, booleans ``true``/``false``, JSON as JSON text.
The column types are in the export description, not in the file.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import math
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from auto_ontology.server.saved_analyses.errors import SavedAnalysisError
from auto_ontology.server.saved_analyses.executor import to_json_value
from auto_ontology.server.saved_analyses.exports.stream import ColumnInfo

FORMATS = ("parquet", "csv")
CONTENT_TYPES = {
    "parquet": "application/vnd.apache.parquet",
    "csv": "text/csv; charset=utf-8",
}
TYPE_KEY = b"auto_ontology.type"
EXPORT_KEY = b"auto_ontology.export"


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    converted = to_json_value(value)
    if converted is None or isinstance(converted, str):
        return converted
    return json.dumps(converted, ensure_ascii=False)


def _as_json_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value  # MySQL hands JSON over as text already
    return json.dumps(to_json_value(value), ensure_ascii=False)


def _as_decimal_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        value = Decimal(repr(value))
    if isinstance(value, Decimal):
        return format(value, "f") if value.is_finite() else None
    return str(value)


def _as_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else Decimal(repr(value))
    return Decimal(str(value))


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        return int.from_bytes(value, "big")  # MySQL BIT
    return int(value)


def _identity(value: Any) -> Any:
    return value


def _decimal_scale(value: Decimal) -> int:
    exponent = value.as_tuple().exponent
    return -exponent if isinstance(exponent, int) and exponent < 0 else 0


# ---------------------------------------------------------------------------
# Parquet
# ---------------------------------------------------------------------------


class ParquetExportWriter:
    def __init__(self, path: Path, columns: list[ColumnInfo], description: dict):
        self._path = path
        self._columns = columns
        self._description = description
        self._file = open(path, "wb")
        self._writer: Any = None
        self._schema: Any = None
        self._converters: list[Callable[[Any], Any]] = []
        self.rows = 0

    def _plan(self, first_rows: list[tuple]) -> None:
        import pyarrow as pa

        fields = []
        converters: list[Callable[[Any], Any]] = []
        for index, column in enumerate(self._columns):
            arrow_type: Any
            converter: Callable[[Any], Any] = _identity
            stored = column.type
            if column.type == "integer":
                arrow_type = pa.uint64() if column.unsigned else pa.int64()
                converter = _as_int
            elif column.type == "number":
                arrow_type, converter = pa.float64(), _as_float
            elif column.type == "decimal":
                precision, scale = column.precision, column.scale
                if scale is None and precision is None:
                    scale = self._mysql_scale(index, first_rows)
                    precision = 38 if scale is not None else None
                if scale is not None and precision:
                    precision = max(precision, scale, 1)
                    arrow_type = (
                        pa.decimal128(precision, scale)
                        if precision <= 38
                        else pa.decimal256(min(precision, 76), scale)
                    )
                    converter = _as_decimal
                else:
                    arrow_type, converter = pa.string(), _as_decimal_text
            elif column.type == "bool":
                arrow_type = pa.bool_()
            elif column.type == "date":
                arrow_type = pa.date32()
            elif column.type == "datetime":
                arrow_type = pa.timestamp(
                    "us", tz="UTC" if column.with_timezone else None
                )
            elif column.type == "json":
                arrow_type, converter = pa.string(), _as_json_text
            else:
                arrow_type, converter = pa.string(), _as_text
                stored = "string" if column.type == "unknown" else column.type
            fields.append(
                pa.field(column.name, arrow_type, metadata={TYPE_KEY: stored.encode()})
            )
            converters.append(converter)
        self._schema = pa.schema(
            fields,
            metadata={
                EXPORT_KEY: json.dumps(
                    self._description, ensure_ascii=False, default=str
                ).encode()
            },
        )
        self._converters = converters
        import pyarrow.parquet as pq

        self._writer = pq.ParquetWriter(self._file, self._schema, compression="zstd")

    def _mysql_scale(self, index: int, rows: list[tuple]) -> int | None:
        if self._description.get("dialect_family") != "mysql":
            return None
        for row in rows:
            value = row[index]
            if isinstance(value, Decimal) and value.is_finite():
                return _decimal_scale(value)
        return None

    def write(self, rows: list[tuple]) -> None:
        import pyarrow as pa

        if self._writer is None:
            self._plan(rows)
        try:
            arrays = [
                pa.array(
                    [convert(row[i]) for row in rows], type=self._schema.field(i).type
                )
                for i, convert in enumerate(self._converters)
            ]
            self._writer.write_table(pa.Table.from_arrays(arrays, schema=self._schema))
        except (pa.ArrowException, ValueError, TypeError, OverflowError) as exc:
            raise SavedAnalysisError(
                "export_failed",
                f"A value could not be written with its column's type: {exc}",
            ) from exc
        self.rows += len(rows)

    def bytes_written(self) -> int:
        return self._file.tell()

    def close(self) -> None:
        if self._writer is None:
            self._plan([])
        self._writer.close()
        self._file.close()

    def abort(self) -> None:
        try:
            if self._writer is not None:
                self._writer.close()
        except Exception:  # noqa: BLE001
            pass
        self._file.close()


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------


def _csv_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return "" if math.isnan(value) or math.isinf(value) else repr(value)
    if isinstance(value, Decimal):
        return format(value, "f") if value.is_finite() else ""
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, str):
        return value
    converted = to_json_value(value)
    if isinstance(converted, str):
        return converted
    return json.dumps(converted, ensure_ascii=False)


class CsvExportWriter:
    def __init__(self, path: Path, columns: list[ColumnInfo], description: dict):
        self._file = open(path, "wb")
        self._json_columns = {i for i, c in enumerate(columns) if c.type == "json"}
        self._bytes = 0
        self.rows = 0
        self._emit([[c.name for c in columns]])

    def _emit(self, rows: list[list[Any]]) -> None:
        buffer = io.StringIO()
        csv.writer(buffer, lineterminator="\n").writerows(rows)
        data = buffer.getvalue().encode("utf-8")
        self._file.write(data)
        self._bytes += len(data)

    def write(self, rows: list[tuple]) -> None:
        try:
            self._emit(
                [
                    [
                        (_as_json_text(v) or "")
                        if i in self._json_columns
                        else _csv_cell(v)
                        for i, v in enumerate(row)
                    ]
                    for row in rows
                ]
            )
        except (ValueError, TypeError) as exc:
            raise SavedAnalysisError(
                "export_failed", f"A value could not be written as CSV: {exc}"
            ) from exc
        self.rows += len(rows)

    def bytes_written(self) -> int:
        return self._bytes

    def close(self) -> None:
        self._file.close()

    def abort(self) -> None:
        self._file.close()


def open_writer(
    fmt: str, path: Path, columns: list[ColumnInfo], description: dict
) -> ParquetExportWriter | CsvExportWriter:
    if fmt == "parquet":
        return ParquetExportWriter(path, columns, description)
    return CsvExportWriter(path, columns, description)
