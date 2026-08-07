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

function mapRawSlipStatus(result) {
  if (!result || result.empty || !result.items?.length) return "empty";
  const st = String(result.items[0]?.status || "empty").toLowerCase();
  if (["active", "suspended", "closed", "odds_missing"].includes(st)) return st;
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

function slipScore(result) {
  if (!result) return 0;
  if (!result.empty && result.items?.length) {
    const item = result.items[0];
    return 100 + (item.odds ? 10 : 0) + (item.event ? 5 : 0) + (item.selection ? 5 : 0);
  }
  if (result.reason === "no-slip-root") return 1;
  if (result.reason === "empty-slip") return 2;
  return 3;
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
  const prev = bestSlip[site];
  if (slipScore(result) >= slipScore(prev)) {
    bestSlip[site] = result;
  }

  const best = bestSlip[site];
  const key = slipPayloadKey(best);
  if (key === lastSentSlipKey[site]) return;
  lastSentSlipKey[site] = key;

  updateSlipStatus(site, best);
  client?.send({
    type: "slip_update",
    site,
    frame_url: meta?.frame_url || best?.frame_url || "",
    frame_depth: meta?.frame_depth,
    result: best,
  });
  sendStatus();
}

function maybeForwardDebug(message) {
  let key;
  if (message.block === "X10 DEBUG") {
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
    onMessage: (message) => {
      if (message.type === "request_status") {
        refreshTabsAndScan();
      }
    },
  });
  client.start();
}

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (message?.type === "bridge_debug") {
    maybeForwardDebug(message);
    return;
  }

  if (message?.type !== "slip_update") return;

  const site = message.site === "bc" ? "bc" : "x10";
  tabStatus[site] = "found";
  maybeForwardSlip(site, message.result, message);
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
