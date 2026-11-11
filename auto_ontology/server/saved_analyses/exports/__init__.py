# SPDX-License-Identifier: Apache-2.0

"""Bulk export of saved analyses to files. Contract: ``docs/saved-analyses.md`` §15.

* ``config``  -- limits, quotas, the export directory
* ``stream``  -- chunked reads inside a read-only transaction
* ``writer``  -- Parquet (typed) and CSV files, one chunk in memory at a time
* ``service`` -- create, log, quotas, retention
* ``router``  -- the FastAPI routes
"""
