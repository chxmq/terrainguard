"""Tests for the UAS A* route planner."""

from __future__ import annotations

import numpy as np
import pytest

from ttci.geo import cell_to_coord
from ttci.pipeline import compute_ttci
from ttci.uas_pathfinder import plan_uas_route


def _flat_surface(geo, base_m: float = 2000.0):
    elevation = np.full(geo.shape, base_m, dtype=np.float64)
    ttci = compute_ttci(elevation)["ttci"]
    return elevation, ttci


def test_plan_route_across_flat_terrain(synthetic_geo):
    elevation, ttci = _flat_surface(synthetic_geo, 1500.0)
    result = plan_uas_route(
        elevation,
        ttci,
        synthetic_geo.transform,
        synthetic_geo.bounds,
        start_lat=34.0,
        start_lon=77.0,
        end_lat=34.3,
        end_lon=77.5,
        max_altitude_m=8000.0,
        max_ttci=0.8,
        grid_res=32,
    )
    assert result["ok"] is True
    assert len(result["path"]) >= 2
    assert result["stats"]["node_count"] >= 2
    assert result["stats"]["max_ttci"] <= 0.8


def test_plan_route_blocked_by_low_ceiling(make_geo):
    geo = make_geo(rows=40, cols=40)
    elevation = np.full(geo.shape, 5000.0, dtype=np.float64)
    ttci = compute_ttci(elevation)["ttci"]
    result = plan_uas_route(
        elevation,
        ttci,
        geo.transform,
        geo.bounds,
        start_lat=34.0,
        start_lon=77.0,
        end_lat=34.3,
        end_lon=77.5,
        max_altitude_m=1000.0,
        max_ttci=1.0,
        grid_res=32,
    )
    assert result["ok"] is False
    assert result["error"] == "Launch Pad Blocked"


def test_plan_route_start_too_risky(make_geo):
    geo = make_geo(rows=40, cols=40)
    elevation = np.full(geo.shape, 1500.0, dtype=np.float64)
    ttci = np.full(geo.shape, 0.2, dtype=np.float64)
    ttci[20, 20] = 0.95
    start_lat, start_lon = cell_to_coord(geo.transform, 20, 20)
    end_lat, end_lon = cell_to_coord(geo.transform, 30, 30)
    result = plan_uas_route(
        elevation,
        ttci,
        geo.transform,
        geo.bounds,
        start_lat=start_lat,
        start_lon=start_lon,
        end_lat=end_lat,
        end_lon=end_lon,
        max_altitude_m=8000.0,
        max_ttci=0.6,
        grid_res=32,
    )
    assert result["ok"] is False
    assert result["error"] == "Launch Pad Unsafe"


def test_plan_route_rejects_invalid_max_ttci(synthetic_geo):
    elevation, ttci = _flat_surface(synthetic_geo)
    with pytest.raises(ValueError, match="max_ttci"):
        plan_uas_route(
            elevation,
            ttci,
            synthetic_geo.transform,
            synthetic_geo.bounds,
            start_lat=34.0,
            start_lon=77.0,
            end_lat=34.3,
            end_lon=77.5,
            max_altitude_m=8000.0,
            max_ttci=1.5,
        )
