import { createWebSocketClient, ensurePaired, loadBridgeConfig } from "./websocket_client.js";

const BC_URLS = ["*://*.bc.game/*", "*://bc.game/*"];
const X10_URLS = ["*://*.x10x10s.com/*", "*://x10x10s.com/*"];

/** @type {ReturnType<typeof createWebSocketClient> | null} */
let client = null;
let tabStatus = { bc: "not_found", x10: "not_found" };
let slipStatus = { bc: "empty", x10: "empty" };
const bestSlip = { bc: null, x10: null };
const lastSentSlipKey = { bc: "", x10: "" };
const lastDebugKeys = new Set();
const siteStatusDebounce = {
  bc: { code: "empty", hits: 0, since: 0, confirmed: "empty" },
  x10: { code: "empty", hits: 0, since: 0, confirmed: "empty" },
};

/** Per-site best-frame cache and per-frame latest results. */
const siteState = {
  bc: {
    best_frame_id: null,
    best_frame_url: "",
    best_priority: 0,
    last_valid_slip: null,
    last_odds: null,
    last_status: "empty",
    last_update_ts: 0,
    injected_frames: 0,
  },
  x10: {
    best_frame_id: null,
    best_frame_url: "",
    best_priority: 0,
    last_valid_slip: null,
    last_odds: null,
    last_status: "empty",
    last_update_ts: 0,
    injected_frames: 0,
  },
};

/** @type {Record<string, { result: object, meta: object, priority: number, ts: number }>} */
const frameSlipCache = {};

const FRAME_CACHE_TTL_MS = 45_000;

/** @type {Record<number, { frameId: number, frame_url: string, selector: string, score: number }>} */
const bcStakeLocatorByTab = {};

function mapRawSlipStatus(result) {
  if (!result || result.empty || !result.items?.length) return "empty";
  const st = String(result.items[0]?.status || "empty").toLowerCase();
  if (["active", "suspended", "closed", "disabled", "odds_missing", "closed_pending"].includes(st)) return st;
  return "empty";
}

function confirmSiteStatus(site, rawCode) {
  const key = site === "bc" ? "bc" : "x10";
  const d = siteStatusDebounce[key];
  const now = Date.now();
  if (rawCode === d.code) {
    d.hits += 1;
  } else {
    d.code = rawCode;
    d.hits = 1;
    d.since = now;
  }
  if (d.hits >= 2 || now - d.since >= 200) {
    d.confirmed = rawCode;
  }
  return d.confirmed;
}

function slipPriority(result) {
  if (!result) return 0;
  if (!result.empty && result.items?.length) {
    const st = String(result.items[0]?.status || "active").toLowerCase();
    if (st === "active") return 100;
    if (st === "closed" || st === "suspended" || st === "disabled" || st === "closed_pending") return 80;
    if (st === "odds_missing") return 60;
    return 55;
  }
  if (result.slip_root_found === "YES" || (result.slip_count || 0) > 0) return 60;
  if (result.reason === "empty-slip") return 10;
  if (result.reason === "no-slip-root") return 0;
  return 5;
}

function slipScore(result) {
  return slipPriority(result);
}

function frameCacheKey(site, tabId, frameId) {
  return `${site}:${tabId ?? "x"}:${frameId ?? 0}`;
}

function pruneFrameCache() {
  const now = Date.now();
  for (const [key, entry] of Object.entries(frameSlipCache)) {
    if (now - entry.ts > FRAME_CACHE_TTL_MS) delete frameSlipCache[key];
  }
}

function pickBestSiteResult(site) {
  pruneFrameCache();
  let best = null;
  let bestPriority = -1;
  for (const [key, entry] of Object.entries(frameSlipCache)) {
    if (!key.startsWith(`${site}:`)) continue;
    if (entry.priority > bestPriority) {
      bestPriority = entry.priority;
      best = entry;
    }
  }
  return best;
}

function updateSiteStateFromBest(site) {
  const best = pickBestSiteResult(site);
  const state = siteState[site];
  if (!best) return null;
  state.best_frame_id = best.meta?.frame_id ?? null;
  state.best_frame_url = best.meta?.frame_url || best.result?.frame_url || "";
  state.best_priority = best.priority;
  state.last_valid_slip = best.result;
  state.last_update_ts = best.ts;
  const item = best.result?.items?.[0];
  state.last_odds = item?.odds ?? best.result?.extracted_odds ?? null;
  state.last_status = item?.status || best.result?.parsed_status || (best.result?.empty ? "empty" : "unknown");
  return best;
}

