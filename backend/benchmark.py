"""
TTCI compute throughput benchmark.

Backs the "embeddable in real-time avionics / flight planning" claim with hard
numbers: how fast the pipeline turns a DEM tile into a TTCI surface, in cells
per second and in milliseconds per standard tile, on commodity hardware.
"""

import time
import os
import contextlib

import numpy as np

from ttci.pipeline import compute_ttci


@contextlib.contextmanager
def _quiet():
    """Silence the pipeline's progress prints during timing."""
    with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
        yield


def _synthetic_grid(n: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n]
    base = (1500.0
            + 900.0 * np.sin(x / 40.0) * np.cos(y / 37.0)
            + 300.0 * np.sin(x / 11.0 + 1.0))
    return (base + 60.0 * rng.standard_normal((n, n))).astype(np.float64)


def bench(sizes=(256, 512, 1024), repeats: int = 3) -> None:
    print("TTCI compute throughput (Horn slope + TRI + curvature + elevation σ)\n")
    print(f"{'grid':>12} {'cells':>10} {'best ms':>10} {'Mcell/s':>10}")
    for n in sizes:
        grid = _synthetic_grid(n)
        with _quiet():
            compute_ttci(grid)  # prime memory
        best = min(_time_once(grid) for _ in range(repeats))
        cells = n * n
        mcells = (cells / best) / 1e6
        print(f"{n}x{n:<7} {cells:>10,} {best * 1000:>10.1f} {mcells:>10.1f}")

    # A 256x256 tile is the de-facto web-map / EGPWS database tile size.
    tile = _synthetic_grid(256)
    t = min(_time_once(tile) for _ in range(repeats))
    print(f"\nStandard 256x256 terrain tile: {t * 1000:.1f} ms "
          f"({1.0 / t:.0f} tiles/s on one core).")


def _time_once(grid: np.ndarray) -> float:
    start = time.perf_counter()
    with _quiet():
        compute_ttci(grid)
    return time.perf_counter() - start


if __name__ == "__main__":
    bench()
