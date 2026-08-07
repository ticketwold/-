from __future__ import annotations

from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QLabel,
    QSpinBox,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from arb_desktop.ui.settings_store import AppSettings


class SettingsDialog(QDialog):
    def __init__(self, settings: AppSettings, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("설정")
        self.setMinimumWidth(480)
        self._settings = settings

        root = QVBoxLayout(self)
        tabs = QTabWidget()

        tabs.addTab(self._build_general_tab(), "일반")
        tabs.addTab(self._build_amount_tab(), "금액")
        tabs.addTab(self._build_fx_tab(), "환율")
        tabs.addTab(self._build_exec_tab(), "실행")
        tabs.addTab(self._build_advanced_tab(), "고급")
        root.addWidget(tabs)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)
        self._load(settings)

    def _build_general_tab(self) -> QWidget:
        w = QWidget()
        form = QFormLayout(w)
        self.combo_theme = QComboBox()
        self.combo_theme.addItems(["dark", "light"])
        self.spin_target = QDoubleSpinBox()
        self.spin_target.setRange(0, 50)
        self.spin_target.setSuffix(" %")
        self.spin_bti_stake = QSpinBox()
        self.spin_bti_stake.setRange(1000, 50_000_000)
        self.spin_bti_stake.setSuffix(" KRW")
        self.spin_stabilize = QDoubleSpinBox()
        self.spin_stabilize.setRange(0.5, 60)
        self.spin_stabilize.setSuffix(" s")
        self.spin_stable_count = QSpinBox()
        self.spin_stable_count.setRange(1, 20)
        self.chk_bet_close_wait = QCheckBox("배팅 닫힘 자동 대기")
        self.chk_auto_resume = QCheckBox("복구 시 자동감시 재개")
        form.addRow("테마", self.combo_theme)
        form.addRow("목표 수익률", self.spin_target)
        form.addRow("텐텐벳 배팅금액", self.spin_bti_stake)
        form.addRow("안정화 시간", self.spin_stabilize)
        form.addRow("동일 배당 확인", self.spin_stable_count)
        form.addRow(self.chk_bet_close_wait)
        form.addRow(self.chk_auto_resume)
        return w

    def _build_amount_tab(self) -> QWidget:
        w = QWidget()
        form = QFormLayout(w)
        self.chk_stake_sync = QCheckBox("BC 자동동기화")
        self.combo_round_krw = QComboBox()
        self.combo_round_krw.addItems(["100", "500", "1000", "10000"])
        self.combo_round_usdt = QComboBox()
        self.combo_round_usdt.addItems(["0.1", "0.01", "1.0"])
        form.addRow(self.chk_stake_sync)
        form.addRow("KRW 단위", self.combo_round_krw)
        form.addRow("USDT 단위", self.combo_round_usdt)
        return w

    def _build_fx_tab(self) -> QWidget:
        w = QWidget()
        form = QFormLayout(w)
        self.chk_fx_auto = QCheckBox("빗썸 자동 환율")
        self.spin_fx_refresh = QDoubleSpinBox()
        self.spin_fx_refresh.setRange(1, 60)
        self.spin_fx_refresh.setSuffix(" s")
        self.spin_fx_stale = QDoubleSpinBox()
        self.spin_fx_stale.setRange(5, 120)
        self.spin_fx_stale.setSuffix(" s")
        form.addRow(self.chk_fx_auto)
        form.addRow("환율 갱신", self.spin_fx_refresh)
        form.addRow("최대 지연", self.spin_fx_stale)
        return w

    def _build_exec_tab(self) -> QWidget:
        w = QWidget()
        form = QFormLayout(w)
        self.chk_dry = QCheckBox("Dry Run")
        self.chk_parallel_live = QCheckBox("Live Execution (실제 Bet 클릭)")
        self.chk_manual_skip = QCheckBox("수동 실행 확인 생략")
        self.chk_parallel_dry = QCheckBox("READY 시 드라이런 병렬")
        self.spin_pre_dispatch_ms = QDoubleSpinBox()
        self.spin_pre_dispatch_ms.setRange(10, 500)
        self.spin_pre_dispatch_ms.setSuffix(" ms")
        self.spin_odds_tolerance = QDoubleSpinBox()
        self.spin_odds_tolerance.setRange(0, 1)
        self.spin_odds_tolerance.setDecimals(3)
        form.addRow(self.chk_dry)
        form.addRow(self.chk_parallel_live)
        form.addRow(self.chk_manual_skip)
        form.addRow(self.chk_parallel_dry)
        form.addRow("재검증 시간", self.spin_pre_dispatch_ms)
        form.addRow("배당 허용치", self.spin_odds_tolerance)
        return w

    def _build_advanced_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)
        box = QGroupBox("Bridge / Debug")
        form = QFormLayout(box)
        self.lbl_bridge = QLabel(f"{self._settings.bridge_host}:{self._settings.bridge_port}")
        form.addRow("Bridge", self.lbl_bridge)
        layout.addWidget(box)
        layout.addStretch()
        return w

    def _load(self, s: AppSettings) -> None:
        self.combo_theme.setCurrentText(s.ui_theme)
        self.spin_target.setValue(s.target_profit_pct)
        self.spin_bti_stake.setValue(s.bti_stake_krw)
        self.chk_fx_auto.setChecked(s.fx_auto_enabled)
        self.spin_fx_refresh.setValue(s.fx_refresh_seconds)
        self.spin_fx_stale.setValue(s.fx_max_stale_seconds)
        self.spin_stabilize.setValue(s.stabilize_seconds)
        self.spin_stable_count.setValue(s.stable_count_required)
        self.chk_dry.setChecked(s.dry_run)
        self.chk_bet_close_wait.setChecked(s.bet_close_auto_wait)
        self.chk_auto_resume.setChecked(s.auto_resume_on_recovery)
        self.chk_parallel_dry.setChecked(s.parallel_dry_run_on_ready)
        self.chk_parallel_live.setChecked(s.parallel_execution_enabled)
        self.chk_stake_sync.setChecked(s.stake_sync_enabled)
        self.chk_manual_skip.setChecked(s.manual_confirm_skip)
        self.spin_pre_dispatch_ms.setValue(s.pre_dispatch_verify_ms)
        self.spin_odds_tolerance.setValue(s.odds_change_tolerance)
        idx = self.combo_round_krw.findText(str(s.round_unit_krw))
        if idx >= 0:
            self.combo_round_krw.setCurrentIndex(idx)
        idx = self.combo_round_usdt.findText(str(s.round_unit_usdt))
        if idx >= 0:
            self.combo_round_usdt.setCurrentIndex(idx)

    def collect(self) -> AppSettings:
        s = self._settings
        s.ui_theme = self.combo_theme.currentText()
        s.target_profit_pct = self.spin_target.value()
        s.bti_stake_krw = self.spin_bti_stake.value()
        s.fx_auto_enabled = self.chk_fx_auto.isChecked()
        s.fx_refresh_seconds = self.spin_fx_refresh.value()
        s.fx_max_stale_seconds = self.spin_fx_stale.value()
        s.stabilize_seconds = self.spin_stabilize.value()
        s.stable_count_required = self.spin_stable_count.value()
        s.dry_run = self.chk_dry.isChecked()
        s.bet_close_auto_wait = self.chk_bet_close_wait.isChecked()
        s.auto_resume_on_recovery = self.chk_auto_resume.isChecked()
        s.parallel_dry_run_on_ready = self.chk_parallel_dry.isChecked()
        s.parallel_execution_enabled = self.chk_parallel_live.isChecked()
        s.live_execution_enabled = self.chk_parallel_live.isChecked()
        s.stake_sync_enabled = self.chk_stake_sync.isChecked()
        s.manual_confirm_skip = self.chk_manual_skip.isChecked()
        s.pre_dispatch_verify_ms = self.spin_pre_dispatch_ms.value()
        s.odds_change_tolerance = self.spin_odds_tolerance.value()
        s.round_unit_krw = int(self.combo_round_krw.currentText())
        s.round_unit_usdt = float(self.combo_round_usdt.currentText())
        return s
