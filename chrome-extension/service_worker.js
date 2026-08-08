import { loadSettings, saveSettings } from "./storage.js";
import { fxSnapshot, isFxUsable, resolveFxRate, startFxPolling } from "./fx_bithumb.js";
import { computeOddsOnlyMetrics, oddsInRange } from "./profit_engine.js";
import {
  bothSitesActive,
  getAllSiteState,
  ingestSlipUpdate,
  setTabFound,
  siteLabel,
} from "./odds_engine.js";
import {
  exportCsv,
  getLogs,
  logBetStep,
  logDebug,
  logOdds,
  logRealtime,
  logStakeStep,
  resetExecutionFlow,
  restoreLogs,
} from "./logger.js";

const BC_MATCH = ["*://*.bc.game/*", "*://bc.game/*"];
const X10_MATCH = ["*://*.x10x10s.com/*", "*://x10x10s.com/*"];

/** @type {ReturnType<typeof createRuntimeState>} */
let runtime;

function createRuntimeState() {
  return {
    watch_enabled: false,
    watch_state: "IDLE",
    stable_count: 0,
    stable_since: 0,
    last_odds_key: "",
    dispatch_armed: false,
    partial_bet: false,
    last_stake_target: null,
    last_stake_actual: null,
    stake_sync_state: "IDLE",
    stake_sync_message: "",
    metrics: null,
    last_dispatch_at: 0,
    settings: null,
  };
}

async function broadcast() {
  const payload = buildUiState();
  try {
    chrome.runtime.sendMessage({ type: "state_update", payload }).catch?.(() => {});
  } catch (_err) {}
  return payload;
}

function buildUiState() {
  const sites = getAllSiteState();
  const settings = runtime.settings || {};
  const fxRate = resolveFxRate(settings);
  let metrics = null;
  if (sites.x10.odds != null && sites.bc.odds != null && fxRate) {
    metrics = computeOddsOnlyMetrics({
      btiOdds: sites.x10.odds,
      bcOdds: sites.bc.odds,
      btiStakeKrw: settings.bti_stake_krw,
      usdtRate: fxRate,
      roundUnitKrw: settings.round_unit_krw,
      roundUnitUsdt: settings.round_unit_usdt,
      targetProfitPct: settings.target_profit_pct,
    });
    runtime.metrics = metrics;
  }

  return {
    watch_enabled: runtime.watch_enabled,
    watch_state: runtime.watch_state,
    partial_bet: runtime.partial_bet,
    settings,
    sites: {
      x10: {
        found: sites.x10.tab_found,
        status: siteLabel("x10"),
        odds: sites.x10.odds,
        revision: sites.x10.revision,
      },
      bc: {
        found: sites.bc.tab_found,
        status: siteLabel("bc"),
        odds: sites.bc.odds,
        revision: sites.bc.revision,
      },
    },
    fx: { ...fxSnapshot },
    metrics,
    stake_sync: {
      state: runtime.stake_sync_state,
      message: runtime.stake_sync_message,
      target: runtime.last_stake_target,
      actual: runtime.last_stake_actual,
    },
    logs: getLogs(),
  };
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({});
  let bcTab = null;
  let x10Tab = null;
  for (const tab of tabs) {
    const url = tab.url || "";
    if (!bcTab && BC_MATCH.some((p) => matchPattern(url, p))) bcTab = tab;
    if (!x10Tab && X10_MATCH.some((p) => matchPattern(url, p))) x10Tab = tab;
  }
  setTabFound("bc", bcTab?.id ?? null, !!bcTab);
  setTabFound("x10", x10Tab?.id ?? null, !!x10Tab);
  return { bcTab, x10Tab };
}

function matchPattern(url, pattern) {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/\./g, "\\.")
        .replace(/\*/g, ".*")
        .replace(/\?/g, "\\?") +
      "$"
  );
  return re.test(url);
}

async function sendToSiteFrame(site, message) {
  const sites = getAllSiteState();
  const bucket = sites[site];
  if (!bucket.tab_id) return { ok: false, reason: "tab-not-found", site };
  const tabId = bucket.tab_id;
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  let best = null;
  for (const frame of frames) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
      if (resp && (resp.ok || resp.found || resp.selector || resp.actual != null)) {
        if (!best || (resp.score || 0) > (best.score || 0)) {
          best = { ...resp, frame_id: frame.frameId, frame_url: frame.url };
        }
      }
    } catch (_err) {}
  }
  return best || { ok: false, reason: "no-frame-response", site };
}

