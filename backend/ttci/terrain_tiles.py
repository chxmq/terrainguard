"""
Real-elevation DEM acquisition via AWS Terrain Tiles (no API key required).

The AWS "Terrain Tiles" Open Data set publishes global elevation as 256x256
PNG tiles in the *Terrarium* encoding, served as a standard XYZ tile pyramid in
Web Mercator (EPSG:3857). Decoding is exact:

    elevation_m = (red * 256 + green + blue / 256) - 32768

This module fetches the tiles covering a WGS84 bounding box at a chosen zoom,
mosaics them into a single Web Mercator grid, and reprojects that grid to
EPSG:4326 over the requested extent so the result drops straight into the
existing TTCI pipeline (which assumes lat/lon rasters). The data is sourced from
SRTM, the USGS NED, and other public DEMs — i.e. exactly the open-source DEM
families named in the problem statement — but requires no account or key, which
makes it ideal for a live, reproducible demo.

References:
    * AWS Open Data — Terrain Tiles: https://registry.opendata.aws/terrain-tiles/
    * Terrarium encoding (Mapzen / Tilezen).
"""

from __future__ import annotations

import logging
import math

logger = logging.getLogger(__name__)
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Tuple

import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.coords import BoundingBox
from rasterio.crs import CRS
from rasterio.transform import from_bounds, from_origin
from rasterio.warp import Resampling, reproject

# Tiles are mirrored on several CDNs; the S3 origin needs no key and is stable.
TILE_URL_TEMPLATE = (
    "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
)

# Web Mercator constants.
_EARTH_RADIUS_M = 6378137.0
_ORIGIN_SHIFT = math.pi * _EARTH_RADIUS_M  # 20037508.342789244
TILE_SIZE = 256

# Per-tile HTTP timeout (seconds) and a bound on how many tiles a single request
# may fetch, so an over-wide bbox/zoom can't trigger an unbounded download.
TILE_TIMEOUT_SECONDS = 30
MAX_TILES = 400

# On-disk tile cache so repeated runs over the same region are instant and the
# demo works offline once warmed.
_TILE_CACHE_DIR = Path(__file__).parent.parent / "data" / "tiles"


@dataclass
class TerrainTileResult:
    """A real DEM acquired from terrain tiles, with full geospatial metadata."""

    elevation: np.ndarray          # float32, metres, NaN for no-data
    profile: dict
    transform: object              # affine transform (EPSG:4326)
    crs: object
    bounds: BoundingBox
    cell_size_m: float             # representative ground resolution (metres)
    zoom: int
    tile_count: int


def _lonlat_to_tile_xy(lon: float, lat: float, zoom: int) -> Tuple[float, float]:
    """Fractional XYZ tile coordinates for a lon/lat at a zoom level."""
    n = 2.0 ** zoom
    x = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(max(min(lat, 85.05112878), -85.05112878))
    y = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def _tile_merc_bounds(x: int, y: int, zoom: int) -> Tuple[float, float, float, float]:
    """Web Mercator (EPSG:3857) bounds of tile (x, y) as (left, bottom, right, top)."""
    n = 2.0 ** zoom
    tile_span = 2.0 * _ORIGIN_SHIFT / n
    left = x * tile_span - _ORIGIN_SHIFT
    right = left + tile_span
    top = _ORIGIN_SHIFT - y * tile_span
    bottom = top - tile_span
    return left, bottom, right, top


def _decode_terrarium(png_bytes: bytes) -> np.ndarray:
    """Decode Terrarium-encoded PNG bytes into a float32 elevation grid (metres)."""
    img = np.asarray(Image.open(BytesIO(png_bytes)).convert("RGB"), dtype=np.float64)
    elev = (img[..., 0] * 256.0 + img[..., 1] + img[..., 2] / 256.0) - 32768.0
    return elev.astype(np.float32)


def _fetch_tile(x: int, y: int, zoom: int, session: requests.Session) -> np.ndarray | None:
    """Fetch and decode one terrain tile, using the on-disk cache when present.

    Returns the decoded elevation grid, or ``None`` when the tile is missing
    (e.g. outside published coverage) so the caller can fill it with no-data.
    """
    cache_path = _TILE_CACHE_DIR / f"{zoom}_{x}_{y}.png"
    if cache_path.exists():
        try:
            return _decode_terrarium(cache_path.read_bytes())
        except Exception:
            cache_path.unlink(missing_ok=True)  # corrupt cache entry; re-fetch

    url = TILE_URL_TEMPLATE.format(z=zoom, x=x, y=y)
    resp = session.get(url, timeout=TILE_TIMEOUT_SECONDS)
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise RuntimeError(
            f"Terrain tile {zoom}/{x}/{y} returned HTTP {resp.status_code}."
        )

    _TILE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(resp.content)
    return _decode_terrarium(resp.content)


