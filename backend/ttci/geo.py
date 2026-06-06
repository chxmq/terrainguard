"""
Shared geospatial coordinate utilities for Terrain Guard.

This module is the single source of truth for converting between WGS84
geographic coordinates (latitude/longitude in decimal degrees) and DEM array
``(row, col)`` indices, for testing whether a coordinate falls within a
surface's geographic bounds, and for validating coordinate inputs.

All terrain data is referenced to WGS84 (EPSG:4326). A rasterio affine
``transform`` relates array indices to geographic coordinates as follows
(north-up rasters have a negative ``transform.e``):

    forward (cell -> coordinate, cell origin / top-left corner):
        lon = transform.c + col * transform.a
        lat = transform.f + row * transform.e

    inverse (coordinate -> cell):
        col = floor((lon - transform.c) / transform.a)
        row = floor((lat - transform.f) / transform.e)

Keeping this math in one place guarantees that the point query, MSA sampling,
the exported GeoTIFF, and the rendered overlay all resolve a coordinate to the
same DEM cell, preserving geographic alignment to within one cell.
"""

from math import floor, isfinite
from numbers import Real
from typing import Tuple

# Valid WGS84 coordinate ranges (decimal degrees).
LAT_MIN, LAT_MAX = -90.0, 90.0
LON_MIN, LON_MAX = -180.0, 180.0


def _require_finite_number(name: str, value) -> float:
    """Return ``value`` as a float, raising ``ValueError`` if it is not a
    finite real number.

    Booleans are rejected explicitly: although ``bool`` is a subclass of
    ``int`` in Python, ``True``/``False`` are not meaningful coordinates.
    NaN and infinities are rejected because they are "not a number" in the
    geospatial sense and cannot identify a location.
    """
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a number, got {value!r}")
    value = float(value)
    if not isfinite(value):
        raise ValueError(f"{name} must be a finite number, got {value!r}")
    return value


def validate_coordinate(lat, lon) -> Tuple[float, float]:
    """Validate a geographic coordinate and return it as ``(lat, lon)`` floats.

    Raises a descriptive ``ValueError`` when ``lat`` is outside ``[-90, 90]``,
    ``lon`` is outside ``[-180, 180]``, or either value is non-numeric,
    NaN, or infinite.

    Args:
        lat: Latitude in decimal degrees.
        lon: Longitude in decimal degrees.

    Returns:
        The validated ``(lat, lon)`` pair as floats.

    Raises:
        ValueError: If the coordinate is non-numeric or out of range.
    """
    lat = _require_finite_number("Latitude", lat)
    lon = _require_finite_number("Longitude", lon)

    if not (LAT_MIN <= lat <= LAT_MAX):
        raise ValueError(
            f"Latitude {lat} is out of range; must be within "
            f"[{LAT_MIN}, {LAT_MAX}] degrees"
        )
    if not (LON_MIN <= lon <= LON_MAX):
        raise ValueError(
            f"Longitude {lon} is out of range; must be within "
            f"[{LON_MIN}, {LON_MAX}] degrees"
        )
    return lat, lon


def coord_to_cell(transform, lat, lon) -> Tuple[int, int]:
    """Map a geographic coordinate to the DEM cell that contains it.

    Uses the inverse affine transform with a floor so that any coordinate
    lying within a cell's footprint resolves to that single cell:

        col = floor((lon - transform.c) / transform.a)
        row = floor((lat - transform.f) / transform.e)

    Args:
        transform: A rasterio/affine ``Affine`` transform with attributes
            ``a`` (lon pixel size), ``c`` (left origin longitude),
            ``e`` (lat pixel size, negative for north-up), and ``f``
            (top origin latitude).
        lat: Latitude in decimal degrees.
        lon: Longitude in decimal degrees.

    Returns:
        The ``(row, col)`` index of the containing cell. The result may be
        outside the array extent if the coordinate lies outside the surface;
        callers are responsible for bounds checking.
    """
    col = floor((lon - transform.c) / transform.a)
    row = floor((lat - transform.f) / transform.e)
    return row, col


def cell_to_coord(transform, row, col) -> Tuple[float, float]:
    """Map a DEM cell index to a geographic coordinate.

    Returns the coordinate at the **center** of the cell rather than its
    top-left origin. The cell center is the most representative point for a
    cell and keeps the round-trip error of ``coord_to_cell``/``cell_to_coord``
    bounded by half a cell, which comfortably satisfies the one-cell alignment
    tolerance required across the DEM, the TTCI surface, and the overlay.

    The half-cell offset is applied through the affine transform itself:

        lon = transform.c + (col + 0.5) * transform.a
        lat = transform.f + (row + 0.5) * transform.e

    Args:
        transform: A rasterio/affine ``Affine`` transform (see ``coord_to_cell``).
        row: Cell row index.
        col: Cell column index.

    Returns:
        The ``(lat, lon)`` coordinate at the center of the cell, in decimal
        degrees.
    """
    lon = transform.c + (col + 0.5) * transform.a
    lat = transform.f + (row + 0.5) * transform.e
    return lat, lon


def in_bounds(bounds, lat, lon) -> bool:
    """Return whether a coordinate falls within a surface's geographic bounds.

    Args:
        bounds: A rasterio ``BoundingBox``-like object exposing ``left``,
            ``bottom``, ``right``, and ``top`` attributes (WGS84 degrees).
        lat: Latitude in decimal degrees.
        lon: Longitude in decimal degrees.

    Returns:
        ``True`` if ``lon`` is within ``[left, right]`` and ``lat`` is within
        ``[bottom, top]`` (inclusive), otherwise ``False``.
    """
    return (
        bounds.left <= lon <= bounds.right
        and bounds.bottom <= lat <= bounds.top
    )
