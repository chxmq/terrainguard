"""Shared Hypothesis strategies for the Terrain Guard test suite.

These strategies generate the inputs the design's correctness properties range
over. They are intentionally small, composable factory functions so individual
property tests can constrain the input space (e.g. ask for a wider grid, or for
grids that are guaranteed to contain no-data cells) without duplicating
generation logic.

Strategy groups
---------------
* **Elevation grids** — 2-D ``float32``/``float64`` arrays covering random
  terrain, constant grids (for the degenerate-normalization clause), linear
  ramps, extreme magnitudes, and ``NaN`` no-data masks.
* **Weight sets** — valid simplex weights summing to ``1.0`` plus the three
  invalid mutation families (missing key, negative weight, off-sum).
* **Coordinates / routes** — in-bounds and out-of-bounds WGS84 coordinates and
  routes of 0–50 waypoints.
* **TTCI surfaces** — arrays in ``[0, 1]`` with optional ``NaN`` masks, used by
  the tiler, GeoTIFF, and statistics properties.

All array strategies couple the generated dtype to the float element ``width``
so values round-trip through ``float32`` without precision warnings.
"""

from __future__ import annotations

import numpy as np
from hypothesis import strategies as st
from hypothesis.extra import numpy as npst

__all__ = [
    # metadata / element strategies
    "WEIGHT_KEYS",
    "FLOAT_DTYPES",
    "float_dtypes",
    "grid_shapes",
    # elevation grids
    "finite_elevation_grids",
    "constant_grids",
    "ramp_grids",
    "extreme_magnitude_grids",
    "elevation_grids_with_nodata",
    "all_nodata_grids",
    "elevation_grids",
    # weights
    "valid_weights",
    "weights_missing_key",
    "weights_with_negative",
    "weights_off_sum",
    "invalid_weights",
    # coordinates / routes
    "latitudes",
    "longitudes",
    "coordinates",
    "out_of_bounds_coordinates",
    "routes",
    # ttci surfaces
    "ttci_surfaces",
    "ttci_surfaces_with_nodata",
    "all_nodata_ttci_surfaces",
]

# --- Shared constants ------------------------------------------------------

#: The four metric keys every weight set must define (design Data Models).
WEIGHT_KEYS = ("slope", "tri", "curvature", "elevation_std")

#: Floating dtypes the pipeline operates on.
FLOAT_DTYPES = (np.float32, np.float64)

#: Default grid side bounds. The design calls for shapes from ~3x3 up to
#: ~200x200; the default upper bound is kept modest so property tests stay fast,
#: while every grid strategy accepts ``min_side``/``max_side`` to widen it.
DEFAULT_MIN_SIDE = 3
DEFAULT_MAX_SIDE = 64

#: Realistic terrain elevation range, in metres.
_ELEV_MIN = -1_000.0
_ELEV_MAX = 9_000.0

#: Extreme magnitude range used to stress numerical stability, in metres.
_EXTREME_MAG = 1.0e6


# --- Primitive helpers -----------------------------------------------------


def float_dtypes() -> st.SearchStrategy:
    """Sample one of the supported floating dtypes (``float32``/``float64``)."""
    return st.sampled_from(FLOAT_DTYPES)


def _width_for(dtype) -> int:
    """Return the Hypothesis float ``width`` matching a NumPy float dtype."""
    return 32 if np.dtype(dtype) == np.dtype(np.float32) else 64


def grid_shapes(min_side: int = DEFAULT_MIN_SIDE,
                max_side: int = DEFAULT_MAX_SIDE) -> st.SearchStrategy:
    """Generate 2-D ``(rows, cols)`` shapes within the requested side bounds."""
    return npst.array_shapes(
        min_dims=2, max_dims=2, min_side=min_side, max_side=max_side
    )


def _elevation_elements(dtype, min_value: float = _ELEV_MIN,
                        max_value: float = _ELEV_MAX) -> st.SearchStrategy:
    """Finite elevation scalars matching ``dtype`` precision (no NaN/inf)."""
    return st.floats(
        min_value=min_value,
        max_value=max_value,
        allow_nan=False,
        allow_infinity=False,
        width=_width_for(dtype),
    )


