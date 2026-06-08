"""
Curated dataset of historical Controlled-Flight-Into-Terrain (CFIT) accidents.

This module is the single source of truth for the accident sites used to
*validate* the Terrain Topography Complexity Index. Every entry is a real,
well-documented CFIT accident in which an airworthy aircraft under crew control
was flown into rising terrain — the exact failure mode TTCI is designed to flag.
Crew-incapacitation, mechanical-failure, and loss-of-control accidents are
deliberately excluded so the set reflects genuine terrain-encounter risk.

Coordinates are taken from public references (Wikipedia/Wikidata infoboxes,
Aviation Safety Network, official accident reports). ``precision_km`` is a
conservative estimate of how tightly the published impact point is localized;
the validation deliberately reads TTCI over a small neighbourhood so a
sub-kilometre coordinate error does not change the conclusion.

Each record carries its provenance so the dataset is auditable:
    flight        — operator and flight number
    date          — ISO date of the accident
    site          — impact location (named terrain feature)
    lat, lon      — WGS84 decimal degrees of the impact point
    precision_km  — estimated coordinate uncertainty (km)
    fatalities    — total deaths (context only)
    source        — primary reference URL
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class CfitAccident:
    """A single historical CFIT accident site with provenance."""

    flight: str
    date: str
    site: str
    country: str
    lat: float
    lon: float
    precision_km: float
    fatalities: int
    source: str


# Fifteen mountainous/terrain CFIT accidents spanning five decades and every
# inhabited continent. Coordinates verified against the cited references.
CFIT_ACCIDENTS: List[CfitAccident] = [
    CfitAccident(
        "American Airlines 965", "1995-12-20", "El Diluvio ridge, near Buga",
        "Colombia", 3.8459, -76.1048, 1.0, 159,
        "https://en.wikipedia.org/wiki/American_Airlines_Flight_965",
    ),
    CfitAccident(
        "Korean Air 801", "1997-08-06", "Nimitz Hill / Bijia Peak",
        "Guam (USA)", 13.4553, 144.7328, 0.5, 229,
        "https://en.wikipedia.org/wiki/Korean_Air_Flight_801",
    ),
    CfitAccident(
        "Air Inter 148", "1992-01-20", "Mont Sainte-Odile, Vosges",
        "France", 48.4253, 7.4050, 0.5, 87,
        "https://en.wikipedia.org/wiki/Air_Inter_Flight_148",
    ),
    CfitAccident(
        "TWA 514", "1974-12-01", "Mount Weather, Blue Ridge",
        "USA", 39.0625, -77.8881, 1.5, 92,
        "https://en.wikipedia.org/wiki/TWA_Flight_514",
    ),
    CfitAccident(
        "Thai Airways 311", "1992-07-31", "Langtang range, N of Kathmandu",
        "Nepal", 28.0200, 85.4800, 3.0, 113,
        "https://en.wikipedia.org/wiki/Thai_Airways_International_Flight_311",
    ),
    CfitAccident(
        "Garuda Indonesia 152", "1997-09-26", "Buah Nabar, Sibolangit",
        "Indonesia", 3.2700, 98.5500, 3.0, 234,
        "https://en.wikipedia.org/wiki/Garuda_Indonesia_Flight_152",
    ),
    CfitAccident(
        "Avianca 011", "1983-11-27", "Mejorada del Campo hills, Madrid",
        "Spain", 40.4033, -3.4492, 1.0, 181,
        "https://en.wikipedia.org/wiki/Avianca_Flight_011",
    ),
    CfitAccident(
        "Air New Zealand 901", "1979-11-28", "Lower slopes of Mount Erebus",
        "Antarctica", -77.4167, 167.4667, 2.0, 257,
        "https://en.wikipedia.org/wiki/Air_New_Zealand_Flight_901",
    ),
    CfitAccident(
        "Sukhoi Superjet 100 (demo)", "2012-05-09", "Mount Salak, West Java",
        "Indonesia", -6.7100, 106.7447, 0.5, 45,
        "https://en.wikipedia.org/wiki/2012_Mount_Salak_Sukhoi_Superjet_crash",
    ),
    CfitAccident(
        "Pakistan Int'l 268", "1992-09-28", "Bhattedanda, Lele valley",
        "Nepal", 27.5328, 85.2847, 1.0, 167,
        "https://en.wikipedia.org/wiki/Pakistan_International_Airlines_Flight_268",
    ),
    CfitAccident(
        "Crossair 3597", "2001-11-24", "Wooded hills near Bassersdorf",
        "Switzerland", 47.4539, 8.6233, 0.3, 24,
        "https://en.wikipedia.org/wiki/Crossair_Flight_3597",
    ),
    CfitAccident(
        "Indian Airlines 257", "1991-08-16", "Thangjing Hill, Imphal valley",
        "India", 24.4600, 93.6800, 3.0, 69,
        "https://en.wikipedia.org/wiki/Indian_Airlines_Flight_257",
    ),
    CfitAccident(
        "Inex-Adria 1308", "1981-12-01", "Mont San-Pietro, Corsica",
        "France", 41.7542, 8.9778, 1.0, 180,
        "https://en.wikipedia.org/wiki/Inex-Adria_Aviopromet_Flight_1308",
    ),
    CfitAccident(
        "Alaska Airlines 1866", "1971-09-04", "Chilkat Range, near Juneau",
        "USA", 58.3617, -135.1700, 1.0, 111,
        "https://en.wikipedia.org/wiki/Alaska_Airlines_Flight_1866",
    ),
    CfitAccident(
        "VASP 168", "1982-06-08", "Serra da Aratanha, Pacatuba",
        "Brazil", -3.7811, -38.8739, 1.0, 137,
        "https://en.wikipedia.org/wiki/VASP_Flight_168",
    ),
]


def as_dicts() -> List[dict]:
    """Return the accident dataset as a list of plain dicts (for JSON/API)."""
    return [
        {
            "flight": a.flight,
            "date": a.date,
            "site": a.site,
            "country": a.country,
            "lat": a.lat,
            "lon": a.lon,
            "precision_km": a.precision_km,
            "fatalities": a.fatalities,
            "source": a.source,
        }
        for a in CFIT_ACCIDENTS
    ]
