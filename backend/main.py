"""
Terrain Guard — FastAPI Backend

Serves TTCI computation, tile overlays, and MSA calculations.
"""

import asyncio
import logging
import math
import os
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ttci.pipeline import run_pipeline, classify_risk, RISK_LEVELS, compute_region
from ttci.tiler import generate_overlay_bytes, generate_overlay_png, generate_metadata_json
from ttci.msa import (
    compute_msa_for_route,
    get_elevation_profile,
    get_sector_buffer_mask,
    BUFFER_NM,
    NM_TO_KM,
)
from ttci.geo import coord_to_cell, validate_coordinate
from ttci.taws import look_ahead_taws

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("terrain_guard")

DATA_DIR = Path(__file__).parent / "data"
OVERLAY_PNG_PATH = DATA_DIR / "ttci_overlay.png"
METADATA_JSON_PATH = DATA_DIR / "ttci_metadata.json"
VALIDATION_REPORT_PATH = DATA_DIR / "validation_report.json"
GLOBAL_VALIDATION_REPORT_PATH = DATA_DIR / "validation_report_global.json"

# --- Demo region configuration --------------------------------------------
#
# The startup precompute runs over a real DEM by default (AWS Terrain Tiles, no
# API key required), so the live demo shows genuine terrain rather than the
# synthetic fallback. Every parameter is overridable from the environment so the
# region can be retargeted without code changes:
#
#   TTCI_BBOX   = "south,north,west,east"  (WGS84 degrees)
#   TTCI_ZOOM   = XYZ zoom for terrain tiles (11 ≈ 76 m/px, 12 ≈ 38 m/px)
#   TTCI_SYNTHETIC = "1" forces the synthetic demonstration DEM
#   OPENTOPO_API_KEY = use OpenTopography instead of terrain tiles when set
#
# The default region is the Ladakh Himalaya around Leh (VILH) — extreme,
# CFIT-relevant terrain served by real flights.
DEFAULT_DEMO_BBOX = (33.8, 34.5, 76.8, 77.8)


def _demo_bbox() -> tuple:
    """Resolve the demo bounding box from ``TTCI_BBOX`` or the default."""
    raw = os.environ.get("TTCI_BBOX")
    if not raw:
        return DEFAULT_DEMO_BBOX
    try:
        south, north, west, east = (float(v) for v in raw.split(","))
        return (south, north, west, east)
    except ValueError:
        logger.warning("Invalid TTCI_BBOX=%r; using default region.", raw)
        return DEFAULT_DEMO_BBOX


def _demo_zoom() -> int:
    """Resolve the terrain-tile zoom from ``TTCI_ZOOM`` or the default (11)."""
    try:
        return int(os.environ.get("TTCI_ZOOM", "11"))
    except ValueError:
        return 11


def _demo_source() -> str:
    """Resolve the DEM source from ``TTCI_SOURCE`` or ``'auto'``.

    ``auto`` uses OpenTopography when an API key is set, else AWS Terrain Tiles.
    Explicit values: ``opentopo`` (#3, key), ``copernicus`` (#2, ESA GLO-30,
    no key), ``tiles`` (SRTM-derived, no key).
    """
    return os.environ.get("TTCI_SOURCE", "auto").strip() or "auto"

# In-memory service state, populated once at startup and reused by every read
# path. ``ready`` flips to True only after the TTCI surface and its rendered
# artifacts are fully available, so a partial startup failure leaves the service
# in a not-ready state (Requirements 6.1, 6.6).
_state: Dict[str, Any] = {
    "results": None,
    "ready": False,
    "zoom": None,
    "source": None,
    "overlay_png_bytes": None,
}


def _cache_overlay_png(results: Dict[str, Any]) -> None:
    """Cache banded overlay bytes so GET /api/ttci/overlay.png avoids re-rendering."""
    _state["overlay_png_bytes"] = generate_overlay_bytes(results["ttci"])

_VALID_REGION_SOURCES = frozenset({"tiles", "copernicus", "opentopo"})

# Single, descriptive message used by every readiness guard so that all TTCI data
# endpoints fail closed with an identical, recognizable 503 response.
_NOT_READY_DETAIL = "TTCI surface is not yet ready; the service is still initializing."


def _normalize_region_source(source: Optional[str]) -> str:
    """Validate and normalize a DEM source id for on-demand region requests."""
    s = (source or "tiles").strip().lower()
    if s not in _VALID_REGION_SOURCES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid source {source!r}. Must be one of: tiles, copernicus, opentopo.",
        )
    return s


def _ttci_stats(ttci: np.ndarray) -> Dict[str, float]:
    """Summary stats over valid TTCI cells; safe when the array is all NaN."""
    valid = ttci[~np.isnan(ttci)]
    if valid.size == 0:
        return {"min": 0.0, "max": 0.0, "mean": 0.0, "std": 0.0}
    return {
        "min": float(np.min(valid)),
        "max": float(np.max(valid)),
        "mean": float(np.mean(valid)),
        "std": float(np.std(valid)),
    }


def _require_ready() -> None:
    """Guard a TTCI data endpoint on service readiness, failing closed with a 503.

    Every endpoint that serves data derived from the TTCI surface — overlay,
    metadata, point query, and MSA calculate/profile (and, later, the TAWS and UAS
    extensibility endpoints) — calls this before touching ``_state["results"]``.
    Until the startup precompute has completed successfully, the surface is
    unavailable, so the request is rejected immediately with a consistent
    ``503 Service Unavailable`` and a descriptive message rather than returning
    partial or misleading TTCI data (Requirements 6.5, 6.6).
    """
    if not _state["ready"]:
        raise HTTPException(status_code=503, detail=_NOT_READY_DETAIL)


# Upper bound on the number of waypoints accepted for a single route. The route
# drawing tool places "up to 50 waypoints" (Requirement 10.1); the MSA and
# profile endpoints enforce the same ceiling so an oversized route is rejected
# rather than driving an unbounded computation.
_MAX_WAYPOINTS = 50