function slipPayloadKey(result) {
  if (!result) return "";
  const item = result.items?.[0] || {};
  return [
    result.reason || "",
    result.frame_url || "",
    result.empty ? "1" : "0",
    item.event || "",
    item.selection || "",
    String(item.odds ?? ""),
    String(item.stake ?? ""),
    item.status || "",
    item.status_reason || "",
    String(item.previous_odds ?? ""),
  ].join("|");
}

function sendStatus() {
  client?.send({
    type: "status",
    bridge_connected: client.isConnected(),
    bc_tab: tabStatus.bc,
    x10_tab: tabStatus.x10,
    bc_betslip: slipStatus.bc,
    x10_betslip: slipStatus.x10,
  });
}

function updateSlipStatus(site, result) {
  const key = site === "bc" ? "bc" : "x10";
  const raw = mapRawSlipStatus(result);
  const confirmed = confirmSiteStatus(site, raw);
  slipStatus[key] = confirmed;
}

function maybeForwardSlip(site, result, meta) {
  const tabId = meta?.tab_id;
  const frameId = meta?.frame_id;
  const priority = slipPriority(result);
  const key = frameCacheKey(site, tabId, frameId);

  frameSlipCache[key] = {
    result,
    meta: {
      ...meta,
      tab_id: tabId ?? null,
      frame_id: frameId ?? null,
      frame_url: meta?.frame_url || result?.frame_url || "",
    },
    priority,
    ts: Date.now(),
  };

  const bestEntry = updateSiteStateFromBest(site);
  if (!bestEntry) return;

  const best = bestEntry.result;
  const bestMeta = bestEntry.meta;
  const payloadKey = slipPayloadKey(best);
  if (payloadKey === lastSentSlipKey[site]) return;
  lastSentSlipKey[site] = payloadKey;

  bestSlip[site] = best;
  updateSlipStatus(site, best);
  client?.send({
    type: "slip_update",
    site,
    tab_id: bestMeta.tab_id,
    frame_id: bestMeta.frame_id,
    frame_url: bestMeta.frame_url || best?.frame_url || "",
    frame_depth: bestMeta.frame_depth,
    result: best,
    site_state: {
      injected_frames: siteState[site].injected_frames,
      best_frame_id: siteState[site].best_frame_id,
      best_frame_url: siteState[site].best_frame_url,
      best_priority: siteState[site].best_priority,
      last_status: siteState[site].last_status,
      last_odds: siteState[site].last_odds,
    },
  });
  sendStatus();
}

function maybeForwardDebug(message) {
  let key;
  if (message.block === "BC STAKE" || message.step) {
    key = [
      message.block || "",
      message.step || "",
      message.frame_url || "",
      String(message.calculated ?? message.requested ?? ""),
      String(message.actual ?? ""),
      String(Date.now()),
    ].join("|");
  } else if (message.block === "X10 DEBUG") {
    const bucket = Math.floor(Date.now() / 1500);
    key = ["X10 DEBUG", message.frame_url || "", String(message.frame_depth ?? ""), bucket].join("|");
  } else {
    const parts = [
      message.block || "",
      message.site || "",
      message.frame_url || "",
      message.selector || "",
      String(message.match_count ?? ""),
      message.sample_text || "",
      message.event || "",
      message.selection || "",
      String(message.odds ?? ""),
      message.reason || "",
      message.found || "",
    ];
    key = parts.join("|");
  }
  if (lastDebugKeys.has(key)) return;
  lastDebugKeys.add(key);
  if (lastDebugKeys.size > 5000) {
    lastDebugKeys.clear();
  }
  client?.send({
    type: "bridge_debug",
    ...message,
  });
}

async function queryTabs() {
  const [bcTabs, x10Tabs] = await Promise.all([
    chrome.tabs.query({ url: BC_URLS }),
    chrome.tabs.query({ url: X10_URLS }),
  ]);
  tabStatus = {
    bc: bcTabs.length ? "found" : "not_found",
    x10: x10Tabs.length ? "found" : "not_found",
  };
  sendStatus();
  return { bcTabs, x10Tabs };
}

async function requestSlipScan(site, tabs) {
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "scan_slip", site });
    } catch (_err) {
      // frame may not be ready
    }
  }
}

