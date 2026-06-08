# Terrain Guard

**A validated Terrain Topography Complexity Index (TTCI) for aviation safety.**

Controlled Flight Into Terrain (CFIT) accounts for roughly a quarter of fatal
aviation accidents. Existing terrain databases store *elevation* — how high the
ground is — but not a unified, portable measure of how *complex and dangerous*
that terrain is. Terrain Guard derives the **Terrain Topography Complexity
Index** from open-source DEM data, serves it as an interactive risk map (2D and
3D), and drives four aviation-safety tools on top of it — then backs the index
with empirical validation against real historical CFIT accidents.

> Built for the Honeywell "Terrain Guard — Terrain Complexity Assessment Tool"
> problem statement (DP1).

---

## Highlights

- **TTCI engine** — fuses slope, ruggedness, curvature, and local relief into a
  single normalized `[0, 1]` complexity score, computed straight from DEM rasters.
- **All three open datasets, no API key** — SRTM 30 m (AWS Terrain Tiles), ESA
  Copernicus GLO-30 (public AWS COG mirror), and the OpenTopography API. The
  active source is displayed live in the UI.
- **Global, on-demand** — select any area on Earth; TTCI is computed for it on
  the fly (resolution scaled to zoom) and cached. Nothing is hard-coded to one
  region.
- **Four safety tools** — point risk query, per-sector **MSA** calculator,
  **predictive look-ahead TAWS** (EGPWS-style, modulated by TTCI), and a **UAS
  corridor** risk scorer.
- **2D + 3D** — a Leaflet risk map and a keyless **Cesium** 3D globe that drapes
  TTCI over real terrain relief, with a light/dark theme toggle.
- **Validated, not just computed** — across 15 documented CFIT accidents, crash
  sites score significantly higher TTCI than surrounding terrain (ROC AUC up to
  **0.80**, p < 0.001).

---

## What is TTCI?

The Terrain Topography Complexity Index is a weighted composite of four terrain
metrics derived from a Digital Elevation Model, normalized to `[0, 1]`:

| Metric              | Weight | Description                          |
| ------------------- | :----: | ------------------------------------ |
| Slope (Horn)        |  30%   | Steepness of the terrain             |
| TRI                 |  30%   | Terrain Ruggedness Index             |
| Curvature           |  20%   | Rate of change of slope              |
| Elevation σ         |  20%   | Local elevation variation (std dev)  |

Values are banded into five risk levels — **Very Low · Low · Moderate · High ·
Critical** — that contiguously span `[0, 1]`. Higher TTCI indicates more complex
terrain and elevated CFIT risk.

---

## Architecture

A two-service monorepo: a Python API that computes TTCI, and a React single-page
app that consumes it.

```
.
├── backend/                     # FastAPI service + TTCI computation
│   ├── main.py                  # API endpoints (also serves the built frontend)
│   ├── validate_ttci.py         # CLI: CFIT validation → data/validation_report.json
│   ├── benchmark.py             # CLI: TTCI compute-throughput benchmark
│   ├── requirements.txt
│   ├── ttci/                    # TTCI computation package
│   │   ├── pipeline.py          #   terrain metrics → weighted TTCI surface
│   │   ├── downloader.py        #   DEM acquisition orchestrator (+ OpenTopography)
│   │   ├── terrain_tiles.py     #   real DEM via AWS Terrain Tiles (SRTM, no key)
│   │   ├── copernicus.py        #   real DEM via ESA Copernicus GLO-30 (no key)
│   │   ├── geo.py               #   coordinate ↔ raster-cell helpers
│   │   ├── msa.py               #   Minimum Safe Altitude + elevation profile
│   │   ├── taws.py              #   predictive look-ahead terrain alerting
│   │   ├── cfit_accidents.py    #   curated, sourced CFIT accident dataset
│   │   ├── validation.py        #   TTCI ↔ CFIT case-control validation engine
│   │   └── tiler.py             #   overlay PNG + metadata rendering
│   ├── tests/                   # Pytest + Hypothesis fixtures & strategies
│   └── data/                    # Generated DEM/TTCI products (gitignored)
└── frontend/                    # Vite + React + TypeScript + Tailwind + shadcn/ui
    └── src/
        ├── main.tsx             # entry
        ├── App.tsx              # layout shell
        ├── components/          # Header, Sidebar, MapView, Globe3DView, charts
        │   ├── ui/              #   shadcn primitives (button, card, tabs, …)
        │   └── panels/          #   Info, MSA, TAWS, CFIT, Layers
        ├── state/               # React context: TTCI surface + tools/interaction
        └── lib/                 # API client, Cesium globe controller, utils
```

**Stack:** FastAPI · rasterio · NumPy · SciPy · Pillow (backend) ·
React · TypeScript · Vite · Tailwind CSS · shadcn/ui · Leaflet · Cesium (frontend).

---

## Getting started

### Prerequisites

- Python 3.11+ and `pip`
- Node 18+ and `npm`

### 1 · Backend (API + TTCI engine)

```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload         # → http://127.0.0.1:8000
```

The API starts with **no preloaded region** — you choose an area in the UI and
TTCI is computed for it on demand. (Opt into a preloaded region with the
environment variables below.)

### 2 · Frontend (Vite + React)

```bash
cd frontend
npm install
npm run dev                       # → http://localhost:5173  (proxies /api → :8000)
```

For a single-origin demo build:

```bash
cd frontend
npm run build                     # → frontend/dist, served by the API at :8000
```

### Tests

```bash
cd backend
pytest                            # property-based (Hypothesis) + example suite
```

Covers the TTCI pipeline (unit-range, no-data handling, risk classification,
weight validation), the geo round-trip, the MSA calculator, the overlay
renderer, and the validation statistics.