async function setBcStakeAllFrames(amount, test = false) {
  const sites = getAllSiteState();
  const tabId = sites.bc.tab_id;
  if (!tabId) return { ok: false, reason: "tab-not-found" };
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  let best = null;
  for (const frame of frames) {
    try {
      const resp = await chrome.tabs.sendMessage(
        tabId,
        {
          type: "bridge_command",
          site: "bc",
          command: "set_bc_stake",
          amount_usdt: amount,
          test,
        },
        { frameId: frame.frameId }
      );
      if (resp?.ok && resp?.actual != null) {
        if (!best || Math.abs(resp.actual - amount) < Math.abs((best.actual ?? 999) - amount)) {
          best = { ...resp, frame_id: frame.frameId };
        }
      } else if (!best && resp) best = { ...resp, frame_id: frame.frameId };
    } catch (_err) {}
  }
  return best || { ok: false, reason: "stake-input-not-found" };
}

async function syncBcStake(force = false) {
  const settings = runtime.settings;
  if (!settings?.stake_sync_enabled) {
    runtime.stake_sync_state = "OFF";
    runtime.stake_sync_message = "OFF";
    return { ok: true, skipped: true };
  }

  const sites = getAllSiteState();
  if (!sites.bc.tab_found || !sites.x10.tab_found) return { ok: false, reason: "tab-missing" };
  if (!bothSitesActive()) return { ok: false, reason: "site-not-active" };
  if (!oddsInRange(sites.x10.odds) || !oddsInRange(sites.bc.odds)) return { ok: false, reason: "odds-missing" };

  const fxRate = resolveFxRate(settings);
  if (!fxRate) return { ok: false, reason: "fx-unavailable" };

  const metrics = computeOddsOnlyMetrics({
    btiOdds: sites.x10.odds,
    bcOdds: sites.bc.odds,
    btiStakeKrw: settings.bti_stake_krw,
    usdtRate: fxRate,
    roundUnitKrw: settings.round_unit_krw,
    roundUnitUsdt: settings.round_unit_usdt,
    targetProfitPct: settings.target_profit_pct,
  });
  if (!metrics) return { ok: false, reason: "calc-error" };

  const target = metrics.bc_stake_usdt;
  resetExecutionFlow("BC STAKE");
  logStakeStep("CALCULATE", true, "ok", { target });

  if (!force && runtime.last_stake_target != null && Math.abs(runtime.last_stake_target - target) < 0.05) {
    if (runtime.last_stake_actual != null && Math.abs(runtime.last_stake_actual - target) <= 0.15) {
      runtime.stake_sync_state = "OK";
      runtime.stake_sync_message = "동기화 완료";
      logStakeStep("ACK", true, "unchanged");
      return { ok: true, target, actual: runtime.last_stake_actual };
    }
  }

  runtime.stake_sync_state = "SYNCING";
  const write = await setBcStakeAllFrames(target, false);
  logStakeStep("SEND", !!write?.ok, write?.reason || write?.error || "sent");
  logStakeStep("INPUT_FOUND", !!(write?.selector || write?.ok), write?.reason || "");
  logStakeStep("WRITE", write?.actual != null, write?.reason || "", { actual: write?.actual });
  const verified = write?.actual != null && Math.abs(write.actual - target) <= 0.15;
  logStakeStep("VERIFY", verified, verified ? "ok" : "value-not-applied", { target, actual: write?.actual });

  if (!write?.ok || !verified) {
    runtime.stake_sync_state = "FAILED";
    runtime.stake_sync_message = write?.reason || "verify-failed";
    logStakeStep("ACK", false, runtime.stake_sync_message);
    return { ok: false, reason: runtime.stake_sync_message };
  }

  runtime.last_stake_target = target;
  runtime.last_stake_actual = write.actual;
  runtime.stake_sync_state = "OK";
  runtime.stake_sync_message = "동기화 완료";
  logStakeStep("ACK", true, "complete");
  return { ok: true, target, actual: write.actual };
}

function oddsKey(sites, settings, metrics) {
  const fxRate = resolveFxRate(settings);
  return [
    sites.bc.odds,
    sites.x10.odds,
    fxRate,
    metrics?.bc_stake_usdt,
    sites.bc.dom_hash,
    sites.x10.dom_hash,
    sites.bc.revision,
    sites.x10.revision,
  ].join("|");
}

