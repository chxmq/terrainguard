"""
CLI: run the CFIT validation and write data/validation_report.json.

Usage:
    python validate_ttci.py            # zoom 11 (default)
    python validate_ttci.py --zoom 12  # finer DEM, more tiles

The report is consumed by the /api/validation endpoint and the frontend
Validation panel. Re-run it whenever the accident set or pipeline changes.
"""

import argparse
from pathlib import Path

from ttci.validation import run_validation, save_report

REPORT_PATH = Path(__file__).parent / "data" / "validation_report.json"


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate TTCI against CFIT accidents.")
    parser.add_argument("--zoom", type=int, default=11, help="Terrain-tile zoom level.")
    args = parser.parse_args()

    report = run_validation(zoom=args.zoom)
    save_report(report, str(REPORT_PATH))

    s = report["summary"]
    print("\n================ TTCI ↔ CFIT VALIDATION ================")
    print(f"  Accident sites analysed : {s['n_accidents']}")
    print(f"  Control terrain samples : {s['n_controls']}")
    print("  -- Exact published coordinate (cell vs cell) --")
    print(f"  Mean TTCI  — accidents  : {s['accident_mean_ttci']}")
    print(f"  Mean TTCI  — controls   : {s['control_mean_ttci']}")
    print(f"  % High/Critical — sites : {s['accident_pct_high_or_critical']}%")
    print(f"  % High/Critical — ctrl  : {s['control_pct_high_or_critical']}%")
    print(f"  Mean site percentile    : {s['accident_mean_site_percentile']}")
    print(f"  ROC AUC                 : {s['auc_exact_cell']}")
    print(f"  Mann-Whitney p-value    : {s['mannwhitney_p_exact']:.2e}")
    print(f"  -- Impact neighbourhood ≤{s['site_radius_km']} km (sites AND controls) --")
    print(f"  Mean TTCI  — accidents  : {s['accident_mean_ttci_1km']}")
    print(f"  Mean TTCI  — controls   : {s['control_mean_ttci_1km']}")
    print(f"  % High/Critical — sites : {s['accident_pct_high_1km']}%")
    print(f"  ROC AUC                 : {s['auc_neighbourhood_1km']}")
    print(f"  Mann-Whitney p-value    : {s['mannwhitney_p_1km']:.2e}")
    print("=======================================================")


if __name__ == "__main__":
    main()
