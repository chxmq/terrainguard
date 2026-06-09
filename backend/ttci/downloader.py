"""
DEM Downloader — Fetches SRTM 30m / Copernicus GLO-30 elevation data.

Uses the OpenTopography REST API to download GeoTIFF DEM tiles
for a given bounding box.
"""

import logging
import os
import requests
import rasterio
from rasterio.io import MemoryFile
from rasterio.errors import RasterioIOError
from pathlib import Path
from dataclasses import dataclass
from typing import Any, Sequence
import numpy as np

logger = logging.getLogger(__name__)

# OpenTopography API endpoint
OPENTOPO_API_URL = "https://portal.opentopography.org/API/globaldem"

# Maximum time, in seconds, allowed for a single DEM retrieval before the
# request is abandoned and reported as a failure (Requirements 1.1, 1.6).
DOWNLOAD_TIMEOUT_SECONDS = 300

# Source registry: maps a supported logical DEM source to its OpenTopography
# ``demtype`` code. These three entries are the only supported sources, and this
# registry is the single source of truth used by ``validate_dem_type`` so that
# the supported-source error stays consistent with what can actually be fetched.
DEM_TYPES = {
    "srtm30": "SRTMGL1",        # SRTM 30 m (1 arc-second)
    "copernicus30": "COP30",    # Copernicus GLO-30
    "opentopo": "SRTMGL1",      # OpenTopography multi-source (SRTMGL1 default)
}

# WGS84 coordinate bounds, in degrees.
MIN_LATITUDE, MAX_LATITUDE = -90.0, 90.0
MIN_LONGITUDE, MAX_LONGITUDE = -180.0, 180.0

DATA_DIR = Path(__file__).parent.parent / "data"

# Filename of the cached synthetic demonstration DEM. Centralized here so the
# generator that writes it and the orchestrator that references it agree on a
# single location (see ``generate_synthetic_dem`` and ``acquire_dem``).
SYNTHETIC_DEM_FILENAME = "synthetic_ladakh_dem.tif"


