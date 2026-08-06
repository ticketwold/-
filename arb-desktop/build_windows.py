#!/usr/bin/env python3
"""Windows exe 빌드 — PyInstaller.

사용법:
  cd arb-desktop
  pip install pyinstaller
  python build_windows.py

출력:
  dist/ArbDesktop/ArbDesktop.exe
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent
CHROME_BRIDGE = WORKSPACE / "chrome-bridge"
DIST = ROOT / "dist" / "ArbDesktop"


def main() -> int:
    if shutil.which("pyinstaller") is None:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller>=6.0"])

    spec_args = [
        "pyinstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--name",
        "ArbDesktop",
        "--distpath",
        str(ROOT / "dist"),
        "--workpath",
        str(ROOT / "build"),
        "--specpath",
        str(ROOT),
        "--add-data",
        f"{CHROME_BRIDGE}{';' if sys.platform == 'win32' else ':'}chrome-bridge",
        "--hidden-import",
        "websockets",
        "--hidden-import",
        "websockets.legacy",
        "--hidden-import",
        "websockets.legacy.server",
        "--hidden-import",
        "PyQt6.QtCore",
        "--hidden-import",
        "PyQt6.QtGui",
        "--hidden-import",
        "PyQt6.QtWidgets",
        "--collect-submodules",
        "websockets",
        str(ROOT / "arb_desktop" / "main.py"),
    ]

    if sys.platform == "win32":
        spec_args.extend(["--version-file", str(ROOT / "version_info.txt")])

    print("Running:", " ".join(spec_args))
    subprocess.check_call(spec_args, cwd=ROOT)

    out_exe = DIST / "ArbDesktop.exe"
    if out_exe.exists():
        print(f"\nBuild OK: {out_exe}")
        print(f"chrome-bridge bundled at: {DIST / 'chrome-bridge'}")
    else:
        print("\nBuild finished — check dist/ folder")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
