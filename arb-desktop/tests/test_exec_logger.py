from __future__ import annotations

from pathlib import Path

from arb_desktop.execution.exec_logger import (
    begin_bet,
    begin_stake_sync,
    bet_step,
    get_exec_logger,
    stake_step,
)


def test_execution_log_file_path(tmp_path: Path) -> None:
    elog = get_exec_logger()
    elog.set_log_dir(tmp_path)
    assert elog.execution_log_path is not None
    assert elog.execution_log_path.name.startswith("execution-")
    assert elog.execution_log_path.suffix == ".log"


def test_stake_sync_steps_and_first_failure(tmp_path: Path) -> None:
    elog = get_exec_logger()
    elog.set_log_dir(tmp_path)
    begin_stake_sync()
    stake_step("CALCULATE", ok=True, reason="ok", requested="5.7000")
    stake_step("SEND", ok=False, reason="timeout")
    stake_step("CONTENT_RX", ok=False, reason="should not be first failure")

    text = elog.execution_log_path.read_text(encoding="utf-8")
    assert "BC STAKE SYNC: CALCULATE PASS" in text
    assert "BC STAKE SYNC: SEND FAIL reason=timeout" in text
    assert ">>> FIRST_FAILURE <<< BC STAKE SYNC / SEND / timeout" in text
    assert elog.first_failure == "BC STAKE SYNC / SEND / timeout"


def test_bet_steps_manual_mode(tmp_path: Path) -> None:
    elog = get_exec_logger()
    elog.set_log_dir(tmp_path)
    begin_bet(manual=True)
    bet_step("EXECUTION_START", ok=True, reason="prepare")
    bet_step("X10_BUTTON_FOUND", ok=False, reason="not-found")
    bet_step("RESULT", ok=False, reason="x10-bet-button-not-found")

    text = elog.execution_log_path.read_text(encoding="utf-8")
    assert "MANUAL BET: EXECUTION_START PASS" in text
    assert "MANUAL BET: X10_BUTTON_FOUND FAIL reason=not-found" in text
    assert ">>> FIRST_FAILURE <<< MANUAL BET / X10_BUTTON_FOUND / not-found" in text


def test_bet_steps_auto_mode(tmp_path: Path) -> None:
    elog = get_exec_logger()
    elog.set_log_dir(tmp_path)
    begin_bet(manual=False)
    bet_step("EXECUTION_START", ok=True, reason="prepare")

    text = elog.execution_log_path.read_text(encoding="utf-8")
    assert "AUTO BET: EXECUTION_START PASS" in text
