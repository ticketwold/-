from __future__ import annotations

import asyncio
from typing import Any

from PyQt6.QtCore import QObject, pyqtSignal, pyqtSlot

from arb_desktop.bridge.app import create_bridge_runtime
from arb_desktop.bridge.message_models import BridgeStatus
from arb_desktop.betslip.models import BetSlipReadResult
from arb_desktop.betslip.scanner import BetSlipScanner
from arb_desktop.config import settings
from arb_desktop.market_data.bithumb_fx import BithumbFxProvider, FxSnapshot
from arb_desktop.ui.settings_store import AppSettings, SettingsStore
from arb_desktop.ui.watch_engine import WatchEngine, WatchMetrics, WatchState


class BridgeWorker(QObject):
    bridge_status = pyqtSignal(object)
    slip_updated = pyqtSignal(str, object)
    x10_debug = pyqtSignal(object)
    watch_state = pyqtSignal(str, object, str)
    live_metrics = pyqtSignal(object)
    fx_updated = pyqtSignal(object)
    log_message = pyqtSignal(str, str, str, str, str, str)
    ready = pyqtSignal()
    error = pyqtSignal(str)

    def __init__(self, store: SettingsStore) -> None:
        super().__init__()
        self._store = store
        self._app_settings = store.load()
        store.apply_to_runtime(self._app_settings)
        self._pairing_store = store.pairing_store_from_settings(self._app_settings)
        self._runtime = None
        self._scanner: BetSlipScanner | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._watch_engine = WatchEngine()
        self._watching = False
        self._user_confirmed = False
        self._poll_task: asyncio.Task | None = None
        self._fx_task: asyncio.Task | None = None
        self._fx = BithumbFxProvider(
            refresh_interval=self._app_settings.fx_refresh_seconds,
            max_stale_seconds=self._app_settings.fx_max_stale_seconds,
        )
        self._fx_snapshot: FxSnapshot | None = None
        self._bridge_started = False

    @property
    def app_settings(self) -> AppSettings:
        return self._app_settings

    @property
    def bridge_connected(self) -> bool:
        return bool(self._runtime and self._runtime.manager.bridge_connected)

    def get_bc_read(self):
        if self._runtime:
            return self._runtime.manager.get_bc_read()
        from arb_desktop.betslip.models import BetSlipReadResult
        return BetSlipReadResult(site="bc", ok=False, empty=True)

    def get_bti_read(self):
        if self._runtime:
            return self._runtime.manager.get_bti_read()
        from arb_desktop.betslip.models import BetSlipReadResult
        return BetSlipReadResult(site="bti", ok=False, empty=True)

    def update_settings(self, app_settings: AppSettings) -> None:
        self._app_settings = app_settings
        self._store.apply_to_runtime(app_settings)
        self._fx._refresh_interval = app_settings.fx_refresh_seconds
        self._fx._max_stale_seconds = app_settings.fx_max_stale_seconds
        self._emit_live_metrics()

    def set_user_confirmed(self, confirmed: bool) -> None:
        self._user_confirmed = confirmed

    @pyqtSlot()
    def bootstrap(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._start_bridge())
            self.ready.emit()
            self._loop.run_forever()
        except Exception as exc:
            self.error.emit(str(exc))
        finally:
            if self._runtime and self._loop:
                self._loop.run_until_complete(self._runtime.stop())
            if self._loop:
                self._loop.close()

    async def _start_bridge(self) -> None:
        self._watch_engine.set_connecting()
        self._emit_watch_state()

        def on_status(status: BridgeStatus) -> None:
            self.bridge_status.emit(status)

        def on_slip(site: str, read: BetSlipReadResult) -> None:
            label = "BC" if site == "bc" else "X10"
            odds = f"{read.first.odds:.2f}" if read.first and read.first.odds else "-"
            status = read.first.status.value if read.first else "EMPTY"
            self.log_message.emit(
                label,
                status,
                odds,
                "-",
                "slip updated",
                f"{label}|{status}|{odds}|slip updated",
            )
            if site == "bti" and read.raw:
                reason = read.reason or read.raw.get("reason") or ""
                found = read.raw.get("slip_root_found") or "?"
                inner = str(read.raw.get("slip_inner_text") or "")[:1000]
                hits = read.raw.get("selector_hits") or []
                hit_summary = ", ".join(
                    f"{h.get('selector')}={h.get('match_count', 0)}" for h in hits[:6]
                )
                self.log_message.emit(
                    "X10DBG",
                    reason or status,
                    found,
                    str(len(hits)),
                    inner[:120] or hit_summary,
                    f"X10DBG|{reason}|{found}|{hit_summary}",
                )
                self.x10_debug.emit(read.raw)
            self.slip_updated.emit(site, read)
            self._emit_live_metrics()
            if self._watching:
                asyncio.run_coroutine_threadsafe(self._evaluate_watch(), self._loop)

        def on_debug(payload: dict[str, Any]) -> None:
            site = str(payload.get("site") or "").lower()
            block = str(payload.get("block") or "").upper()
            if site not in {"x10", "bti"}:
                return
            if block in {"X10 DEBUG", "SLIP ROOT FOUND", "FRAME DEBUG", "FRAME SCAN"}:
                self.x10_debug.emit(payload)
            if block == "X10 DEBUG":
                inner = str(payload.get("slip_inner_text") or "")[:1000]
                found = payload.get("slip_root_found") or payload.get("found") or "?"
                reason = payload.get("reason") or ""
                self.log_message.emit(
                    "X10DBG",
                    reason,
                    str(found),
                    str(payload.get("body_text_length", "")),
                    inner[:120],
                    f"X10DBG|{reason}|{found}|{payload.get('frame_url', '')}",
                )

        self._runtime = create_bridge_runtime(
            pairing_store=self._pairing_store,
            on_status_change=on_status,
            on_slip_update=on_slip,
            on_debug=on_debug,
        )
        self._scanner = BetSlipScanner(self._runtime.session)
        await self._runtime.start()
        self._bridge_started = True
        self._watch_engine.set_idle()
        self._emit_watch_state()
        self._poll_task = asyncio.create_task(self._poll_loop())
        self._fx_task = asyncio.create_task(self._fx_loop())

    async def _fx_loop(self) -> None:
        while True:
            try:
                snap = await self._fx.refresh()
                self._fx_snapshot = snap
                if snap.rate is not None:
                    self._app_settings.usdt_rate = snap.rate
                self.fx_updated.emit(snap)
                self._emit_live_metrics()
                if self._watching:
                    await self._evaluate_watch()
            except Exception:
                pass
            await asyncio.sleep(self._app_settings.fx_refresh_seconds)

    async def _poll_loop(self) -> None:
        while True:
            try:
                if self._runtime:
                    await self._runtime.server.request_status()
                    self._emit_live_metrics()
                    if self._watching:
                        await self._evaluate_watch()
            except Exception:
                pass
            await asyncio.sleep(settings.scan_interval_ms / 1000)

    def _emit_live_metrics(self) -> None:
        if not self._runtime:
            return
        metrics = self._watch_engine.compute_live_metrics(
            bc=self._runtime.manager.get_bc_read(),
            bti=self._runtime.manager.get_bti_read(),
            settings=self._app_settings,
            fx=self._fx_snapshot,
        )
        self.live_metrics.emit(metrics)

    async def _evaluate_watch(self) -> None:
        if not self._runtime:
            return
        bc = self._runtime.manager.get_bc_read()
        bti = self._runtime.manager.get_bti_read()
        state, metrics, err_key = self._watch_engine.tick(
            bridge_connected=self._runtime.manager.bridge_connected,
            bc=bc,
            bti=bti,
            settings=self._app_settings,
            fx=self._fx_snapshot,
            user_confirmed=self._user_confirmed,
        )
        self._emit_watch_state(metrics, err_key)
        if err_key == "below-target":
            self.log_message.emit(
                "ENGINE",
                state.value,
                "-",
                f"{metrics.current_profit_rate:.2f}%",
                metrics.message,
                f"ENGINE|{state.value}|{metrics.current_profit_rate:.2f}|below-target",
            )
        elif state == WatchState.READY:
            self.log_message.emit(
                "ENGINE",
                "READY",
                "-",
                f"{metrics.current_profit_rate:.2f}%",
                "target reached",
                f"ENGINE|READY|{metrics.current_profit_rate:.2f}|ready",
            )

    def _emit_watch_state(self, metrics: WatchMetrics | None = None, err: str | None = None) -> None:
        m = metrics or self._watch_engine.metrics
        msg = m.message or err or ""
        self.watch_state.emit(self._watch_engine.state.value, m, msg)

    @pyqtSlot()
    def reconnect(self) -> None:
        if self._loop and self._runtime:
            asyncio.run_coroutine_threadsafe(self._runtime.server.request_status(), self._loop)

    @pyqtSlot()
    def repair_pairing(self) -> None:
        if self._loop and self._runtime:
            self._runtime.reset_pairing()
            self._store.save(self._app_settings)
            asyncio.run_coroutine_threadsafe(self._runtime.server.request_status(), self._loop)

    @pyqtSlot()
    def reset_connection(self) -> None:
        self._watching = False
        self._watch_engine.stop_watch()
        self._emit_watch_state()
        if self._loop and self._runtime:
            self._runtime.reset_pairing()
            self._store.save(self._app_settings)

    @pyqtSlot()
    def start_watch(self) -> None:
        self._watching = True
        self._watch_engine.start_watch(user_confirmed=self._user_confirmed)
        self._emit_watch_state()
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._evaluate_watch(), self._loop)

    @pyqtSlot()
    def stop_watch(self) -> None:
        self._watching = False
        self._watch_engine.stop_watch()
        self._emit_watch_state()

    @pyqtSlot()
    def stop_bridge(self) -> None:
        self._watching = False
        if self._poll_task:
            self._poll_task.cancel()
        if self._fx_task:
            self._fx_task.cancel()
        if self._loop and self._runtime:
            asyncio.run_coroutine_threadsafe(self._runtime.stop(), self._loop)