def _validate_waypoints(waypoints: List[List[float]]) -> List[List[float]]:
    """Validate and normalize a route's waypoints, failing closed with a 400.

    Each waypoint must be a ``[lat, lon]`` pair whose coordinates are valid WGS84
    values — latitude within [-90, 90], longitude within [-180, 180], both finite
    numbers — and the route may contain at most :data:`_MAX_WAYPOINTS` (50)
    waypoints (Requirement 10.1). Coordinate validity is delegated to the shared
    :func:`ttci.geo.validate_coordinate` so the MSA and profile endpoints reject
    coordinates by exactly the same rule as the point query.

    Malformed input — a waypoint that is not a two-element pair, an out-of-range
    coordinate, or a non-numeric value — is rejected with a descriptive
    ``400 Bad Request`` that identifies the offending waypoint by index.

    A route with fewer than two waypoints is **not** an error: the calculators
    legitimately return an empty set of sectors / an empty profile for it
    (Requirements 9.6, 10.6). Validation still runs over whatever waypoints are
    present, so a single malformed waypoint is rejected, but an empty or
    single-point route of well-formed coordinates is accepted and flows through
    to an empty result.

    Args:
        waypoints: The raw ``[[lat, lon], ...]`` list from the request body.

    Returns:
        The validated waypoints as a list of ``[lat, lon]`` float pairs.

    Raises:
        HTTPException: ``400`` if the route exceeds the waypoint cap, or any
            waypoint is not a ``[lat, lon]`` pair, out of range, or non-numeric.
    """
    if len(waypoints) > _MAX_WAYPOINTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Route has too many waypoints: {len(waypoints)}; "
                f"the maximum is {_MAX_WAYPOINTS}."
            ),
        )

    validated: List[List[float]] = []
    for index, waypoint in enumerate(waypoints):
        if len(waypoint) != 2:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Waypoint {index} must be a [lat, lon] pair, "
                    f"got {len(waypoint)} value(s)."
                ),
            )
        try:
            lat, lon = validate_coordinate(waypoint[0], waypoint[1])
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Waypoint {index} is invalid: {exc}",
            )
        validated.append([lat, lon])
    return validated


