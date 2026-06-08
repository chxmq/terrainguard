"""
TTCI Pipeline — Core terrain complexity analysis.

Computes Slope, TRI, Curvature, Elevation StdDev from DEM data
and combines them into a weighted TTCI score [0,1].
"""

import os

import numpy as np
from scipy.ndimage import gaussian_filter, uniform_filter
import rasterio

DEFAULT_WEIGHTS = {
    "slope": 0.30, "tri": 0.30,
    "curvature": 0.20, "elevation_std": 0.20,
}

# Human-readable provenance labels for the DEM sources, surfaced to the client so
# the demo can state exactly which open dataset produced the displayed surface.
DEM_SOURCE_LABELS = {
    "srtm30": "SRTM 30 m (NASA/USGS, via AWS Terrain Tiles)",
    "copernicus30": "Copernicus GLO-30 (ESA)",
    "opentopo": "OpenTopography (SRTM 30 m)",
    "synthetic": "Synthetic demonstration terrain",
}

# Single sentinel written for no-data cells on GeoTIFF export. It lies outside
# the valid TTCI range [0, 1] and is recorded in the raster's no-data metadata
# so downstream readers can mask it unambiguously (Requirement 5.2).
NODATA_SENTINEL = -9999.0

# Default demonstration region (Ladakh), ordered ``(south, north, west, east)``
# to match :func:`acquire_dem`. Used when ``run_pipeline`` acquires a DEM and no
# bounding box is supplied; matches the extent of the synthetic demo DEM.
DEFAULT_BBOX = (33.8, 34.5, 76.8, 77.8)

# The four terrain metrics that every TTCI weight set must specify. Derived from
# DEFAULT_WEIGHTS so the required set and the defaults never drift apart.
REQUIRED_METRICS = tuple(DEFAULT_WEIGHTS.keys())

# Tolerances for weight validation and percentile-bound collapse detection.
WEIGHT_SUM_TOLERANCE = 0.001
BOUND_COLLAPSE_TOLERANCE = 1e-10

RISK_LEVELS = [
    (0.0, 0.2, "Very Low",  "#2ecc71"),
    (0.2, 0.4, "Low",       "#f1c40f"),
    (0.4, 0.6, "Moderate",  "#e67e22"),
    (0.6, 0.8, "High",      "#e74c3c"),
    (0.8, 1.0, "Critical",  "#8e44ad"),
]


def _ensure_has_valid_cells(elevation):
    """Raise a descriptive error when the DEM has no valid (non-NaN) cells.

    Terrain metrics are undefined when every cell is no-data, so callers fail
    loudly rather than emit an all-NaN surface.
    """
    if np.all(np.isnan(elevation)):
        raise ValueError(
            "DEM contains no valid elevation data: every cell is no-data (NaN). "
            "Cannot compute terrain metrics."
        )


def _prepare_grid(elevation):
    """Return a NaN-free float64 working grid and its no-data mask.

    The grid is computed in float64 for numerical stability, and no-data cells
    are filled with the mean of the valid cells so that edge padding and
    neighborhood filters do not bleed NaN into adjacent valid cells. Callers
    restore the no-data mask on the computed metric so that no-data cells map
    back to NaN. The input array is never mutated.
    """
    grid = np.asarray(elevation, dtype=np.float64)
    _ensure_has_valid_cells(grid)
    nodata = np.isnan(grid)
    if nodata.any():
        grid = grid.copy()
        grid[nodata] = np.nanmean(grid)
    return grid, nodata


