"""
Tile Generator — Convert the TTCI surface into a colored map overlay and metadata.

The overlay colors each valid TTCI cell with the discrete display color of its
risk level (no interpolation), keeping the map overlay, the legend, and point-query
markers color-consistent. :data:`ttci.pipeline.RISK_LEVELS` is the single source of
truth for the band boundaries and the level->color association.
"""

import json
from io import BytesIO

import numpy as np
from PIL import Image

from .pipeline import RISK_LEVELS

# Opacity applied to valid (non-no-data) cells in the overlay. No-data cells are
# rendered fully transparent (alpha 0); valid cells use this non-zero alpha so the
# overlay reads as a semi-transparent risk surface on top of the base map.
VALID_CELL_ALPHA = 180


def _hex_to_rgb(hex_color):
    """Convert a ``"#rrggbb"`` hex string to an ``(r, g, b)`` tuple of 0-255 ints."""
    h = hex_color.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _require_valid_cells(ttci_array):
    """Raise ``ValueError`` when the TTCI surface has no valid (non-NaN) cells.

    Enforces the fail-closed contract: when every cell is no-data the Tile
    Generator returns a descriptive error rather than emitting an empty or
    partial overlay or metadata record (Requirement 5.7).
    """
    if not np.any(~np.isnan(ttci_array)):
        raise ValueError(
            "TTCI surface contains no valid cells (every cell is no-data); "
            "cannot generate an overlay or metadata."
        )


def ttci_to_rgba(ttci_array):
    """Render a TTCI surface as a banded RGBA overlay image.

    Each valid TTCI value is colored with the discrete display color of the risk
    level whose band contains it (no interpolation between bands), drawn directly
    from :data:`ttci.pipeline.RISK_LEVELS`. The risk bands are contiguous and
    half-open ``[lo, hi)`` across ``[0.0, 1.0]`` except the final (Critical) band
    ``[0.8, 1.0]``, which includes both bounds, matching
    :func:`ttci.pipeline.classify_risk`.

    No-data (NaN) cells are rendered fully transparent (alpha 0); valid cells are
    rendered with a non-zero alpha (Requirements 5.3, 5.4). The returned image has
    the same ``(rows, cols)`` shape as the input surface (Requirement 5.5).

    Args:
        ttci_array: A 2-D array of TTCI values in ``[0.0, 1.0]`` with NaN for
            no-data cells.

    Returns:
        An ``(rows, cols, 4)`` ``uint8`` RGBA array.

    Raises:
        ValueError: If the surface contains no valid cells (Requirement 5.7).
    """
    _require_valid_cells(ttci_array)

    rows, cols = ttci_array.shape
    rgba = np.zeros((rows, cols, 4), dtype=np.uint8)

    valid = ~np.isnan(ttci_array)
    last_index = len(RISK_LEVELS) - 1
    for index, (lo, hi, _label, hex_color) in enumerate(RISK_LEVELS):
        # Every band includes its lower bound and excludes its upper bound,
        # except the final (Critical) band, which also includes its upper bound.
        in_band = (ttci_array >= lo) & (ttci_array < hi)
        if index == last_index:
            in_band |= ttci_array == hi
        band_mask = valid & in_band
        if not band_mask.any():
            continue
        r, g, b = _hex_to_rgb(hex_color)
        rgba[band_mask] = (r, g, b, VALID_CELL_ALPHA)

    return rgba


def generate_overlay_png(ttci_array, output_path):
    """Render the TTCI surface to a banded PNG overlay on disk and return the path."""
    rgba = ttci_to_rgba(ttci_array)
    img = Image.fromarray(rgba, "RGBA")
    img.save(output_path)
    print(f"🖼️  Overlay PNG saved: {output_path}")
    return output_path


def generate_overlay_bytes(ttci_array):
    """Render the TTCI surface to in-memory PNG bytes for API serving."""
    rgba = ttci_to_rgba(ttci_array)
    img = Image.fromarray(rgba, "RGBA")
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()


def generate_metadata_json(bounds, ttci_array, output_path):
    """Write the TTCI overlay metadata record to ``output_path`` and return it.

    The record carries the geographic bounds (north, south, east, west), the array
    shape as ``[rows, cols]``, and the minimum, maximum, mean, and standard
    deviation of the TTCI values computed over only the valid (non-no-data) cells
    (Requirement 5.6).

    Raises:
        ValueError: If the surface contains no valid cells, in which case no
            metadata file is written (Requirement 5.7).
    """
    _require_valid_cells(ttci_array)

    valid = ttci_array[~np.isnan(ttci_array)]
    meta = {
        "bounds": {
            "south": bounds.bottom,
            "north": bounds.top,
            "west": bounds.left,
            "east": bounds.right,
        },
        "stats": {
            "min": float(np.min(valid)),
            "max": float(np.max(valid)),
            "mean": float(np.mean(valid)),
            "std": float(np.std(valid)),
        },
        "shape": list(ttci_array.shape),
    }
    with open(output_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"📋 Metadata saved: {output_path}")
    return meta
