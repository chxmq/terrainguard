"""Tests for on-demand region bbox validation."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from main import _MAX_REGION_SPAN_DEG, _validate_region


def test_validate_region_accepts_demo_bbox():
    south, north, west, east, zoom = _validate_region(33.8, 34.5, 76.8, 77.8, 11)
    assert (south, north, west, east) == (33.8, 34.5, 76.8, 77.8)
    assert zoom == 11


def test_validate_region_accepts_moderate_span():
    south, north, west, east, zoom = _validate_region(0.0, 10.0, 0.0, 10.0, 11)
    assert north - south == 10.0
    assert zoom == 11


def test_validate_region_rejects_oversized_lat_span():
    with pytest.raises(HTTPException) as exc:
        _validate_region(0.0, _MAX_REGION_SPAN_DEG + 0.1, 0.0, 1.0, 11)
    assert exc.value.status_code == 400
    assert "too large" in exc.value.detail.lower()


def test_validate_region_rejects_oversized_lon_span():
    with pytest.raises(HTTPException) as exc:
        _validate_region(0.0, 1.0, 0.0, _MAX_REGION_SPAN_DEG + 0.1, 11)
    assert exc.value.status_code == 400
    assert "too large" in exc.value.detail.lower()


def test_validate_region_clamps_zoom():
    _, _, _, _, zoom = _validate_region(33.8, 34.5, 76.8, 77.8, 99)
    assert zoom == 13