def compute_slope(elevation, cell_size=30.0):
    """Compute slope in degrees using Horn's method.

    Uses ``cell_size`` (meters) as the spatial unit and returns values bounded
    within [0, 90] degrees over the full grid via edge padding. No-data cells
    are returned as NaN.
    """
    grid, nodata = _prepare_grid(elevation)
    pad = np.pad(grid, 1, mode='edge')
    dz_dx = (
        (pad[:-2, 2:] + 2*pad[1:-1, 2:] + pad[2:, 2:]) -
        (pad[:-2, :-2] + 2*pad[1:-1, :-2] + pad[2:, :-2])
    ) / (8 * cell_size)
    dz_dy = (
        (pad[2:, :-2] + 2*pad[2:, 1:-1] + pad[2:, 2:]) -
        (pad[:-2, :-2] + 2*pad[:-2, 1:-1] + pad[:-2, 2:])
    ) / (8 * cell_size)
    slope = np.degrees(np.arctan(np.sqrt(dz_dx**2 + dz_dy**2)))
    slope = np.clip(slope, 0.0, 90.0)
    slope[nodata] = np.nan
    return slope


def compute_tri(elevation):
    """Compute the Terrain Ruggedness Index (Riley et al., 1999).

    Returns the root-mean-square elevation difference between each cell and its
    eight neighbors as a non-negative value in meters, computed over the full
    grid via edge padding. No-data cells are returned as NaN.
    """
    grid, nodata = _prepare_grid(elevation)
    pad = np.pad(grid, 1, mode='edge')
    tri_sq = np.zeros_like(grid)
    for di in range(3):
        for dj in range(3):
            if di == 1 and dj == 1:
                continue
            nb = pad[di:di+grid.shape[0], dj:dj+grid.shape[1]]
            tri_sq += (nb - grid) ** 2
    tri = np.sqrt(np.maximum(tri_sq / 8.0, 0.0))
    tri[nodata] = np.nan
    return tri


def compute_curvature(elevation, cell_size=30.0):
    """Compute absolute profile curvature (Zevenbergen & Thorne).

    Uses ``cell_size`` (meters) as the spatial unit and returns a non-negative
    value per cell over the full grid via edge padding. No-data cells are
    returned as NaN.
    """
    grid, nodata = _prepare_grid(elevation)
    es = gaussian_filter(grid, sigma=0.5)
    pad = np.pad(es, 1, mode='edge')
    L = cell_size
    z4, z5, z6 = pad[1:-1, :-2], pad[1:-1, 1:-1], pad[1:-1, 2:]
    z2, z8 = pad[:-2, 1:-1], pad[2:, 1:-1]
    z1, z3 = pad[:-2, :-2], pad[:-2, 2:]
    z7, z9 = pad[2:, :-2], pad[2:, 2:]
    D = ((z4 + z6)/2 - z5) / L**2
    E = ((z2 + z8)/2 - z5) / L**2
    F = (-z1 + z3 + z7 - z9) / (4 * L**2)
    G = (-z4 + z6) / (2 * L)
    H = (z2 - z8) / (2 * L)
    denom = np.where(G**2 + H**2 > 1e-10, G**2 + H**2, 1e-10)
    curvature = np.abs(-2*(D*G**2 + E*H**2 + F*G*H) / denom)
    curvature[nodata] = np.nan
    return curvature


def compute_elevation_std(elevation, window_size=5):
    """Compute local elevation standard deviation over a window.

    Returns a non-negative value per cell in meters using an edge-aware moving
    window of ``window_size`` cells. No-data cells are returned as NaN.
    """
    grid, nodata = _prepare_grid(elevation)
    mean = uniform_filter(grid, size=window_size, mode='nearest')
    mean_sq = uniform_filter(grid**2, size=window_size, mode='nearest')
    estd = np.sqrt(np.maximum(mean_sq - mean**2, 0.0))
    estd[nodata] = np.nan
    return estd


