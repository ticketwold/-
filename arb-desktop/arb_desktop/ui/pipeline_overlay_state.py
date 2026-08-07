from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class PipelineSiteOverlay:
    site: str
    content_loaded: str = "no"
    frame_count: str = "0"
    frame_url: str = "—"
    scanner_root_found: str = "no"
    scanner_selector: str = "—"
    scanner_match_count: str = "0"
    parser_slip_count: str = "0"
    parser_odds: str = "—"
    parser_status: str = "—"
    service_worker_received: str = "no"
    python_received: str = "no"
    gui_applied: str = "no"

    def step_pass(self, value: str) -> bool:
        return str(value).lower() in {"yes", "true", "pass", "ok", "active"}

    def parser_ok(self) -> bool:
        if self.parser_status not in {"—", "", "none"}:
            return True
        if self.parser_slip_count not in {"0", "—", ""}:
            return True
        if self.parser_odds not in {"—", "", "none"}:
            return True
        return False

    def first_failure(self) -> str | None:
        if not self.step_pass(self.content_loaded):
            return "Content Script Loaded"
        if not self.step_pass(self.scanner_root_found):
            return "BetSlip Root Not Found"
        if not self.parser_ok():
            return "Parser — No Slip Data"
        if not self.step_pass(self.service_worker_received):
            return "Service Worker Not Received"
        if not self.step_pass(self.python_received):
            return "Python Not Received"
        if not self.step_pass(self.gui_applied):
            return "GUI Apply Failed"
        return None

    def to_dict(self) -> dict[str, str]:
        fail = self.first_failure()
        return {
            "site": self.site,
            "content_loaded": self.content_loaded,
            "frame_count": self.frame_count,
            "frame_url": self.frame_url,
            "scanner_root_found": self.scanner_root_found,
            "scanner_selector": self.scanner_selector,
            "scanner_match_count": self.scanner_match_count,
            "parser_slip_count": self.parser_slip_count,
            "parser_odds": self.parser_odds,
            "parser_status": self.parser_status,
            "service_worker_received": self.service_worker_received,
            "python_received": self.python_received,
            "gui_applied": self.gui_applied,
            "first_failure": fail or "",
            "all_pass": "yes" if fail is None else "no",
        }


@dataclass
class PipelineOverlayState:
    bc: PipelineSiteOverlay = field(default_factory=lambda: PipelineSiteOverlay(site="bc"))
    x10: PipelineSiteOverlay = field(default_factory=lambda: PipelineSiteOverlay(site="x10"))

    def site(self, key: str) -> PipelineSiteOverlay:
        return self.bc if key == "bc" else self.x10

    def to_payload(self) -> dict:
        return {
            "bc": self.bc.to_dict(),
            "x10": self.x10.to_dict(),
        }