def _ensure_some_and_not_all(mask: np.ndarray) -> np.ndarray:
    """Force a boolean mask to have at least one True and one False cell.

    Used when injecting no-data so a grid is guaranteed to contain both valid
    and no-data cells (the pipeline rejects all-no-data DEMs separately).
    """
    flat = mask.reshape(-1)
    if not flat.any():
        flat[0] = True
    if flat.all():
        flat[-1] = False
    return mask


# --- Elevation grids -------------------------------------------------------


@st.composite
def finite_elevation_grids(draw, *, dtype_strategy: st.SearchStrategy | None = None,
                           min_side: int = DEFAULT_MIN_SIDE,
                           max_side: int = DEFAULT_MAX_SIDE,
                           min_value: float = _ELEV_MIN,
                           max_value: float = _ELEV_MAX) -> np.ndarray:
    """Random finite elevation grids with no no-data cells."""
    dtype = draw(dtype_strategy or float_dtypes())
    shape = draw(grid_shapes(min_side, max_side))
    return draw(npst.arrays(
        dtype=dtype,
        shape=shape,
        elements=_elevation_elements(dtype, min_value, max_value),
    ))


@st.composite
def constant_grids(draw, *, dtype_strategy: st.SearchStrategy | None = None,
                   min_side: int = DEFAULT_MIN_SIDE,
                   max_side: int = DEFAULT_MAX_SIDE) -> np.ndarray:
    """Grids where every cell holds the same value.

    Exercises the degenerate-normalization clause (collapsed percentile bounds).
    """
    dtype = draw(dtype_strategy or float_dtypes())
    shape = draw(grid_shapes(min_side, max_side))
    value = draw(_elevation_elements(dtype))
    return np.full(shape, value, dtype=dtype)


@st.composite
def ramp_grids(draw, *, dtype_strategy: st.SearchStrategy | None = None,
               min_side: int = DEFAULT_MIN_SIDE,
               max_side: int = DEFAULT_MAX_SIDE) -> np.ndarray:
    """Smooth linear ramps with independent row/column gradients."""
    dtype = draw(dtype_strategy or float_dtypes())
    rows, cols = draw(grid_shapes(min_side, max_side))
    base = draw(st.floats(min_value=_ELEV_MIN, max_value=_ELEV_MAX,
                          allow_nan=False, allow_infinity=False))
    row_slope = draw(st.floats(min_value=-50.0, max_value=50.0,
                               allow_nan=False, allow_infinity=False))
    col_slope = draw(st.floats(min_value=-50.0, max_value=50.0,
                               allow_nan=False, allow_infinity=False))
    r = np.arange(rows, dtype=np.float64)[:, None]
    c = np.arange(cols, dtype=np.float64)[None, :]
    grid = base + row_slope * r + col_slope * c
    return grid.astype(dtype)


@st.composite
def extreme_magnitude_grids(draw, *, dtype_strategy: st.SearchStrategy | None = None,
                            min_side: int = DEFAULT_MIN_SIDE,
                            max_side: int = DEFAULT_MAX_SIDE) -> np.ndarray:
    """Finite grids with very large positive/negative magnitudes."""
    return draw(finite_elevation_grids(
        dtype_strategy=dtype_strategy,
        min_side=min_side,
        max_side=max_side,
        min_value=-_EXTREME_MAG,
        max_value=_EXTREME_MAG,
    ))


def _base_elevation_grids(*, min_side: int = DEFAULT_MIN_SIDE,
                          max_side: int = DEFAULT_MAX_SIDE) -> st.SearchStrategy:
    """Union of the no-data-free elevation grid shapes."""
    return st.one_of(
        finite_elevation_grids(min_side=min_side, max_side=max_side),
        constant_grids(min_side=min_side, max_side=max_side),
        ramp_grids(min_side=min_side, max_side=max_side),
        extreme_magnitude_grids(min_side=min_side, max_side=max_side),
    )