def normalize(arr, pct=2.0):
    """Min-max normalize a metric surface into [0, 1] with percentile clipping.

    The lower and upper bounds are the ``pct`` and ``100 - pct`` percentiles
    (the 2nd and 98th by default) computed over the finite, non-no-data values
    of ``arr``. Every value is linearly rescaled against those bounds and clipped
    to the inclusive range [0, 1]: values at or below the lower bound map to 0
    and values at or above the upper bound map to 1. No-data (NaN) cells are
    preserved as NaN in the output.

    Returns an all-zeros surface (so the metric contributes nothing to the TTCI)
    when either:

    * ``arr`` has no finite values to derive bounds from (for example, an
      entirely-NaN surface), or
    * the percentile bounds collapse to within ``BOUND_COLLAPSE_TOLERANCE`` of
      each other.
    """
    arr = np.asarray(arr, dtype=np.float64)
    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        return np.zeros_like(arr)
    vmin = np.percentile(finite, pct)
    vmax = np.percentile(finite, 100 - pct)
    if vmax - vmin < BOUND_COLLAPSE_TOLERANCE:
        return np.zeros_like(arr)
    return np.clip((arr - vmin) / (vmax - vmin), 0.0, 1.0)


def validate_weights(weights):
    """Validate a TTCI metric weight set, raising ``ValueError`` when invalid.

    A weight set is valid only when it:

    * specifies every required metric (slope, tri, curvature, elevation_std),
    * contains no negative weight, and
    * sums to 1.0 within a tolerance of ``+/-WEIGHT_SUM_TOLERANCE``.

    A descriptive ``ValueError`` is raised on any violation so that callers
    produce no TTCI output for an invalid weight set.
    """
    if not isinstance(weights, dict):
        raise ValueError(
            "Invalid weight set: expected a mapping of metric name to weight, "
            f"got {type(weights).__name__}."
        )
    missing = [m for m in REQUIRED_METRICS if m not in weights]
    if missing:
        raise ValueError(
            f"Invalid weight set: missing required metric weight(s) {missing}. "
            f"Required metrics are {list(REQUIRED_METRICS)}."
        )
    negative = {m: weights[m] for m in REQUIRED_METRICS if weights[m] < 0}
    if negative:
        raise ValueError(
            "Invalid weight set: all weights must be non-negative, but found "
            f"negative weight(s) {negative}."
        )
    total = sum(float(weights[m]) for m in REQUIRED_METRICS)
    if abs(total - 1.0) > WEIGHT_SUM_TOLERANCE:
        raise ValueError(
            "Invalid weight set: weights must sum to 1.0 within "
            f"+/-{WEIGHT_SUM_TOLERANCE}, but they sum to {total:.6f}."
        )


def compute_ttci(elevation, cell_size=30.0, weights=None):
    """Compute the full TTCI surface plus its component and normalized metrics.

    When ``weights`` is ``None`` the default weights are used (slope 0.30,
    tri 0.30, curvature 0.20, elevation_std 0.20). When a weight set is supplied
    it is validated with :func:`validate_weights` first, so an invalid weight set
    raises ``ValueError`` and no TTCI output is produced.

    The returned TTCI surface holds values in [0, 1] for every valid cell and
    preserves NaN for no-data cells. The result dict also exposes the four raw
    metric surfaces and their normalized counterparts for downstream consumers.
    """
    if weights is None:
        w = DEFAULT_WEIGHTS.copy()
    else:
        validate_weights(weights)
        w = weights
    print("⏳ Computing terrain metrics...")
    slope = compute_slope(elevation, cell_size)
    tri = compute_tri(elevation)
    curv = compute_curvature(elevation, cell_size)
    estd = compute_elevation_std(elevation)
    sn, tn, cn, en = normalize(slope), normalize(tri), normalize(curv), normalize(estd)
    ttci = w["slope"]*sn + w["tri"]*tn + w["curvature"]*cn + w["elevation_std"]*en
    # Clip valid cells to the contractual [0, 1] range (NaN is preserved by clip),
    # then restore no-data cells from the source elevation to NaN.
    ttci = np.clip(ttci, 0.0, 1.0)
    ttci[np.isnan(np.asarray(elevation, dtype=np.float64))] = np.nan
    print(f"✅ TTCI range: [{np.nanmin(ttci):.3f}, {np.nanmax(ttci):.3f}], mean: {np.nanmean(ttci):.3f}")
    return {"ttci": ttci, "slope": slope, "tri": tri, "curvature": curv,
            "elevation_std": estd, "slope_norm": sn, "tri_norm": tn,
            "curvature_norm": cn, "elevation_std_norm": en}


