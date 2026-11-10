# SPDX-License-Identifier: Apache-2.0

"""Saved analyses: versioned, immutable SQL that dashboards run by id.

A package rather than a module under ``auto_ontology.dal`` on purpose: the DAL
surface snapshot (``dal/tests/dal_surface.json``) covers plain modules only, and
keeping this fork-only feature out of it keeps upstream cherry-picks of that
file conflict-free.

``tables`` declares the tables on the shared ``METADATA``; ``store`` reads and
writes them.
"""
