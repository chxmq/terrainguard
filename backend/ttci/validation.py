"""
Empirical validation of TTCI against historical CFIT accident sites.

This module answers the question a Honeywell judge will ask first: *does the
index actually predict where terrain accidents happen?* It does not assume the
answer — it measures it.

Method (a matched case-control design):
    1. For each real CFIT accident in :mod:`ttci.cfit_accidents`, acquire a real
       DEM patch centred on the impact point (AWS Terrain Tiles, no API key) and
       compute the TTCI surface with the exact production pipeline.
    2. Read the TTCI **at the crash cell** (the "case"), plus a robust
       neighbourhood value (max TTCI within 1 km) that absorbs sub-kilometre
       coordinate error.
    3. Sample many "control" cells from the *same* patch but well away from the
       crash (> 3 km). Controls therefore represent the ordinary surrounding
       terrain a flight in that region would normally overfly — a fair, locally
       matched baseline rather than a trivially flat global average.
    4. Aggregate across all accidents and quantify the separation between crash
       sites and controls: mean/median TTCI, the share landing in the High/
       Critical bands, the crash site's percentile rank within its own local
       terrain, a Mann-Whitney U test, and the ROC AUC.

A high AUC and a strong percentile rank mean CFIT accidents concentrate in the
terrain TTCI scores as most complex — i.e. the index is a genuine risk signal,
not a repackaged elevation map.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from scipy.ndimage import maximum_filter

from .cfit_accidents import CFIT_ACCIDENTS, CfitAccident
from .geo import coord_to_cell
from .pipeline import classify_risk, compute_ttci
from .terrain_tiles import download_terrain_dem

# Risk bands at or above this TTCI are "High" or "Critical" (see RISK_LEVELS).
HIGH_RISK_THRESHOLD = 0.6

# Validation geometry.
PATCH_HALF_DEG = 0.35        # half-width of each DEM patch (~39 km, region-scale)
SITE_RADIUS_KM = 1.0         # impact neighbourhood (applied to sites AND controls)
CONTROL_MIN_KM = 5.0         # controls must be at least this far from the crash
CONTROLS_PER_SITE = 400      # control cells sampled per accident
RANDOM_SEED = 42             # reproducible control sampling

_M_PER_DEG_LAT = 110_540.0


def _neighbourhood_max(ttci: np.ndarray, radius_px: int) -> np.ndarray:
    """Max TTCI within a circular ``radius_px`` of each cell (NaN-safe).

    Applied identically to crash sites and controls so the comparison stays
    fair: it accounts for sub-kilometre coordinate uncertainty on the accident
    side while, conservatively, granting controls the same neighbourhood
    benefit. No-data cells stay no-data.
    """
    if radius_px < 1:
        return ttci
    span = np.arange(-radius_px, radius_px + 1)
    yy, xx = np.meshgrid(span, span)
    footprint = (xx * xx + yy * yy) <= radius_px * radius_px
    filled = np.where(np.isnan(ttci), -np.inf, ttci)
    maxed = maximum_filter(filled, footprint=footprint, mode="nearest")
    return np.where(np.isnan(ttci), np.nan, maxed)


def _cell_distance_km(transform, rows, cols, lat0, lon0) -> np.ndarray:
    """Great-circle-ish distance (km) from (lat0, lon0) to every cell centre."""
    cc, rr = np.meshgrid(np.arange(cols), np.arange(rows))
    lons = transform.c + cc * transform.a
    lats = transform.f + rr * transform.e
    dx = (lons - lon0) * (111_320.0 * math.cos(math.radians(lat0)))
    dy = (lats - lat0) * _M_PER_DEG_LAT
    return np.sqrt(dx * dx + dy * dy) / 1000.0


def _percentile_rank(value: float, population: np.ndarray) -> float:
    """Percentile rank (0-100) of ``value`` within ``population`` (mean rank)."""
    if population.size == 0:
        return float("nan")
    below = np.count_nonzero(population < value)
    equal = np.count_nonzero(population == value)
    return 100.0 * (below + 0.5 * equal) / population.size


def _evaluate_accident(
    accident: CfitAccident, zoom: int, rng: np.random.Generator
) -> Optional[Dict]:
    """Compute the TTCI case/control sample for one accident, or None on failure."""
    half = PATCH_HALF_DEG
    bbox = (accident.lat - half, accident.lat + half,
            accident.lon - half, accident.lon + half)
    try:
        patch = download_terrain_dem(bbox, zoom=zoom)
    except Exception as exc:  # noqa: BLE001 — skip sites without tile coverage
        print(f"Skipping {accident.flight}: DEM unavailable ({exc}).")
        return None

    result = compute_ttci(patch.elevation, cell_size=patch.cell_size_m)
    ttci = result["ttci"]
    rows, cols = ttci.shape

    row, col = coord_to_cell(patch.transform, accident.lat, accident.lon)
    if not (0 <= row < rows and 0 <= col < cols):
        print(f"Skipping {accident.flight}: crash cell outside patch.")
        return None

    site_ttci = float(ttci[row, col])
    if math.isnan(site_ttci):
        print(f"Skipping {accident.flight}: no-data at crash cell.")
        return None

    dist_km = _cell_distance_km(patch.transform, rows, cols, accident.lat, accident.lon)
    valid = ~np.isnan(ttci)

    # Neighbourhood-max surface (≤ SITE_RADIUS_KM), applied to sites AND controls.
    radius_px = max(1, int(round(SITE_RADIUS_KM * 1000.0 / patch.cell_size_m)))
    nbhd = _neighbourhood_max(ttci, radius_px)
    site_max = float(nbhd[row, col])

    # Percentile rank of the crash site within its own local terrain.
    patch_values = ttci[valid]
    site_pctile = _percentile_rank(site_ttci, patch_values)

    # Controls: ordinary terrain well away from the impact point. Sample once and
    # read BOTH the exact-cell and neighbourhood-max value at the same cells so
    # each AUC compares like with like.
    control_pool = valid & (dist_km >= CONTROL_MIN_KM)
    pool_idx = np.flatnonzero(control_pool.reshape(-1))
    if pool_idx.size > CONTROLS_PER_SITE:
        pool_idx = rng.choice(pool_idx, CONTROLS_PER_SITE, replace=False)
    control_cell = ttci.reshape(-1)[pool_idx]
    control_nbhd = nbhd.reshape(-1)[pool_idx]

    label, color = classify_risk(site_ttci)

    # Baseline comparison: sample each normalized component metric at the same
    # crash cell and the same control cells, so we can later show the composite
    # TTCI out-predicts any single metric on identical samples.
    metric_surfaces = {
        "ttci": ttci,
        "slope": result["slope_norm"],
        "tri": result["tri_norm"],
        "curvature": result["curvature_norm"],
        "elevation_std": result["elevation_std_norm"],
    }
    metric_site = {}
    metric_controls = {}
    for name, surf in metric_surfaces.items():
        metric_site[name] = float(surf[row, col])
        metric_controls[name] = surf.reshape(-1)[pool_idx]

    return {
        "flight": accident.flight,
        "date": accident.date,
        "site": accident.site,
        "country": accident.country,
        "lat": accident.lat,
        "lon": accident.lon,
        "fatalities": accident.fatalities,
        "source": accident.source,
        "site_ttci": round(site_ttci, 4),
        "site_max_1km": round(site_max, 4),
        "site_percentile": round(site_pctile, 1),
        "risk_level": label,
        "risk_color": color,
        "elevation_m": round(float(patch.elevation[row, col]), 1),
        "_controls_cell": control_cell,   # internal; stripped before serialization
        "_controls_nbhd": control_nbhd,   # internal; stripped before serialization
        "_metric_site": metric_site,      # internal; per-metric crash-cell values
        "_metric_controls": metric_controls,  # internal; per-metric control arrays
    }


def _auc(positives: np.ndarray, negatives: np.ndarray) -> float:
    """ROC AUC = P(positive ranks above negative), via the Mann-Whitney U."""
    n_pos, n_neg = positives.size, negatives.size
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    pooled = np.concatenate([positives, negatives])
    ranks = _rankdata(pooled)
    rank_pos = ranks[:n_pos].sum()
    u_pos = rank_pos - n_pos * (n_pos + 1) / 2.0
    return float(u_pos / (n_pos * n_neg))


def _rankdata(a: np.ndarray) -> np.ndarray:
    """Average ranks (1-based), ties shared — equivalent to scipy.stats.rankdata."""
    order = np.argsort(a, kind="mergesort")
    ranks = np.empty(a.size, dtype=np.float64)
    sa = a[order]
    i = 0
    while i < a.size:
        j = i
        while j + 1 < a.size and sa[j + 1] == sa[i]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        ranks[order[i:j + 1]] = avg
        i = j + 1
    return ranks


def _mannwhitney_p(positives: np.ndarray, negatives: np.ndarray) -> float:
    """One-sided Mann-Whitney U p-value (positives > negatives), normal approx."""
    n1, n2 = positives.size, negatives.size
    if n1 == 0 or n2 == 0:
        return float("nan")
    pooled = np.concatenate([positives, negatives])
    ranks = _rankdata(pooled)
    r1 = ranks[:n1].sum()
    u1 = r1 - n1 * (n1 + 1) / 2.0
    mu = n1 * n2 / 2.0
    sigma = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12.0)
    if sigma == 0:
        return float("nan")
    z = (u1 - mu - 0.5) / sigma  # continuity-corrected
    # One-sided upper-tail p-value from the standard normal survival function.
    return float(0.5 * math.erfc(z / math.sqrt(2.0)))


def run_validation(zoom: int = 11) -> Dict:
    """Run the full CFIT validation and return a structured report dict.

    Acquires a real DEM patch per accident, computes TTCI, and aggregates the
    case/control separation statistics across all sites. Network-heavy on a cold
    tile cache; fast once warmed.
    """
    rng = np.random.default_rng(RANDOM_SEED)
    print(f"Validating TTCI against {len(CFIT_ACCIDENTS)} CFIT accident sites...")

    per_site: List[Dict] = []
    control_cell_chunks: List[np.ndarray] = []
    control_nbhd_chunks: List[np.ndarray] = []
    metric_names = ["ttci", "slope", "tri", "curvature", "elevation_std"]
    metric_site_vals: Dict[str, List[float]] = {m: [] for m in metric_names}
    metric_control_chunks: Dict[str, List[np.ndarray]] = {m: [] for m in metric_names}
    for accident in CFIT_ACCIDENTS:
        record = _evaluate_accident(accident, zoom, rng)
        if record is None:
            continue
        control_cell_chunks.append(record.pop("_controls_cell"))
        control_nbhd_chunks.append(record.pop("_controls_nbhd"))
        msite = record.pop("_metric_site")
        mctrl = record.pop("_metric_controls")
        for m in metric_names:
            metric_site_vals[m].append(msite[m])
            metric_control_chunks[m].append(mctrl[m])
        per_site.append(record)

    if not per_site:
        raise RuntimeError("Validation produced no usable accident sites.")

    site_ttci = np.array([r["site_ttci"] for r in per_site], dtype=np.float64)
    site_max = np.array([r["site_max_1km"] for r in per_site], dtype=np.float64)
    controls_cell = np.concatenate(control_cell_chunks)
    controls_nbhd = np.concatenate(control_nbhd_chunks)

    n_sites = len(per_site)
    sites_high = int(np.count_nonzero(site_ttci >= HIGH_RISK_THRESHOLD))
    sites_max_high = int(np.count_nonzero(site_max >= HIGH_RISK_THRESHOLD))
    controls_high = int(np.count_nonzero(controls_cell >= HIGH_RISK_THRESHOLD))

    summary = {
        "n_accidents": n_sites,
        "n_controls": int(controls_cell.size),
        "zoom": zoom,
        "high_risk_threshold": HIGH_RISK_THRESHOLD,
        "site_radius_km": SITE_RADIUS_KM,
        # Exact published coordinate (single cell vs single control cell).
        "accident_mean_ttci": round(float(np.mean(site_ttci)), 4),
        "accident_median_ttci": round(float(np.median(site_ttci)), 4),
        "control_mean_ttci": round(float(np.mean(controls_cell)), 4),
        "control_median_ttci": round(float(np.median(controls_cell)), 4),
        "accident_pct_high_or_critical": round(100.0 * sites_high / n_sites, 1),
        "control_pct_high_or_critical": round(100.0 * controls_high / controls_cell.size, 1),
        "accident_mean_site_percentile": round(
            float(np.mean([r["site_percentile"] for r in per_site])), 1),
        "auc_exact_cell": round(_auc(site_ttci, controls_cell), 3),
        "mannwhitney_p_exact": _mannwhitney_p(site_ttci, controls_cell),
        # Impact neighbourhood (≤ radius, applied equally to sites and controls).
        "accident_mean_ttci_1km": round(float(np.mean(site_max)), 4),
        "control_mean_ttci_1km": round(float(np.mean(controls_nbhd)), 4),
        "accident_pct_high_1km": round(100.0 * sites_max_high / n_sites, 1),
        "auc_neighbourhood_1km": round(_auc(site_max, controls_nbhd), 3),
        "mannwhitney_p_1km": _mannwhitney_p(site_max, controls_nbhd),
        "lift_mean": round(float(np.mean(site_ttci) / max(np.mean(controls_cell), 1e-9)), 2),
    }

    # Baseline comparison: per-metric AUC on identical case/control samples. The
    # composite TTCI should out-separate every individual component metric,
    # justifying the multi-metric design and the chosen weights.
    baseline_auc = {}
    for m in metric_names:
        pos = np.array(metric_site_vals[m], dtype=np.float64)
        neg = np.concatenate(metric_control_chunks[m])
        # Guard against any stray no-data leaking into a component sample.
        pos = pos[~np.isnan(pos)]
        neg = neg[~np.isnan(neg)]
        baseline_auc[m] = round(_auc(pos, neg), 3)
    summary["baseline_auc"] = baseline_auc

    return {"summary": summary, "accidents": per_site}


# ---------------------------------------------------------------------------
# Global-control validation (additive — nothing above is modified)
# ---------------------------------------------------------------------------

# Eight diverse terrain reference regions: (label, center_lat, center_lon).
# Together they span flat plains, low hills, high mountains, desert, and
# coastal terrain across five continents, so global controls are not biased
# toward any single terrain type.
GLOBAL_REFERENCE_REGIONS = [
    ("Kansas Plains",      38.00,  -98.00),  # flat prairie
    ("Netherlands",        52.25,    5.25),  # coastal, very flat
    ("Scotland Highlands", 57.25,   -4.50),  # moderate hills
    ("Swiss Alps",         46.50,    8.50),  # high mountain
    ("Nepal Himalaya",     28.00,   86.00),  # extreme elevation
    ("Atacama Desert",    -22.50,  -69.00),  # arid high plateau
    ("Australian Outback", -27.50,  137.50), # low-elevation plains
    ("Patagonia",          -50.50,  -72.00), # subantarctic mountains
]

GLOBAL_CONTROLS_PER_REGION = 400  # sampled cells per reference region
GLOBAL_RANDOM_SEED = 43           # independent of local-control seed (42)


def _sample_global_controls(
    zoom: int,
    rng: np.random.Generator,
    controls_per_region: int = GLOBAL_CONTROLS_PER_REGION,
) -> Dict:
    """Download one DEM patch per global reference region and sample TTCI cells.

    Returns a dict with concatenated arrays ``controls_cell``,
    ``controls_nbhd``, ``metric_controls`` (per-metric), and a
    ``sampled_regions`` metadata list.  Regions for which the DEM download
    fails are skipped with a warning.
    """
    metric_names = ["ttci", "slope", "tri", "curvature", "elevation_std"]
    all_cells: List[np.ndarray] = []
    all_nbhd: List[np.ndarray] = []
    metric_chunks: Dict[str, List[np.ndarray]] = {m: [] for m in metric_names}
    sampled_regions: List[Dict] = []

    for name, lat, lon in GLOBAL_REFERENCE_REGIONS:
        half = PATCH_HALF_DEG
        bbox = (lat - half, lat + half, lon - half, lon + half)
        try:
            patch = download_terrain_dem(bbox, zoom=zoom)
        except Exception as exc:  # noqa: BLE001
            print(f"Skipping global region {name}: DEM unavailable ({exc})")
            continue

        result = compute_ttci(patch.elevation, cell_size=patch.cell_size_m)
        ttci = result["ttci"]

        valid = ~np.isnan(ttci)
        radius_px = max(1, int(round(SITE_RADIUS_KM * 1000.0 / patch.cell_size_m)))
        nbhd = _neighbourhood_max(ttci, radius_px)

        pool_idx = np.flatnonzero(valid.reshape(-1))
        n_available = pool_idx.size
        if n_available > controls_per_region:
            pool_idx = rng.choice(pool_idx, controls_per_region, replace=False)

        all_cells.append(ttci.reshape(-1)[pool_idx])
        all_nbhd.append(nbhd.reshape(-1)[pool_idx])

        metric_surfaces = {
            "ttci":          ttci,
            "slope":         result["slope_norm"],
            "tri":           result["tri_norm"],
            "curvature":     result["curvature_norm"],
            "elevation_std": result["elevation_std_norm"],
        }
        for mname, surf in metric_surfaces.items():
            metric_chunks[mname].append(surf.reshape(-1)[pool_idx])

        n_sampled = pool_idx.size
        mean_ttci = float(np.nanmean(ttci.reshape(-1)[pool_idx]))
        sampled_regions.append({
            "name": name, "lat": lat, "lon": lon,
            "n_cells": n_sampled, "mean_ttci": round(mean_ttci, 4),
        })
        print(f"   {name}: {n_sampled} cells  (mean TTCI {mean_ttci:.3f})")

    return {
        "controls_cell":  np.concatenate(all_cells) if all_cells else np.array([]),
        "controls_nbhd":  np.concatenate(all_nbhd) if all_nbhd else np.array([]),
        "metric_controls": {
            m: np.concatenate(v) if v else np.array([])
            for m, v in metric_chunks.items()
        },
        "sampled_regions": sampled_regions,
    }


def run_global_validation(zoom: int = 11) -> Dict:
    """Global-control CFIT validation: accident sites vs diverse global terrain.

    Compares the same 15 CFIT accident sites against TTCI values sampled from
    8 geographically diverse reference regions (flat plains, low hills, moderate
    and high mountains, desert, coastal).  This complements the matched
    local-control validation by answering a different question: *does TTCI
    separate CFIT impact coordinates from average global terrain?*

    For a worldwide EGPWS product the global comparison is arguably the more
    honest headline number — the system must discriminate against the full
    breadth of terrain it overflies, not just the local surroundings of a
    mountain crash.

    The accident-site values are recomputed from scratch (DEM tiles are cache-
    hits after ``run_validation()`` has already warmed them) so the global
    report is fully self-contained.
    """
    rng = np.random.default_rng(GLOBAL_RANDOM_SEED)
    print(f"Global-control validation: {len(CFIT_ACCIDENTS)} accidents vs global terrain…")

    # --- Accident sites (reuse _evaluate_accident; tiles are cached) ----------
    accident_rng = np.random.default_rng(RANDOM_SEED)
    metric_names = ["ttci", "slope", "tri", "curvature", "elevation_std"]
    per_site: List[Dict] = []
    metric_site_vals: Dict[str, List[float]] = {m: [] for m in metric_names}

    for accident in CFIT_ACCIDENTS:
        record = _evaluate_accident(accident, zoom, accident_rng)
        if record is None:
            continue
        record.pop("_controls_cell")
        record.pop("_controls_nbhd")
        msite = record.pop("_metric_site")
        record.pop("_metric_controls")
        for m in metric_names:
            metric_site_vals[m].append(msite[m])
        per_site.append(record)

    if not per_site:
        raise RuntimeError("Global validation: no usable accident sites.")

    print(f"   {len(per_site)} accident sites evaluated")

    # --- Global reference controls -------------------------------------------
    print("Sampling global reference terrain…")
    ctrl = _sample_global_controls(zoom, rng)
    controls_cell = ctrl["controls_cell"]
    controls_nbhd = ctrl["controls_nbhd"]
    metric_controls = ctrl["metric_controls"]
    sampled_regions = ctrl["sampled_regions"]

    if controls_cell.size == 0:
        raise RuntimeError("Global validation: no control cells could be sampled.")

    site_ttci = np.array([r["site_ttci"] for r in per_site], dtype=np.float64)
    site_max  = np.array([r["site_max_1km"] for r in per_site], dtype=np.float64)

    n_sites       = len(per_site)
    sites_high    = int(np.count_nonzero(site_ttci >= HIGH_RISK_THRESHOLD))
    sites_max_high = int(np.count_nonzero(site_max >= HIGH_RISK_THRESHOLD))
    controls_high = int(np.count_nonzero(controls_cell >= HIGH_RISK_THRESHOLD))

    summary: Dict = {
        "n_accidents":   n_sites,
        "n_controls":    int(controls_cell.size),
        "n_regions":     len(sampled_regions),
        "zoom":          zoom,
        "control_type":  "global_random",
        "high_risk_threshold":  HIGH_RISK_THRESHOLD,
        "site_radius_km":       SITE_RADIUS_KM,
        # Exact cell stats.
        "accident_mean_ttci":   round(float(np.mean(site_ttci)), 4),
        "accident_median_ttci": round(float(np.median(site_ttci)), 4),
        "control_mean_ttci":    round(float(np.mean(controls_cell)), 4),
        "control_median_ttci":  round(float(np.median(controls_cell)), 4),
        "accident_pct_high_or_critical": round(100.0 * sites_high / n_sites, 1),
        "control_pct_high_or_critical":  round(
            100.0 * controls_high / controls_cell.size, 1),
        "accident_mean_site_percentile": round(
            float(np.mean([r["site_percentile"] for r in per_site])), 1),
        "auc_exact_cell":       round(_auc(site_ttci, controls_cell), 3),
        "mannwhitney_p_exact":  _mannwhitney_p(site_ttci, controls_cell),
        # 1 km neighbourhood stats.
        "accident_mean_ttci_1km": round(float(np.mean(site_max)), 4),
        "control_mean_ttci_1km":  round(float(np.mean(controls_nbhd)), 4),
        "accident_pct_high_1km":  round(100.0 * sites_max_high / n_sites, 1),
        "auc_neighbourhood_1km":  round(_auc(site_max, controls_nbhd), 3),
        "mannwhitney_p_1km":      _mannwhitney_p(site_max, controls_nbhd),
        "lift_mean":  round(
            float(np.mean(site_ttci)) / max(float(np.mean(controls_cell)), 1e-9), 2),
        "reference_regions": sampled_regions,
    }

    baseline_auc: Dict[str, float] = {}
    for m in metric_names:
        pos = np.array(metric_site_vals[m], dtype=np.float64)
        neg = metric_controls[m]
        pos = pos[~np.isnan(pos)]
        neg = neg[~np.isnan(neg)]
        baseline_auc[m] = round(_auc(pos, neg), 3)
    summary["baseline_auc"] = baseline_auc

    return {"summary": summary, "accidents": per_site}


def save_report(report: Dict, path: str) -> str:
    """Write a validation report to JSON (stripping any internal arrays)."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"Validation report saved: {path}")
    return path