def _is_nodata(val):
    """Return ``True`` when ``val`` is no-data and must be excluded from classification.

    Per Requirement 4.8 a value that is NoData or "not a number" is excluded and
    receives no risk level. That covers ``None``, IEEE NaN, and any value that
    cannot be interpreted as a real number (e.g. a non-numeric type).
    """
    if val is None:
        return True
    try:
        return bool(np.isnan(val))
    except (TypeError, ValueError):
        # Non-numeric input is "not a number" and is treated as no-data.
        return True


def classify_risk(val):
    """Classify a TTCI value into its risk level.

    The five risk bands are defined by :data:`RISK_LEVELS`, the single source of
    truth for both the band boundaries and the deterministic, one-to-one
    level->color association. Bands are contiguous and half-open ``[lo, hi)``
    across ``[0.0, 1.0]`` except the Critical band ``[0.8, 1.0]``, which includes
    both bounds, so every in-range value maps to exactly one level.

    Args:
        val: The TTCI value to classify, normally a float in ``[0.0, 1.0]``.

    Returns:
        A ``(label, color)`` tuple drawn from :data:`RISK_LEVELS` for any value
        in the inclusive range ``[0.0, 1.0]``. Returns ``None`` when ``val`` is
        no-data (``None``, NaN, or otherwise not a number), signalling that no
        risk level applies (Requirement 4.8).

    Raises:
        ValueError: If ``val`` is a real number outside the supported range
            ``[0.0, 1.0]`` (Requirement 4.9).
    """
    # No-data / not-a-number is excluded: no risk level is assigned.
    if _is_nodata(val):
        return None
    # Real values outside the supported range are rejected, not classified.
    if val < 0.0 or val > 1.0:
        raise ValueError(
            f"TTCI value {val!r} is outside the supported range [0.0, 1.0] and "
            "cannot be classified into a risk level."
        )
    last_index = len(RISK_LEVELS) - 1
    for index, (lo, hi, label, color) in enumerate(RISK_LEVELS):
        # Every band includes its lower bound and excludes its upper bound,
        # except the final (Critical) band, which also includes its upper bound.
        if lo <= val < hi or (index == last_index and val == hi):
            return label, color
    # Unreachable while RISK_LEVELS contiguously spans [0.0, 1.0]; guards against
    # a future gap in the table rather than silently mislabelling a value.
    raise ValueError(
        f"TTCI value {val!r} did not match any risk band; RISK_LEVELS must "
        "contiguously cover [0.0, 1.0]."
    )


def save_ttci_geotiff(ttci, profile, path):
    """Export a TTCI surface as a georeferenced GeoTIFF.

    The source DEM's coordinate reference system and affine transform are
    preserved exactly: the output profile is derived from ``profile`` and only
    the band layout (a single ``float32`` band) and the no-data encoding are
    overridden, so the CRS and transform pass through unchanged (Requirement
    5.1).

    Valid cells are written as their TTCI value in ``[0, 1]``. No-data cells
    (``NaN``) are written as the single sentinel :data:`NODATA_SENTINEL`
    (``-9999.0``), which lies outside ``[0, 1]`` and is recorded in the GeoTIFF
    no-data metadata so downstream readers can mask it (Requirement 5.2). The
    caller's array is never mutated.

    Args:
        ttci: 2-D TTCI surface holding values in ``[0, 1]`` for valid cells and
            ``NaN`` for no-data cells.
        profile: rasterio profile of the source DEM; its CRS and transform are
            carried through to the exported raster unchanged.
        path: Destination path for the GeoTIFF.

    Returns:
        The ``path`` that was written.
    """
    out_profile = profile.copy()
    # Override only the band layout and no-data encoding. Every other field —
    # crucially the CRS and affine transform — is preserved from the source.
    out_profile.update(dtype=rasterio.float32, count=1, nodata=NODATA_SENTINEL)

    # Work on a float32 copy so no-data cells can be encoded with the sentinel
    # without disturbing the caller's array.
    out = np.asarray(ttci, dtype=np.float32).copy()
    out[np.isnan(out)] = np.float32(NODATA_SENTINEL)

    with rasterio.open(path, "w", **out_profile) as dst:
        dst.write(out, 1)
    print(f"💾 TTCI saved: {path}")
    return path