def download_terrain_dem(
    bbox: Tuple[float, float, float, float], zoom: int = 11
) -> TerrainTileResult:
    """Acquire a real DEM for a bounding box from AWS Terrain Tiles.

    Args:
        bbox: ``(south, north, west, east)`` in WGS84 degrees — the same order
            used throughout the downloader.
        zoom: XYZ zoom level. Higher zoom = finer resolution and more tiles
            (zoom 11 ≈ 76 m/px, 12 ≈ 38 m/px, 13 ≈ 19 m/px at the equator).

    Returns:
        A :class:`TerrainTileResult` with a float32 EPSG:4326 elevation grid
        (NaN for no-data), its rasterio profile/transform/crs/bounds, and a
        representative ground ``cell_size_m`` for the slope/curvature math.

    Raises:
        ValueError: If the bbox is degenerate or the tile count exceeds
            :data:`MAX_TILES` at the requested zoom.
        RuntimeError: If a required tile cannot be retrieved.
    """
    south, north, west, east = (float(v) for v in bbox)
    if north <= south or east <= west:
        raise ValueError(
            f"Invalid bbox (south,north,west,east)={bbox!r}: need north>south and east>west."
        )

    # Tile index range covering the bbox (note: tile Y grows southward).
    x0f, y0f = _lonlat_to_tile_xy(west, north, zoom)
    x1f, y1f = _lonlat_to_tile_xy(east, south, zoom)
    x_min, x_max = int(math.floor(x0f)), int(math.floor(x1f))
    y_min, y_max = int(math.floor(y0f)), int(math.floor(y1f))

    n_x = x_max - x_min + 1
    n_y = y_max - y_min + 1
    tile_count = n_x * n_y
    if tile_count > MAX_TILES:
        raise ValueError(
            f"Requested region needs {tile_count} tiles at zoom {zoom} "
            f"(max {MAX_TILES}). Use a smaller bbox or lower zoom."
        )

    # Assemble the mosaic in Web Mercator. Missing tiles become NaN.
    mosaic = np.full((n_y * TILE_SIZE, n_x * TILE_SIZE), np.nan, dtype=np.float32)
    session = requests.Session()
    fetched = 0
    for ty in range(y_min, y_max + 1):
        for tx in range(x_min, x_max + 1):
            tile = _fetch_tile(tx, ty, zoom, session)
            if tile is None:
                continue
            r0 = (ty - y_min) * TILE_SIZE
            c0 = (tx - x_min) * TILE_SIZE
            mosaic[r0:r0 + TILE_SIZE, c0:c0 + TILE_SIZE] = tile
            fetched += 1

    if fetched == 0:
        raise RuntimeError(
            "No terrain tiles were available for the requested region."
        )

    # Mosaic geotransform (EPSG:3857): top-left corner of the top-left tile.
    merc_left, _, _, merc_top = _tile_merc_bounds(x_min, y_min, zoom)
    res_merc = (2.0 * _ORIGIN_SHIFT / (2.0 ** zoom)) / TILE_SIZE
    src_transform = from_origin(merc_left, merc_top, res_merc, res_merc)
    src_crs = CRS.from_epsg(3857)

    # Reproject to EPSG:4326 over exactly the requested bbox. Longitude is linear
    # in Mercator x, so degrees-per-pixel is exact for the chosen zoom.
    deg_per_px = 360.0 / (TILE_SIZE * 2.0 ** zoom)
    dst_width = max(1, int(round((east - west) / deg_per_px)))
    dst_height = max(1, int(round((north - south) / deg_per_px)))
    dst_transform = from_bounds(west, south, east, north, dst_width, dst_height)
    dst_crs = CRS.from_epsg(4326)

    destination = np.full((dst_height, dst_width), np.nan, dtype=np.float32)
    reproject(
        source=mosaic,
        destination=destination,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=dst_transform,
        dst_crs=dst_crs,
        src_nodata=np.nan,
        dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )

    # Representative ground resolution at the region centre, for slope/curvature.
    center_lat = (south + north) / 2.0
    cell_size_m = deg_per_px * 111_320.0 * math.cos(math.radians(center_lat))
    cell_size_m = float(max(cell_size_m, 1.0))

    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "width": dst_width,
        "height": dst_height,
        "count": 1,
        "crs": dst_crs,
        "transform": dst_transform,
        "nodata": -9999.0,
    }
    bounds = BoundingBox(west, south, east, north)

    valid = np.isfinite(destination)
    if valid.any():
        logger.info(
            f"🛰️  Real DEM acquired: {destination.shape} from {fetched}/{tile_count} "
            f"tiles @ z{zoom}, range "
            f"[{np.nanmin(destination):.0f}, {np.nanmax(destination):.0f}] m, "
            f"~{cell_size_m:.0f} m/px"
        )
    return TerrainTileResult(
        elevation=destination,
        profile=profile,
        transform=dst_transform,
        crs=dst_crs,
        bounds=bounds,
        cell_size_m=cell_size_m,
        zoom=zoom,
        tile_count=fetched,
    )
