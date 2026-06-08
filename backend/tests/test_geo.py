"""Tests for the shared geospatial coordinate utilities."""

from __future__ import annotations

import math

import pytest
from hypothesis import given, strategies as st
from rasterio.transform import from_bounds

from ttci.geo import validate_coordinate, coord_to_cell, cell_to_coord, in_bounds
from tests.strategies import coordinates, out_of_bounds_coordinates

# A fixed EPSG:4326 grid for the round-trip property (1° box, 100x100 cells).
_W, _S, _E, _N, _COLS, _ROWS = 76.8, 33.8, 77.8, 34.5, 100, 100
_TRANSFORM = from_bounds(_W, _S, _E, _N, _COLS, _ROWS)
_CELL_LON = (_E - _W) / _COLS
_CELL_LAT = (_N - _S) / _ROWS


# --- validate_coordinate ----------------------------------------------------

@given(coordinates())
def test_validate_coordinate_accepts_valid(coord):
    lat, lon = validate_coordinate(coord[0], coord[1])
    assert lat == coord[0] and lon == coord[1]


@given(out_of_bounds_coordinates())
def test_validate_coordinate_rejects_out_of_range(coord):
    with pytest.raises(ValueError):
        validate_coordinate(coord[0], coord[1])


@pytest.mark.parametrize("lat,lon", [
    (float("nan"), 0.0), (0.0, float("inf")), (float("-inf"), 0.0),
])
def test_validate_coordinate_rejects_non_finite(lat, lon):
    with pytest.raises(ValueError):
        validate_coordinate(lat, lon)


def test_validate_coordinate_rejects_bool():
    with pytest.raises(ValueError):
        validate_coordinate(True, 0.0)


# --- coord_to_cell / cell_to_coord round trip -------------------------------

@given(
    st.floats(min_value=_S + 1e-6, max_value=_N - 1e-6),
    st.floats(min_value=_W + 1e-6, max_value=_E - 1e-6),
)
def test_cell_roundtrip_within_one_cell(lat, lon):
    row, col = coord_to_cell(_TRANSFORM, lat, lon)
    assert 0 <= row < _ROWS and 0 <= col < _COLS
    rlat, rlon = cell_to_coord(_TRANSFORM, row, col)
    # The recovered cell-centre lies within half a cell of the original point.
    assert abs(rlat - lat) <= _CELL_LAT
    assert abs(rlon - lon) <= _CELL_LON


# --- in_bounds --------------------------------------------------------------

class _Bounds:
    left, bottom, right, top = _W, _S, _E, _N


def test_in_bounds():
    b = _Bounds()
    assert in_bounds(b, (_S + _N) / 2, (_W + _E) / 2)
    assert not in_bounds(b, _N + 1.0, (_W + _E) / 2)
    assert not in_bounds(b, (_S + _N) / 2, _E + 1.0)