function tickWatch() {
  if (!runtime.watch_enabled) {
    runtime.watch_state = "IDLE";
    return;
  }
  if (runtime.partial_bet) {
    runtime.watch_state = "PARTIAL BET";
    return;
  }

  const settings = runtime.settings;
  const sites = getAllSiteState();
  if (!sites.bc.tab_found || !sites.x10.tab_found) {
    runtime.watch_state = "AUTO BET WAIT";
    return;
  }
  if (!isFxUsable(settings.fx_max_stale_seconds)) {
    runtime.watch_state = "AUTO BET WAIT";
    return;
  }
  if (!bothSitesActive()) {
    runtime.watch_state = "자동배팅 대기";
    return;
  }

  const metrics = runtime.metrics;
  if (!metrics) {
    runtime.watch_state = "TARGET WAIT";
    return;
  }

  const key = oddsKey(sites, settings, metrics);
  if (key !== runtime.last_odds_key) {
    runtime.last_odds_key = key;
    runtime.stable_count = 0;
    runtime.stable_since = 0;
    runtime.dispatch_armed = false;
  }

  if (metrics.current_profit_rate < settings.target_profit_pct) {
    runtime.watch_state = "TARGET WAIT";
    runtime.stable_count = 0;
    runtime.stable_since = 0;
    return;
  }

  const now = Date.now() / 1000;
  if (!runtime.stable_since) runtime.stable_since = now;
  runtime.stable_count += 1;
  const elapsed = now - runtime.stable_since;
  if (runtime.stable_count < settings.stable_count_required || elapsed < settings.stabilize_seconds) {
    runtime.watch_state = "STABILIZING";
    return;
  }

  runtime.watch_state = "READY";
  if (!runtime.dispatch_armed) {
    runtime.dispatch_armed = true;
    maybeAutoDispatch();
  }
}

async function maybeAutoDispatch() {
  const settings = runtime.settings;
  if (!settings.auto_watch_enabled || runtime.partial_bet) return;
  if (runtime.watch_state !== "READY") return;
  await dispatchParallel({ manual: false });
}

async function executeBetAllFrames(site) {
  const sites = getAllSiteState();
  const tabId = sites[site].tab_id;
  if (!tabId) return { ok: false, outcome: "FAILED", reason: "tab-not-found", site };
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  let best = null;
  for (const frame of frames) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "EXECUTE_BET", site }, { frameId: frame.frameId });
      if (resp?.outcome === "CLICKED") return { ...resp, frame_id: frame.frameId };
      if (!best && resp) best = { ...resp, frame_id: frame.frameId };
    } catch (_err) {}
  }
  return best || { ok: false, outcome: "FAILED", reason: "no-frame-response", site };
}

