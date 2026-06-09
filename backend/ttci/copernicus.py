"""
Copernicus GLO-30 DEM acquisition from ESA's public AWS open-data mirror.

This is dataset #2 from the problem statement — the ESA Copernicus GLO-30 DEM —
used directly and by name, with **no API key**. ESA publishes GLO-30 as
Cloud-Optimized GeoTIFF (COG) tiles in the public ``copernicus-dem-30m`` AWS
Open Data bucket, one 1°×1° tile per file in WGS84 (EPSG:4326) at 1 arc-second
(~30 m) resolution. Because the tiles are COGs and the bucket allows anonymous
HTTP range requests, GDAL/rasterio can read just the window covering a region
without downloading whole tiles.

This gives Terrain Guard a second real, key-free elevation source alongside the
AWS Terrain Tiles, and a faithful path to the exact GLO-30 product ESA ships.

Reference: https://registry.opendata.aws/copernicus-dem/
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Tuple

import numpy as np
import rasterio
from rasterio.coords import BoundingBox
from rasterio.crs import CRS
from rasterio.merge import merge
from rasterio.transform import from_bounds

# Public, anonymous Copernicus GLO-30 COG bucket (HTTPS, range-request capable).
_COP_BASE = "https://copernicus-dem-30m.s3.amazonaws.com"

# GLO-30 native posting: 1 arc-second.
_ARCSEC_DEG = 1.0 / 3600.0

# Bound the number of 1°×1° tiles a single request may touch.
_MAX_TILES = 25

# GDAL options that make anonymous COG-over-HTTP reads fast and reliable.
_GDAL_ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
    GDAL_HTTP_MULTIRANGE="YES",
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES",
    VSI_CACHE="TRUE",
)


@dataclass
class CopernicusResult:
    """A real Copernicus GLO-30 DEM for a bbox, with geospatial metadata."""

    elevation: np.ndarray      # float32, metres, NaN for no-data
    profile: dict
    transform: object
    crs: object
    bounds: BoundingBox
    cell_size_m: float


def _tile_name(lat_sw: int, lon_sw: int) -> str:
    """Copernicus COG tile name for an integer SW corner (e.g. N34_00_E077_00)."""
    ns = "N" if lat_sw >= 0 else "S"
    ew = "E" if lon_sw >= 0 else "W"
    return (f"Copernicus_DSM_COG_10_{ns}{abs(lat_sw):02d}_00_"
            f"{ew}{abs(lon_sw):03d}_00_DEM")


def _tile_url(lat_sw: int, lon_sw: int) -> str:
    name = _tile_name(lat_sw, lon_sw)
    return f"/vsicurl/{_COP_BASE}/{name}/{name}.tif"


def _tiles_for_bbox(south, north, west, east) -> List[Tuple[int, int]]:
    """Integer (lat_sw, lon_sw) corners of the 1°×1° tiles covering a bbox."""
    lat0, lat1 = math.floor(south), math.floor(north - 1e-9)
    lon0, lon1 = math.floor(west), math.floor(east - 1e-9)
    return [(la, lo)
            for la in range(lat0, lat1 + 1)
            for lo in range(lon0, lon1 + 1)]


def download_copernicus_dem(bbox: Tuple[float, float, float, float]) -> CopernicusResult:
    """Acquire a real Copernicus GLO-30 DEM for ``bbox`` (south, north, west, east).

    Reads only the windows of the public COG tiles intersecting the bbox and
    mosaics them to a single EPSG:4326 grid at ~30 m. Missing tiles (e.g. open
    ocean) are simply skipped; no-data is preserved as NaN.

    Raises:
        ValueError: degenerate bbox or too many tiles.
        RuntimeError: no Copernicus tile could be read for the region.
    """
    south, north, west, east = (float(v) for v in bbox)
    if north <= south or east <= west:
        raise ValueError(
            f"Invalid bbox (south,north,west,east)={bbox!r}: need north>south, east>west."
        )

    corners = _tiles_for_bbox(south, north, west, east)
    if len(corners) > _MAX_TILES:
        raise ValueError(
            f"Region spans {len(corners)} Copernicus tiles (max {_MAX_TILES}). "
            f"Use a smaller bbox."
        )

    with rasterio.Env(**_GDAL_ENV):
        datasets = []
        for lat_sw, lon_sw in corners:
            try:
                datasets.append(rasterio.open(_tile_url(lat_sw, lon_sw)))
            except Exception:
                continue  # tile absent (e.g. ocean) — skip it
        if not datasets:
            raise RuntimeError(
                "No Copernicus GLO-30 tiles were available for the requested region."
            )
        try:
            mosaic, out_transform = merge(
                datasets, bounds=(west, south, east, north),
                res=(_ARCSEC_DEG, _ARCSEC_DEG), nodata=datasets[0].nodata,
            )
            src_nodata = datasets[0].nodata
        finally:
            for ds in datasets:
                ds.close()

    elevation = mosaic[0].astype(np.float32)
    if src_nodata is not None and not (isinstance(src_nodata, float) and math.isnan(src_nodata)):
        elevation[elevation == np.float32(src_nodata)] = np.nan

    height, width = elevation.shape
    center_lat = (south + north) / 2.0
    cell_size_m = float(max(_ARCSEC_DEG * 111_320.0 * math.cos(math.radians(center_lat)), 1.0))
    bounds = BoundingBox(west, south, east, north)
    profile = {
        "driver": "GTiff", "dtype": "float32", "width": width, "height": height,
        "count": 1, "crs": CRS.from_epsg(4326), "transform": out_transform,
        "nodata": -9999.0,
    }

    valid = np.isfinite(elevation)
    if valid.any():
        print(
            f"Copernicus GLO-30 DEM: {elevation.shape} from {len(corners)} tile(s), "
            f"range [{np.nanmin(elevation):.0f}, {np.nanmax(elevation):.0f}] m, ~{cell_size_m:.0f} m/px"
        )
    return CopernicusResult(
        elevation=elevation, profile=profile, transform=out_transform,
        crs=CRS.from_epsg(4326), bounds=bounds, cell_size_m=cell_size_m,
    )