def ensure_data_dir():
    """Create data directory if it doesn't exist."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def validate_dem_type(dem_type: str) -> str:
    """
    Resolve a logical DEM source to its OpenTopography ``demtype`` code.

    Args:
        dem_type: A supported logical source — ``'srtm30'``, ``'copernicus30'``,
            or ``'opentopo'``.

    Returns:
        The OpenTopography ``demtype`` string for the requested source.

    Raises:
        ValueError: If ``dem_type`` is not one of the supported sources. The
            message enumerates the supported sources.
    """
    try:
        return DEM_TYPES[dem_type]
    except KeyError:
        supported = ", ".join(sorted(DEM_TYPES))
        raise ValueError(
            f"Unsupported DEM source: {dem_type!r}. "
            f"Supported sources are: {supported}."
        ) from None


def validate_bbox(south: float, north: float, west: float, east: float) -> None:
    """
    Validate a WGS84 bounding box, raising ``ValueError`` if it is malformed.

    A bounding box is well formed when north is strictly greater than south,
    east is strictly greater than west, both latitudes lie within
    [-90, 90] degrees, and both longitudes lie within [-180, 180] degrees.

    Args:
        south: Southern latitude bound, in degrees.
        north: Northern latitude bound, in degrees.
        west: Western longitude bound, in degrees.
        east: Eastern longitude bound, in degrees.

    Raises:
        ValueError: If any coordinate falls outside its valid range or the box
            is degenerate (``north <= south`` or ``east <= west``). The message
            identifies the offending value.
    """
    for name, latitude in (("south", south), ("north", north)):
        if not MIN_LATITUDE <= latitude <= MAX_LATITUDE:
            raise ValueError(
                f"Invalid bounding box: {name} latitude {latitude} is outside "
                f"the valid range [{MIN_LATITUDE}, {MAX_LATITUDE}] degrees."
            )

    for name, longitude in (("west", west), ("east", east)):
        if not MIN_LONGITUDE <= longitude <= MAX_LONGITUDE:
            raise ValueError(
                f"Invalid bounding box: {name} longitude {longitude} is outside "
                f"the valid range [{MIN_LONGITUDE}, {MAX_LONGITUDE}] degrees."
            )

    if north <= south:
        raise ValueError(
            f"Invalid bounding box: north ({north}) must be greater than "
            f"south ({south})."
        )

    if east <= west:
        raise ValueError(
            f"Invalid bounding box: east ({east}) must be greater than "
            f"west ({west})."
        )


def get_dem_filename(south: float, north: float, west: float, east: float, 
                     dem_type: str = "srtm30") -> str:
    """Generate a consistent filename for a DEM tile."""
    return f"dem_{dem_type}_{south}_{north}_{west}_{east}.tif"


def download_dem(south: float, north: float, west: float, east: float,
                 dem_type: str = "srtm30", api_key: str = None,
                 force_redownload: bool = False) -> str:
    """
    Download DEM data from OpenTopography for the given bounding box.

    The download is fail-closed: a non-success response, a timeout, a transport
    error, or content that cannot be opened as a valid raster all raise a
    descriptive :class:`RuntimeError` and leave no DEM file on disk. Retrieved
    content is validated in memory and only persisted once confirmed to be a
    readable raster, so the on-disk cache never contains a partial or invalid
    tile.

    Args:
        south, north, west, east: Bounding box coordinates (WGS84), in degrees.
        dem_type: A supported logical source — ``'srtm30'``, ``'copernicus30'``,
            or ``'opentopo'``.
        api_key: OpenTopography access key. When provided it is forwarded to the
            API as the ``API_Key`` request parameter.
        force_redownload: If ``True``, re-download even when a cached tile exists.

    Returns:
        Path to the downloaded (or cached) GeoTIFF file.

    Raises:
        ValueError: If ``dem_type`` is unsupported or the bounding box is
            malformed.
        RuntimeError: If retrieval returns a non-200 response, exceeds the
            300-second timeout, fails at the transport layer, or returns content
            that cannot be opened as a valid DEM raster.
    """
    ensure_data_dir()

    # Reject unsupported sources and malformed bounding boxes up front, before
    # any cache lookup or network access.
    demtype = validate_dem_type(dem_type)
    validate_bbox(south, north, west, east)

    filename = get_dem_filename(south, north, west, east, dem_type)
    filepath = DATA_DIR / filename

    # Reuse the cached tile when present. The filename is a pure function of the
    # bounding box and source (see ``get_dem_filename``), so cache reuse is fully
    # deterministic for a given request (Requirement 1.4).
    if filepath.exists() and not force_redownload:
        logger.info(f"Using cached DEM: {filepath}")
        return str(filepath)

    logger.info(f"Downloading {dem_type} DEM for bbox: [{south}, {north}, {west}, {east}]...")

    params = {
        "demtype": demtype,
        "south": south,
        "north": north,
        "west": west,
        "east": east,
        "outputFormat": "GTiff",
    }

    # Forward the configured access key when one is supplied (Requirement 1.7).
    if api_key:
        params["API_Key"] = api_key

    # Enforce the retrieval timeout and convert every transport failure into a
    # descriptive RuntimeError so no partial result escapes (Requirement 1.6).
    try:
        response = requests.get(
            OPENTOPO_API_URL, params=params, timeout=DOWNLOAD_TIMEOUT_SECONDS
        )
    except requests.Timeout as exc:
        raise RuntimeError(
            f"DEM retrieval for source {dem_type!r} timed out after "
            f"{DOWNLOAD_TIMEOUT_SECONDS} seconds."
        ) from exc
    except requests.RequestException as exc:
        raise RuntimeError(
            f"DEM retrieval for source {dem_type!r} failed: {exc}"
        ) from exc

    if response.status_code != 200:
        raise RuntimeError(
            f"DEM retrieval for source {dem_type!r} returned HTTP "
            f"{response.status_code}: {response.text[:500]}"
        )

    # Confirm the payload is a genuine raster before writing anything to disk,
    # so an error page or truncated download never becomes a cached tile.
    _verify_dem_raster(response.content, dem_type)

    # Persist atomically so an interrupted write cannot leave a partial tile at
    # the cache path.
    _write_dem_atomic(filepath, response.content)

    logger.info(f"DEM saved: {filepath} ({len(response.content) / 1024 / 1024:.1f} MB)")
    return str(filepath)


def _verify_dem_raster(content: bytes, dem_type: str) -> None:
    """
    Validate that raw response bytes open as a readable raster.

    The bytes are opened in memory (no temporary file is written) and must
    expose at least one band over a non-empty grid. Any failure to parse the
    content as a raster is reported as a descriptive ``RuntimeError``.

    Args:
        content: The raw bytes returned by the DEM source.
        dem_type: The logical source name, used only for error messages.

    Raises:
        RuntimeError: If ``content`` cannot be opened as a valid DEM raster.
    """
    try:
        with MemoryFile(content) as memfile:
            with memfile.open() as dataset:
                if dataset.count < 1 or dataset.width < 1 or dataset.height < 1:
                    raise RuntimeError(
                        f"DEM retrieval for source {dem_type!r} returned a raster "
                        f"with no readable elevation data "
                        f"(bands={dataset.count}, size={dataset.width}x{dataset.height})."
                    )
    except RuntimeError:
        raise
    except RasterioIOError as exc:
        raise RuntimeError(
            f"DEM retrieval for source {dem_type!r} returned content that could "
            f"not be opened as a valid raster: {exc}"
        ) from exc
    except Exception as exc:
        # Any other parsing/GDAL failure on the in-memory dataset is treated as
        # an invalid raster rather than propagating an opaque low-level error.
        raise RuntimeError(
            f"DEM retrieval for source {dem_type!r} returned content that could "
            f"not be processed as a valid raster: {exc}"
        ) from exc


def _write_dem_atomic(filepath: Path, content: bytes) -> None:
    """
    Write ``content`` to ``filepath`` atomically via a temporary sibling file.

    The bytes are written to a ``.part`` file and then moved into place with
    :func:`os.replace`, which is atomic on a single filesystem. If the write or
    move fails, the temporary file is removed so no partial artifact remains.

    Args:
        filepath: Destination path for the DEM tile.
        content: The validated raster bytes to persist.

    Raises:
        OSError: If the file cannot be written or moved into place.
    """
    tmp_path = filepath.with_name(filepath.name + ".part")
    try:
        tmp_path.write_bytes(content)
        os.replace(tmp_path, filepath)
    except OSError:
        tmp_path.unlink(missing_ok=True)
        raise


def load_dem(filepath: str) -> tuple:
    """
    Load a DEM GeoTIFF and return its elevation grid plus geospatial metadata.

    The first raster band is read as ``float32`` elevation in meters. No-data
    cells are mapped to ``NaN`` so they are naturally excluded from every
    downstream computation (Requirements 1.3, 2.6). No-data detection is
    robust: it honors the no-data value recorded in the raster profile and also
    falls back to the value the dataset itself declares via ``src.nodata`` when
    the profile does not record one. A no-data value that is already ``NaN``
    needs no remapping, since such cells are read as ``NaN`` directly.

    Args:
        filepath: Path to a GeoTIFF DEM. Supported sources serve elevation in
            the WGS84 geographic coordinate system (EPSG:4326).

    Returns:
        A tuple ``(elevation, profile, transform, crs, bounds)`` where:
          * ``elevation`` is a ``float32`` ndarray in meters with ``NaN`` no-data,
          * ``profile`` is the rasterio profile dict for the source raster,
          * ``transform`` is the affine transform mapping ``(row, col)`` to
            ``(lon, lat)``,
          * ``crs`` is the coordinate reference system (EPSG:4326 for the
            supported sources),
          * ``bounds`` is the geographic bounding box of the raster.
    """
    with rasterio.open(filepath) as src:
        elevation = src.read(1).astype(np.float32)
        profile = src.profile.copy()
        transform = src.transform
        crs = src.crs
        bounds = src.bounds
        # The dataset may declare a no-data value even when it is absent from the
        # copied profile, so capture both and reconcile them below.
        src_nodata = src.nodata

    # Prefer the profile's no-data value; fall back to the dataset-declared one.
    nodata = profile.get("nodata")
    if nodata is None:
        nodata = src_nodata

    # Map finite no-data sentinels to NaN. A NaN sentinel requires no work: those
    # cells are already read as NaN. Cast to float so the comparison is exact.
    if nodata is not None and not np.isnan(nodata):
        elevation[elevation == np.float32(nodata)] = np.nan

    # Report the valid-data range without choking on an all-no-data raster.
    if np.any(np.isfinite(elevation)):
        logger.info(f"DEM loaded: {elevation.shape}, range: "
                    f"[{np.nanmin(elevation):.0f}, {np.nanmax(elevation):.0f}] m")
    else:
        logger.info(f"DEM loaded: {elevation.shape}, no valid elevation cells "
                    f"(all no-data)")

    return elevation, profile, transform, crs, bounds


def generate_synthetic_dem(rows: int = 500, cols: int = 500, 
                           seed: int = 42) -> tuple:
    """
    Generate a synthetic DEM for testing/demo when no API key is available.
    Creates a realistic-looking mountainous terrain using multiple sine waves + noise.
    
    Returns:
        (elevation_array, profile, transform, crs, bounds)
    """
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.crs import CRS
    
    np.random.seed(seed)
    
    # Simulate Ladakh region bounding box
    south, north = 33.8, 34.5
    west, east = 76.8, 77.8
    
    y = np.linspace(0, 1, rows)
    x = np.linspace(0, 1, cols)
    X, Y = np.meshgrid(x, y)
    
    # Base elevation (high plateau ~3500m)
    base = 3500
    
    # Large mountain ranges
    mountains = (
        800 * np.sin(2 * np.pi * X * 2.5) * np.cos(2 * np.pi * Y * 1.8) +
        600 * np.sin(2 * np.pi * X * 1.2 + 0.5) * np.sin(2 * np.pi * Y * 3.1) +
        400 * np.cos(2 * np.pi * (X + Y) * 2.0)
    )
    
    # Medium ridges
    ridges = (
        200 * np.sin(2 * np.pi * X * 6) * np.cos(2 * np.pi * Y * 5) +
        150 * np.sin(2 * np.pi * X * 8 + 1.0) * np.sin(2 * np.pi * Y * 7)
    )
    
    # Fine texture / noise
    noise = 80 * np.random.randn(rows, cols)
    
    # Deep valley (simulating Indus river valley)
    valley_center_y = 0.45
    valley = -600 * np.exp(-((Y - valley_center_y) ** 2) / (2 * 0.02 ** 2))
    
    elevation = base + mountains + ridges + noise + valley
    elevation = np.clip(elevation, 2800, 6500).astype(np.float32)
    
    # Smooth slightly to make it more realistic
    from scipy.ndimage import gaussian_filter
    elevation = gaussian_filter(elevation, sigma=1.5)
    
    transform = from_bounds(west, south, east, north, cols, rows)
    crs = CRS.from_epsg(4326)
    
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "width": cols,
        "height": rows,
        "count": 1,
        "crs": crs,
        "transform": transform,
        "nodata": -9999.0,
    }
    
    bounds = rasterio.coords.BoundingBox(west, south, east, north)
    
    # Save to disk for reuse
    ensure_data_dir()
    filepath = DATA_DIR / SYNTHETIC_DEM_FILENAME
    with rasterio.open(filepath, "w", **profile) as dst:
        dst.write(elevation, 1)
    
    logger.info(f"Synthetic DEM generated: {elevation.shape}, "
                f"range: [{elevation.min():.0f}, {elevation.max():.0f}] m")
    
    return elevation, profile, transform, crs, bounds


@dataclass
class DemResult:
    """
    Outcome of a DEM acquisition: a loaded elevation grid with its metadata.

    A ``DemResult`` carries everything a downstream consumer needs to run the
    TTCI pipeline over the acquired terrain, plus an ``is_synthetic`` flag that
    distinguishes real downloaded elevation data from the synthetic
    demonstration DEM produced when no access key is configured (Requirement
    1.8). The flag is intended to be propagated through the pipeline results and
    surfaced to clients so demonstration data can be labeled.

    Attributes:
        elevation: ``float32`` elevation grid in meters; no-data cells are
            ``NaN`` (EPSG:4326).
        profile: rasterio profile dict for the backing raster.
        transform: affine transform mapping ``(row, col)`` to ``(lon, lat)``.
        crs: coordinate reference system (EPSG:4326 for supported sources).
        bounds: geographic bounding box of the raster.
        dem_path: path to the GeoTIFF backing this result.
        dem_type: the logical DEM source that was requested.
        is_synthetic: ``True`` when ``elevation`` is synthetic demonstration
            terrain generated because no access key was available.
        cell_size_m: representative ground resolution in metres for the
            slope/curvature math. ``None`` falls back to the pipeline default.
    """

    elevation: np.ndarray
    profile: dict
    transform: Any
    crs: Any
    bounds: Any
    dem_path: str
    dem_type: str
    is_synthetic: bool
    cell_size_m: float = None


def _unpack_bbox(bbox: Sequence[float]) -> tuple:
    """
    Unpack and coerce a bounding box into ``(south, north, west, east)`` floats.

    Args:
        bbox: A four-element sequence of ``(south, north, west, east)``
            coordinates in degrees.

    Returns:
        The four coordinates as a tuple of floats.

    Raises:
        ValueError: If ``bbox`` is not a four-element sequence of numbers.
    """
    try:
        south, north, west, east = bbox
        return float(south), float(north), float(west), float(east)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            "Invalid bounding box: expected a (south, north, west, east) "
            f"sequence of four numeric coordinates, got {bbox!r}."
        ) from exc


def acquire_dem(bbox: Sequence[float], dem_type: str = "srtm30",
                api_key: str = None, zoom: int = 11,
                source: str = "auto",
                allow_synthetic_fallback: bool = True) -> DemResult:
    """
    Acquire a real DEM for ``bbox`` from a selectable open-source provider.

    Terrain Guard ingests all three open-source DEM families named in the problem
    statement, chosen via ``source``:

    * ``"opentopo"`` — the **OpenTopography multi-source API** (dataset #3). Serves
      SRTM 30 m (``dem_type='srtm30'``/``'opentopo'``) and Copernicus GLO-30
      (``dem_type='copernicus30'``). Requires a free OpenTopography ``api_key``;
      reuses a cached tile when present and fails closed on a bad response.
    * ``"copernicus"`` — the **ESA Copernicus GLO-30 DEM** (dataset #2), read
      directly (no key) from ESA's public AWS COG mirror via
      :func:`ttci.copernicus.download_copernicus_dem`.
    * ``"tiles"`` — **AWS Terrain Tiles** (no key), an SRTM/USGS-derived global
      mosaic (covers the SRTM 30 m data of dataset #1) via
      :func:`ttci.terrain_tiles.download_terrain_dem`. The fast default for a
      key-free live demo.
    * ``"auto"`` (default) — ``opentopo`` when an ``api_key`` is available,
      otherwise ``tiles``.

    On any acquisition failure a labelled synthetic DEM is returned when
    ``allow_synthetic_fallback`` is set (Requirement 1.8), otherwise the error
    propagates.

    Args:
        bbox: ``(south, north, west, east)`` in degrees (WGS84).
        dem_type: OpenTopography logical source — ``'srtm30'``, ``'copernicus30'``,
            or ``'opentopo'`` (used only when ``source`` resolves to OpenTopography).
        api_key: OpenTopography access key.
        zoom: XYZ zoom for the terrain-tiles path.
        source: ``'auto'`` | ``'opentopo'`` | ``'copernicus'`` | ``'tiles'``.
        allow_synthetic_fallback: Permit the synthetic fallback on failure.

    Returns:
        A :class:`DemResult` with the elevation grid, geospatial metadata, the
        resolved ``dem_type``, the ``is_synthetic`` flag, and a representative
        ``cell_size_m``.

    Raises:
        ValueError: unsupported ``dem_type``/``source`` or malformed bbox.
        RuntimeError: acquisition failed and the synthetic fallback is disabled.
    """
    south, north, west, east = _unpack_bbox(bbox)
    validate_dem_type(dem_type)
    validate_bbox(south, north, west, east)

    resolved = source
    if resolved == "auto":
        resolved = "opentopo" if api_key else "tiles"
    if resolved not in ("opentopo", "copernicus", "tiles"):
        raise ValueError(
            f"Unsupported DEM source {source!r}. "
            f"Choose 'auto', 'opentopo', 'copernicus', or 'tiles'."
        )

    try:
        if resolved == "opentopo":
            if not api_key:
                raise RuntimeError(
                    "OpenTopography source requires an API key (set OPENTOPO_API_KEY)."
                )
            dem_path = download_dem(
                south, north, west, east, dem_type=dem_type, api_key=api_key
            )
            elevation, profile, transform, crs, bounds = load_dem(dem_path)
            return DemResult(
                elevation=elevation, profile=profile, transform=transform,
                crs=crs, bounds=bounds, dem_path=dem_path, dem_type=dem_type,
                is_synthetic=False,
            )

        if resolved == "copernicus":
            from .copernicus import download_copernicus_dem

            cop = download_copernicus_dem((south, north, west, east))
            dem_path = str(DATA_DIR / f"copernicus_glo30_{south}_{north}_{west}_{east}.tif")
            return DemResult(
                elevation=cop.elevation, profile=cop.profile,
                transform=cop.transform, crs=cop.crs, bounds=cop.bounds,
                dem_path=dem_path, dem_type="copernicus30", is_synthetic=False,
                cell_size_m=cop.cell_size_m,
            )

        # resolved == "tiles"
        from .terrain_tiles import download_terrain_dem

        tile = download_terrain_dem((south, north, west, east), zoom=zoom)
        dem_path = str(DATA_DIR / f"terrain_dem_z{zoom}_{south}_{north}_{west}_{east}.tif")
        return DemResult(
            elevation=tile.elevation, profile=tile.profile,
            transform=tile.transform, crs=tile.crs, bounds=tile.bounds,
            dem_path=dem_path, dem_type="srtm30", is_synthetic=False,
            cell_size_m=tile.cell_size_m,
        )
    except Exception as exc:
        if not allow_synthetic_fallback:
            raise
        logger.warning(f"Real DEM acquisition via {resolved!r} failed ({exc}); "
                       f"falling back to synthetic demonstration DEM.")

    # Last resort: labelled synthetic demo terrain.
    elevation, profile, transform, crs, bounds = generate_synthetic_dem()
    dem_path = str(DATA_DIR / SYNTHETIC_DEM_FILENAME)
    return DemResult(
        elevation=elevation, profile=profile, transform=transform,
        crs=crs, bounds=bounds, dem_path=dem_path, dem_type=dem_type,
        is_synthetic=True,
    )