def run_pipeline(dem_path=None, cell_size=30.0, weights=None, use_synthetic=False,
                 bbox=None, dem_type="srtm30", api_key=None, zoom=11, source="auto"):
    """Run the full TTCI pipeline end-to-end and return a reusable results dict.

    DEM acquisition follows exactly one of three paths:

    * ``use_synthetic=True`` — generate the synthetic demonstration DEM, marking
      the result ``is_synthetic=True``. This is the backward-compatible path the
      API startup relies on (``run_pipeline(use_synthetic=True)``).
    * an explicit ``dem_path`` — load real elevation data from that GeoTIFF,
      marking the result ``is_synthetic=False``.
    * neither — delegate to :func:`acquire_dem`, which downloads real elevation
      data when an access key is configured and otherwise falls back to a
      synthetic DEM, propagating the resulting ``is_synthetic`` flag so the
      synthetic-vs-real distinction is decided in a single place.

    The returned dict carries everything a downstream consumer (TAWS overlay,
    UAS corridor scorer, point query) needs without recomputation: the TTCI
    surface, the four component metric surfaces (``slope``, ``tri``,
    ``curvature``, ``elevation_std``), their four normalized counterparts, the
    elevation surface, the affine ``transform``, ``crs``, ``bounds``, the
    rasterio ``profile``, the ``dem_path`` and ``ttci_path``, and the
    ``is_synthetic`` flag — all over the same extent (Requirement 11.1).

    Args:
        dem_path: Path to an existing DEM GeoTIFF to load. Ignored when
            ``use_synthetic`` is ``True``.
        cell_size: DEM cell size in meters, used as the spatial unit for slope
            and curvature.
        weights: Optional metric weight set; validated inside :func:`compute_ttci`.
        use_synthetic: When ``True``, force the synthetic demonstration DEM.
        bbox: Optional ``(south, north, west, east)`` bounding box used only on
            the :func:`acquire_dem` path; defaults to :data:`DEFAULT_BBOX`.
        dem_type: Logical DEM source for the :func:`acquire_dem` path.
        api_key: OpenTopography access key for the :func:`acquire_dem` path. When
            ``None``, the ``OPENTOPO_API_KEY`` environment variable is used; when
            no key is available, :func:`acquire_dem` falls back to synthetic data.

    Returns:
        A results dict with keys ``ttci``, ``slope``, ``tri``, ``curvature``,
        ``elevation_std``, ``slope_norm``, ``tri_norm``, ``curvature_norm``,
        ``elevation_std_norm``, ``elevation``, ``transform``, ``crs``,
        ``bounds``, ``profile``, ``dem_path``, ``ttci_path``, and
        ``is_synthetic``.
    """
    from .downloader import (
        acquire_dem, generate_synthetic_dem, load_dem,
        DATA_DIR, SYNTHETIC_DEM_FILENAME,
    )

    if use_synthetic:
        # Backward-compatible explicit synthetic path (used by the API startup).
        elevation, profile, transform, crs, bounds = generate_synthetic_dem()
        dem_path = str(DATA_DIR / SYNTHETIC_DEM_FILENAME)
        is_synthetic = True
        dem_type_used = "synthetic"
    elif dem_path is not None:
        # Load real elevation data from an explicit GeoTIFF path.
        elevation, profile, transform, crs, bounds = load_dem(dem_path)
        is_synthetic = False
        dem_type_used = dem_type
    else:
        # No explicit DEM path: acquire via the orchestrator so the synthetic-vs-
        # real decision (and the is_synthetic flag) is made in exactly one place.
        if api_key is None:
            api_key = os.environ.get("OPENTOPO_API_KEY")
        dem = acquire_dem(
            bbox if bbox is not None else DEFAULT_BBOX,
            dem_type=dem_type,
            api_key=api_key,
            zoom=zoom,
            source=source,
        )
        elevation = dem.elevation
        profile = dem.profile
        transform = dem.transform
        crs = dem.crs
        bounds = dem.bounds
        dem_path = dem.dem_path
        is_synthetic = dem.is_synthetic
        dem_type_used = "synthetic" if dem.is_synthetic else dem.dem_type
        # Use the DEM's real ground resolution for slope/curvature when known.
        if dem.cell_size_m is not None:
            cell_size = dem.cell_size_m

    results = compute_ttci(elevation, cell_size, weights)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ttci_path = str(DATA_DIR / "ttci_output.tif")
    save_ttci_geotiff(results["ttci"], profile, ttci_path)

    # Expose every surface and its geospatial context over the same extent so
    # downstream consumers reuse them without recomputation (Requirement 11.1).
    results.update(
        elevation=elevation, transform=transform, crs=crs, bounds=bounds,
        profile=profile, dem_path=dem_path, ttci_path=ttci_path,
        is_synthetic=is_synthetic, dem_type=dem_type_used,
        source_label=DEM_SOURCE_LABELS.get(dem_type_used, dem_type_used),
    )
    return results


