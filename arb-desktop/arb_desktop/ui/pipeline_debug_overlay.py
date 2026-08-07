from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import QFrame, QGridLayout, QGroupBox, QLabel, QVBoxLayout, QWidget


class _SitePipelinePanel(QGroupBox):
    def __init__(self, title: str, parent: QWidget | None = None) -> None:
        super().__init__(title, parent)
        self._mono = QFont("Consolas", 9)
        grid = QGridLayout(self)
        grid.setColumnStretch(1, 1)
        self._rows: dict[str, QLabel] = {}
        self.lbl_banner = QLabel("—")
        self.lbl_banner.setFont(self._mono)
        self.lbl_banner.setWordWrap(True)
        grid.addWidget(self.lbl_banner, 0, 0, 1, 2)

        sections = [
            ("content", "[Content Script]"),
            ("scanner", "[Scanner]"),
            ("parser", "[Parser]"),
            ("sw", "[Service Worker]"),
            ("python", "[Python]"),
            ("gui", "[GUI]"),
        ]
        row = 1
        for key, heading in sections:
            head = QLabel(heading)
            head.setFont(self._mono)
            head.setProperty("class", "muted")
            grid.addWidget(head, row, 0, 1, 2)
            row += 1
            self._rows[f"{key}_body"] = QLabel("—")
            self._rows[f"{key}_body"].setFont(self._mono)
            self._rows[f"{key}_body"].setWordWrap(True)
            self._rows[f"{key}_body"].setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            grid.addWidget(self._rows[f"{key}_body"], row, 0, 1, 2)
            row += 1

    def _paint(self, lbl: QLabel, ok: bool | None, text: str) -> None:
        lbl.setText(text)
        if ok is True:
            lbl.setProperty("class", "status-ok")
        elif ok is False:
            lbl.setProperty("class", "status-bad")
        else:
            lbl.setProperty("class", "mono")
        lbl.style().unpolish(lbl)
        lbl.style().polish(lbl)

    def update_site(self, data: dict) -> None:
        fail = data.get("first_failure") or ""
        if fail:
            self.lbl_banner.setText(f"FAIL\n{fail}")
            self.lbl_banner.setProperty("class", "status-bad")
        elif data.get("all_pass") == "yes":
            self.lbl_banner.setText("PASS — 전체 경로 정상")
            self.lbl_banner.setProperty("class", "status-ok")
        else:
            self.lbl_banner.setText("대기 중…")
            self.lbl_banner.setProperty("class", "muted")
        self.lbl_banner.style().unpolish(self.lbl_banner)
        self.lbl_banner.style().polish(self.lbl_banner)

        loaded = str(data.get("content_loaded", "no")).lower() == "yes"
        self._paint(
            self._rows["content_body"],
            loaded,
            f"Loaded: {'YES' if loaded else 'NO'}\n"
            f"Frame Count: {data.get('frame_count', '0')}\n"
            f"Frame URL: {data.get('frame_url', '—')}",
        )

        root = str(data.get("scanner_root_found", "no")).lower() == "yes"
        self._paint(
            self._rows["scanner_body"],
            root,
            f"BetSlip Root Found: {'YES' if root else 'NO'}\n"
            f"Selector: {data.get('scanner_selector', '—')}\n"
            f"Match Count: {data.get('scanner_match_count', '0')}",
        )

        slip_ok = str(data.get("parser_slip_count", "0")) not in {"—", ""}
        odds_ok = str(data.get("parser_odds", "—")) not in {"—", ""}
        status_ok = str(data.get("parser_status", "—")) not in {"—", ""}
        self._paint(
            self._rows["parser_body"],
            slip_ok or odds_ok or status_ok,
            f"Slip Count: {data.get('parser_slip_count', '0')}\n"
            f"Odds: {data.get('parser_odds', '—')}\n"
            f"Status: {data.get('parser_status', '—')}",
        )

        sw = str(data.get("service_worker_received", "no")).lower() == "yes"
        self._paint(
            self._rows["sw_body"],
            sw,
            f"Message Received: {'YES' if sw else 'NO'}",
        )

        py = str(data.get("python_received", "no")).lower() == "yes"
        self._paint(
            self._rows["python_body"],
            py,
            f"Message Received: {'YES' if py else 'NO'}",
        )

        gui = str(data.get("gui_applied", "no")).lower() == "yes"
        self._paint(
            self._rows["gui_body"],
            gui,
            f"Applied: {'YES' if gui else 'NO'}",
        )


class PipelineDebugOverlay(QFrame):
    """카트 인식 경로 실시간 Debug Overlay — BC / X10."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("class", "Card")
        root = QVBoxLayout(self)
        title = QLabel("Pipeline Debug Overlay")
        title.setProperty("class", "section-title")
        root.addWidget(title)
        row = QGridLayout()
        self.panel_bc = _SitePipelinePanel("BC")
        self.panel_x10 = _SitePipelinePanel("X10")
        row.addWidget(self.panel_bc, 0, 0)
        row.addWidget(self.panel_x10, 0, 1)
        root.addLayout(row)

    def update_payload(self, payload: dict | None) -> None:
        if not payload:
            return
        if "bc" in payload:
            self.panel_bc.update_site(payload["bc"])
        if "x10" in payload:
            self.panel_x10.update_site(payload["x10"])
