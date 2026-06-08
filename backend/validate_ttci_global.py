"""
CLI: run the global-control CFIT validation and write
data/validation_report_global.json.

Compares the same 15 CFIT accident sites against control TTCI values sampled
from 8 geographically diverse reference regions (Kansas plains, Netherlands,
Scotland Highlands, Swiss Alps, Nepal Himalaya, Atacama Desert, Australian
Outback, Patagonia).  This complements validate_ttci.py which uses locally-
matched controls from the terrain patch surrounding each accident.

Usage:
    python validate_ttci_global.py          # zoom 11 (default)
    python validate_ttci_global.py --zoom 12
"""

import argparse
from pathlib import Path

from ttci.validation import run_global_validation, save_report

REPORT_PATH = Path(__file__).parent / "data" / "validation_report_global.json"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Global-control TTCI validation against CFIT accidents."
    )
    parser.add_argument("--zoom", type=int, default=11, help="Terrain-tile zoom level.")
    args = parser.parse_args()

    report = run_global_validation(zoom=args.zoom)
    save_report(report, str(REPORT_PATH))

    s = report["summary"]
    print("\n====== TTCI ↔ CFIT  GLOBAL-CONTROL VALIDATION ======")
    print(f"  Accident sites analysed  : {s['n_accidents']}")
    print(f"  Global reference regions : {s['n_regions']}")
    print(f"  Global control samples   : {s['n_controls']}")
    print("  -- Exact published coordinate --")
    print(f"  Mean TTCI — accidents    : {s['accident_mean_ttci']}")
    print(f"  Mean TTCI — controls     : {s['control_mean_ttci']}")
    print(f"  % High/Critical — sites  : {s['accident_pct_high_or_critical']}%")
    print(f"  % High/Critical — ctrl   : {s['control_pct_high_or_critical']}%")
    print(f"  ROC AUC                  : {s['auc_exact_cell']}")
    print(f"  Mann-Whitney p-value     : {s['mannwhitney_p_exact']:.2e}")
    print(f"  -- 1 km neighbourhood --")
    print(f"  Mean TTCI — accidents    : {s['accident_mean_ttci_1km']}")
    print(f"  Mean TTCI — controls     : {s['control_mean_ttci_1km']}")
    print(f"  % High/Critical — sites  : {s['accident_pct_high_1km']}%")
    print(f"  ROC AUC                  : {s['auc_neighbourhood_1km']}")
    print(f"  Mann-Whitney p-value     : {s['mannwhitney_p_1km']:.2e}")
    print("  -- Per-metric AUC vs global controls --")
    for m, auc in s["baseline_auc"].items():
        marker = " ← best" if auc == max(s["baseline_auc"].values()) else ""
        print(f"  AUC {m:<20} : {auc}{marker}")
    print("=====================================================")

    print("\n  Reference regions sampled:")
    for r in s.get("reference_regions", []):
        print(f"    {r['name']:<22} {r['n_cells']:>4} cells  mean TTCI {r['mean_ttci']:.3f}")


if __name__ == "__main__":
    main()
