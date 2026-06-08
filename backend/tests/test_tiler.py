"""Tests for the TTCI overlay (RGBA) renderer."""

from __future__ import annotations

import numpy as np
import pytest
from hypothesis import given

from ttci.tiler import ttci_to_rgba, VALID_CELL_ALPHA
from tests.strategies import (
    ttci_surfaces, ttci_surfaces_with_nodata, all_nodata_ttci_surfaces,
)


@given(ttci_surfaces())
def test_rgba_shape_and_dtype(surface):
    rgba = ttci_to_rgba(surface)
    assert rgba.shape == (surface.shape[0], surface.shape[1], 4)
    assert rgba.dtype == np.uint8


@given(ttci_surfaces())
def test_valid_cells_opaque(surface):
    """Every valid cell is rendered with the non-zero valid-cell alpha."""
    rgba = ttci_to_rgba(surface)
    assert np.all(rgba[..., 3] == VALID_CELL_ALPHA)


@given(ttci_surfaces_with_nodata())
def test_nodata_cells_transparent(surface):
    rgba = ttci_to_rgba(surface)
    nodata = np.isnan(surface)
    assert np.all(rgba[nodata, 3] == 0)
    assert np.all(rgba[~nodata, 3] == VALID_CELL_ALPHA)


@given(all_nodata_ttci_surfaces())
def test_all_nodata_raises(surface):
    with pytest.raises(ValueError):
        ttci_to_rgba(surface)