async function refreshTabsAndScan() {
  const { bcTabs, x10Tabs } = await queryTabs();
  await requestSlipScan("bc", bcTabs);
  await requestSlipScan("x10", x10Tabs);
}

async function sendMessageToFrame(tabId, frameId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId });
}

async function iterateTabFrames(tabId, message, { collectAll = false } = {}) {
  /** @type {Array<{frameId:number, url?:string}>} */
  let frames = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (_err) {
    frames = [{ frameId: 0 }];
  }

  let lastResult = { ok: false, error: "no-frame-response", reason: "no-frame-response" };
  const ranked = [];
  const collected = [];

  const registered = bcStakeLocatorByTab[tabId];
  if (registered?.frameId != null && message.site === "bc") {
    frames = [
      { frameId: registered.frameId, url: registered.frame_url },
      ...frames.filter((f) => f.frameId !== registered.frameId),
    ];
  }

  for (const frame of frames) {
    try {
      const result = await sendMessageToFrame(tabId, frame.frameId, message);
      if (!result) continue;
      const merged = {
        ...result,
        frameId: frame.frameId,
        frame_url: result.frame_url || frame.url || "",
      };
      if (collectAll) {
        collected.push(merged);
        continue;
      }
      if (result.deferred) continue;
      if (result.ok) return merged;
      ranked.push(merged);
      lastResult = merged;
    } catch (_err) {
      // frame may not have content script
    }
  }
  if (collectAll) return collected;
  return ranked.sort((a, b) => (b.score || 0) - (a.score || 0))[0] || lastResult;
}

function mergeBcScanResults(frameResults) {
  const scans = [];
  const inputCandidates = [];
  const scanLines = [];
  let best = null;
  let bestFrame = null;

  for (const fr of frameResults) {
    for (const row of fr.scans || []) {
      scans.push({ ...row, frame_url: row.frame_url || fr.frame_url || "" });
    }
    for (const row of fr.input_candidates || []) {
      inputCandidates.push({ ...row, frame_url: row.frame_url || fr.frame_url || "" });
    }
    for (const line of fr.scan_lines || []) {
      scanLines.push(line);
    }
    const candidate = fr.best || fr.found;
    const score = Number(candidate?.score || 0);
    if (candidate && score >= Number(best?.score || 0)) {
      best = candidate;
      bestFrame = fr;
    }
  }

  const found = !!best;
  const frame_url = best?.frame_url || bestFrame?.frame_url || "";
  const selector = best?.selector || "";
  const current_value = best?.current_value ?? best?.meta?.value ?? null;

  return {
    ok: found,
    found,
    frame_url,
    selector,
    current_value,
    scans,
    input_candidates: inputCandidates,
    scan_lines: scanLines,
    best,
    reason: found ? "ok" : "stake-input-not-found",
    debug: {
      block: "BC INPUT SCAN",
      found: found
        ? { selector, frame_url, current_value }
        : null,
      scans,
      input_candidates: inputCandidates,
      scan_lines: scanLines,
      frame_count: frameResults.length,
    },
  };
}

async function scanBcStakeInputsAllFrames(message) {
  const tabs = await chrome.tabs.query({ url: BC_URLS });
  if (!tabs.length) {
    return { ok: false, reason: "frame-not-found", found: false, scans: [], input_candidates: [] };
  }

  const payload = {
    type: "bridge_command",
    site: "bc",
    command: "scan_bc_stake",
    request_id: message.request_id,
  };

  const allFrameResults = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    const frameResults = await iterateTabFrames(tab.id, payload, { collectAll: true });
    allFrameResults.push(...frameResults);
  }

  const merged = mergeBcScanResults(allFrameResults);
  maybeForwardDebug({
    block: merged.found ? "BC STAKE INPUT FOUND" : "BC STAKE INPUT NOT FOUND",
    site: "bc",
    frame_url: merged.frame_url,
    selector: merged.selector,
    current_value: merged.current_value,
    ...merged.debug,
  });
  return merged;
}

  return merged;
}

function mergeBcStakeWriteResults(frameResults) {
  let best = null;
  for (const fr of frameResults) {
    if (!fr) continue;
    if (fr.ok && fr.success !== false) {
      if (!best || Number(fr.score || 0) >= Number(best.score || 0)) best = fr;
    }
  }
  if (best) return best;
  const ranked = frameResults
    .filter((fr) => fr && !fr.deferred)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  return ranked[0] || { ok: false, reason: "stake-input-not-found", deferred: false };
}