def compute_region(
    bbox, zoom=11, source="auto", weights=None, api_key=None,
    allow_synthetic_fallback: bool = False,
):
    """Compute a TTCI surface for an arbitrary bbox in-memory (no disk writes).

    This is the on-demand, *global* counterpart to :func:`run_pipeline`: it
    acquires a real DEM for ``bbox`` from the selected open-source provider and
    computes the full TTCI surface, returning the same results dict shape
    (``ttci``, component + normalized metrics, ``elevation``, ``transform``,
    ``crs``, ``bounds``, ``profile``, ``is_synthetic``, ``dem_type``,
    ``source_label``) — but without persisting any GeoTIFF/PNG, so it is safe to
    call repeatedly as a user navigates the map.

    The DEM sources are global, so this works for any land region on Earth; the
    caller is responsible for clamping the bbox/zoom to a sane size (the DEM
    acquirers already cap tile counts).

    Args:
        bbox: ``(south, north, west, east)`` in WGS84 degrees.
        zoom: terrain-tile zoom (resolution); scale this with map zoom.
        source: ``'auto'`` | ``'opentopo'`` | ``'copernicus'`` | ``'tiles'``.
        weights: optional TTCI weight override (validated in :func:`compute_ttci`).
        api_key: OpenTopography key; falls back to ``OPENTOPO_API_KEY``.
        allow_synthetic_fallback: when False (default for on-demand regions),
            DEM acquisition failures propagate instead of substituting demo terrain.

    Returns:
        A results dict (see above). Never writes to disk.
    """
    from .downloader import acquire_dem

    if api_key is None:
        api_key = os.environ.get("OPENTOPO_API_KEY")

    dem = acquire_dem(
        bbox, api_key=api_key, zoom=zoom, source=source,
        allow_synthetic_fallback=allow_synthetic_fallback,
    )
    cell_size = dem.cell_size_m if dem.cell_size_m is not None else 30.0
    results = compute_ttci(dem.elevation, cell_size, weights)

    dem_type_used = "synthetic" if dem.is_synthetic else dem.dem_type
    results.update(
        elevation=dem.elevation, transform=dem.transform, crs=dem.crs,
        bounds=dem.bounds, profile=dem.profile, is_synthetic=dem.is_synthetic,
        dem_type=dem_type_used,
        source_label=DEM_SOURCE_LABELS.get(dem_type_used, dem_type_used),
    )
    return results
