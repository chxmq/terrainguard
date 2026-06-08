"""Property-based and example tests for the TTCI computation pipeline."""

from __future__ import annotations

import numpy as np
import pytest
from hypothesis import given, strategies as st

from ttci.pipeline import (
    compute_ttci, normalize, classify_risk, validate_weights,
    compute_slope, compute_tri, compute_curvature, compute_elevation_std,
    RISK_LEVELS,
)
from tests.strategies import (
    elevation_grids, finite_elevation_grids, constant_grids, all_nodata_grids,
    elevation_grids_with_nodata, valid_weights, invalid_weights,
)

_RISK_LABELS = {lvl[2] for lvl in RISK_LEVELS}


# --- compute_ttci -----------------------------------------------------------

@given(elevation_grids())
def test_ttci_valid_cells_in_unit_range(grid):
    """Every valid TTCI cell lies within [0, 1]."""
    ttci = compute_ttci(grid)["ttci"]
    valid = ttci[~np.isnan(ttci)]
    assert valid.size > 0
    assert np.all(valid >= 0.0) and np.all(valid <= 1.0)


@given(elevation_grids())
def test_ttci_shape_matches_input(grid):
    assert compute_ttci(grid)["ttci"].shape == grid.shape


@given(elevation_grids_with_nodata())
def test_ttci_preserves_nodata_mask(grid):
    """No-data (NaN) cells in the DEM stay NaN in the TTCI surface, and only those."""
    ttci = compute_ttci(grid)["ttci"]
    assert np.array_equal(np.isnan(ttci), np.isnan(np.asarray(grid, dtype=np.float64)))


@given(all_nodata_grids())
def test_ttci_all_nodata_raises(grid):
    with pytest.raises(ValueError):
        compute_ttci(grid)


# --- component metrics ------------------------------------------------------

@given(finite_elevation_grids())
def test_slope_bounded_0_90(grid):
    slope = compute_slope(grid)
    assert np.all(slope >= 0.0) and np.all(slope <= 90.0)


@given(finite_elevation_grids())
def test_terrain_metrics_non_negative(grid):
    for metric in (compute_tri(grid), compute_curvature(grid), compute_elevation_std(grid)):
        assert np.all(metric >= 0.0)


# --- normalize --------------------------------------------------------------

@given(finite_elevation_grids())
def test_normalize_unit_range(grid):
    out = normalize(grid)
    assert np.all(out >= 0.0) and np.all(out <= 1.0)


@given(constant_grids())
def test_normalize_constant_grid_is_zero(grid):
    """A constant surface has collapsed percentile bounds → contributes nothing."""
    assert np.all(normalize(grid) == 0.0)


# --- classify_risk ----------------------------------------------------------

@given(st.floats(min_value=0.0, max_value=1.0, allow_nan=False))
def test_classify_risk_returns_known_band(value):
    label, color = classify_risk(value)
    assert label in _RISK_LABELS
    assert isinstance(color, str) and color.startswith("#")


def test_classify_risk_nodata_is_none():
    assert classify_risk(float("nan")) is None
    assert classify_risk(None) is None


@pytest.mark.parametrize("bad", [-0.01, 1.01, 5.0, -3.0])
def test_classify_risk_out_of_range_raises(bad):
    with pytest.raises(ValueError):
        classify_risk(bad)


# --- weight validation ------------------------------------------------------

@given(valid_weights())
def test_valid_weights_accepted(weights):
    validate_weights(weights)  # must not raise


@given(invalid_weights())
def test_invalid_weights_rejected(weights):
    with pytest.raises(ValueError):
        validate_weights(weights)
