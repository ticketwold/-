from __future__ import annotations

from arb_desktop.ui.pipeline_overlay_state import PipelineOverlayState, PipelineSiteOverlay


def test_first_failure_content_script() -> None:
    site = PipelineSiteOverlay(site="bc")
    assert site.first_failure() == "Content Script Loaded"


def test_first_failure_scanner() -> None:
    site = PipelineSiteOverlay(site="bc", content_loaded="yes")
    assert site.first_failure() == "BetSlip Root Not Found"


def test_first_failure_parser() -> None:
    site = PipelineSiteOverlay(site="bc", content_loaded="yes", scanner_root_found="yes")
    assert site.first_failure() == "Parser — No Slip Data"


def test_first_failure_service_worker() -> None:
    site = PipelineSiteOverlay(
        site="bc",
        content_loaded="yes",
        scanner_root_found="yes",
        parser_status="empty-slip",
    )
    assert site.first_failure() == "Service Worker Not Received"


def test_first_failure_gui_apply() -> None:
    site = PipelineSiteOverlay(
        site="bc",
        content_loaded="yes",
        scanner_root_found="yes",
        parser_status="ACTIVE",
        service_worker_received="yes",
        python_received="yes",
        gui_applied="no",
    )
    assert site.first_failure() == "GUI Apply Failed"


def test_all_pass() -> None:
    site = PipelineSiteOverlay(
        site="bc",
        content_loaded="yes",
        scanner_root_found="yes",
        parser_status="ACTIVE",
        service_worker_received="yes",
        python_received="yes",
        gui_applied="yes",
    )
    assert site.first_failure() is None
    assert site.to_dict()["all_pass"] == "yes"


def test_overlay_payload_keys() -> None:
    state = PipelineOverlayState()
    payload = state.to_payload()
    assert set(payload.keys()) == {"bc", "x10"}
    for key in ("bc", "x10"):
        data = payload[key]
        for field in (
            "content_loaded",
            "frame_count",
            "frame_url",
            "scanner_root_found",
            "scanner_selector",
            "scanner_match_count",
            "parser_slip_count",
            "parser_odds",
            "parser_status",
            "service_worker_received",
            "python_received",
            "gui_applied",
            "first_failure",
            "all_pass",
        ):
            assert field in data