async function dispatchParallel({ manual = false } = {}) {
  const settings = runtime.settings;
  resetExecutionFlow("BET");
  logBetStep("EXECUTION_START", true, manual ? "manual" : "auto");

  if (!isFxUsable(settings.fx_max_stale_seconds) && settings.live_execution_enabled) {
    logBetStep("RESULT", false, "fx-stale");
    return { ok: false, reason: "fx-stale" };
  }

  const sites = getAllSiteState();
  if (!bothSitesActive()) {
    logBetStep("RESULT", false, "site-not-active");
    return { ok: false, reason: "site-not-active" };
  }

  const sync = await syncBcStake(true);
  if (settings.stake_sync_enabled && !sync.ok) {
    logBetStep("RESULT", false, "bc-stake-sync-failed");
    return { ok: false, reason: "bc-stake-sync-failed" };
  }

  const x10Btn = await sendToSiteFrame("x10", { type: "SCAN_BET_BUTTON", site: "x10" });
  const bcBtn = await sendToSiteFrame("bc", { type: "SCAN_BET_BUTTON", site: "bc" });
  logBetStep("X10_BUTTON", !!x10Btn?.ok, x10Btn?.reason || "");
  logBetStep("BC_BUTTON", !!bcBtn?.ok, bcBtn?.reason || "");
  if (!x10Btn?.ok || !bcBtn?.ok) {
    logBetStep("RESULT", false, "button-not-found");
    return { ok: false, reason: "button-not-found" };
  }

  const metrics = runtime.metrics;
  if (!metrics || metrics.current_profit_rate < settings.target_profit_pct) {
    logBetStep("FINAL_RECHECK", false, "target-lost");
    logBetStep("RESULT", false, "target-lost");
    return { ok: false, reason: "target-lost" };
  }
  logBetStep("FINAL_RECHECK", true, "ok");

  if (!settings.live_execution_enabled) {
    logBetStep("DISPATCH", true, "dry-run");
    logBetStep("RESULT", true, "DRY_RUN");
    return { ok: true, outcome: "DRY_RUN" };
  }

  logBetStep("DISPATCH", true, "parallel");
  const started = Date.now();
  const [x10, bc] = await Promise.all([executeBetAllFrames("x10"), executeBetAllFrames("bc")]);
  logBetStep("X10_CLICK", x10?.outcome === "CLICKED", x10?.reason || x10?.outcome || "");
  logBetStep("BC_CLICK", bc?.outcome === "CLICKED", bc?.reason || bc?.outcome || "");

  let outcome = "BOTH_FAILED";
  if (x10?.outcome === "CLICKED" && bc?.outcome === "CLICKED") outcome = "BOTH_SUCCESS";
  else if (x10?.outcome === "CLICKED") outcome = "X10_SUCCESS_BC_FAILED";
  else if (bc?.outcome === "CLICKED") outcome = "BC_SUCCESS_X10_FAILED";

  const partial = outcome === "X10_SUCCESS_BC_FAILED" || outcome === "BC_SUCCESS_X10_FAILED";
  if (partial) {
    runtime.partial_bet = true;
    runtime.watch_enabled = false;
    runtime.watch_state = "PARTIAL BET";
  }

  logBetStep("RESULT", outcome === "BOTH_SUCCESS", outcome, { gap_ms: Date.now() - started });
  runtime.last_dispatch_at = Date.now();
  runtime.dispatch_armed = false;
  await broadcast();
  return { ok: outcome === "BOTH_SUCCESS", outcome, partial };
}

async function handleSlipUpdate(message, sender) {
  const site = message.site === "bc" ? "bc" : "x10";
  const meta = {
    tab_id: sender.tab?.id,
    frame_id: sender.frameId,
    frame_url: message.frame_url || sender.url,
  };
  const prev = getAllSiteState()[site].odds;
  const ingested = ingestSlipUpdate(site, message.result, meta);
  if (ingested.accepted) {
    const next = ingested.bucket.odds;
    if (prev != null && next != null && Math.abs(prev - next) > 0.0001) {
      logOdds(site, prev, next, { revision: ingested.bucket.revision });
    }
    if (runtime.settings?.stake_sync_enabled) {
      syncBcStake(false).then(() => broadcast());
    }
  }
  tickWatch();
  await broadcast();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "content_loaded":
      case "content_script_loaded": {
        const site = message.site === "bc" ? "bc" : "x10";
        if (sender.tab?.id) setTabFound(site, sender.tab.id, true);
        await refreshTabs();
        sendResponse({ ok: true });
        await broadcast();
        break;
      }
      case "slip_update":
        await handleSlipUpdate(message, sender);
        sendResponse({ ok: true });
        break;
      case "stake_input_changed":
        if (runtime.settings?.stake_sync_enabled) {
          await syncBcStake(true);
          await broadcast();
        }
        sendResponse({ ok: true });
        break;
      case "get_state":
        sendResponse(buildUiState());
        break;
      case "save_settings": {
        runtime.settings = await saveSettings(message.settings || {});
        if (runtime.settings.stake_sync_enabled) await syncBcStake(true);
        sendResponse({ ok: true, settings: runtime.settings });
        await broadcast();
        break;
      }
      case "start_watch":
        runtime.watch_enabled = true;
        runtime.partial_bet = false;
        runtime.watch_state = "TARGET WAIT";
        runtime.stable_count = 0;
        runtime.stable_since = 0;
        runtime.dispatch_armed = false;
        sendResponse({ ok: true });
        await broadcast();
        break;
      case "stop_watch":
        runtime.watch_enabled = false;
        runtime.watch_state = "IDLE";
        sendResponse({ ok: true });
        await broadcast();
        break;
      case "manual_dispatch": {
        const result = await dispatchParallel({ manual: true });
        sendResponse(result);
        break;
      }
      case "debug_action": {
        const result = await runDebugAction(message.action);
        sendResponse(result);
        break;
      }
      case "export_logs":
        sendResponse({ csv: exportCsv(message.kind || "execution") });
        break;
      default:
        sendResponse({ ok: false, error: "unknown-message" });
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true;
});

