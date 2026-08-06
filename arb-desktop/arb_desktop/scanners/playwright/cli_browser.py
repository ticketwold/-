from __future__ import annotations

import argparse
from pathlib import Path

from arb_desktop.config import settings


def add_browser_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--setup-profile",
        action="store_true",
        help="최초 1회: 원본 Chrome 프로필을 arb-chrome-profile로 복제",
    )
    parser.add_argument(
        "--source-profile",
        default=None,
        help='복제할 원본 프로필명 (기본: "Profile 3")',
    )
    parser.add_argument(
        "--source-user-data",
        dest="chrome_source_user_data_dir",
        default=None,
        help="원본 Chrome User Data 경로",
    )
    parser.add_argument(
        "--automation-profile",
        dest="chrome_automation_profile_dir",
        default=None,
        help="자동화 전용 프로필 경로 (기본: ~/arb-chrome-profile)",
    )
    parser.add_argument(
        "--force-setup",
        action="store_true",
        help="이미 설정된 자동화 프로필을 다시 복제",
    )


def apply_browser_arguments(args: argparse.Namespace) -> None:
    if args.source_profile:
        settings.chrome_source_profile_directory = args.source_profile
    if args.chrome_source_user_data_dir:
        settings.chrome_source_user_data_dir = Path(args.chrome_source_user_data_dir)
    if args.chrome_automation_profile_dir:
        settings.chrome_automation_profile_dir = Path(args.chrome_automation_profile_dir)
