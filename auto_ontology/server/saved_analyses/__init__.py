# SPDX-License-Identifier: Apache-2.0

"""Saved analyses API: store versioned SQL, run it by id without an LLM.

The contract for callers is ``docs/saved-analyses.md``. Module map:

* ``config``   -- limits and defaults, read from the environment per call
* ``errors``   -- the one error type every layer raises, with its HTTP status
* ``params``   -- parameter definitions, validation, relative dates, literals
* ``sqltext``  -- parsing, the read-only guard, placeholder binding, row limit
* ``executor`` -- running bound SQL on a connector, read-only where possible
* ``service``  -- save / verify / run / batch, the result cache
* ``router``   -- the FastAPI routes under ``/api/saved-analyses``
"""
