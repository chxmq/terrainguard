"""
Risk-aware UAS route planner on the active TTCI + elevation surface.

Downsamples the cached DEM to a planning grid and runs A* with hard constraints
(max altitude, max TTCI) plus soft TTCI penalties so paths prefer lower-complexity
terrain when a safe corridor exists.
"""

from __future__ import annotations

import heapq
import math
import time
from typing import Dict, List, Optional, Tuple

import numpy as np
from rasterio.transform import from_bounds

from .geo import cell_to_coord, coord_to_cell, in_bounds, validate_coordinate
from .pipeline import classify_risk

DEFAULT_GRID_RES = 128
_MIN_FLIGHT_CLEARANCE_M = 30.0
_CLEARANCE_RELief_FRACTION = 0.075

# Soft penalties on the 0–1 TTCI scale (mirrors the competitor's 50/80 thresholds).
_RISK_PENALTY_HIGH = 15.0
_RISK_PENALTY_CRITICAL = 1000.0
_TTCI_SOFT_HIGH = 0.5
_TTCI_SOFT_CRITICAL = 0.8

_NEIGHBORS = (
    (0, -1, 1.0),
    (0, 1, 1.0),
    (-1, 0, 1.0),
    (1, 0, 1.0),
    (-1, -1, math.sqrt(2)),
    (1, -1, math.sqrt(2)),
    (-1, 1, math.sqrt(2)),
    (1, 1, math.sqrt(2)),
)


def _surface_bounds(transform, rows: int, cols: int):
    """Return (west, south, east, north) for a north-up EPSG:4326 raster."""
    west = transform.c
    north = transform.f
    east = west + cols * transform.a
    south = north + rows * transform.e
    return west, south, east, north


def _build_planning_grid(
    elevation: np.ndarray,
    ttci: np.ndarray,
    transform,
    grid_res: int = DEFAULT_GRID_RES,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, object]:
    """Downsample elevation and TTCI to a square planning grid."""
    rows, cols = elevation.shape
    west, south, east, north = _surface_bounds(transform, rows, cols)
    plan_transform = from_bounds(west, south, east, north, grid_res, grid_res)

    elev_ds = np.full((grid_res, grid_res), np.nan, dtype=np.float64)
    ttci_ds = np.full((grid_res, grid_res), np.nan, dtype=np.float64)

    for gr in range(grid_res):
        for gc in range(grid_res):
            lat, lon = cell_to_coord(plan_transform, gr, gc)
            sr, sc = coord_to_cell(transform, lat, lon)
            if sr < 0 or sc < 0 or sr >= rows or sc >= cols:
                continue
            e = elevation[sr, sc]
            t = ttci[sr, sc]
            if np.isnan(e) or np.isnan(t):
                continue
            elev_ds[gr, gc] = float(e)
            ttci_ds[gr, gc] = float(t)

    valid = ~np.isnan(elev_ds)
    return elev_ds, ttci_ds, valid, plan_transform


def _risk_penalty(ttci_val: float) -> float:
    if ttci_val > _TTCI_SOFT_CRITICAL:
        return _RISK_PENALTY_CRITICAL
    if ttci_val > _TTCI_SOFT_HIGH:
        return _RISK_PENALTY_HIGH
    return 0.0


def _flight_clearance_m(elev_ds: np.ndarray, valid: np.ndarray) -> float:
    finite = elev_ds[valid]
    if finite.size == 0:
        return _MIN_FLIGHT_CLEARANCE_M
    relief = float(np.max(finite) - np.min(finite))
    return max(_MIN_FLIGHT_CLEARANCE_M, _CLEARANCE_RELief_FRACTION * relief)


def _latlon_to_plan_cell(
    lat: float,
    lon: float,
    plan_transform,
    grid_res: int,
    valid: np.ndarray,
) -> Optional[Tuple[int, int]]:
    row, col = coord_to_cell(plan_transform, lat, lon)
    if row < 0 or col < 0 or row >= grid_res or col >= grid_res:
        return None
    if not valid[row, col]:
        return None
    return row, col


def _heuristic(row: int, col: int, end_row: int, end_col: int) -> float:
    return math.hypot(end_col - col, end_row - row)


