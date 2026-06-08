"""Tests for the MSA calculator and along-route elevation profile."""

from __future__ import annotations

from hypothesis import given, strategies as st

from ttci.msa import (
    haversine_km, _round_up_to_100ft, compute_msa_for_route, get_elevation_profile,
)
from tests.strategies import coordinates


# --- haversine --------------------------------------------------------------

@given(coordinates(), coordinates())
def test_haversine_symmetric_and_non_negative(a, b):
    d1 = haversine_km(a[0], a[1], b[0], b[1])
    d2 = haversine_km(b[0], b[1], a[0], a[1])
    assert d1 >= 0.0
    assert abs(d1 - d2) < 1e-6


@given(coordinates())
def test_haversine_zero_for_same_point(p):
    assert haversine_km(p[0], p[1], p[0], p[1]) < 1e-9


# --- round up to 100 ft -----------------------------------------------------

@given(st.floats(min_value=0.0, max_value=60_000.0, allow_nan=False))
def test_round_up_to_100ft(feet):
    out = _round_up_to_100ft(feet)
    assert out % 100 == 0
    # `out` is the least 100-ft multiple at or above `feet` (the function rounds
    # to 6 decimals first to absorb floating-point noise, hence the tolerance).
    assert out + 1e-6 >= feet
    assert out - 100 < feet


# --- MSA per route ----------------------------------------------------------

def test_msa_fewer_than_two_waypoints_is_empty(synthetic_elevation, synthetic_geo):
    assert compute_msa_for_route([], synthetic_elevation, synthetic_geo.transform) == []
    assert compute_msa_for_route([[34.0, 77.0]], synthetic_elevation, synthetic_geo.transform) == []


def test_msa_sectors_structure_and_clearance(synthetic_elevation, synthetic_geo):
    route = [[33.95, 76.95], [34.15, 77.25], [34.35, 77.6]]
    sectors = compute_msa_for_route(route, synthetic_elevation, synthetic_geo.transform)
    assert len(sectors) == len(route) - 1
    for s in sectors:
        assert s["msa_ft"] % 100 == 0
        # The synthetic terrain is positive, so MSA = terrain + 1000 ft MOC,
        # rounded up — always at least 1000 ft and above the terrain it clears.
        assert s["msa_ft"] >= 1000
        assert s["msa_ft"] >= s["max_terrain_ft"]
        assert s["distance_km"] >= 0.0


# --- elevation profile ------------------------------------------------------

def test_profile_empty_for_short_route(synthetic_elevation, synthetic_geo):
    assert get_elevation_profile([[34.0, 77.0]], synthetic_elevation, synthetic_geo.transform) == []


def test_profile_distance_non_decreasing(synthetic_elevation, synthetic_geo):
    route = [[33.95, 76.95], [34.2, 77.3], [34.4, 77.6]]
    profile = get_elevation_profile(route, synthetic_elevation, synthetic_geo.transform)
    assert len(profile) >= 2
    dists = [p["distance_km"] for p in profile]
    assert dists == sorted(dists)
    for p in profile:
        assert {"distance_km", "elevation_m", "lat", "lon"} <= p.keys()