async function probeAllX10Frames() {
  const { x10Tab } = await refreshTabs();
  if (!x10Tab?.id) return { frames: [], target: null };
  const tabId = x10Tab.id;
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const results = [];
  let target = null;
  for (const frame of frames) {
    const base = { frameId: frame.frameId, url: frame.url };
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "x10_probe" }, { frameId: frame.frameId });
      const entry = {
        ...base,
        readyState: resp?.readyState || resp?.document_ready,
        bodyLength: resp?.bodyLength ?? resp?.body_text_length,
        hasBetSlipKeyword: !!(resp?.hasBetSlipKeyword ?? resp?.has_betslip_keyword),
        pipeline_steps: resp?.pipeline_steps || {},
        root_found: resp?.root_found,
        slip_count: resp?.slip_count,
        extracted_odds: resp?.extracted_odds,
        first_failure: resp?.first_failure,
      };
      results.push(entry);
      if (entry.pipeline_steps?.X10_ROOT === "PASS") {
        target = { frameId: frame.frameId, url: frame.url };
      } else if (!target && entry.hasBetSlipKeyword) {
        target = { frameId: frame.frameId, url: frame.url };
      }
    } catch (_err) {
      results.push({ ...base, error: "no-content-script" });
    }
  }
  return { frames: results, target };
}

function buildCombinedCaptureHtml(parts) {
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const chunks = [
    "<!DOCTYPE html><html><head><meta charset='utf-8'><title>x10-betslip-debug</title></head><body>",
    `<h1>x10 BetSlip DOM Capture (all frames)</h1><p>${new Date().toISOString()}</p>`,
  ];
  for (const p of parts) {
    chunks.push(`<h2>Frame ${p.frameId} — ${esc(p.url)}</h2>`);
    if (p.report) {
      chunks.push(`<pre>${esc(JSON.stringify(p.report, null, 2))}</pre>`);
    }
    chunks.push(p.html || "");
  }
  chunks.push("</body></html>");
  return chunks.join("\n");
}

async function captureX10DomAllFrames() {
  const { x10Tab } = await refreshTabs();
  if (!x10Tab?.id) return { ok: false, reason: "x10-tab-not-found" };
  const tabId = x10Tab.id;
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const parts = [];
  for (const frame of frames) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "x10_capture_dom" }, { frameId: frame.frameId });
      if (resp?.html || resp?.report) {
        parts.push({ frameId: frame.frameId, url: frame.url, html: resp.html, report: resp.report });
      }
    } catch (_err) {}
  }
  if (!parts.length) return { ok: false, reason: "no-frame-capture" };
  return {
    ok: true,
    filename: "x10-betslip-debug.html",
    html: buildCombinedCaptureHtml(parts),
    frame_count: parts.length,
    probe: await probeAllX10Frames(),
  };
}

async function runDebugAction(action) {
  const settings = runtime.settings;
  switch (action) {
    case "rescan_x10":
      return sendToSiteFrame("x10", { type: "scan_slip", site: "x10" });
    case "rescan_bc":
      return sendToSiteFrame("bc", { type: "scan_slip", site: "bc" });
    case "find_bc_stake":
      return sendToSiteFrame("bc", { type: "bridge_command", site: "bc", command: "scan_bc_stake" });
    case "test_bc_stake":
      return setBcStakeAllFrames(1.0, true);
    case "find_x10_button":
      return sendToSiteFrame("x10", { type: "SCAN_BET_BUTTON", site: "x10" });
    case "find_bc_button":
      return sendToSiteFrame("bc", { type: "SCAN_BET_BUTTON", site: "bc" });
    case "dry_run_dispatch":
      runtime.settings = { ...settings, live_execution_enabled: false };
      return dispatchParallel({ manual: true });
    case "probe_x10_frames":
      return probeAllX10Frames();
    case "capture_x10_dom":
      return captureX10DomAllFrames();
    default:
      return { ok: false, reason: "unknown-action" };
  }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function init() {
  runtime = createRuntimeState();
  await restoreLogs();
  runtime.settings = await loadSettings();
  startFxPolling(runtime.settings.fx_refresh_seconds || 2);
  await refreshTabs();
  setInterval(async () => {
    await refreshTabs();
    tickWatch();
    if (runtime.settings?.stake_sync_enabled) await syncBcStake(false);
    await broadcast();
  }, 1500);
  await broadcast();
}

init();
