"""
Predictive look-ahead Terrain Awareness (EGPWS-style), modulated by TTCI.

The original ``/api/taws/check`` heuristic only compared the aircraft's altitude
to the terrain *directly beneath it* — a reactive check a certified system would
never rely on. Real terrain-awareness systems (the EGPWS family Honeywell
pioneered) are *predictive*: they project the aircraft's trajectory forward and
test whether terrain penetrates a clearance envelope *ahead* of the aircraft,
giving the crew time to react.

This module implements a simplified but faithful version of that idea:

    * Project the ground track forward from the current position using heading
      and ground speed, sampling terrain at fixed time steps out to a
      look-ahead horizon (the horizon distance scales with ground speed).
    * Sweep a widening lateral corridor around the track and take the worst-case
      (highest) terrain at each step, so a ridge just off the nose is not missed.
    * Compare the projected flight path (current altitude + vertical speed) to
      that terrain and raise a graded alert when clearance falls below the
      CAUTION / WARNING floors — "Caution, Terrain" then "Terrain, Pull Up".
    * **TTCI modulation (the novel part):** in complex terrain the look-ahead
      horizon and the required clearances are expanded in proportion to the TTCI
      along the path, so the system alerts *earlier and more conservatively*
      exactly where the terrain is most dangerous. This is the concrete payoff
      of having a unified complexity index embedded in the alerting logic.

This is a demonstration model, not certified avionics: it omits flight-phase
logic, the bable of envelope shapes, GPS/baro blending, and the obstacle
database of a real EGPWS. It is, however, a genuine look-ahead algorithm rather
than a one-cell altitude check.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional

import numpy as np

from .geo import coord_to_cell

EARTH_RADIUS_KM = 6371.0
FEET_PER_METER = 1.0 / 0.3048
NM_TO_KM = 1.852

# Baseline look-ahead horizons (seconds ahead of the aircraft) and the required
# terrain clearance floors (feet). These are expanded by the TTCI modulation.
CAUTION_LOOKAHEAD_S = 60.0
WARNING_LOOKAHEAD_S = 30.0
CAUTION_CLEARANCE_FT = 500.0
WARNING_CLEARANCE_FT = 300.0

# How strongly TTCI stretches the envelope. At TTCI = 1.0 the look-ahead horizon
# grows by TTCI_TIME_GAIN and the clearance floors by TTCI_CLEAR_GAIN.
TTCI_TIME_GAIN = 0.5     # up to +50% look-ahead time in the most complex terrain
TTCI_CLEAR_GAIN = 0.4    # up to +40% required clearance in the most complex terrain

# Lateral corridor half-width (NM): a fixed base that splays out with distance,
# mirroring how a real look-ahead beam widens ahead of the aircraft.
CORRIDOR_BASE_NM = 0.25
CORRIDOR_SPLAY_NM_PER_NM = 0.10

# Along-track sampling resolution.
STEP_SECONDS = 2.0

_ALERT_COLORS = {
    "WARNING": "#e74c3c",
    "CAUTION": "#e67e22",
    "CLEAR": "#2ecc71",
}


def _destination_point(lat: float, lon: float, bearing_deg: float, distance_km: float):
    """Forward geodesic: point ``distance_km`` from (lat, lon) along a bearing."""
    ang = distance_km / EARTH_RADIUS_KM
    brg = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    lat2 = math.asin(math.sin(lat1) * math.cos(ang)
                     + math.cos(lat1) * math.sin(ang) * math.cos(brg))
    lon2 = lon1 + math.atan2(
        math.sin(brg) * math.sin(ang) * math.cos(lat1),
        math.cos(ang) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lon2)


def _sample_cell(elevation, ttci, transform, lat: float, lon: float):
    """Return (elevation_m, ttci) at a coordinate, or (None, None) if off-surface."""
    rows, cols = elevation.shape
    row, col = coord_to_cell(transform, lat, lon)
    if not (0 <= row < rows and 0 <= col < cols):
        return None, None
    elev = float(elevation[row, col])
    if math.isnan(elev):
        return None, None
    t = float(ttci[row, col]) if ttci is not None else None
    if t is not None and math.isnan(t):
        t = None
    return elev, t


def _worst_terrain_in_corridor(
    elevation, ttci, transform, lat: float, lon: float,
    track_deg: float, half_width_nm: float, lateral_samples: int = 2,
):
    """Highest terrain (and its TTCI) across a lateral cut of the corridor.

    Samples the centreline plus ``lateral_samples`` offsets to each side at the
    given half-width, returning the worst (highest) terrain found and the TTCI
    co-located with it.
    """
    best_elev = None
    best_ttci = None
    offsets = [0.0]
    if half_width_nm > 0 and lateral_samples > 0:
        for k in range(1, lateral_samples + 1):
            frac = k / lateral_samples
            offsets.extend([frac * half_width_nm, -frac * half_width_nm])

    for off_nm in offsets:
        if off_nm == 0.0:
            plat, plon = lat, lon
        else:
            side_bearing = (track_deg + (90.0 if off_nm > 0 else -90.0)) % 360.0
            plat, plon = _destination_point(lat, lon, side_bearing, abs(off_nm) * NM_TO_KM)
        elev, t = _sample_cell(elevation, ttci, transform, plat, plon)
        if elev is None:
            continue
        if best_elev is None or elev > best_elev:
            best_elev = elev
            best_ttci = t
    return best_elev, best_ttci


def look_ahead_taws(
    elevation, ttci, transform,
    lat: float, lon: float, altitude_ft: float,
    heading_deg: float, ground_speed_kt: float,
    vertical_speed_fpm: float = 0.0,
) -> Dict:
    """Run a predictive, TTCI-modulated terrain look-ahead from an aircraft state.

    Args:
        elevation: 2D DEM (metres, NaN no-data).
        ttci: matching TTCI surface ([0,1], NaN no-data); may be ``None``.
        transform: affine transform for both surfaces.
        lat, lon: aircraft position (WGS84 degrees).
        altitude_ft: aircraft altitude (feet MSL).
        heading_deg: ground track (degrees from true north, clockwise).
        ground_speed_kt: ground speed (knots). Must be > 0 to project ahead.
        vertical_speed_fpm: vertical speed (feet/min); positive = climbing.

    Returns:
        A dict with the graded ``alert_level`` (CLEAR/CAUTION/WARNING), the
        triggering point and its metrics, the effective (TTCI-modulated) horizons
        and clearance floors, the mean TTCI along the path, and the full sampled
        look-ahead profile for plotting.
    """
    # The TTCI modulation needs a first pass over the nominal track to estimate
    # how complex the terrain ahead is. Use the baseline caution horizon for it.
    nominal_horizon_km = max(ground_speed_kt * (CAUTION_LOOKAHEAD_S / 3600.0) * NM_TO_KM, 0.0)
    n_nominal = max(int(CAUTION_LOOKAHEAD_S / STEP_SECONDS), 1)
    path_ttci: List[float] = []
    for i in range(1, n_nominal + 1):
        d_km = nominal_horizon_km * (i / n_nominal)
        plat, plon = _destination_point(lat, lon, heading_deg, d_km)
        _, t = _sample_cell(elevation, ttci, transform, plat, plon)
        if t is not None:
            path_ttci.append(t)
    mean_path_ttci = float(np.mean(path_ttci)) if path_ttci else 0.0

    # TTCI modulation: stretch horizons and clearance floors with complexity.
    caution_time = CAUTION_LOOKAHEAD_S * (1.0 + TTCI_TIME_GAIN * mean_path_ttci)
    warning_time = WARNING_LOOKAHEAD_S * (1.0 + TTCI_TIME_GAIN * mean_path_ttci)
    caution_clear = CAUTION_CLEARANCE_FT * (1.0 + TTCI_CLEAR_GAIN * mean_path_ttci)
    warning_clear = WARNING_CLEARANCE_FT * (1.0 + TTCI_CLEAR_GAIN * mean_path_ttci)

    horizon_km = max(ground_speed_kt * (caution_time / 3600.0) * NM_TO_KM, 0.0)
    n_steps = max(int(caution_time / STEP_SECONDS), 1)

    profile: List[Dict] = []
    caution_hit: Optional[Dict] = None
    warning_hit: Optional[Dict] = None
    min_clearance_ft = math.inf

    for i in range(1, n_steps + 1):
        t_s = caution_time * (i / n_steps)
        d_km = horizon_km * (i / n_steps)
        d_nm = d_km / NM_TO_KM
        plat, plon = _destination_point(lat, lon, heading_deg, d_km)

        half_width_nm = CORRIDOR_BASE_NM + CORRIDOR_SPLAY_NM_PER_NM * d_nm
        terr_m, terr_ttci = _worst_terrain_in_corridor(
            elevation, ttci, transform, plat, plon, heading_deg, half_width_nm
        )
        if terr_m is None:
            continue  # outside surface coverage at this step

        terr_ft = terr_m * FEET_PER_METER
        path_alt_ft = altitude_ft + vertical_speed_fpm * (t_s / 60.0)
        clearance_ft = path_alt_ft - terr_ft
        min_clearance_ft = min(min_clearance_ft, clearance_ft)

        point = {
            "time_s": round(t_s, 1),
            "distance_nm": round(d_nm, 2),
            "lat": round(plat, 6),
            "lon": round(plon, 6),
            "terrain_ft": round(terr_ft, 0),
            "path_alt_ft": round(path_alt_ft, 0),
            "clearance_ft": round(clearance_ft, 0),
            "ttci": round(terr_ttci, 4) if terr_ttci is not None else None,
        }
        profile.append(point)

        # WARNING takes priority and only applies within the (shorter) warning
        # horizon; CAUTION applies across the full caution horizon.
        if warning_hit is None and t_s <= warning_time and clearance_ft < warning_clear:
            warning_hit = point
        if caution_hit is None and clearance_ft < caution_clear:
            caution_hit = point

    if warning_hit is not None:
        level, trigger = "WARNING", warning_hit
    elif caution_hit is not None:
        level, trigger = "CAUTION", caution_hit
    else:
        level, trigger = "CLEAR", None

    return {
        "alert_level": level,
        "alert": level != "CLEAR",
        "alert_color": _ALERT_COLORS[level],
        "callout": {
            "WARNING": "TERRAIN, TERRAIN — PULL UP",
            "CAUTION": "CAUTION, TERRAIN",
            "CLEAR": "Terrain clear",
        }[level],
        "aircraft": {
            "lat": lat, "lon": lon, "altitude_ft": round(altitude_ft, 0),
            "heading_deg": heading_deg, "ground_speed_kt": ground_speed_kt,
            "vertical_speed_fpm": vertical_speed_fpm,
        },
        "trigger": trigger,
        "min_clearance_ft": (round(min_clearance_ft, 0)
                             if math.isfinite(min_clearance_ft) else None),
        "mean_path_ttci": round(mean_path_ttci, 4),
        "envelope": {
            "caution_lookahead_s": round(caution_time, 1),
            "warning_lookahead_s": round(warning_time, 1),
            "caution_clearance_ft": round(caution_clear, 0),
            "warning_clearance_ft": round(warning_clear, 0),
            "horizon_nm": round(horizon_km / NM_TO_KM, 1),
            "ttci_time_gain_applied": round(TTCI_TIME_GAIN * mean_path_ttci, 3),
            "ttci_clearance_gain_applied": round(TTCI_CLEAR_GAIN * mean_path_ttci, 3),
        },
        "profile": profile,
    }