def _precompute_ttci() -> None:
    """Compute the TTCI surface for the configured region and cache it in ``_state``.

    The surface is computed once, the overlay PNG and metadata JSON are pre-rendered
    to ``DATA_DIR``, and the results dict is held in process memory. The ``ready``
    flag is set last, only after every artifact has been produced successfully, so
    readiness truthfully reflects that the full TTCI surface is available
    (Requirement 6.1).

    On any failure the service is left in a not-ready state with the error logged;
    the exception is intentionally swallowed so the API can still start and report
    its not-ready status rather than crashing (Requirement 6.6).

    Preloading is **opt-in**. By default the service starts with no active region
    and waits for the user to select an area (``POST /api/region/activate``), so
    nothing is hard-coded to one place. Preload only happens when explicitly
    requested via ``TTCI_PRELOAD=1``, ``TTCI_BBOX``, or ``TTCI_SYNTHETIC``.
    """
    preload = (
        os.environ.get("TTCI_PRELOAD", "").strip() in ("1", "true", "True")
        or bool(os.environ.get("TTCI_BBOX"))
        or os.environ.get("TTCI_SYNTHETIC", "").strip() in ("1", "true", "True")
    )
    if not preload:
        logger.info("No preload configured — awaiting a user-selected area "
                    "(POST /api/region/activate).")
        _state["results"] = None
        _state["ready"] = False
        return

    logger.info("Preloading a TTCI surface (opt-in)...")
    try:
        force_synthetic = os.environ.get("TTCI_SYNTHETIC", "").strip() in ("1", "true", "True")
        if force_synthetic:
            logger.info("TTCI_SYNTHETIC set — using the synthetic demonstration DEM.")
            results = run_pipeline(use_synthetic=True)
        else:
            bbox = _demo_bbox()
            zoom = _demo_zoom()
            src = _demo_source()
            logger.info("Acquiring real DEM for bbox=%s at zoom %d (source=%s)...", bbox, zoom, src)
            results = run_pipeline(bbox=bbox, zoom=zoom, source=src)

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        generate_overlay_png(results["ttci"], str(OVERLAY_PNG_PATH))
        generate_metadata_json(results["bounds"], results["ttci"], str(METADATA_JSON_PATH))

        _state["results"] = results
        _state["ready"] = True
        _cache_overlay_png(results)
        if not force_synthetic:
            _state["zoom"] = zoom
            _state["source"] = src
        logger.info(
            "TTCI preload complete: shape=%s, synthetic=%s — service is ready.",
            results["ttci"].shape, results["is_synthetic"],
        )
    except Exception:
        # Fail closed: keep the service not-ready and surface the cause in logs.
        _state["results"] = None
        _state["ready"] = False
        _state["overlay_png_bytes"] = None
        logger.exception("TTCI precompute failed; service will remain not-ready.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """FastAPI lifespan handler: pre-compute the TTCI surface before serving traffic."""
    _precompute_ttci()
    yield


app = FastAPI(
    title="Terrain Guard API",
    version="1.0.0",
    description="TTCI Computation & Aviation Safety Tool",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- TAWS (Terrain Awareness and Warning System) demonstration heuristic ---
#
# The TAWS check (Requirements 11.2, 11.4) reports the terrain and TTCI under an
# aircraft and evaluates a simple terrain-proximity result. The proximity logic
# below is a deliberately simplified, clearly documented demonstration heuristic
# — it is NOT a certified TAWS/GPWS implementation and models none of the
# look-ahead, descent-rate, or flight-phase logic of a real system. It is keyed
# purely on vertical clearance above the terrain directly beneath the aircraft:
#
#     clearance_ft = altitude_ft - terrain_ft
#
# Clearance is then banded into three alert levels. The thresholds are inspired
# by the ICAO 1000 ft Minimum Obstacle Clearance used elsewhere in Terrain Guard:
#
#   * WARNING — clearance below 1000 ft (at or below terrain + the standard
#     obstacle-clearance margin): the aircraft is dangerously close to terrain.
#   * CAUTION — clearance below 2000 ft but at or above 1000 ft: terrain is
#     approaching the standard margin and warrants attention.
#   * CLEAR   — clearance at or above 2000 ft: comfortable terrain separation.
#
# ``alert`` is True for any non-CLEAR level so callers can branch on a single
# flag, while ``alert_level``/``alert_color`` give the graded result and a fixed
# display color consistent with the risk-level palette.
_TAWS_WARNING_CLEARANCE_FT = 1000.0
_TAWS_CAUTION_CLEARANCE_FT = 2000.0
_TAWS_ALERT_COLORS = {
    "WARNING": "#e74c3c",  # red
    "CAUTION": "#e67e22",  # orange
    "CLEAR": "#2ecc71",    # green
}

# Exact meters-per-foot factor used for every dual-unit conversion (Requirement
# 13.3), matching the point query and MSA calculator.
_METERS_PER_FOOT = 0.3048


# --- UAS corridor risk scorer ---
#
# The UAS corridor scorer (Requirements 11.3, 11.5) scores a planned unmanned
# flight corridor against the cached TTCI surface. A corridor is modelled as a
# polyline path of waypoints with a lateral buffer (the same representation used
# by the MSA calculator), which lets us reuse ttci.msa.get_sector_buffer_mask to
# select the corridor's cells rather than re-implementing any masking geometry.
#
# The requested buffer is expressed in nautical miles and converted to a degree
# half-width exactly as msa.py derives BUFFER_DEG (km / 111.0 km-per-degree), so
# a 5 NM corridor buffer here selects the same width as a 5 NM MSA sector buffer.
_KM_PER_DEGREE_LAT = 111.0  # Matches the approximation used in ttci.msa.

# Upper bound on the corridor buffer half-width. A buffer wider than this is far
# beyond any realistic UAS corridor and would simply mask the whole surface, so
# it is rejected rather than silently scoring the entire extent.
_MAX_CORRIDOR_BUFFER_NM = 100.0


def _corridor_buffer_deg(buffer_nm: float) -> float:
    """Convert a corridor buffer half-width in nautical miles to degrees.

    Mirrors :data:`ttci.msa.BUFFER_DEG` (``buffer_km / 111.0``) so a corridor
    buffer expressed in NM selects the same lateral width as the MSA sector
    buffer for the same NM value.
    """
    return buffer_nm * NM_TO_KM / _KM_PER_DEGREE_LAT


def _dominant_risk_level(valid_ttci: np.ndarray):
    """Return the most common risk level across a corridor's valid TTCI cells.

    Each valid cell is binned into one of the five :data:`RISK_LEVELS` bands using
    the same half-open boundaries as :func:`ttci.pipeline.classify_risk` (each band
    includes its lower bound and excludes its upper, except the final Critical band
    which is inclusive on both ends). The band holding the most cells wins; ties are
    broken toward the higher-risk band, which is the conservative choice for an
    aviation-safety assessment.

    Args:
        valid_ttci: 1-D array of TTCI values for the corridor's valid cells. Every
            value is assumed to lie within [0, 1] (guaranteed for valid cells).

    Returns:
        A ``(label, color)`` pair for the dominant risk level.
    """
    last = len(RISK_LEVELS) - 1
    best_count = -1
    best_label, best_color = RISK_LEVELS[0][2], RISK_LEVELS[0][3]
    for index, (lo, hi, label, color) in enumerate(RISK_LEVELS):
        if index == last:
            in_band = (valid_ttci >= lo) & (valid_ttci <= hi)
        else:
            in_band = (valid_ttci >= lo) & (valid_ttci < hi)
        count = int(np.count_nonzero(in_band))
        # ">=" breaks ties toward the later (higher-risk) band.
        if count >= best_count:
            best_count = count
            best_label, best_color = label, color
    return best_label, best_color


def _classify_taws_clearance(clearance_ft: float) -> Dict[str, Any]:
    """Band a vertical terrain clearance into the demonstration TAWS alert result.

    Implements the simplified proximity heuristic documented above: WARNING below
    1000 ft of clearance, CAUTION below 2000 ft, otherwise CLEAR. Returns the
    alert level, a boolean ``alert`` flag (True for any non-CLEAR level), and the
    level's fixed display color.
    """
    if clearance_ft < _TAWS_WARNING_CLEARANCE_FT:
        level = "WARNING"
    elif clearance_ft < _TAWS_CAUTION_CLEARANCE_FT:
        level = "CAUTION"
    else:
        level = "CLEAR"
    return {
        "alert": level != "CLEAR",
        "alert_level": level,
        "alert_color": _TAWS_ALERT_COLORS[level],
    }


# --- Pydantic Models ---

class BBoxRequest(BaseModel):
    south: float
    north: float
    west: float
    east: float
    dem_type: str = "srtm30"
    api_key: Optional[str] = None

class WaypointList(BaseModel):
    waypoints: List[List[float]]  # [[lat, lon], ...]

class PointQuery(BaseModel):
    lat: float
    lon: float


class TawsCheckRequest(BaseModel):
    """Aircraft position and altitude for a TAWS terrain-proximity check.

    ``lat``/``lon`` are WGS84 decimal degrees and ``altitude_ft`` is the
    aircraft's altitude above mean sea level in feet. The fields are typed as
    floats so the model rejects structurally non-numeric input at parse time;
    the handler additionally validates coordinate ranges and rejects a
    non-finite (NaN/infinite) altitude with a descriptive error (Requirement
    11.4).
    """
    lat: float
    lon: float
    altitude_ft: float


class CorridorRequest(BaseModel):
    """A UAS corridor geometry to score against the TTCI surface.

    A corridor is modelled as a polyline path of ``waypoints`` (``[lat, lon]``
    pairs in WGS84 decimal degrees) with a lateral ``buffer_nm`` half-width in
    nautical miles applied to each side of the path — the same polyline+buffer
    representation the MSA calculator uses, so the corridor's cells can be
    selected with the shared sector-buffer masking (Requirement 11.3).

    ``buffer_nm`` defaults to the 5 NM used elsewhere in the app. The handler
    validates the waypoints (a ``[lat, lon]`` path of at least two points, each a
    valid WGS84 coordinate, capped at the route waypoint limit) and that the
    buffer is a positive, finite width within the supported range.
    """
    waypoints: List[List[float]]  # [[lat, lon], ...]
    buffer_nm: float = float(BUFFER_NM)


class ActivateRegionRequest(BaseModel):
    """A user-selected area to compute TTCI for and make the active surface.

    ``south``/``north``/``west``/``east`` are WGS84 degrees. ``zoom`` is optional
    (auto-chosen from the area span when omitted). ``source`` picks the open
    dataset: ``tiles`` (SRTM via AWS Terrain Tiles, default), ``copernicus``
    (ESA GLO-30), or ``opentopo`` (needs an API key).
    """
    south: float
    north: float
    west: float
    east: float
    zoom: Optional[int] = None
    source: Optional[str] = "tiles"


class TawsLookaheadRequest(BaseModel):
    """Aircraft state for a predictive, TTCI-modulated terrain look-ahead.

    ``lat``/``lon`` are WGS84 degrees, ``altitude_ft`` is feet MSL,
    ``heading_deg`` is the ground track (0-360, true), ``ground_speed_kt`` is
    knots, and ``vertical_speed_fpm`` is feet/min (positive climbing). All are
    typed so the model rejects non-numeric input; the handler additionally
    validates ranges and finiteness.
    """
    lat: float
    lon: float
    altitude_ft: float
    heading_deg: float
    ground_speed_kt: float
    vertical_speed_fpm: float = 0.0


# --- Health & Info ---

@app.get("/api/health")
async def health():
    """Report service readiness (Requirement 6.2).

    ``ready`` is the boolean readiness flag indicating whether the TTCI surface
    is available; ``status`` mirrors it in human-readable form.
    """
    ready = _state["ready"]
    return {"status": "ok" if ready else "initializing", "ready": ready}


@app.get("/api/info")
async def info():
    """Return TTCI surface metadata for clients that have detected readiness.

    Provides the geographic bounds, the array shape, summary statistics computed
    over valid (non-no-data) cells only, the five risk-level definitions that
    contiguously span [0, 1] without gaps, and whether the surface was derived
    from synthetic demonstration data (Requirements 6.4, 1.8, 11.1).
    """
    if not _state["ready"]:
        return {"ready": False}

    r = _state["results"]
    bounds = r["bounds"]
    ttci = r["ttci"]

    return {
        "ready": True,
        "is_synthetic": bool(r["is_synthetic"]),
        "dem_type": r.get("dem_type", "unknown"),
        "source_label": r.get("source_label", "Unknown source"),
        "zoom": _state.get("zoom"),
        "source": _state.get("source"),
        "bounds": {
            "south": bounds.bottom,
            "north": bounds.top,
            "west": bounds.left,
            "east": bounds.right,
        },
        "shape": list(ttci.shape),
        "stats": _ttci_stats(ttci),
        "risk_levels": [
            {"min": lo, "max": hi, "label": label, "color": color}
            for lo, hi, label, color in RISK_LEVELS
        ],
    }


# --- TTCI Overlay ---

@app.get("/api/ttci/overlay.png")
async def ttci_overlay():
    """Serve the banded TTCI risk overlay as a PNG image (Requirements 6.3, 6.5).

    The overlay is rendered on demand from the in-memory TTCI surface, coloring each
    valid cell by its risk level and rendering no-data cells fully transparent. The
    response carries an ``image/png`` content type. Requests received before the
    surface is available are rejected with a 503 (see :func:`_require_ready`).
    """
    _require_ready()
    png_bytes = _state.get("overlay_png_bytes")
    if png_bytes is None:
        png_bytes = generate_overlay_bytes(_state["results"]["ttci"])
        _state["overlay_png_bytes"] = png_bytes
    return Response(content=png_bytes, media_type="image/png")


@app.get("/api/ttci/metadata")
async def ttci_metadata():
    """Return TTCI overlay metadata: geographic bounds, array shape, and stats.

    The metadata is computed from the in-memory TTCI surface so it stays consistent
    with ``/api/info`` and the pre-rendered overlay, rather than re-reading the
    persisted artifact on every request. Summary statistics are taken over valid
    (non-no-data) cells only (Requirements 6.4, 5.6). Requests received before the
    surface is available are rejected with a 503 (see :func:`_require_ready`).
    """
    _require_ready()

    r = _state["results"]
    bounds = r["bounds"]
    ttci = r["ttci"]

    return {
        "bounds": {
            "south": bounds.bottom,
            "north": bounds.top,
            "west": bounds.left,
            "east": bounds.right,
        },
        "shape": list(ttci.shape),
        "stats": _ttci_stats(ttci),
    }


# --- On-demand global TTCI regions ---
#
# The startup surface is one fixed region for an instant demo, but the pipeline
# is global: these endpoints compute TTCI for ANY bbox on demand (resolution
# scaled by ``zoom``) and cache the most recent regions in memory, so the map
# can show real terrain risk anywhere on Earth without precomputing the planet.

from collections import OrderedDict

_REGION_CACHE: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_REGION_CACHE_MAX = 16
_REGION_ZOOM_MIN, _REGION_ZOOM_MAX = 6, 13
# Largest area (degrees per side) accepted for on-demand assessment. Matches the
# span bucket used by :func:`_auto_zoom` (12° → zoom 8). Larger boxes are still
# capped by per-source tile limits inside the DEM acquirers.
_MAX_REGION_SPAN_DEG = 12.0


def _region_key(south, north, west, east, zoom, source) -> str:
    return f"{south:.3f},{north:.3f},{west:.3f},{east:.3f},z{zoom},{source}"


def _validate_region(south, north, west, east, zoom):
    """Validate/clamp a region request, failing closed with a 400."""
    try:
        south, north, west, east = float(south), float(north), float(west), float(east)
        zoom = int(zoom)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Region bbox/zoom must be numeric.")
    for nm, v in (("south", south), ("north", north)):
        if not -90.0 <= v <= 90.0:
            raise HTTPException(status_code=400, detail=f"{nm} latitude out of range.")
    for nm, v in (("west", west), ("east", east)):
        if not -180.0 <= v <= 180.0:
            raise HTTPException(status_code=400, detail=f"{nm} longitude out of range.")
    if north <= south or east <= west:
        raise HTTPException(status_code=400, detail="Need north>south and east>west.")
    if (north - south) > _MAX_REGION_SPAN_DEG or (east - west) > _MAX_REGION_SPAN_DEG:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Selected area is too large (max {_MAX_REGION_SPAN_DEG}° per side). "
                f"Zoom in and draw a smaller box."
            ),
        )
    zoom = max(_REGION_ZOOM_MIN, min(zoom, _REGION_ZOOM_MAX))
    return south, north, west, east, zoom


def _get_region(south, north, west, east, zoom, source="tiles") -> Dict[str, Any]:
    """Return a cached or freshly-computed TTCI region surface (in memory)."""
    key = _region_key(south, north, west, east, zoom, source)
    cached = _REGION_CACHE.get(key)
    if cached is not None:
        _REGION_CACHE.move_to_end(key)
        return cached
    source = _normalize_region_source(source)
    try:
        results = compute_region(
            (south, north, west, east), zoom=zoom, source=source,
            allow_synthetic_fallback=False,
        )
    except ValueError as exc:
        # Oversized region / too many tiles for this zoom.
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Region compute failed for %s", key)
        raise HTTPException(status_code=502, detail=f"Region computation failed: {exc}")
    _REGION_CACHE[key] = results
    _REGION_CACHE.move_to_end(key)
    while len(_REGION_CACHE) > _REGION_CACHE_MAX:
        _REGION_CACHE.popitem(last=False)
    return results


def _downsample(arr: np.ndarray, rows: int, cols: int, fill: float = 0.0) -> np.ndarray:
    """Nearest-neighbour downsample a 2-D array to rows×cols, filling NaN."""
    src_rows, src_cols = arr.shape
    ri = np.round(np.linspace(0, src_rows - 1, rows)).astype(int)
    ci = np.round(np.linspace(0, src_cols - 1, cols)).astype(int)
    out = arr[np.ix_(ri, ci)].astype(np.float64)
    nan = np.isnan(out)
    if nan.any():
        out[nan] = fill
    return out


@app.get("/api/region/overlay.png")
async def region_overlay(
    south: float = Query(...), north: float = Query(...),
    west: float = Query(...), east: float = Query(...),
    zoom: int = Query(11), source: str = Query("tiles"),
):
    """Compute and serve the banded TTCI overlay PNG for an arbitrary region.

    The map calls this as the user navigates: any land bbox on Earth yields a
    real TTCI surface at a resolution set by ``zoom``. Results are cached so
    repeat views are instant.
    """
    south, north, west, east, zoom = _validate_region(south, north, west, east, zoom)
    source = _normalize_region_source(source)
    results = await asyncio.to_thread(_get_region, south, north, west, east, zoom, source)
    png_bytes = generate_overlay_bytes(results["ttci"])
    return Response(content=png_bytes, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/region/info")
async def region_info(
    south: float = Query(...), north: float = Query(...),
    west: float = Query(...), east: float = Query(...),
    zoom: int = Query(11), source: str = Query("tiles"),
):
    """Bounds, shape, stats, and source provenance for an on-demand region."""
    south, north, west, east, zoom = _validate_region(south, north, west, east, zoom)
    source = _normalize_region_source(source)
    r = await asyncio.to_thread(_get_region, south, north, west, east, zoom, source)
    ttci = r["ttci"]
    b = r["bounds"]
    return {
        "bounds": {"south": b.bottom, "north": b.top, "west": b.left, "east": b.right},
        "shape": list(ttci.shape),
        "is_synthetic": bool(r["is_synthetic"]),
        "dem_type": r.get("dem_type"),
        "source_label": r.get("source_label"),
        "stats": _ttci_stats(ttci),
    }


@app.get("/api/region/grid")
async def region_grid(
    south: float = Query(...), north: float = Query(...),
    west: float = Query(...), east: float = Query(...),
    zoom: int = Query(11), source: str = Query("tiles"),
    rows: int = Query(128), cols: int = Query(128),
):
    """Downsampled TTCI + elevation grids for 3-D rendering of a region.

    Returns matching ``rows``×``cols`` arrays: ``ttci`` (0..1) for colouring and
    ``elevation`` (normalised 0..1, with ``elev_min``/``elev_max`` in metres) for
    vertex displacement, plus the geographic bounds. Both are derived from the
    same in-memory region surface, so the 3-D view stays consistent with the 2-D
    overlay.
    """
    south, north, west, east, zoom = _validate_region(south, north, west, east, zoom)
    rows = max(2, min(rows, 400))
    cols = max(2, min(cols, 400))
    source = _normalize_region_source(source)
    r = await asyncio.to_thread(_get_region, south, north, west, east, zoom, source)

    ttci = _downsample(r["ttci"], rows, cols, fill=0.0)
    ttci = np.clip(ttci, 0.0, 1.0)

    elev = r["elevation"]
    elev_fill = float(np.nanmean(elev)) if np.any(np.isfinite(elev)) else 0.0
    elev_ds = _downsample(elev, rows, cols, fill=elev_fill)
    elev_min = float(np.min(elev_ds))
    elev_max = float(np.max(elev_ds))
    span = max(elev_max - elev_min, 1.0)
    elev_norm = np.clip((elev_ds - elev_min) / span, 0.0, 1.0)

    b = r["bounds"]
    return {
        "rows": rows, "cols": cols,
        "bounds": {"south": b.bottom, "north": b.top, "west": b.left, "east": b.right},
        "elev_min": elev_min, "elev_max": elev_max,
        "source_label": r.get("source_label"),
        "ttci": ttci.tolist(),
        "elevation": elev_norm.tolist(),
    }


def _auto_zoom(south, north, west, east) -> int:
    """Pick a terrain-tile zoom from the area span so tile counts stay bounded."""
    span = max(north - south, east - west)
    if span <= 0.5:
        z = 12
    elif span <= 1.5:
        z = 11
    elif span <= 3.0:
        z = 10
    elif span <= 6.0:
        z = 9
    elif span <= 12.0:
        z = 8
    else:
        z = 7
    return max(_REGION_ZOOM_MIN, min(z, _REGION_ZOOM_MAX))


@app.post("/api/region/activate")
async def region_activate(req: "ActivateRegionRequest"):
    """Compute TTCI for a user-selected area and make it the active surface.

    This is how the app works now: instead of a hard-coded region, the user draws
    or picks an area and this endpoint computes its TTCI surface and publishes it
    as the active surface that the overlay, point query, MSA, and TAWS all read.
    Selecting a new area simply re-activates with a fresh surface.

    ``zoom`` is optional; when omitted it is chosen from the area's span so large
    areas don't request an unbounded number of tiles. ``source`` selects the open
    dataset (``tiles`` | ``copernicus`` | ``opentopo``).
    """
    south, north, west, east, _ = _validate_region(req.south, req.north, req.west, req.east, req.zoom or 11)
    zoom = int(req.zoom) if req.zoom else _auto_zoom(south, north, west, east)
    zoom = max(_REGION_ZOOM_MIN, min(zoom, _REGION_ZOOM_MAX))
    source = _normalize_region_source(req.source)

    try:
        results = await asyncio.to_thread(
            compute_region,
            (south, north, west, east),
            zoom,
            source,
            None,
            None,
            False,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Region activation failed")
        raise HTTPException(status_code=502, detail=f"Region computation failed: {exc}")

    if results.get("is_synthetic"):
        raise HTTPException(
            status_code=502,
            detail="Could not acquire real terrain data for this area. Try a smaller region or a different DEM source.",
        )

    # Publish as the active surface so every existing feature now operates on it.
    _state["results"] = results
    _state["ready"] = True
    _state["zoom"] = zoom
    _state["source"] = source
    _cache_overlay_png(results)

    ttci = results["ttci"]
    b = results["bounds"]
    logger.info("Activated region bbox=(%.3f,%.3f,%.3f,%.3f) zoom=%d source=%s shape=%s",
                south, north, west, east, zoom, source, ttci.shape)
    return {
        "ready": True,
        "zoom": zoom,
        "source": source,
        "is_synthetic": bool(results["is_synthetic"]),
        "dem_type": results.get("dem_type"),
        "source_label": results.get("source_label"),
        "bounds": {"south": b.bottom, "north": b.top, "west": b.left, "east": b.right},
        "shape": list(ttci.shape),
        "stats": _ttci_stats(ttci),
    }


# --- Point Query ---

@app.get("/api/ttci/query")
async def query_point(lat: float = Query(...), lon: float = Query(...)):
    """Return TTCI and terrain details for the DEM cell containing a coordinate.

    The handler resolves a single geographic coordinate to the one DEM cell that
    contains it and returns that cell's TTCI value, risk level and color, elevation
    (in meters and feet), slope, Terrain Ruggedness Index, and local elevation
    standard deviation (Requirements 8.1, 13.2).

    It fails closed with three distinct, descriptive error responses so callers can
    tell the failure modes apart:

    * ``400 Bad Request`` — the coordinate is malformed: latitude outside [-90, 90],
      longitude outside [-180, 180], or a non-numeric/NaN/infinite value. Detected by
      :func:`ttci.geo.validate_coordinate` (Requirements 8.4, 13.6).
    * ``404 Not Found`` — the coordinate is well-formed but falls outside the published
      surface's coverage. The cell resolved by :func:`ttci.geo.coord_to_cell` lies
      outside the DEM array extent, which corresponds exactly to the source DEM extent
      (Requirements 8.2, 13.5).
    * ``400 Bad Request`` — the coordinate maps to a cell that holds a no-data value in
      the TTCI surface (Requirement 8.3).

    In every error case no point-query values are returned. Requests received before the
    TTCI surface is available are rejected with a 503 (see :func:`_require_ready`).
    """
    _require_ready()

    # Validate the coordinate first so malformed input is rejected before any DEM
    # math (Requirements 8.4, 13.6). ``validate_coordinate`` raises a descriptive
    # ValueError for out-of-range or non-numeric latitude/longitude.
    try:
        lat, lon = validate_coordinate(lat, lon)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    r = _state["results"]
    transform = r["transform"]
    elevation = r["elevation"]
    ttci = r["ttci"]

    # Map the coordinate to the single DEM cell that contains it via the shared
    # inverse affine transform (Requirements 13.2, 8.1).
    row, col = coord_to_cell(transform, lat, lon)

    # Reject coordinates outside the surface coverage (Requirements 8.2, 13.5). The
    # array-extent check is the authoritative coverage test: a cell inside
    # [0, rows) x [0, cols) corresponds exactly to the published DEM extent and
    # guarantees the subsequent array access resolves to a real cell.
    rows, cols = elevation.shape
    if not (0 <= row < rows and 0 <= col < cols):
        raise HTTPException(
            status_code=404,
            detail="Coordinate is outside the TTCI surface coverage",
        )

    # Reject cells that hold a no-data value in the TTCI surface (Requirement 8.3).
    ttci_val = float(ttci[row, col])
    if np.isnan(ttci_val):
        raise HTTPException(status_code=400, detail="No data at coordinate")

    elev_val = float(elevation[row, col])
    risk_label, risk_color = classify_risk(ttci_val)

    # Elevation is reported in both units using the exact 0.3048 m/ft factor
    # (Requirement 13.3).
    return {
        "lat": lat,
        "lon": lon,
        "elevation_m": round(elev_val, 1),
        "elevation_ft": round(elev_val / 0.3048, 0),
        "ttci": round(ttci_val, 4),
        "risk_level": risk_label,
        "risk_color": risk_color,
        "metrics": {
            "slope_deg": round(float(r["slope"][row, col]), 2),
            "tri_m": round(float(r["tri"][row, col]), 2),
            "curvature": round(float(r["curvature"][row, col]), 6),
            "elevation_std_m": round(float(r["elevation_std"][row, col]), 2),
        },
    }


# --- MSA Calculator ---

@app.post("/api/msa/calculate")
async def calculate_msa(req: WaypointList):
    """Compute the per-sector Minimum Safe Altitude for a flight route.

    A route of ``N`` waypoints yields ``N - 1`` sectors, one per consecutive
    pair (Requirement 9.1). For each sector the response carries the great-circle
    distance in NM and km, the highest terrain and the MSA in feet and metres, and
    the min/max/mean TTCI over the sector's 10 NM buffer when terrain data covers
    it (Requirements 9.4, 9.5). The full route is echoed back so the client can
    align the sectors with the waypoints it submitted.

    The waypoints are validated first (see :func:`_validate_waypoints`): each must
    be a ``[lat, lon]`` pair with valid WGS84 coordinates and the route is capped
    at 50 waypoints, with malformed input rejected as ``400 Bad Request``. A route
    of fewer than two waypoints is not an error — it yields an empty list of
    sectors (Requirement 9.6). Requests received before the TTCI surface is
    available are rejected with a 503 (see :func:`_require_ready`, Requirement 6.5).
    """
    _require_ready()
    waypoints = _validate_waypoints(req.waypoints)

    r = _state["results"]
    sectors = compute_msa_for_route(
        waypoints, r["elevation"], r["transform"], r["ttci"]
    )
    return {"sectors": sectors, "waypoints": waypoints}


@app.post("/api/msa/profile")
async def elevation_profile(req: WaypointList):
    """Return the terrain elevation profile sampled along a flight route.

    For a route of two or more waypoints the response is an ordered sequence of
    roughly 100 points (at least two per sector) with non-decreasing cumulative
    distance, each carrying the cumulative distance in km, the terrain elevation
    in metres, and the sample's latitude/longitude (Requirement 10.5).

    The waypoints are validated first (see :func:`_validate_waypoints`): each must
    be a ``[lat, lon]`` pair with valid WGS84 coordinates and the route is capped
    at 50 waypoints, with malformed input rejected as ``400 Bad Request``. A route
    of fewer than two waypoints is not an error — it yields an empty profile
    (Requirement 10.6). Requests received before the TTCI surface is available are
    rejected with a 503 (see :func:`_require_ready`, Requirement 6.5).
    """
    _require_ready()
    waypoints = _validate_waypoints(req.waypoints)

    r = _state["results"]
    profile = get_elevation_profile(
        waypoints, r["elevation"], r["transform"]
    )
    return {"profile": profile}


# --- TAWS (extensibility) ---

@app.post("/api/taws/check")
async def taws_check(req: TawsCheckRequest):
    """Evaluate terrain awareness for an aircraft position (Requirements 11.2, 11.4).

    Given an aircraft position (``lat``, ``lon`` in WGS84 degrees) and altitude
    (``altitude_ft``, feet MSL), this resolves the single DEM cell beneath the
    aircraft from the cached TTCI surfaces and reports that cell's terrain
    elevation (in metres and feet) and TTCI value, risk level, and color — the
    extensibility surface required so terrain proximity can be evaluated against
    the supplied altitude without recomputing the TTCI core (Requirements 11.1,
    11.2).

    On top of that lookup it computes a simple, clearly documented demonstration
    terrain-proximity result (see the ``_TAWS_*`` heuristic above): the vertical
    ``clearance_ft = altitude_ft - terrain_ft`` and a graded alert level —
    ``WARNING`` below 1000 ft of clearance, ``CAUTION`` below 2000 ft, otherwise
    ``CLEAR`` — with a boolean ``alert`` flag and a fixed display color. This is a
    hackathon demonstration heuristic, not a certified TAWS/GPWS.

    It fails closed with distinct, descriptive errors and returns no terrain,
    TTCI, or proximity values in any error case (Requirement 11.4):

    * ``400 Bad Request`` — ``lat``/``lon`` are out of range or non-numeric
      (delegated to :func:`ttci.geo.validate_coordinate`), or ``altitude_ft`` is
      not a finite number (NaN/infinite).
    * ``404 Not Found`` — the position is well-formed but falls outside the
      published surface's coverage (the resolved cell lies outside the DEM extent).
    * ``400 Bad Request`` — the position maps to a cell that holds a no-data value,
      so no terrain or TTCI is available there.

    Requests received before the TTCI surface is available are rejected with a
    503 (see :func:`_require_ready`).
    """
    _require_ready()

    # Validate the coordinate first so malformed input is rejected before any DEM
    # math (Requirement 11.4); validate_coordinate raises a descriptive ValueError
    # for out-of-range or non-numeric latitude/longitude.
    try:
        lat, lon = validate_coordinate(req.lat, req.lon)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Reject a non-finite altitude (NaN/infinite). The pydantic model already
    # rejects structurally non-numeric altitudes; this guards the "altitude is
    # not a number" case that survives float parsing (Requirement 11.4).
    altitude_ft = float(req.altitude_ft)
    if not math.isfinite(altitude_ft):
        raise HTTPException(
            status_code=400,
            detail="Altitude must be a finite number in feet",
        )

    r = _state["results"]
    transform = r["transform"]
    elevation = r["elevation"]
    ttci = r["ttci"]

    # Map the position to the single DEM cell that contains it via the shared
    # inverse affine transform (Requirements 11.2, 13.2). The same helper backs
    # the point query, so a position resolves to the same cell in both features.
    row, col = coord_to_cell(transform, lat, lon)

    # Reject positions outside the surface coverage (Requirement 11.4). The
    # array-extent check is the authoritative coverage test.
    rows, cols = elevation.shape
    if not (0 <= row < rows and 0 <= col < cols):
        raise HTTPException(
            status_code=404,
            detail="Aircraft position is outside the TTCI surface coverage",
        )

    # A no-data cell has no terrain or TTCI to report (no-data propagates from the
    # elevation surface to the TTCI surface), so there is nothing to evaluate.
    ttci_val = float(ttci[row, col])
    if np.isnan(ttci_val):
        raise HTTPException(status_code=400, detail="No data at aircraft position")

    elev_m = float(elevation[row, col])
    risk_label, risk_color = classify_risk(ttci_val)

    # Dual-unit terrain elevation via the exact 0.3048 m/ft factor (Requirement
    # 13.3). Clearance is computed from the unrounded terrain feet to avoid
    # compounding rounding error, then reported to the nearest foot.
    terrain_ft = elev_m / _METERS_PER_FOOT
    clearance_ft = altitude_ft - terrain_ft
    proximity = _classify_taws_clearance(clearance_ft)

    return {
        "lat": lat,
        "lon": lon,
        "altitude_ft": round(altitude_ft, 0),
        "terrain_elevation_m": round(elev_m, 1),
        "terrain_elevation_ft": round(terrain_ft, 0),
        "ttci": round(ttci_val, 4),
        "risk_level": risk_label,
        "risk_color": risk_color,
        "clearance_ft": round(clearance_ft, 0),
        **proximity,
    }


@app.post("/api/taws/lookahead")
async def taws_lookahead(req: TawsLookaheadRequest):
    """Predictive, TTCI-modulated terrain look-ahead from an aircraft state.

    Unlike :func:`taws_check` (which only reports the terrain directly beneath
    the aircraft), this projects the ground track forward using heading and
    ground speed and tests whether terrain penetrates a clearance envelope
    *ahead* of the aircraft — the predictive principle behind real EGPWS. The
    look-ahead horizon and required clearances are expanded in proportion to the
    TTCI of the terrain along the path, so alerts come earlier in complex terrain
    (see :mod:`ttci.taws`).

    Returns the graded alert (CLEAR/CAUTION/WARNING), the triggering point, the
    effective TTCI-modulated envelope, and the full sampled look-ahead profile
    for plotting. Fails closed with descriptive errors:

    * ``400`` — coordinates out of range/non-numeric, a non-finite altitude/
      heading/vertical speed, or a non-positive ground speed (no forward
      projection is possible without motion).
    """
    _require_ready()

    try:
        lat, lon = validate_coordinate(req.lat, req.lon)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    altitude_ft = float(req.altitude_ft)
    heading_deg = float(req.heading_deg)
    ground_speed_kt = float(req.ground_speed_kt)
    vertical_speed_fpm = float(req.vertical_speed_fpm)

    for name, value in (
        ("altitude_ft", altitude_ft),
        ("heading_deg", heading_deg),
        ("ground_speed_kt", ground_speed_kt),
        ("vertical_speed_fpm", vertical_speed_fpm),
    ):
        if not math.isfinite(value):
            raise HTTPException(status_code=400, detail=f"{name} must be a finite number.")

    if ground_speed_kt <= 0:
        raise HTTPException(
            status_code=400,
            detail="Ground speed must be positive to project the flight path ahead.",
        )
    heading_deg = heading_deg % 360.0

    r = _state["results"]
    return look_ahead_taws(
        r["elevation"], r["ttci"], r["transform"],
        lat, lon, altitude_ft, heading_deg, ground_speed_kt, vertical_speed_fpm,
    )


# --- UAS Corridor Risk Scorer (extensibility) ---

@app.post("/api/uas/corridor")
async def uas_corridor(req: CorridorRequest):
    """Score a UAS flight corridor against the TTCI surface (Requirements 11.3, 11.5).

    The corridor is a polyline path of waypoints with a lateral buffer (``buffer_nm``
    on each side). The handler reuses the cached TTCI surface and the shared
    :func:`ttci.msa.get_sector_buffer_mask` — the same masking that backs the MSA
    sector buffers — over each consecutive waypoint pair, unioning the per-segment
    masks into one corridor mask. It then reports, over the **valid** (non-no-data)
    cells inside that corridor only, the minimum, maximum, and mean TTCI (each in
    [0, 1]) plus the count of valid cells, the peak risk level (the risk band of the
    highest-TTCI cell — the worst case along the corridor), and the dominant risk
    level (the band holding the most cells) (Requirement 11.3).

    The corridor is reused without recomputing the TTCI core, drawing on the cached
    surfaces the pipeline exposes for exactly this kind of extension (Requirement
    11.1).

    It fails closed with distinct, descriptive errors and returns no corridor
    statistics in any error case (Requirement 11.5):

    * ``400 Bad Request`` — the waypoints are malformed (not ``[lat, lon]`` pairs,
      out of range, non-numeric, or over the waypoint cap; delegated to
      :func:`_validate_waypoints`), fewer than two waypoints are supplied (a
      corridor needs a path), or ``buffer_nm`` is not a positive, finite width
      within the supported range.
    * ``404 Not Found`` — the corridor is well-formed but falls entirely outside
      the published surface's coverage (its mask selects no cells).
    * ``404 Not Found`` — the corridor overlaps the surface but every selected cell
      holds a no-data value, so there is no valid TTCI data to summarize.

    Requests received before the TTCI surface is available are rejected with a
    503 (see :func:`_require_ready`).
    """
    _require_ready()

    # Validate the path: reuse the shared waypoint validator (coordinate ranges,
    # numeric, waypoint cap) and additionally require at least two waypoints, since
    # a corridor with no path has no geometry to score.
    waypoints = _validate_waypoints(req.waypoints)
    if len(waypoints) < 2:
        raise HTTPException(
            status_code=400,
            detail="A corridor requires at least two waypoints to form a path.",
        )

    # Validate the buffer width: it must be a positive, finite NM half-width within
    # the supported range. The pydantic model already rejects structurally
    # non-numeric input; this guards NaN/infinite, non-positive, and oversized values.
    buffer_nm = float(req.buffer_nm)
    if not math.isfinite(buffer_nm) or buffer_nm <= 0:
        raise HTTPException(
            status_code=400,
            detail="Buffer width must be a positive, finite number of nautical miles.",
        )
    if buffer_nm > _MAX_CORRIDOR_BUFFER_NM:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Buffer width {buffer_nm} NM exceeds the maximum supported "
                f"corridor buffer of {_MAX_CORRIDOR_BUFFER_NM} NM."
            ),
        )

    r = _state["results"]
    transform = r["transform"]
    elevation = r["elevation"]
    ttci = r["ttci"]

    # Build the corridor mask: union the per-segment 2 * buffer_nm wide corridors
    # produced by the shared sector-buffer masking, so no masking geometry is
    # duplicated here (Requirement 11.3).
    buffer_deg = _corridor_buffer_deg(buffer_nm)
    corridor_mask = np.zeros(elevation.shape, dtype=bool)
    for i in range(len(waypoints) - 1):
        lat1, lon1 = waypoints[i]
        lat2, lon2 = waypoints[i + 1]
        corridor_mask |= get_sector_buffer_mask(
            elevation, transform, lat1, lon1, lat2, lon2, buffer_deg
        )

    # A corridor that selects no cells lies entirely outside the surface coverage.
    if not corridor_mask.any():
        raise HTTPException(
            status_code=404,
            detail="Corridor is entirely outside the TTCI surface coverage.",
        )

    # Summarize over valid (non-no-data) cells only (Requirement 11.3).
    corridor_ttci = ttci[corridor_mask]
    valid_ttci = corridor_ttci[~np.isnan(corridor_ttci)]
    if valid_ttci.size == 0:
        raise HTTPException(
            status_code=404,
            detail="Corridor contains no valid TTCI data (all cells are no-data).",
        )

    min_ttci = float(np.min(valid_ttci))
    max_ttci = float(np.max(valid_ttci))
    mean_ttci = float(np.mean(valid_ttci))

    # Peak risk = the band of the worst (highest) cell; dominant = the most common
    # band across the corridor's valid cells.
    peak_label, peak_color = classify_risk(max_ttci)
    dominant_label, dominant_color = _dominant_risk_level(valid_ttci)

    return {
        "waypoints": waypoints,
        "buffer_nm": buffer_nm,
        "valid_cell_count": int(valid_ttci.size),
        "ttci": {
            "min": round(min_ttci, 4),
            "max": round(max_ttci, 4),
            "mean": round(mean_ttci, 4),
        },
        "peak_risk_level": peak_label,
        "peak_risk_color": peak_color,
        "dominant_risk_level": dominant_label,
        "dominant_risk_color": dominant_color,
    }


# --- TTCI ↔ CFIT validation (evidence the index predicts real accidents) ---

@app.get("/api/validation")
async def validation():
    """Serve the precomputed TTCI ↔ CFIT validation report.

    The report quantifies how strongly TTCI separates real historical CFIT
    accident sites from ordinary surrounding terrain (mean TTCI, % High/Critical,
    percentile rank, ROC AUC, Mann-Whitney p). It is generated offline by
    ``validate_ttci.py`` (network-heavy, cached to ``data/validation_report.json``)
    and served read-only here.

    Returns 404 with guidance when the report has not yet been generated, so the
    frontend can show a clear "run the validation" prompt rather than failing
    opaquely.
    """
    if not VALIDATION_REPORT_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail=("Validation report not generated yet. "
                    "Run `python validate_ttci.py` in the backend."),
        )
    try:
        with open(VALIDATION_REPORT_PATH) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Validation report could not be read: {exc}",
        )


def _patch_metrics_sync(lat: float, lon: float, dim: int) -> Dict[str, Any]:
    """CPU/DEM-heavy patch metrics work — run in a thread pool from the async handler."""
    import base64
    from io import BytesIO
    from PIL import Image as _PILImage
    from ttci.validation import PATCH_HALF_DEG
    from ttci.terrain_tiles import download_terrain_dem
    from ttci.pipeline import compute_ttci as _cttci

    lat, lon = validate_coordinate(lat, lon)
    dim = max(16, min(int(dim), 128))

    half = PATCH_HALF_DEG
    bbox = (lat - half, lat + half, lon - half, lon + half)
    patch = download_terrain_dem(bbox, zoom=11)

    result = _cttci(patch.elevation, cell_size=patch.cell_size_m)
    rows, cols = result["ttci"].shape

    site_row, site_col = coord_to_cell(patch.transform, lat, lon)
    site_row = max(0, min(rows - 1, site_row))
    site_col = max(0, min(cols - 1, site_col))

    _KV = np.array([0.00, 0.25, 0.50, 0.75, 1.00])
    _KR = np.array([46,  241, 230, 231, 142], dtype=np.float64)
    _KG = np.array([204, 196, 126,  76,  68], dtype=np.float64)
    _KB = np.array([113,  15,  34,  60, 173], dtype=np.float64)

    def _to_png(surface: np.ndarray) -> str:
        clean = np.nan_to_num(np.clip(surface, 0.0, 1.0), nan=0.0)
        r_step = max(1, rows // dim)
        c_step = max(1, cols // dim)
        small = clean[::r_step, ::c_step][:dim, :dim]
        h, w = small.shape

        img_arr = np.stack([
            np.interp(small, _KV, _KR),
            np.interp(small, _KV, _KG),
            np.interp(small, _KV, _KB),
        ], axis=-1).astype(np.uint8)

        sr = max(0, min(h - 1, site_row // r_step))
        sc = max(0, min(w - 1, site_col // c_step))
        for d in range(-3, 4):
            color = [255, 255, 255] if abs(d) <= 2 else [20, 20, 20]
            if 0 <= sr + d < h:
                img_arr[sr + d, sc] = color
            if 0 <= sc + d < w:
                img_arr[sr, sc + d] = color

        img = _PILImage.fromarray(img_arr, "RGB")
        img = img.resize((dim * 3, dim * 3), _PILImage.NEAREST)
        buf = BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    t = result["ttci"]
    e = result["elevation_std_norm"]
    valid = ~(np.isnan(t) | np.isnan(e))
    corr = float(np.corrcoef(t[valid], e[valid])[0, 1]) if valid.sum() > 1 else float("nan")

    return {
        "ttci_png": _to_png(result["ttci"]),
        "estd_png": _to_png(result["elevation_std_norm"]),
        "corr": round(corr, 3),
        "bounds": {
            "south": float(bbox[0]), "north": float(bbox[1]),
            "west":  float(bbox[2]), "east":  float(bbox[3]),
        },
    }


@app.get("/api/validation/patch-metrics")
async def patch_metrics_endpoint(lat: float, lon: float, dim: int = 64):
    """Return base64 PNG heatmaps comparing composite TTCI vs normalized
    elevation_std for a DEM patch centred on (lat, lon).

    Used to visualise where the two measures agree and diverge across the
    same patch of terrain.  A white crosshair marks the (lat, lon) impact
    cell.  Both images are ``dim``×``dim`` pixels upscaled 3× with nearest-
    neighbour interpolation and encoded as ``data:image/png;base64`` URIs.
    """
    try:
        return await asyncio.to_thread(_patch_metrics_sync, lat, lon, dim)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"DEM unavailable: {exc}")


@app.get("/api/validation/global")
async def validation_global():
    """Serve the global-control CFIT validation report.

    Compares the same 15 CFIT accident sites against TTCI values sampled from
    8 geographically diverse reference terrain regions.  Generated offline by
    ``validate_ttci_global.py``; cached to
    ``data/validation_report_global.json``.
    """
    if not GLOBAL_VALIDATION_REPORT_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail=(
                "Global validation report not generated yet. "
                "Run `python validate_ttci_global.py` in the backend."
            ),
        )
    try:
        with open(GLOBAL_VALIDATION_REPORT_PATH) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Global validation report could not be read: {exc}",
        )


# --- Serve the built web client ---
# The React app (Vite) builds to ``frontend/dist`` and is served here for the
# production/demo build. In development the app runs on the Vite dev server
# (:5173) and proxies ``/api`` to this service.
FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="web")