async function setBcStakeAllFrames(message) {
  const tabs = await chrome.tabs.query({ url: BC_URLS });
  if (!tabs.length) {
    return { ok: false, reason: "frame-not-found", found: false };
  }

  const payload = {
    type: "bridge_command",
    site: "bc",
    command: "set_bc_stake",
    amount_usdt: message.amount_usdt,
    request_id: message.request_id,
    test: message.test,
  };

  const allFrameResults = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    const frameResults = await iterateTabFrames(tab.id, payload, { collectAll: true });
    allFrameResults.push(...frameResults);
  }
  return mergeBcStakeWriteResults(allFrameResults);
}

async function scanBetButtonsAllFrames(message) {
  const site = message.site === "bc" ? "bc" : "x10";
  const urls = site === "bc" ? BC_URLS : X10_URLS;
  const tabs = await chrome.tabs.query({ url: urls });
  if (!tabs.length) {
    return { ok: false, reason: "button-not-found", found: false, site };
  }

  const payload = {
    type: "bridge_command",
    site,
    command: "scan_bet_buttons",
    request_id: message.request_id,
  };

  for (const tab of tabs) {
    if (!tab.id) continue;
    const frameResults = await iterateTabFrames(tab.id, payload, { collectAll: true });
    for (const fr of frameResults) {
      if (fr?.ok && fr.found !== false) {
        return { ...fr, site };
      }
    }
  }
  return { ok: false, reason: "button-not-found", found: false, site };
}

async function placeBetAllFrames(message) {
  const site = message.site === "bc" ? "bc" : "x10";
  const command = site === "bc" ? "place_bc_bet" : "place_x10_bet";
  const urls = site === "bc" ? BC_URLS : X10_URLS;
  const tabs = await chrome.tabs.query({ url: urls });
  if (!tabs.length) {
    return { ok: false, reason: `${site}-tab-not-found`, deferred: true };
  }

  const payload = {
    type: "bridge_command",
    site,
    command,
    request_id: message.request_id,
    execution_id: message.execution_id,
  };

  let last = { ok: false, reason: "button-not-found", deferred: true };
  for (const tab of tabs) {
    if (!tab.id) continue;
    const frameResults = await iterateTabFrames(tab.id, payload, { collectAll: true });
    for (const fr of frameResults) {
      if (fr?.ok) return fr;
      if (fr && !fr.deferred) last = fr;
    }
  }
  return last;
}

async function executeBridgeCommand(message) {
  const site = message.site === "bc" ? "bc" : "x10";
  const urls = site === "bc" ? BC_URLS : X10_URLS;
  const tabs = await chrome.tabs.query({ url: urls });
  if (!tabs.length) {
    return { ok: false, error: `${site}-tab-not-found`, reason: "frame-not-found" };
  }

  const payload = {
    type: "bridge_command",
    site,
    command: message.command,
    amount_usdt: message.amount_usdt,
    amount_krw: message.amount_krw,
    request_id: message.request_id,
    test: message.test,
    execution_id: message.execution_id,
  };

  if (message.command === "scan_bet_buttons") {
    return scanBetButtonsAllFrames(message);
  }

  let lastResult = { ok: false, error: "no-frame-response", reason: "no-frame-response" };
  for (const tab of tabs) {
    if (!tab.id) continue;
    const result = await iterateTabFrames(tab.id, payload);
    if (result?.ok) return result;
    lastResult = result || lastResult;
  }
  return lastResult;
}

