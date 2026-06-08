"""Pytest configuration, the default Hypothesis profile, and shared fixtures.

This module is auto-loaded by pytest. It does three things:

1. Registers and loads the project-default Hypothesis profile so **every**
   property-based test runs a minimum of 100 examples.
2. Re-exports the shared Hypothesis strategies from :mod:`tests.strategies` for
   convenient ``from tests.conftest import ...`` access alongside the fixtures.
3. Provides shared pytest fixtures — most importantly a synthetic EPSG:4326
   transform/bounds context built the same way the real pipeline builds it
   (``rasterio.transform.from_bounds`` + ``rasterio.coords.BoundingBox``) so the
   query, MSA, and tiler tests align with production geometry.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pytest
from affine import Affine
from hypothesis import settings
from rasterio.coords import BoundingBox
from rasterio.crs import CRS
from rasterio.transform import from_bounds

# Re-export the shared strategies so tests may import them from either module.
from tests.strategies import *  # noqa: F401,F403
from tests.strategies import WEIGHT_KEYS  # noqa: F401  (explicit for clarity)

# --- Hypothesis default profile -------------------------------------------

#: Name of the project-default Hypothesis profile.
HYPOTHESIS_PROFILE = "terrain-guard"

# Minimum of 100 examples per property test (design Testing Strategy). The
# deadline is disabled because the larger generated grids can take longer than
# Hypothesis' default per-example deadline on slower machines, which would
# otherwise produce spurious failures unrelated to correctness.
settings.register_profile(HYPOTHESIS_PROFILE, max_examples=100, deadline=None)
settings.load_profile(HYPOTHESIS_PROFILE)


# --- Synthetic geospatial context -----------------------------------------


@dataclass(frozen=True)
class GeoContext:
    """A self-consistent EPSG:4326 raster geometry for tests.

    Bundles the affine ``transform`` and ``bounds`` (built the same way the
    pipeline builds them) with the grid ``rows``/``cols`` so query, MSA, and
    tiler tests share one source of geographic truth.
    """

    transform: Affine
    bounds: BoundingBox
    crs: CRS
    rows: int
    cols: int

    @property
    def west(self) -> float:
        return self.bounds.left

    @property
    def south(self) -> float:
        return self.bounds.bottom

    @property
    def east(self) -> float:
        return self.bounds.right

    @property
    def north(self) -> float:
        return self.bounds.top

    @property
    def shape(self) -> tuple:
        return (self.rows, self.cols)


def _build_geo(west: float, south: float, east: float, north: float,
               cols: int, rows: int) -> GeoContext:
    """Construct a :class:`GeoContext` from a bbox and grid dimensions."""
    transform = from_bounds(west, south, east, north, cols, rows)
    bounds = BoundingBox(left=west, bottom=south, right=east, top=north)
    crs = CRS.from_epsg(4326)
    return GeoContext(transform=transform, bounds=bounds, crs=crs,
                      rows=rows, cols=cols)


@pytest.fixture
def make_geo():
    """Factory fixture for synthetic EPSG:4326 geometries.

    Defaults model a small Ladakh-like region (the same bbox the synthetic DEM
    uses) at a modest 40x40 resolution; callers may override any bound or the
    grid dimensions::

        geo = make_geo(rows=10, cols=10)
        geo = make_geo(west=0.0, south=0.0, east=1.0, north=1.0)
    """

    def _factory(*, west: float = 76.8, south: float = 33.8,
                 east: float = 77.8, north: float = 34.5,
                 cols: int = 40, rows: int = 40) -> GeoContext:
        return _build_geo(west, south, east, north, cols, rows)

    return _factory


@pytest.fixture
def synthetic_geo(make_geo) -> GeoContext:
    """Default synthetic EPSG:4326 geometry shared across test modules."""
    return make_geo()


@pytest.fixture
def synthetic_transform(synthetic_geo) -> Affine:
    """The affine transform of :func:`synthetic_geo`."""
    return synthetic_geo.transform


@pytest.fixture
def synthetic_bounds(synthetic_geo) -> BoundingBox:
    """The bounding box of :func:`synthetic_geo`."""
    return synthetic_geo.bounds


@pytest.fixture
def synthetic_crs(synthetic_geo) -> CRS:
    """The CRS (EPSG:4326) of :func:`synthetic_geo`."""
    return synthetic_geo.crs


# --- Concrete sample arrays ------------------------------------------------


@pytest.fixture
def synthetic_elevation(synthetic_geo) -> np.ndarray:
    """A small, deterministic, no-data-free elevation grid (metres).

    A gentle sinusoidal hill over the synthetic geometry's extent, useful for
    example/integration tests that need a concrete, finite surface.
    """
    rows, cols = synthetic_geo.shape
    y, x = np.mgrid[0:rows, 0:cols]
    elevation = 1_000.0 + 50.0 * np.sin(x / 3.0) * np.cos(y / 3.0)
    return elevation.astype(np.float64)


@pytest.fixture
def default_weights() -> dict:
    """A fresh copy of the pipeline's default TTCI weights."""
    from ttci.pipeline import DEFAULT_WEIGHTS

    return dict(DEFAULT_WEIGHTS)