def _reconstruct_path(
    came_from: Dict[Tuple[int, int], Tuple[int, int]],
    end_key: Tuple[int, int],
) -> List[Tuple[int, int]]:
    path = [end_key]
    while end_key in came_from:
        end_key = came_from[end_key]
        path.append(end_key)
    path.reverse()
    return path


def plan_uas_route(
    elevation: np.ndarray,
    ttci: np.ndarray,
    transform,
    bounds,
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    max_altitude_m: float,
    max_ttci: float,
    grid_res: int = DEFAULT_GRID_RES,
) -> Dict:
    """Plan a low-risk UAS path or return a structured failure diagnostic."""
    start_lat, start_lon = validate_coordinate(start_lat, start_lon)
    end_lat, end_lon = validate_coordinate(end_lat, end_lon)

    if not math.isfinite(max_altitude_m) or max_altitude_m <= 0:
        raise ValueError("max_altitude_m must be a positive, finite number of metres.")
    if not math.isfinite(max_ttci) or max_ttci < 0 or max_ttci > 1:
        raise ValueError("max_ttci must be a finite number within [0, 1].")
    if grid_res < 16 or grid_res > 256:
        raise ValueError("grid_res must be between 16 and 256.")

    for label, lat, lon in (("Start", start_lat, start_lon), ("End", end_lat, end_lon)):
        if not in_bounds(bounds, lat, lon):
            return {
                "ok": False,
                "error": f"{label} Out of Coverage",
                "detail": (
                    f"The {label.lower()} point ({lat:.5f}, {lon:.5f}) lies outside "
                    "the active TTCI surface."
                ),
            }

    t0 = time.perf_counter()
    elev_ds, ttci_ds, valid, plan_transform = _build_planning_grid(
        elevation, ttci, transform, grid_res,
    )

    if not valid.any():
        return {
            "ok": False,
            "error": "No Valid Terrain",
            "detail": "The active surface contains no valid elevation/TTCI cells to plan over.",
        }

    clearance_m = _flight_clearance_m(elev_ds, valid)

    start_cell = _latlon_to_plan_cell(start_lat, start_lon, plan_transform, grid_res, valid)
    end_cell = _latlon_to_plan_cell(end_lat, end_lon, plan_transform, grid_res, valid)
    if start_cell is None:
        return {
            "ok": False,
            "error": "Launch Pad Out of Coverage",
            "detail": "The start point has no valid terrain data on the planning grid.",
        }
    if end_cell is None:
        return {
            "ok": False,
            "error": "Landing Zone Out of Coverage",
            "detail": "The end point has no valid terrain data on the planning grid.",
        }

    sr, sc = start_cell
    er, ec = end_cell

    start_elev = elev_ds[sr, sc]
    end_elev = elev_ds[er, ec]
    start_ttci = ttci_ds[sr, sc]
    end_ttci = ttci_ds[er, ec]

    if start_elev + clearance_m > max_altitude_m:
        return {
            "ok": False,
            "error": "Launch Pad Blocked",
            "detail": (
                f"Start elevation + hover clearance ({start_elev:.0f} m + "
                f"{clearance_m:.0f} m) exceeds your flight ceiling ({max_altitude_m:.0f} m)."
            ),
        }
    if end_elev + clearance_m > max_altitude_m:
        return {
            "ok": False,
            "error": "Landing Zone Blocked",
            "detail": (
                f"Target elevation + hover clearance ({end_elev:.0f} m + "
                f"{clearance_m:.0f} m) exceeds your flight ceiling ({max_altitude_m:.0f} m)."
            ),
        }
    if start_ttci > max_ttci:
        return {
            "ok": False,
            "error": "Launch Pad Unsafe",
            "detail": (
                f"Start point TTCI ({start_ttci:.3f}) exceeds your max acceptable "
                f"TTCI ({max_ttci:.3f})."
            ),
        }
    if end_ttci > max_ttci:
        return {
            "ok": False,
            "error": "Landing Zone Unsafe",
            "detail": (
                f"Target TTCI ({end_ttci:.3f}) exceeds your max acceptable "
                f"TTCI ({max_ttci:.3f})."
            ),
        }

    if start_cell == end_cell:
        lat, lon = cell_to_coord(plan_transform, sr, sc)
        calc_ms = (time.perf_counter() - t0) * 1000.0
        label, color = classify_risk(start_ttci)
        return {
            "ok": True,
            "path": [[lat, lon]],
            "stats": {
                "node_count": 1,
                "max_ttci": round(start_ttci, 4),
                "mean_ttci": round(start_ttci, 4),
                "peak_risk_level": label,
                "peak_risk_color": color,
                "flight_clearance_m": round(clearance_m, 1),
                "calc_time_ms": round(calc_ms, 2),
            },
        }

    open_heap: List[Tuple[float, int, int, int]] = []
    counter = 0
    start_key = (sr, sc)
    end_key = (er, ec)
    g_score: Dict[Tuple[int, int], float] = {start_key: 0.0}
    came_from: Dict[Tuple[int, int], Tuple[int, int]] = {}
    heapq.heappush(open_heap, (_heuristic(sr, sc, er, ec), counter, sr, sc))

    hit_altitude_wall = False
    hit_risk_wall = False

    while open_heap:
        _, _, row, col = heapq.heappop(open_heap)
        curr_key = (row, col)
        if curr_key == end_key:
            grid_path = _reconstruct_path(came_from, end_key)
            path_latlon = [
                list(cell_to_coord(plan_transform, r, c)) for r, c in grid_path
            ]
            path_ttci = [float(ttci_ds[r, c]) for r, c in grid_path]
            max_path_ttci = float(max(path_ttci))
            mean_path_ttci = float(sum(path_ttci) / len(path_ttci))
            label, color = classify_risk(max_path_ttci)
            calc_ms = (time.perf_counter() - t0) * 1000.0
            return {
                "ok": True,
                "path": path_latlon,
                "stats": {
                    "node_count": len(grid_path),
                    "max_ttci": round(max_path_ttci, 4),
                    "mean_ttci": round(mean_path_ttci, 4),
                    "peak_risk_level": label,
                    "peak_risk_color": color,
                    "flight_clearance_m": round(clearance_m, 1),
                    "calc_time_ms": round(calc_ms, 2),
                },
            }

        curr_g = g_score[curr_key]
        for dr, dc, move_cost in _NEIGHBORS:
            nr, nc = row + dr, col + dc
            if nr < 0 or nc < 0 or nr >= grid_res or nc >= grid_res:
                continue
            if not valid[nr, nc]:
                continue

            on_border = nr == 0 or nc == 0 or nr == grid_res - 1 or nc == grid_res - 1
            is_destination = nr == er and nc == ec
            if on_border and not is_destination:
                continue

            n_elev = elev_ds[nr, nc]
            n_ttci = ttci_ds[nr, nc]

            if n_elev + clearance_m > max_altitude_m:
                hit_altitude_wall = True
                continue
            if n_ttci > max_ttci:
                hit_risk_wall = True
                continue

            step_cost = move_cost + _risk_penalty(n_ttci)
            tentative_g = curr_g + step_cost
            n_key = (nr, nc)
            if tentative_g >= g_score.get(n_key, float("inf")):
                continue

            came_from[n_key] = curr_key
            g_score[n_key] = tentative_g
            counter += 1
            f = tentative_g + _heuristic(nr, nc, er, ec)
            heapq.heappush(open_heap, (f, counter, nr, nc))

    if hit_altitude_wall and not hit_risk_wall:
        detail = (
            f"All available routes are blocked by terrain peaks (requiring at least "
            f"{clearance_m:.0f} m hover clearance below your {max_altitude_m:.0f} m ceiling)."
        )
    elif not hit_altitude_wall and hit_risk_wall:
        detail = (
            f"All available routes are blocked by high-complexity zones exceeding "
            f"your TTCI limit of {max_ttci:.3f}."
        )
    elif hit_altitude_wall and hit_risk_wall:
        detail = (
            f"The path is choked by terrain (needs {clearance_m:.0f} m clearance below "
            f"{max_altitude_m:.0f} m) and TTCI zones above {max_ttci:.3f}."
        )
    else:
        detail = "Terrain geometry completely blocks the corridor."

    return {
        "ok": False,
        "error": "No Safe Corridor Found",
        "detail": detail,
    }
