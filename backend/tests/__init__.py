"""Terrain Guard test suite.

This package holds the property-based, example, edge-case, integration, UI, and
benchmark tests described in the design's *Testing Strategy* section.

Shared building blocks live in two modules:

* :mod:`tests.strategies` — reusable Hypothesis strategies (elevation grids,
  weight sets, coordinates/routes, and TTCI surfaces).
* :mod:`tests.conftest` — the default Hypothesis profile plus shared pytest
  fixtures (notably the synthetic EPSG:4326 transform/bounds context reused by
  the query, MSA, and tiler tests).

Property-based tests use `Hypothesis <https://hypothesis.readthedocs.io/>`_ and
each correctness property (1–24) is implemented by a single test function tagged
``# Feature: terrain-guard, Property {n}: ...`` in its own module.
"""
