import { createWebSocketClient, loadBridgeConfig } from "./websocket_client.js";

const BC_URLS = ["*://*.bc.game/*", "*://bc.game/*"];
const X10_URLS = ["*://*.x10x10s.com/*", "*://x10x10s.com/*"];

/** @type {ReturnType<typeof createWebSocketClient> | null} */
let client = null;
let tabStatus = { bc: "not_found", x10: "not_found" };
let slipStatus = { bc: "empty", x10: "empty" };

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
      // content script may not be injected yet
    }
  }
}

async function refreshTabsAndScan() {
  const { bcTabs, x10Tabs } = await queryTabs();
  await requestSlipScan("bc", bcTabs);
  await requestSlipScan("x10", x10Tabs);
}

function updateSlipStatus(site, result) {
  const key = site === "bc" ? "bc" : "x10";
  if (!result || result.empty || !result.items?.length) {
    slipStatus[key] = "empty";
  } else if (result.items[0]?.status === "active") {
    slipStatus[key] = "active";
  } else {
    slipStatus[key] = "empty";
  }
}

async function startBridge() {
  const config = await loadBridgeConfig();
  client = createWebSocketClient({
    host: config.host,
    port: config.port,
    token: config.token,
    onConnectionChange: (connected) => {
      if (connected) {
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
  if (message?.type !== "slip_update") return;
  const site = message.site === "bc" ? "bc" : "x10";
  updateSlipStatus(site, message.result);
  if (message.site === "bc" || message.site === "x10") {
    tabStatus[site] = "found";
  }
  client?.send({
    type: "slip_update",
    site: message.site,
    frame_url: message.frame_url || "",
    result: message.result,
  });
  sendStatus();
});

chrome.runtime.onInstalled.addListener(() => {
  startBridge();
});

chrome.runtime.onStartup.addListener(() => {
  startBridge();
});

startBridge();
setInterval(() => {
  refreshTabsAndScan();
}, 3000);