async function startBridge() {
  console.log("[BRIDGE] service worker started");
  try {
    await ensurePaired();
  } catch (err) {
    console.warn("[PAIR] pairing deferred — ArbDesktop may be offline:", err?.message || err);
  }

  const config = await loadBridgeConfig();
  client = createWebSocketClient({
    host: config.host,
    port: config.port,
    credential: config.credential,
    extensionId: config.extensionId,
    onConnectionChange: (connected) => {
      if (connected) {
        console.log("[BRIDGE] connected");
        refreshTabsAndScan();
      } else {
        sendStatus();
      }
    },
    onMessage: async (message) => {
      if (message.type === "request_status") {
        refreshTabsAndScan();
        return;
      }
      if (message.type === "bridge_command") {
        let result;
        if (message.command === "scan_bc_stake" && message.site === "bc") {
          result = await scanBcStakeInputsAllFrames(message);
        } else if (message.command === "set_bc_stake" && message.site === "bc") {
          result = await setBcStakeAllFrames(message);
        } else if (message.command === "scan_bet_buttons") {
          result = await scanBetButtonsAllFrames(message);
        } else if (message.command === "place_bc_bet" || message.command === "place_x10_bet") {
          result = await placeBetAllFrames(message);
        } else {
          result = await executeBridgeCommand(message);
        }
        client?.send({
          type: "command_result",
          request_id: message.request_id,
          command: message.command,
          site: message.site,
          ...result,
        });
        if (message.command === "scan_bc_stake" && message.site === "bc") {
          client?.send({
            type: "bridge_debug",
            block: result.found ? "BC STAKE INPUT FOUND" : "BC STAKE INPUT NOT FOUND",
            site: "bc",
            found: !!result.found,
            frame_url: result.frame_url || "",
            selector: result.selector || "",
            current_value: result.current_value ?? null,
            ...(result.debug || {}),
          });
        }
        if (message.command === "set_bc_stake" || message.command === "read_bc_stake") {
          client?.send({
            type: "stake_sync_result",
            request_id: message.request_id,
            site: "bc",
            requested: result.requested ?? result.expected ?? message.amount_usdt,
            actual: result.actual ?? null,
            success: !!result.ok,
            reason: result.reason || result.error || (result.ok ? "ok" : "failed"),
            frame_url: result.frame_url || "",
            selector: result.selector || "",
            debug: result.debug || null,
          });
        }
      }
    },
  });
  client.start();
}

chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
  if (message?.type === "content_script_loaded") {
    const site = message.site === "bc" ? "bc" : message.site === "x10" ? "x10" : null;
    if (site) {
      siteState[site].injected_frames += 1;
      maybeForwardDebug({
        block: "CONTENT SCRIPT LOADED",
        site,
        tab_id: sender.tab?.id ?? null,
        frame_id: sender.frameId ?? null,
        frame_url: message.frame_url || sender.url || "",
        readyState: message.readyState || "",
        injected_frames: siteState[site].injected_frames,
      });
    }
    return;
  }

  if (message?.type === "bridge_debug") {
    const enriched = {
      ...message,
      tab_id: message.tab_id ?? sender.tab?.id ?? null,
      frame_id: message.frame_id ?? sender.frameId ?? null,
      frame_url: message.frame_url || sender.url || "",
    };
    maybeForwardDebug(enriched);
    return;
  }

  if (message?.type === "stake_input_register" && message.site === "bc") {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId != null && frameId != null && message.locator) {
      const prev = bcStakeLocatorByTab[tabId];
      const score = Number(message.locator.score || 0);
      if (!prev || score >= (prev.score || 0)) {
        bcStakeLocatorByTab[tabId] = {
          frameId,
          frame_url: message.frame_url || message.locator.frame_url || "",
          selector: message.locator.selector || "",
          score,
        };
      }
    }
    maybeForwardDebug({
      block: "BC STAKE INPUT FOUND",
      site: "bc",
      frame_url: message.frame_url,
      ...message.locator,
    });
    return;
  }

  if (message?.type === "stake_sync_result") {
    client?.send({ type: "stake_sync_result", ...message });
    maybeForwardDebug({
      block: message.success ? "BC STAKE SYNC OK" : "BC STAKE SYNC FAILED",
      site: "bc",
      ...message,
      ...(message.debug || {}),
    });
    return;
  }

  if (message?.type === "stake_input_changed" && message.site === "bc") {
    client?.send({ type: "stake_input_changed", site: "bc", frame_url: message.frame_url || "" });
    return;
  }

  if (message?.type !== "slip_update") return;

  const site = message.site === "bc" ? "bc" : "x10";
  tabStatus[site] = "found";
  maybeForwardSlip(site, message.result, {
    tab_id: sender.tab?.id ?? message.tab_id ?? null,
    frame_id: sender.frameId ?? message.frame_id ?? null,
    frame_url: message.frame_url || sender.url || "",
    frame_depth: message.frame_depth,
  });
});

chrome.runtime.onInstalled.addListener(() => {
  startBridge().catch((error) => {
    console.error("[BRIDGE START ERROR]", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  startBridge().catch((error) => {
    console.error("[BRIDGE START ERROR]", error);
  });
});

startBridge().catch((error) => {
  console.error("[BRIDGE START ERROR]", error);
});
setInterval(() => {
  refreshTabsAndScan();
}, 3000);
