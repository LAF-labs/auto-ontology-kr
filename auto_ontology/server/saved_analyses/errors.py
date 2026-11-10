# SPDX-License-Identifier: Apache-2.0

"""The error every saved-analysis layer raises.

Routes turn it into ``{"error": {"code", "message", "details", "last_success"}}``
with :attr:`SavedAnalysisError.status`. Codes are part of the contract in
``docs/saved-analyses.md``; add new ones there too.
"""

from __future__ import annotations

from typing import Any

#: code -> HTTP status
STATUS_BY_CODE: dict[str, int] = {
    "not_found": 404,
    "unknown_database": 422,
    "invalid_definition": 422,
    "invalid_params": 422,
    "parse_error": 422,
    "forbidden_statement": 422,
    "unsupported_placeholder": 422,
    "duplicate_columns": 422,
    "name_conflict": 409,
    "not_verified": 409,
    "retired": 409,
    "invalid_status_transition": 409,
    "schema_mismatch": 409,
    "busy": 429,
    "db_error": 502,
    "timeout": 504,
}


class SavedAnalysisError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        last_success: dict[str, Any] | None = None,
    ) -> None:
        if code not in STATUS_BY_CODE:
            raise ValueError(f"unknown saved-analysis error code {code!r}")
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details
        self.last_success = last_success

    @property
    def status(self) -> int:
        return STATUS_BY_CODE[self.code]

    def payload(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
                "last_success": self.last_success,
            }
        }
