from __future__ import annotations

from datetime import datetime

from PyQt6.QtCore import QObject, pyqtSignal, pyqtSlot

from arb_desktop.bridge.app import create_bridge_runtime
from arb_desktop.bridge.message_models import BridgeStatus
from arb_desktop.betslip.models import BetSlipReadResult
from arb_desktop.betslip.scanner import BetSlipScanner
from arb_desktop.config import settings
from arb_desktop.betslip.odds_only_calc import compute_odds_only_metrics
from arb_desktop.execution.dispatch_readiness import assess_dispatch_readiness
from arb_desktop.execution.exec_logger import get_exec_logger
from arb_desktop.execution.execution_engine import ExecutionEngine
from arb_desktop.execution.stake_sync_service import StakeSyncState
from arb_desktop.execution.parallel_orchestrator import DispatchContext, ParallelBetOrchestrator
from arb_desktop.market_data.bithumb_fx import BithumbFxProvider, FxSnapshot
from arb_desktop.ui.odds_log_manager import OddsLogManager
from arb_desktop.ui.pipeline_overlay_state import PipelineOverlayState
from arb_desktop.ui.settings_store import AppSettings, SettingsStore
from arb_desktop.ui.watch_engine import WatchEngine, WatchMetrics, WatchState


class BridgeWorker(QObject):
    bridge_status = pyqtSignal(object)
    slip_updated = pyqtSignal(str, object)
    x10_debug = pyqtSignal(object)
    watch_state = pyqtSignal(str, object, str)
    live_metrics = pyqtSignal(object)
    fx_updated = pyqtSignal(object)
    execution_update = pyqtSignal(object)
    bc_stake_debug = pyqtSignal(object)
    bc_slip_debug = pyqtSignal(object)
    pipeline_overlay_updated = pyqtSignal(object)
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
        self._orchestrator = ParallelBetOrchestrator()
        self._execution = ExecutionEngine()
        self._dispatch_running = False
        self._stake_sync_running = False
        self._odds_log: OddsLogManager | None = None
        self._last_engine_log_state: str = ""
        self._bet_button_cache: dict[str, str] = {"x10": "?", "bc": "?"}
        self._pipeline_overlay = PipelineOverlayState()
        get_exec_logger().set_log_dir(store.logs_dir)
        get_exec_logger().add_listener(self._on_exec_log)

    def _on_exec_log(self, line: str, _payload: dict[str, Any]) -> None:
        self.log_message.emit("EXEC", "-", "-", "-", line, line)

    def attach_odds_log(self, manager: OddsLogManager) -> None:
        self._odds_log = manager

    @property
    def watch_enabled(self) -> bool:
        return self._watching

    @property
    def watch_metrics(self) -> WatchMetrics:
        return self._watch_engine.metrics

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
        from arb_desktop.startup_crash import startup_log

        startup_log("[STARTUP 6] start Bridge")
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._start_bridge())
            startup_log("[STARTUP 7] start FX worker")
            self.ready.emit()
        except Exception as exc:
            startup_log(f"[STARTUP 6] Bridge failed: {type(exc).__name__}: {exc}")
            self.error.emit(f"Bridge ERROR: {exc}")
            self._watch_engine.set_idle()
            self._emit_watch_state()
            if not self._fx_task:
                try:
                    startup_log("[STARTUP 7] start FX worker (degraded)")
                    self._fx_task = asyncio.create_task(self._fx_loop())
                except Exception as fx_exc:
                    startup_log(f"[STARTUP 7] FX failed: {type(fx_exc).__name__}: {fx_exc}")
                    self.error.emit(f"FX ERROR: {fx_exc}")
        try:
            self._loop.run_forever()
        except Exception as exc:
            self.error.emit(str(exc))
        finally:
            if self._runtime and self._loop:
                try:
                    self._loop.run_until_complete(self._runtime.stop())
                except Exception:
                    pass
            if self._loop:
                self._loop.close()

    async def _start_bridge(self) -> None:
        self._watch_engine.set_connecting()
        self._emit_watch_state()

        def on_status(status: BridgeStatus) -> None:
            self.bridge_status.emit(status)

        def on_slip_rx(site: str, read: BetSlipReadResult) -> None:
            site_key = "bc" if site == "bc" else "x10"
            self._apply_slip_pipeline(site_key, read, gui_applied=False)
            overlay = self._pipeline_overlay.site(site_key)
            overlay.python_received = "yes"
            overlay.service_worker_received = "yes"
            self._emit_pipeline_overlay(site_key)

        def on_slip(site: str, read: BetSlipReadResult) -> None:
            site_key = "bc" if site == "bc" else "x10"
            self._apply_slip_pipeline(site_key, read, gui_applied=True)
            overlay = self._pipeline_overlay.site(site_key)
            overlay.python_received = "yes"
            overlay.gui_applied = "yes"
            overlay.service_worker_received = "yes"
            self._emit_pipeline_overlay(site_key)
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
                try:
                    rev = int(read.raw.get("revision") or 0)
                except (TypeError, ValueError):
                    rev = 0
                self._watch_engine.metrics.x10_slip_revision = rev
                ts_raw = read.raw.get("timestamp")
                if ts_raw:
                    try:
                        ts_val = float(ts_raw)
                        if ts_val > 1e12:
                            ts_val /= 1000.0
                        stamp = datetime.fromtimestamp(ts_val)
                    except (TypeError, ValueError, OSError):
                        stamp = datetime.now()
                else:
                    stamp = datetime.now()
                self._watch_engine.metrics.x10_slip_updated_at = stamp.strftime("%H:%M:%S.%f")[:-3]
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
            asyncio.run_coroutine_threadsafe(self._maybe_stake_sync(), self._loop)
            if self._watching:
                asyncio.run_coroutine_threadsafe(self._evaluate_watch(), self._loop)

        def on_debug(payload: dict[str, Any]) -> None:
            site = str(payload.get("site") or "").lower()
            block = str(payload.get("block") or "").upper()
            site_key = "bc" if site == "bc" else "x10" if site in {"x10", "bti"} else ""
            if site_key:
                self._apply_debug_pipeline(site_key, payload)
                self._emit_pipeline_overlay(site_key)
            if site == "bc":
                if block.startswith("BC STAKE") or block == "BC INPUT SCAN" or payload.get("step"):
                    self.bc_stake_debug.emit(payload)
                if block in {
                    "BC DEBUG",
                    "BC FRAME",
                    "CONTENT SCRIPT LOADED",
                    "SLIP ITEM",
                    "SLIP ROOT FOUND",
                    "FRAME SCAN",
                    "PIPELINE TRACE",
                } or payload.get("slip_root_found"):
                    self.bc_slip_debug.emit(payload)
            if site in {"x10", "bti"}:
                if block in {
                    "X10 DEBUG",
                    "SLIP ROOT FOUND",
                    "FRAME DEBUG",
                    "FRAME SCAN",
                    "CONTENT SCRIPT LOADED",
                    "PIPELINE TRACE",
                }:
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

        def on_stake_input_changed() -> None:
            if self._loop:
                asyncio.run_coroutine_threadsafe(self._maybe_stake_sync(), self._loop)

        self._runtime = create_bridge_runtime(
            pairing_store=self._pairing_store,
            on_status_change=on_status,
            on_slip_update=on_slip,
            on_slip_rx=on_slip_rx,
            on_debug=on_debug,
        )
        self._runtime.manager.on_stake_input_changed = on_stake_input_changed
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
                if self._loop:
                    asyncio.run_coroutine_threadsafe(self._maybe_stake_sync(), self._loop)
                if self._watching:
                    await self._evaluate_watch()
            except Exception as exc:
                self.error.emit(f"FX ERROR: {exc}")
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
        self._watch_engine.enrich_ui_context(
            metrics,
            settings=self._app_settings,
            bridge_connected=self._runtime.manager.bridge_connected,
            user_confirmed=self._user_confirmed,
        )
        self._apply_stake_sync_metrics(metrics)
        self._log_odds_metrics(metrics)
        self.live_metrics.emit(metrics)

    def _apply_stake_sync_metrics(self, metrics: WatchMetrics) -> None:
        status = self._execution.stake_sync.last_status
        if not status:
            return
        metrics.stake_sync_enabled = self._app_settings.stake_sync_enabled
        metrics.stake_sync_state = status.state.value if hasattr(status.state, "value") else str(status.state)
        metrics.stake_sync_calculated_usdt = status.calculated_usdt
        metrics.stake_sync_actual_usdt = status.actual_usdt
        metrics.stake_sync_message = status.message
        metrics.stake_sync_reason = status.reason
        metrics.stake_sync_debug = status.debug or {}
        metrics.bc_stake_input_found = bool(status.debug.get("found")) if status.debug else False

        if metrics.stake_sync_enabled:
            calc = status.calculated_usdt
            if calc is None and metrics.bc_stake_usdt:
                metrics.stake_sync_calculated_usdt = metrics.bc_stake_usdt
            state = metrics.stake_sync_state
            if state in {StakeSyncState.INPUT_NOT_FOUND.value, StakeSyncState.FAILED.value}:
                if status.reason in {"input-not-found", "stake-input-not-found"} or "not-found" in (status.reason or ""):
                    metrics.stake_sync_message = status.message or "input-not-found"
            elif state == StakeSyncState.SYNCING.value:
                metrics.stake_sync_message = status.message or "동기화 중..."

        if self._runtime:
            readiness = assess_dispatch_readiness(
                metrics=metrics,
                settings=self._app_settings,
                bridge_connected=self._runtime.manager.bridge_connected,
                bc=self._runtime.manager.get_bc_read(),
                bti=self._runtime.manager.get_bti_read(),
                fx=self._fx_snapshot,
                stake_sync=self._execution.stake_sync,
                watch_state=self._watch_engine.state,
                watch_enabled=self._watching,
            )
            readiness.checklist["X10 Bet Button"] = self._bet_button_cache.get("x10", "?")
            readiness.checklist["BC Bet Button"] = self._bet_button_cache.get("bc", "?")
            metrics.exec_checklist = readiness.checklist
            metrics.dispatch_block_reason = readiness.first_failure
            metrics.live_execution_on = self._app_settings.live_execution_enabled
            metrics.dry_run_on = self._app_settings.dry_run

        metrics.execution_phase = self._execution.state.phase.value
        metrics.execution_message = self._execution.state.message
        metrics.dispatch_gap_ms = self._execution.state.dispatch_gap_ms

    async def _maybe_stake_sync(self) -> None:
        if not self._runtime or self._stake_sync_running or not self._app_settings.stake_sync_enabled:
            return
        self._stake_sync_running = True
        try:
            await self._execution.maybe_sync_stakes(
                server=self._runtime.server,
                bridge_connected=self._runtime.manager.bridge_connected,
                bc=self._runtime.manager.get_bc_read(),
                bti=self._runtime.manager.get_bti_read(),
                settings=self._app_settings,
                fx=self._fx_snapshot,
            )
            self._emit_live_metrics()
            self.execution_update.emit(self._execution.state)
        finally:
            self._stake_sync_running = False

    def _log_odds_metrics(self, metrics: WatchMetrics) -> None:
        if not self._odds_log:
            return
        profit = metrics.current_profit_rate if metrics.total_stake_krw else None
        watch = self._watching
        self._odds_log.observe_site(
            site="X10",
            odds=metrics.bti_odds,
            display_odds=metrics.bti_display_odds,
            status=metrics.x10_site_label,
            watch_enabled=watch,
            profit_rate=profit,
            status_reason=metrics.x10_status_reason,
        )
        self._odds_log.observe_site(
            site="BC",
            odds=metrics.bc_odds,
            status=metrics.bc_site_label,
            watch_enabled=watch,
            profit_rate=profit,
        )

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
        get_exec_logger().log("WATCH", ok=True, state=state.value, reason=err_key or "")
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
            if self._watch_engine.consume_ready_for_dispatch():
                live = self._app_settings.live_execution_enabled
                should_dispatch = live and not self._app_settings.dry_run
                if not should_dispatch:
                    reason = "live_execution_disabled"
                    if not live:
                        reason = "live_execution_disabled"
                    elif self._app_settings.dry_run:
                        reason = "dry_run_enabled"
                    get_exec_logger().log("DISPATCH", ok=False, reason=reason)
                if should_dispatch:
                    asyncio.create_task(self._run_parallel_dispatch(manual=False))

    async def _run_parallel_dispatch(self, *, manual: bool = False, skip_target_check: bool = False) -> None:
        if not self._runtime or self._dispatch_running:
            return
        self._dispatch_running = True
        try:
            if manual:
                get_exec_logger().log("MANUAL_BET", button_clicked="PASS")
            if not self._runtime.manager.bridge_connected:
                if manual:
                    get_exec_logger().log("MANUAL_BET", execution_engine_called="FAIL", reason="bridge-disconnected")
                return
            if manual:
                live = self._app_settings.live_execution_enabled
                if not live:
                    get_exec_logger().log("MANUAL_BET", dispatch_started="FAIL", reason="live_execution_disabled")
                    self.log_message.emit(
                        "BET",
                        "BLOCKED",
                        "-",
                        "-",
                        "Live Execution OFF",
                        "MANUAL BET|Live Execution OFF",
                    )
                    self.execution_update.emit(self._execution.state)
                    return
                get_exec_logger().log("MANUAL_BET", execution_engine_called="PASS")
            if self._runtime:
                await self._runtime.server.request_status()
                await asyncio.sleep(0.25)
            bc = self._runtime.manager.get_bc_read()
            bti = self._runtime.manager.get_bti_read()
            if manual:
                self._watch_engine.set_dispatch_state(WatchState.PREPARING, "수동 배팅 준비")
            else:
                self._watch_engine.set_dispatch_state(WatchState.PREPARING, "동시 배팅 준비")
            self._emit_watch_state()
            await asyncio.sleep(self._app_settings.pre_dispatch_verify_ms / 1000)
            if self._runtime:
                bc = self._runtime.manager.get_bc_read()
                bti = self._runtime.manager.get_bti_read()
            self._watch_engine.set_dispatch_state(WatchState.DISPATCHING, "양쪽 배팅 전송 중")
            self._emit_watch_state()
            result = await self._execution.prepare_and_dispatch(
                server=self._runtime.server,
                bridge_connected=self._runtime.manager.bridge_connected,
                bc=bc,
                bti=bti,
                settings=self._app_settings,
                fx=self._fx_snapshot,
                manual=manual,
                skip_target_check=skip_target_check,
                get_reads=lambda: (
                    self._runtime.manager.get_bc_read(),
                    self._runtime.manager.get_bti_read(),
                ),
            )
            if manual:
                get_exec_logger().log(
                    "MANUAL_BET",
                    dispatch_started="PASS" if result.outcome.name != "CANCELLED" else "FAIL",
                    reason=result.abort_reason or result.outcome.value,
                )
            for line in result.log_lines:
                self.log_message.emit("BET", result.outcome.value, "-", "-", line, f"BET|{line}")
            if result.abort_reason:
                self.log_message.emit(
                    "BET",
                    "CANCELLED",
                    "-",
                    "-",
                    result.abort_reason,
                    f"BET|CANCELLED|{result.abort_reason}",
                )
            self._watch_engine.set_dispatch_state(WatchState.VERIFYING_RESULT, "결과 확인")
            self._emit_watch_state()
            self.execution_update.emit(self._execution.state)
            if result.outcome.name == "CANCELLED":
                self._watch_engine.mark_dispatch_complete(success=False)
                self._emit_watch_state()
                return
            if result.partial:
                if not manual:
                    self._watching = False
                self._watch_engine.mark_dispatch_complete(partial=True)
                self.log_message.emit(
                    "ENGINE",
                    "PARTIAL BET",
                    "-",
                    "-",
                    "MANUAL ACTION REQUIRED",
                    "ENGINE|PARTIAL|manual",
                )
            elif result.outcome.name.endswith("SUCCESS") or result.outcome.value == "DRY_RUN_MOCK":
                self._watch_engine.mark_dispatch_complete(success=True)
            else:
                self._watch_engine.mark_dispatch_complete(success=False)
            self._emit_watch_state()
        finally:
            self._dispatch_running = False

    def _apply_debug_pipeline(self, site_key: str, payload: dict[str, Any]) -> None:
        site = self._pipeline_overlay.site(site_key)
        block = str(payload.get("block") or "").upper()
        site.service_worker_received = "yes"

        if block == "CONTENT SCRIPT LOADED" or payload.get("type") == "content_loaded":
            site.content_loaded = "yes"
            injected = payload.get("injected_frames")
            if injected is not None:
                site.frame_count = str(injected)
            urls = payload.get("injected_frame_urls") or []
            if urls:
                site.frame_url = str(urls[0]) if len(urls) == 1 else f"{urls[0]} (+{len(urls) - 1})"

        frame_url = payload.get("frame_url") or payload.get("document_location")
        if frame_url:
            site.frame_url = str(frame_url)

        if block == "FRAME SCAN":
            total = payload.get("total_selector_matches")
            if total is not None:
                site.scanner_match_count = str(total)
                if int(total) > 0:
                    site.scanner_root_found = "yes"
            if payload.get("betslipSelection_count") is not None:
                count = int(payload.get("betslipSelection_count") or 0)
                site.scanner_match_count = str(count)
                if count > 0:
                    site.scanner_root_found = "yes"
                    site.scanner_selector = '[data-editor-id="betslipSelection"]'
            scans = payload.get("selector_scans") or payload.get("selector_hits") or []
            if scans:
                best = max(scans, key=lambda row: int(row.get("match_count") or 0))
                best_count = int(best.get("match_count") or 0)
                if best_count > 0:
                    site.scanner_root_found = "yes"
                    site.scanner_selector = str(best.get("selector") or site.scanner_selector)
                    site.scanner_match_count = str(best_count)

        if block in {"SLIP ROOT FOUND", "BC DEBUG", "X10 DEBUG", "BC FRAME"}:
            found = payload.get("slip_root_found") or payload.get("found")
            if str(found).upper() == "YES":
                site.scanner_root_found = "yes"
            selector = payload.get("selector") or payload.get("container_selector")
            if selector:
                site.scanner_selector = str(selector)
            match_count = payload.get("match_count")
            if match_count is not None:
                site.scanner_match_count = str(match_count)
                if int(match_count) > 0:
                    site.scanner_root_found = "yes"

        if block in {"BC DEBUG", "X10 DEBUG", "SLIP ITEM"} or payload.get("slip_count") is not None:
            if payload.get("slip_count") is not None:
                site.parser_slip_count = str(payload.get("slip_count"))
            odds = payload.get("extracted_odds")
            if odds is None:
                odds = payload.get("odds")
            if odds is not None and odds != "":
                site.parser_odds = str(odds)
            status = (
                payload.get("parsed_status")
                or payload.get("status")
                or payload.get("status_reason")
                or payload.get("reason")
            )
            if status:
                site.parser_status = str(status)

        if block == "PIPELINE TRACE":
            trace = payload.get("trace") or {}
            if trace.get("content_loaded") == "yes":
                site.content_loaded = "yes"
            if trace.get("service_worker_received") == "yes":
                site.service_worker_received = "yes"
            if trace.get("python_received") == "yes":
                site.python_received = "yes"
            if trace.get("gui_applied") == "yes":
                site.gui_applied = "yes"

    def _apply_slip_pipeline(self, site_key: str, read: BetSlipReadResult, *, gui_applied: bool) -> None:
        site = self._pipeline_overlay.site(site_key)
        site.service_worker_received = "yes"
        site.python_received = "yes"
        site.gui_applied = "yes" if gui_applied else "no"

        raw = read.raw or {}
        if read.frame_url:
            site.frame_url = read.frame_url
        slip_count = raw.get("slip_count")
        if slip_count is None:
            slip_count = len(read.items or [])
        site.parser_slip_count = str(slip_count)
        if read.first and read.first.odds is not None:
            site.parser_odds = f"{read.first.odds:.2f}"
        elif raw.get("extracted_odds") is not None:
            site.parser_odds = str(raw.get("extracted_odds"))
        if read.first:
            site.parser_status = read.first.status.value
        elif raw.get("parsed_status") or raw.get("reason"):
            site.parser_status = str(raw.get("parsed_status") or raw.get("reason"))

        found = raw.get("slip_root_found")
        if str(found).upper() == "YES" or slip_count or (read.items and len(read.items) > 0):
            site.scanner_root_found = "yes"
        selector = read.container_selector or raw.get("container_selector")
        if selector:
            site.scanner_selector = str(selector)

    def _emit_pipeline_overlay(self, site_key: str) -> None:
        payload = self._pipeline_overlay.to_payload()
        site_data = payload.get(site_key, {})
        emit_payload = {
            "block": "PIPELINE TRACE",
            "site": site_key,
            "trace": site_data,
            **site_data,
        }
        if site_key == "bc":
            self.bc_slip_debug.emit(emit_payload)
        else:
            self.x10_debug.emit(emit_payload)
        self.pipeline_overlay_updated.emit(payload)
        fail = site_data.get("first_failure") or ""
        status = "PASS" if site_data.get("all_pass") == "yes" else ("FAIL" if fail else "WAIT")
        self.log_message.emit(
            "TRACE",
            site_key.upper(),
            status,
            fail or "-",
            self._pipeline_overlay_line(site_key),
            f"TRACE|{site_key}|{status}|{fail}",
        )

    def _pipeline_overlay_line(self, site_key: str) -> str:
        site = self._pipeline_overlay.site(site_key).to_dict()
        return " ".join(f"{k}={v}" for k, v in site.items() if k not in {"site", "first_failure", "all_pass"})

    def _emit_pipeline_trace(self, site_key: str) -> None:
        self._emit_pipeline_overlay(site_key)

    @pyqtSlot()
    def force_rescan_x10(self) -> None:
        if self._loop and self._runtime:
            asyncio.run_coroutine_threadsafe(self._force_rescan("x10"), self._loop)

    @pyqtSlot()
    def force_rescan_bc(self) -> None:
        if self._loop and self._runtime:
            asyncio.run_coroutine_threadsafe(self._force_rescan("bc"), self._loop)

    async def _force_rescan(self, site: str) -> None:
        if not self._runtime:
            return
        await self._runtime.server.request_slip_scan(site)
        self.log_message.emit(
            "TRACE",
            site.upper(),
            "SCAN",
            "-",
            f"force rescan {site}",
            f"TRACE|{site}|force-rescan",
        )

    @pyqtSlot()
    def scan_x10_bet_button(self) -> None:
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._scan_site_bet_button("x10"), self._loop)

    @pyqtSlot()
    def scan_bc_bet_button(self) -> None:
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._scan_site_bet_button("bc"), self._loop)

    async def _scan_site_bet_button(self, site: str) -> None:
        if not self._runtime:
            return
        result = await self._runtime.server.send_command(site, "scan_bet_buttons")
        ok = bool(result.ok)
        self._bet_button_cache[site] = "OK" if ok else "FAIL"
        label = "X10" if site == "x10" else "BC"
        block = f"{label} BET BUTTON"
        payload = {
            "block": block,
            "site": site,
            "found": ok,
            "ok": ok,
            "reason": result.reason or result.error or ("ok" if ok else "button-not-found"),
            "frame_url": (result.raw or {}).get("frame_url", ""),
            "button_text": (result.raw or {}).get("button_text", ""),
            "raw": result.raw,
        }
        get_exec_logger().log(block.replace(" ", "_"), ok=ok, reason=payload["reason"])
        self.bc_stake_debug.emit(payload)
        self._emit_live_metrics()

    @pyqtSlot()
    def scan_bet_buttons(self) -> None:
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._scan_bet_buttons(), self._loop)

    async def _scan_bet_buttons(self) -> None:
        if not self._runtime:
            return
        x10 = await self._runtime.server.send_command("x10", "scan_bet_buttons")
        bc = await self._runtime.server.send_command("bc", "scan_bet_buttons")
        x10_ok = bool(x10.ok)
        bc_ok = bool(bc.ok)
        self._bet_button_cache["x10"] = "OK" if x10_ok else "FAIL"
        self._bet_button_cache["bc"] = "OK" if bc_ok else "FAIL"
        get_exec_logger().log("X10_BET_BUTTON", ok=x10_ok, reason=x10.reason or x10.error or "")
        get_exec_logger().log("BC_BET_BUTTON", ok=bc_ok, reason=bc.reason or bc.error or "")
        payload = {
            "block": "BET BUTTON SCAN",
            "site": "bc",
            "x10_found": x10_ok,
            "bc_found": bc_ok,
            "x10_reason": x10.reason or x10.error or "",
            "bc_reason": bc.reason or bc.error or "",
            "x10_raw": x10.raw,
            "bc_raw": bc.raw,
        }
        self.bc_stake_debug.emit(payload)
        self._emit_live_metrics()

    @pyqtSlot(float)
    def test_bc_stake(self, amount_usdt: float = 1.0) -> None:
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._test_bc_stake(amount_usdt), self._loop)

    @pyqtSlot()
    def scan_bc_stake(self) -> None:
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._scan_bc_stake(), self._loop)

    async def _scan_bc_stake(self) -> None:
        if not self._runtime:
            return
        status = await self._execution.stake_sync.scan_bc_stake(server=self._runtime.server)
        debug = status.debug or {}
        payload = {
            "block": "BC INPUT SCAN",
            "site": "bc",
            "found": bool(debug.get("found")),
            "selector": debug.get("selector"),
            "frame_url": debug.get("frame_url"),
            "current_value": debug.get("current_value"),
            "debug": debug,
            **debug,
        }
        self.bc_stake_debug.emit(payload)
        self._emit_live_metrics()

    async def _test_bc_stake(self, amount_usdt: float) -> None:
        if not self._runtime:
            return
        status = await self._execution.stake_sync.test_bc_stake(
            server=self._runtime.server,
            amount_usdt=amount_usdt,
        )
        self._emit_live_metrics()
        payload = {
            "block": "BC STAKE TEST",
            "site": "bc",
            "success": status.state == StakeSyncState.OK,
            "test": True,
            "requested": status.calculated_usdt,
            "actual": status.actual_usdt,
            "reason": status.reason,
            "debug": status.debug,
        }
        self.bc_stake_debug.emit(payload)

    @pyqtSlot(bool)
    def manual_bet(self, skip_target_check: bool = False) -> None:
        if self._loop:
            asyncio.run_coroutine_threadsafe(
                self._run_parallel_dispatch(manual=True, skip_target_check=skip_target_check),
                self._loop,
            )

    def _emit_watch_state(self, metrics: WatchMetrics | None = None, err: str | None = None) -> None:
        m = metrics or self._watch_engine.metrics
        if self._runtime:
            self._watch_engine.enrich_ui_context(
                m,
                settings=self._app_settings,
                bridge_connected=self._runtime.manager.bridge_connected,
                user_confirmed=self._user_confirmed,
            )
        msg = m.message or err or ""
        self._log_engine_state(self._watch_engine.state.value, m, err, msg)
        self.watch_state.emit(self._watch_engine.state.value, m, msg)

    def _log_engine_state(
        self,
        state: str,
        metrics: WatchMetrics,
        err: str | None,
        msg: str,
    ) -> None:
        if not self._odds_log:
            return
        profit = metrics.current_profit_rate if metrics.total_stake_krw else None
        watch = self._watching
        key = f"{state}|{err}|{msg}|{profit}"
        if key == self._last_engine_log_state:
            return

        if state == "READY":
            self._odds_log.log_engine(
                status="READY",
                watch_enabled=watch,
                profit_rate=profit,
                message=f"현재 수익률 {profit:.2f}%" if profit is not None else "READY",
            )
            self._last_engine_log_state = key
        elif err == "below-target" or (state == "TARGET WAIT" and "below-target" in msg):
            self._odds_log.log_engine(
                status="TARGET WAIT",
                watch_enabled=watch,
                profit_rate=profit,
                message=f"현재 수익률 {profit:.2f}%" if profit is not None else msg,
            )
            self._last_engine_log_state = key
        elif state == "AUTO BET WAIT" and ("닫" in msg or "CLOSED" in msg.upper()):
            site = "X10" if "텐텐" in msg or "x10" in msg.lower() else "BC" if "BC" in msg else "ENGINE"
            self._odds_log.log_engine(
                status="CLOSED",
                watch_enabled=watch,
                profit_rate=profit,
                message=msg or "자동배팅 대기",
            )
            if site in {"X10", "BC"}:
                self._odds_log.log_site_change(
                    site=site,
                    previous_odds=metrics.bti_odds if site == "X10" else metrics.bc_odds,
                    current_odds=metrics.bti_odds if site == "X10" else metrics.bc_odds,
                    previous_status="ACTIVE",
                    current_status="CLOSED",
                    watch_enabled=watch,
                    profit_rate=profit,
                    message="closed",
                )
            self._last_engine_log_state = key
        elif state == "IDLE" and not watch:
            self._last_engine_log_state = key

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
        self._last_engine_log_state = ""
        self._watch_engine.start_watch(user_confirmed=self._user_confirmed)
        if self._odds_log:
            self._odds_log.log_watch(enabled=True)
        self._emit_watch_state()
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._evaluate_watch(), self._loop)

    @pyqtSlot()
    def stop_watch(self) -> None:
        self._watching = False
        self._watch_engine.stop_watch()
        if self._odds_log:
            self._odds_log.log_watch(enabled=False)
        self._last_engine_log_state = ""
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
