"""
MSA Calculator — Minimum Safe Altitude per route sector.

Given a flight route (an ordered list of waypoints), this module computes the
Minimum Safe Altitude (MSA) for each leg by inspecting the highest terrain
within a lateral buffer around the leg centerline, applying the ICAO 1000 ft
Minimum Obstacle Clearance (MOC), and rounding up to the next 100 ft increment.
It also derives an along-route elevation profile for charting.

All geographic distances use the haversine great-circle formula on WGS84
(EPSG:4326) and all meter/foot conversions use the exact factor 0.3048 m/ft.
"""

from math import radians, sin, cos, sqrt, atan2, ceil

import numpy as np

# --- Constants -------------------------------------------------------------

EARTH_RADIUS_KM = 6371.0       # Mean Earth radius for haversine (km)
FEET_PER_METER_FACTOR = 0.3048  # Exact meters-per-foot conversion factor (Req 13.3)
NM_TO_KM = 1.852               # Nautical mile to kilometre

# ICAO standard obstacle clearance
MOC_FEET = 1000                          # Minimum Obstacle Clearance (ft)
MOC_METERS = MOC_FEET * FEET_PER_METER_FACTOR  # 304.8 m

# Lateral buffer: 5 NM on each side of the centerline => 10 NM wide corridor
BUFFER_NM = 5                          # Nautical miles on each side
BUFFER_KM = BUFFER_NM * NM_TO_KM       # 9.26 km
BUFFER_DEG = BUFFER_KM / 111.0         # Approx. degrees of latitude (~0.0834 deg)


# --- Distance --------------------------------------------------------------

