# AGENTS.md

## Cursor Cloud specific instructions

This repo is a Python 3.12 arbitrage-betting CLI (`python -m src.main`) plus two Edge browser
extensions (`extension/`, `extension-legacy/`). The Python CLI is the runnable product here.

### Services / entry points

- CLI: `python -m src.main <command>` (run from repo root). See `python -m src.main --help`.
- There is no long-running server/dev process — commands run and exit.

### Run / test / lint / build

- Tests: `python3 -m pytest tests/ -v` (config in `pytest.ini`, `asyncio_mode = auto`). No network needed.
- Lint: none configured (no ruff/flake8/black/pyproject). Don't invent a lint step.
- Build: none — it's a plain Python package run via `-m src.main`. No compile/build step.
- The `pip` console scripts (`pytest`, `playwright`) land in `~/.local/bin`, which is not on `PATH`.
  Always invoke via `python3 -m pytest` / `python3 -m playwright` instead of the bare command.

### What works in the cloud VM vs. what does not

- Works offline (no creds/network): `virtual-test`, `calc`, `list-sports`, and all tests. Use the
  `mock` adapter (`config/settings.test.yaml`) for a self-contained end-to-end arbitrage demo:
  `python3 -m src.main virtual-test --scans 8`.
- Works with network egress: `pinnacle` and `scan`'s Pinnacle side use Pinnacle's public "guest" API
  (no login). `python3 -m src.main pinnacle --sport football --limit 5` returns live odds.
- Does NOT work in the cloud VM: the `pbc00` adapter and the `discover` / `pbc00-login` /
  `pbc00-setup` commands. They drive a real browser via Playwright against pbc00.com, which is behind
  Cloudflare and requires an interactive login — README explicitly says "local PC only". Running
  `playwright install chromium` is only useful on a local machine for these; skip it in the cloud.

### Config loading gotcha

- `load_config(None)` searches `config/settings.yaml` then falls back to `config/settings.yaml.example`.
  `config/settings.yaml` is gitignored, so on a fresh checkout the example file is used. Commands that
  take `-c/--config` (e.g. `virtual-test-real -c config/settings.real.yaml`) override this. `virtual-test`
  always uses `config/settings.test.yaml` (mock A/B), so it never touches the network.