@st.composite
def elevation_grids_with_nodata(draw, *, min_side: int = DEFAULT_MIN_SIDE,
                                max_side: int = DEFAULT_MAX_SIDE) -> np.ndarray:
    """Elevation grids guaranteed to contain both valid and ``NaN`` cells."""
    grid = draw(_base_elevation_grids(min_side=min_side, max_side=max_side))
    grid = np.array(grid, copy=True)
    mask = draw(npst.arrays(np.bool_, grid.shape, elements=st.booleans()))
    mask = _ensure_some_and_not_all(mask)
    grid[mask] = np.nan
    return grid


@st.composite
def all_nodata_grids(draw, *, min_side: int = DEFAULT_MIN_SIDE,
                     max_side: int = DEFAULT_MAX_SIDE) -> np.ndarray:
    """All-``NaN`` grids for exercising the "no valid elevation" error path."""
    dtype = draw(float_dtypes())
    shape = draw(grid_shapes(min_side, max_side))
    return np.full(shape, np.nan, dtype=dtype)


def elevation_grids(*, min_side: int = DEFAULT_MIN_SIDE,
                    max_side: int = DEFAULT_MAX_SIDE,
                    include_nodata: bool = True) -> st.SearchStrategy:
    """General-purpose elevation grid strategy.

    Samples across random, constant, ramp, and extreme-magnitude grids, and
    (when ``include_nodata`` is true) grids that mix valid and ``NaN`` cells.
    Every generated grid retains at least one valid cell.
    """
    base = _base_elevation_grids(min_side=min_side, max_side=max_side)
    if include_nodata:
        return st.one_of(
            base,
            elevation_grids_with_nodata(min_side=min_side, max_side=max_side),
        )
    return base


# --- Weight sets -----------------------------------------------------------


@st.composite
def valid_weights(draw) -> dict:
    """Valid simplex weights: all four keys, non-negative, summing to ``1.0``.

    Four non-negative values are drawn and normalised by their sum, so the
    result sums to ``1.0`` to within floating-point error (well inside the
    ``+/-0.001`` tolerance the pipeline allows).
    """
    raw = [draw(st.floats(min_value=0.0, max_value=1.0,
                          allow_nan=False, allow_infinity=False))
           for _ in WEIGHT_KEYS]
    total = sum(raw)
    if total <= 0.0:
        raw = [1.0] * len(WEIGHT_KEYS)
        total = float(len(WEIGHT_KEYS))
    return {key: value / total for key, value in zip(WEIGHT_KEYS, raw)}


@st.composite
def weights_missing_key(draw) -> dict:
    """Otherwise-valid weights with one of the four metric keys removed."""
    weights = draw(valid_weights())
    weights.pop(draw(st.sampled_from(WEIGHT_KEYS)))
    return weights


@st.composite
def weights_with_negative(draw) -> dict:
    """Weights where exactly one metric carries a negative value."""
    weights = draw(valid_weights())
    key = draw(st.sampled_from(WEIGHT_KEYS))
    weights[key] = draw(st.floats(min_value=-1.0, max_value=-1.0e-6,
                                  allow_nan=False, allow_infinity=False))
    return weights


@st.composite
def weights_off_sum(draw) -> dict:
    """Non-negative weights whose sum deviates from ``1.0`` beyond tolerance."""
    weights = draw(valid_weights())
    key = draw(st.sampled_from(WEIGHT_KEYS))
    delta = draw(st.floats(min_value=0.01, max_value=5.0,
                           allow_nan=False, allow_infinity=False))
    sign = draw(st.sampled_from((-1.0, 1.0)))
    shifted = weights[key] + sign * delta
    # Keep every weight non-negative so the *only* violation is the off-sum.
    weights[key] = shifted if shifted >= 0.0 else weights[key] + delta
    return weights


def invalid_weights() -> st.SearchStrategy:
    """Union of the three invalid weight families (missing/negative/off-sum)."""
    return st.one_of(
        weights_missing_key(),
        weights_with_negative(),
        weights_off_sum(),
    )


# --- Coordinates and routes ------------------------------------------------


def latitudes() -> st.SearchStrategy:
    """In-range WGS84 latitudes in ``[-90, 90]`` degrees."""
    return st.floats(min_value=-90.0, max_value=90.0,
                     allow_nan=False, allow_infinity=False)