def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in kilometres between two WGS84 coordinates.

    Uses the haversine formula on a spherical Earth (Requirement 13.1).
    The result is symmetric and is exactly 0 when the two points coincide.
    """
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = (sin(dlat / 2) ** 2
         + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2)
    return EARTH_RADIUS_KM * 2 * atan2(sqrt(a), sqrt(1 - a))


# --- Buffer masking --------------------------------------------------------

def get_sector_buffer_mask(elevation, transform, lat1, lon1, lat2, lon2, buffer_deg):
    """Boolean mask of DEM cells within ``buffer_deg`` of a sector centerline.

    A cell is selected when its perpendicular (point-to-segment) distance to the
    segment from ``(lat1, lon1)`` to ``(lat2, lon2)`` is within ``buffer_deg``.
    With ``buffer_deg`` corresponding to 5 NM, the selected cells form the
    10 NM wide corridor required for MSA evaluation (Requirement 9.2).

    A fast axis-aligned bounding-box prefilter (expanded by ``buffer_deg``)
    rejects the bulk of the grid before the precise distance test runs on the
    remaining candidate cells.

    Args:
        elevation: 2D DEM array; only its shape is used here.
        transform: Affine transform mapping (row, col) -> (lon, lat).
        lat1, lon1: Sector start coordinate (decimal degrees).
        lat2, lon2: Sector end coordinate (decimal degrees).
        buffer_deg: Lateral buffer half-width in degrees.

    Returns:
        A boolean ``ndarray`` with the same shape as ``elevation``.
    """
    rows, cols = elevation.shape
    mask = np.zeros((rows, cols), dtype=bool)

    # Geographic coordinate of every cell centre.
    cc, rr = np.meshgrid(np.arange(cols), np.arange(rows))
    lons = transform.c + cc * transform.a
    lats = transform.f + rr * transform.e

    # Bounding-box prefilter (fast): keep cells whose lat/lon fall within the
    # segment extent expanded by the buffer on every side.
    min_lat = min(lat1, lat2) - buffer_deg
    max_lat = max(lat1, lat2) + buffer_deg
    min_lon = min(lon1, lon2) - buffer_deg
    max_lon = max(lon1, lon2) + buffer_deg
    bbox_mask = ((lats >= min_lat) & (lats <= max_lat)
                 & (lons >= min_lon) & (lons <= max_lon))

    if not bbox_mask.any():
        return mask

    # Precise point-to-segment distance, evaluated only on prefiltered cells.
    sub_lons = lons[bbox_mask]
    sub_lats = lats[bbox_mask]

    dx = lon2 - lon1
    dy = lat2 - lat1
    seg_len_sq = dx * dx + dy * dy

    if seg_len_sq < 1e-12:
        # Degenerate segment (both endpoints coincide): distance to the point.
        dist = np.hypot(sub_lons - lon1, sub_lats - lat1)
    else:
        # Project each cell onto the segment, clamped to the [0, 1] extent.
        t = ((sub_lons - lon1) * dx + (sub_lats - lat1) * dy) / seg_len_sq
        t = np.clip(t, 0.0, 1.0)
        proj_lon = lon1 + t * dx
        proj_lat = lat1 + t * dy
        dist = np.hypot(sub_lons - proj_lon, sub_lats - proj_lat)

    mask[bbox_mask] = dist <= buffer_deg
    return mask


# --- MSA -------------------------------------------------------------------

def _round_up_to_100ft(feet):
    """Round an altitude in feet up to the next 100 ft increment.

    A small tolerance absorbs floating-point noise so that a value that is
    already an exact multiple of 100 ft (e.g. 1000.0) is not pushed up to the
    next increment by rounding error.
    """
    return int(ceil(round(feet, 6) / 100.0) * 100)


def compute_msa_for_route(waypoints, elevation, transform, ttci_array=None):
    """Compute the per-sector MSA for a flight route.

    A route of ``N`` waypoints yields ``N - 1`` sectors, one per consecutive
    pair (Requirement 9.1); a route with fewer than two waypoints yields an
    empty list (Requirement 9.6).

    For each sector the highest terrain within the 10 NM corridor is found and
    the MSA is computed as
    ``ceil((max_terrain_m + MOC_METERS) / 0.3048 / 100) * 100`` feet
    (Requirement 9.3). When the buffer contains no valid terrain the highest
    terrain is treated as 0 m, giving an MSA of exactly 1000 ft
    (Requirement 9.7).

    Args:
        waypoints: Ordered list of ``[lat, lon]`` pairs (decimal degrees).
        elevation: 2D DEM array in metres (NaN marks no-data cells).
        transform: Affine transform mapping (row, col) -> (lon, lat).
        ttci_array: Optional TTCI surface; when supplied, per-sector min/max/mean
            TTCI over the valid buffer cells is reported (Requirement 9.5).

    Returns:
        A list of per-sector dicts. Distances are reported in NM and km rounded
        to 0.1; terrain and MSA are reported in feet and metres as whole units
        (Requirement 9.4).
    """
    if len(waypoints) < 2:
        return []

    sectors = []
    for i in range(len(waypoints) - 1):
        lat1, lon1 = waypoints[i]
        lat2, lon2 = waypoints[i + 1]

        # Cells within the 10 NM corridor around this leg.
        mask = get_sector_buffer_mask(
            elevation, transform, lat1, lon1, lat2, lon2, BUFFER_DEG
        )

        # Highest terrain over valid (non-NaN) cells in the buffer.
        buffer_elev = elevation[mask]
        buffer_elev = buffer_elev[~np.isnan(buffer_elev)]
        if buffer_elev.size == 0:
            max_terrain_m = 0.0
        else:
            max_terrain_m = float(np.max(buffer_elev))

        # MSA = highest terrain + 1000 ft MOC, rounded up to the next 100 ft.
        msa_ft = _round_up_to_100ft(
            (max_terrain_m + MOC_METERS) / FEET_PER_METER_FACTOR
        )

        # Great-circle leg distance.
        dist_km = haversine_km(lat1, lon1, lat2, lon2)

        # TTCI statistics over the valid buffer cells (when a surface is given).
        ttci_stats = None
        if ttci_array is not None:
            buffer_ttci = ttci_array[mask]
            buffer_ttci = buffer_ttci[~np.isnan(buffer_ttci)]
            if buffer_ttci.size > 0:
                ttci_stats = {
                    "min": float(np.min(buffer_ttci)),
                    "max": float(np.max(buffer_ttci)),
                    "mean": float(np.mean(buffer_ttci)),
                }

        sectors.append({
            "sector": i + 1,
            "from": {"lat": lat1, "lon": lon1},
            "to": {"lat": lat2, "lon": lon2},
            "distance_km": round(dist_km, 1),
            "distance_nm": round(dist_km / NM_TO_KM, 1),
            "max_terrain_m": round(max_terrain_m, 0),
            "max_terrain_ft": round(max_terrain_m / FEET_PER_METER_FACTOR, 0),
            "msa_ft": msa_ft,
            "msa_m": round(msa_ft * FEET_PER_METER_FACTOR, 0),
            "buffer_nm": BUFFER_NM,
            "ttci": ttci_stats,
        })

    return sectors


# --- Elevation profile -----------------------------------------------------

def get_elevation_profile(waypoints, elevation, transform, num_points=100):
    """Sample the terrain elevation along a route for charting.

    Returns roughly ``num_points`` points distributed across the legs in
    proportion to their length, with no fewer than two points per sector, all
    ordered by non-decreasing cumulative distance (Requirement 10.5). A route
    with fewer than two waypoints yields an empty list (Requirement 10.6).

    Args:
        waypoints: Ordered list of ``[lat, lon]`` pairs (decimal degrees).
        elevation: 2D DEM array in metres (NaN marks no-data cells).
        transform: Affine transform mapping (row, col) -> (lon, lat).
        num_points: Approximate total number of profile points to return.

    Returns:
        A list of ``{distance_km, elevation_m, lat, lon}`` dicts.
    """
    if len(waypoints) < 2:
        return []

    rows, cols = elevation.shape

    # Per-leg distances and the route total (computed once).
    seg_dists = [
        haversine_km(waypoints[j][0], waypoints[j][1],
                     waypoints[j + 1][0], waypoints[j + 1][1])
        for j in range(len(waypoints) - 1)
    ]
    total_dist = sum(seg_dists)

    profile_points = []
    cumulative_dist = 0.0

    for i, seg_dist in enumerate(seg_dists):
        lat1, lon1 = waypoints[i]
        lat2, lon2 = waypoints[i + 1]

        # Allocate points proportionally to leg length, but never fewer than 2.
        if total_dist > 0:
            n = max(int(round(num_points * seg_dist / total_dist)), 2)
        else:
            n = 2

        for k in range(n):
            t = k / (n - 1)
            lat = lat1 + t * (lat2 - lat1)
            lon = lon1 + t * (lon2 - lon1)

            # Map the sample to its containing DEM cell via the inverse transform.
            col = int(np.floor((lon - transform.c) / transform.a))
            row = int(np.floor((lat - transform.f) / transform.e))

            elev = 0.0
            if 0 <= row < rows and 0 <= col < cols:
                cell = float(elevation[row, col])
                if not np.isnan(cell):
                    elev = cell

            profile_points.append({
                "distance_km": round(cumulative_dist + t * seg_dist, 2),
                "elevation_m": round(elev, 1),
                "lat": round(lat, 6),
                "lon": round(lon, 6),
            })

        cumulative_dist += seg_dist

    return profile_points
