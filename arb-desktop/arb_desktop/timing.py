from __future__ import annotations

from contextlib import contextmanager
from time import perf_counter, perf_counter_ns


@contextmanager
def measure_ms():
    start = perf_counter()
    result = {"ms": 0.0}
    try:
        yield result
    finally:
        result["ms"] = (perf_counter() - start) * 1000


def now_ns() -> int:
    return perf_counter_ns()
