from __future__ import annotations

import argparse
from pathlib import Path

from arb_desktop.config import settings


def add_browser_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--profile-mode",
        choices=["existing", "dedicated"],
        default=None,
        help="Chrome 프로필 모드 (existing=기존 Chrome 프로필, dedicated=전용 arb 프로필)",
    )
    parser.add_argument(
        "--chrome-profile",
        dest="chrome_profile_directory",
        default=None,
        help="기존 프로필 디렉터리명 (예: Default, Profile 1)",
    )
    parser.add_argument(
        "--chrome-user-data",
        dest="chrome_user_data_dir",
        default=None,
        help="Chrome User Data 경로 (기본: OS별 Google Chrome 경로)",
    )


def apply_browser_arguments(args: argparse.Namespace) -> None:
    if args.profile_mode:
        settings.chrome_profile_mode = args.profile_mode
    if args.chrome_profile_directory:
        settings.chrome_profile_directory = args.chrome_profile_directory
    if args.chrome_user_data_dir:
        settings.chrome_user_data_dir = Path(args.chrome_user_data_dir)
