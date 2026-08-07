from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QLabel,
    QVBoxLayout,
    QWizard,
    QWizardPage,
)


class SetupWizard(QWizard):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("arb-desktop 초기 설정")
        self.setWizardStyle(QWizard.WizardStyle.ModernStyle)
        self.addPage(self._page(
            "1. Chrome 확장 설치",
            "chrome://extensions 에서 개발자 모드를 켜고\n"
            "프로그램 폴더의 chrome-bridge 를 '압축해제된 확장 프로그램을 로드합니다'로 추가하세요.\n\n"
            "Token 입력은 필요 없습니다. 확장이 자동으로 페어링됩니다.",
        ))
        self.addPage(self._page(
            "2. Bridge 연결",
            "ArbDesktop.exe 를 실행하면 WebSocket·페어링 서버가 자동 시작됩니다.\n"
            "확장 프로그램이 localhost 로 자동 페어링 후 CONNECTED 상태가 됩니다.\n"
            "연결 상태가 CONNECTED 가 되면 다음 단계로 진행합니다.",
        ))
        self.addPage(self._page(
            "3. 사이트 탭 준비",
            "평소 Chrome에서 BC.Game 과 x10x10s 를 로그인한 상태로 탭을 열어두세요.\n"
            "Chrome 을 종료할 필요 없습니다.",
        ))
        self.addPage(self._page(
            "4. 배팅카트 테스트",
            "양쪽 사이트에 배팅카트 항목을 1개씩 넣으세요.\n"
            "메인 화면에서 BC / x10 BetSlip 이 ACTIVE 로 표시되는지 확인합니다.",
        ))
        self.addPage(self._page(
            "5. 드라이런 READY",
            "'양쪽 카트가 서로 반대 선택' 체크 후 자동감시를 시작하세요.\n"
            "목표 수익률에 도달하면 READY 상태가 됩니다.\n"
            "실제 Bet 버튼은 클릭되지 않습니다.",
        ))

    def _page(self, title: str, body: str) -> QWizardPage:
        page = QWizardPage()
        page.setTitle(title)
        layout = QVBoxLayout(page)
        label = QLabel(body)
        label.setWordWrap(True)
        label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        layout.addWidget(label)
        return page