- **Development:** open **http://localhost:5173** (hot reload).
- **Demo / production:** `npm run build`, then open **http://127.0.0.1:8000**
  (FastAPI serves the built client and the API from one origin).

### Configuration (optional, backend env vars)

```bash
export TTCI_PRELOAD=1                      # preload a region at startup
export TTCI_BBOX="33.8,34.5,76.8,77.8"     # south,north,west,east (WGS84)
export TTCI_ZOOM=11                        # tile zoom (11 ≈ 76 m/px, 12 ≈ 38 m/px)
export TTCI_SOURCE=tiles                   # tiles | copernicus | opentopo | auto
export TTCI_SYNTHETIC=1                    # force the synthetic demonstration DEM
export OPENTOPO_API_KEY=...                # required for TTCI_SOURCE=opentopo
```

---

## Open-source DEM datasets

All three datasets named in the brief are ingested; the active one is shown in
the app header.

| `TTCI_SOURCE`     | Dataset                              | API key | Notes                                                   |
| ----------------- | ------------------------------------ | :-----: | ------------------------------------------------------- |
| `tiles` (default) | **SRTM 30 m** (NASA/USGS)            |  none   | via AWS Terrain Tiles — SRTM/NED global mosaic, fast    |
| `copernicus`      | **Copernicus GLO-30** (ESA)          |  none   | real GLO-30 COGs read from ESA's public AWS mirror      |
| `opentopo`        | **OpenTopography** multi-source API  |  free   | serves SRTM (`srtm30`) and Copernicus (`copernicus30`)  |

`auto` uses OpenTopography when a key is set, otherwise AWS Terrain Tiles. Any
source falls back to a clearly-labelled synthetic DEM only if the network is
unreachable.

---

## Validation — does TTCI predict real accidents?

Run `python validate_ttci.py` (writes `data/validation_report.json`, surfaced in
the **CFIT** tab). It uses a matched **case-control** design over 15 documented
CFIT accidents spanning five decades and six continents (`ttci/cfit_accidents.py`):
for each accident a real DEM patch is fetched, TTCI is computed with the
production pipeline, and the crash-site value is compared against hundreds of
random control cells from the surrounding terrain.

| Measure                              |   Crash sites    | Surrounding terrain |
| ------------------------------------ | :--------------: | :-----------------: |
| Mean TTCI                            |     **0.43**     |  0.26 (1.66× lift)  |
| Share in High/Critical bands         |     **40%**      |         11%         |
| High/Critical terrain within 1 km    |    **100%**      |          —          |

- ROC AUC **0.68** at the exact published coordinate (p = 0.007); **0.80** over
  the ≤1 km impact neighbourhood — applied equally to sites *and* controls, so
  the comparison is fair (p ≈ 3e-5).
- Crash sites average the **66th percentile** of their local terrain complexity.
- Each component metric is independently predictive (AUC 0.63–0.69); TTCI fuses
  them into one robust, embeddable score.

> Correlation, not causation: terrain complexity is one CFIT risk factor among
> weather, procedures, and human factors. The dataset is curated and modest
> (15 accidents), and the result is reported with its caveats.

---

## Performance

`python benchmark.py` measures TTCI compute throughput. On a commodity laptop
core the pipeline sustains **~5.5 million cells/second** — about **12 ms per
256×256 terrain tile (~85 tiles/s, single core)** — fast enough to compute or
stream tiles for real-time flight-planning and avionics use.

---

## API reference

| Method | Path                         | Purpose                                            |
| ------ | ---------------------------- | -------------------------------------------------- |
| GET    | `/api/health`                | Service readiness                                  |
| GET    | `/api/info`                  | Active surface bounds, stats, risk levels, source  |
| POST   | `/api/region/activate`       | Compute TTCI for a selected area → active surface  |
| GET    | `/api/region/overlay.png`    | On-demand TTCI overlay for an arbitrary bbox       |
| GET    | `/api/region/info`           | Stats/source for an arbitrary bbox                 |
| GET    | `/api/region/grid`           | Downsampled TTCI + elevation grids (3D rendering)  |
| GET    | `/api/ttci/overlay.png`      | Banded risk overlay of the active surface          |
| GET    | `/api/ttci/metadata`         | Active-surface bounds, shape, and stats            |
| GET    | `/api/ttci/query`            | TTCI + terrain detail at a coordinate              |
| POST   | `/api/msa/calculate`         | Per-sector Minimum Safe Altitude for a route       |
| POST   | `/api/msa/profile`           | Terrain elevation profile along a route            |
| POST   | `/api/taws/check`            | Point terrain-proximity check                      |
| POST   | `/api/taws/lookahead`        | Predictive look-ahead terrain alerting             |
| POST   | `/api/uas/corridor`          | UAS corridor TTCI risk scoring                     |
| GET    | `/api/validation`            | TTCI ↔ CFIT validation report                      |

---




## Notes & limitations

- The TTCI engine is **global**; a default region is never required. Products in
  `backend/data/` are recomputed on demand and excluded from version control.
- `/api/taws/lookahead` is a faithful *demonstration* of predictive look-ahead
  alerting that modulates its envelope by TTCI — **not** a certified TAWS/EGPWS
  (it omits flight-phase logic and an obstacle database).
- The 3D globe uses **CesiumJS** (Apache-2.0, no token); base imagery is Esri
  World Imagery and the relief is built from our own DEM, so no Cesium ion key
  is used.
- The validation reports **correlation**: terrain complexity is one CFIT risk
  factor among weather, procedures, and human factors. The dataset is curated
  and modest (15 accidents); results are reported with their caveats.

