// background.js — 무장 상태만 관리 (배팅은 panel.js에서 실행)
importScripts('sites_config.js', 'odds.js', 'poly_api.js', 'bti_read.js', 'engine.js', 'poly_read.js');

const STORAGE_KEY = 'autoBetConfig';
const LOG_KEY = 'autoBetLog';

let armed = false;
let config = {
  minProfit: 1,
  leg2: 'auto',
  btiBetKrw: 10000,
  usdRate: 1400,
  cooldownMs: 8000,
  useArbBotBridge: true,
  preSyncAmount: true
};

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function logEntry(text, level = 'info') {
  const entry = { time: Date.now(), text, level };
  chrome.storage.local.get(LOG_KEY, (data) => {
    const list = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
    list.unshift(entry);
    if (list.length > 50) list.length = 50;
    chrome.storage.local.set({ [LOG_KEY]: list });
  });
  broadcast({ type: 'AUTOBET_LOG', entry });
}

async function loadConfig() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY]) config = { ...config, ...data[STORAGE_KEY] };
    armed = !!config.armed;
  } catch (_) {}
}

async function saveConfig(patch) {
  config = { ...config, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'AUTOBET_ARM') {
    armed = !!msg.armed;
    saveConfig({ armed }).then(() => {
      logEntry(armed ? '무장' : '해제', 'info');
      broadcast({ type: 'AUTOBET_ARMED', armed });
      sendResponse({ ok: true, armed });
    });
    return true;
  }

  if (msg.type === 'AUTOBET_GET_STATE') {
    sendResponse({ ok: true, armed, config });
    return false;
  }

  if (msg.type === 'AUTOBET_SET_CONFIG') {
    saveConfig(msg.config || {}).then(() => {
      if (msg.config?.armed != null) armed = !!msg.config.armed;
      sendResponse({ ok: true, config });
    });
    return true;
  }

  if (msg.type === 'AUTOBET_STRIKE_RESULT' && msg.result) {
    const r = msg.result;
    if (r.ok) logEntry('✓ 배팅 성공 (panel)', 'ok');
    else logEntry(`✗ BTI:${r.btiRes?.reason} Poly:${r.polyRes?.reason}`, 'err');
    return false;
  }

  if (msg.type === 'ODDS_CHANGED' || msg.type === 'BTI_STAKE_CHANGED') {
    broadcast(msg);
    return false;
  }

  if (msg.type === 'OPEN_AUTOBET_PANEL') {
    openPanel().then((id) => sendResponse({ ok: true, windowId: id })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

let panelWindowId = null;

async function openPanel() {
  if (panelWindowId != null) {
    try {
      const win = await chrome.windows.get(panelWindowId);
      await chrome.windows.update(panelWindowId, { focused: true, drawAttention: true });
      const tabs = await chrome.tabs.query({ windowId: panelWindowId });
      if (tabs[0]?.id) await chrome.tabs.update(tabs[0].id, { active: true });
      return panelWindowId;
    } catch (_) {
      panelWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('panel.html'),
    type: 'popup',
    width: 460,
    height: 780,
    focused: true
  });
  panelWindowId = win.id;
  return panelWindowId;
}

chrome.action.onClicked.addListener(() => openPanel());
chrome.windows.onRemoved.addListener((id) => { if (id === panelWindowId) panelWindowId = null; });

chrome.runtime.onInstalled.addListener(() => {
  openPanel().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  loadConfig().then(() => {
    if (armed) openPanel().catch(() => {});
  });
});

loadConfig().then(() => {
  console.log('[자동배팅] background — 별도 창 패널');
  if (armed) openPanel().catch(() => {});
});
