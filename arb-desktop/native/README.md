# Optional C++ acceleration module (future)

Build with pybind11 for hot paths:

- `calc_arb_batch()` — vectorized margin / profit for thousands of pairings
- `json_odds_scan()` — SIMD-friendly JSON field scan

Python fallback in `arb_desktop/core/odds_engine.py` is the default.
Target: shave 1–3ms off calc phase when >500 pairings.

```bash
# Future build (requires pybind11, cmake)
cmake -B build native
cmake --build build
```