def longitudes() -> st.SearchStrategy:
    """In-range WGS84 longitudes in ``[-180, 180]`` degrees."""
    return st.floats(min_value=-180.0, max_value=180.0,
                     allow_nan=False, allow_infinity=False)


def coordinates() -> st.SearchStrategy:
    """``(lat, lon)`` tuples within valid WGS84 bounds."""
    return st.tuples(latitudes(), longitudes())


def _out_of_range_latitudes() -> st.SearchStrategy:
    return st.one_of(
        st.floats(min_value=90.0 + 1e-6, max_value=1.0e6,
                  allow_nan=False, allow_infinity=False),
        st.floats(min_value=-1.0e6, max_value=-90.0 - 1e-6,
                  allow_nan=False, allow_infinity=False),
    )


def _out_of_range_longitudes() -> st.SearchStrategy:
    return st.one_of(
        st.floats(min_value=180.0 + 1e-6, max_value=1.0e6,
                  allow_nan=False, allow_infinity=False),
        st.floats(min_value=-1.0e6, max_value=-180.0 - 1e-6,
                  allow_nan=False, allow_infinity=False),
    )


@st.composite
def out_of_bounds_coordinates(draw) -> tuple:
    """``(lat, lon)`` tuples where latitude and/or longitude is out of range."""
    which = draw(st.sampled_from(("lat", "lon", "both")))
    if which == "lat":
        return draw(_out_of_range_latitudes()), draw(longitudes())
    if which == "lon":
        return draw(latitudes()), draw(_out_of_range_longitudes())
    return draw(_out_of_range_latitudes()), draw(_out_of_range_longitudes())


def routes(min_waypoints: int = 0, max_waypoints: int = 50) -> st.SearchStrategy:
    """Routes as lists of ``[lat, lon]`` waypoints (matching the API model).

    Lengths span ``0`` to ``50`` waypoints by default, covering the empty,
    single-waypoint (no sectors), and multi-sector cases.
    """
    waypoint = st.tuples(latitudes(), longitudes()).map(
        lambda pair: [pair[0], pair[1]]
    )
    return st.lists(waypoint, min_size=min_waypoints, max_size=max_waypoints)


# --- TTCI surfaces ---------------------------------------------------------


def _unit_elements(dtype) -> st.SearchStrategy:
    """TTCI scalars in ``[0, 1]`` matching ``dtype`` precision."""
    return st.floats(min_value=0.0, max_value=1.0,
                     allow_nan=False, allow_infinity=False,
                     width=_width_for(dtype))


@st.composite
def ttci_surfaces(draw, *, min_side: int = DEFAULT_MIN_SIDE,
                  max_side: int = DEFAULT_MAX_SIDE) -> np.ndarray:
    """TTCI surfaces with every cell a valid value in ``[0, 1]``."""
    dtype = draw(float_dtypes())
    shape = draw(grid_shapes(min_side, max_side))
    return draw(npst.arrays(dtype=dtype, shape=shape,
                            elements=_unit_elements(dtype)))


@st.composite
def ttci_surfaces_with_nodata(draw, *, min_side: int = DEFAULT_MIN_SIDE,
                              max_side: int = DEFAULT_MAX_SIDE) -> np.ndarray:
    """TTCI surfaces in ``[0, 1]`` with both valid and ``NaN`` no-data cells."""
    surface = draw(ttci_surfaces(min_side=min_side, max_side=max_side))
    surface = np.array(surface, copy=True)
    mask = draw(npst.arrays(np.bool_, surface.shape, elements=st.booleans()))
    mask = _ensure_some_and_not_all(mask)
    surface[mask] = np.nan
    return surface


@st.composite
def all_nodata_ttci_surfaces(draw, *, min_side: int = DEFAULT_MIN_SIDE,
                             max_side: int = DEFAULT_MAX_SIDE) -> np.ndarray:
    """All-``NaN`` TTCI surfaces for the tiler/metadata "no valid cells" path."""
    dtype = draw(float_dtypes())
    shape = draw(grid_shapes(min_side, max_side))
    return np.full(shape, np.nan, dtype=dtype)
