// background.js — 수익 구간 즉시 동시 배팅 오케스트레이터
importScripts('sites_config.js', 'odds.js', 'bti_read.js', 'engine.js');

const STORAGE_KEY = 'autoBetConfig';
const LOG_KEY = 'autoBetLog';
const LOG_MAX = 50;

let armed = false;
let betInFlight = false;
let lastStrikeAt = 0;
let lastProfitKey = '';
let config = {
  minProfit: 1,
  leg2: 'auto',
  btiBetKrw: 10000,
  usdRate: 1400,
  cooldownMs: 8000,
  useArbBotBridge: true,
  preSyncAmount: true
};

let prewarmDone = false;

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function logEntry(text, level = 'info') {
  const entry = { time: Date.now(), text, level };
  chrome.storage.local.get(LOG_KEY, (data) => {
    const list = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
    list.unshift(entry);
    if (list.length > LOG_MAX) list.length = LOG_MAX;
    chrome.storage.local.set({ [LOG_KEY]: list });
  });
  broadcast({ type: 'AUTOBET_LOG', entry });
  console.log(`[자동배팅] ${text}`);
}

async function loadConfig() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY]) config = { ...config, ...data[STORAGE_KEY] };
  } catch (_) {}
}

async function saveConfig(patch) {
  config = { ...config, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

function profitKey(btiO, polyO) {
  return `${btiO?.toFixed(4)}|${polyO?.toFixed(4)}`;
}

async function tryPreSync(snap) {
  if (!config.preSyncAmount || !snap.found?.polyTab) return;
  await setPolyAmount(snap.found.polyTab, snap.polyUsd);
}

async function evaluateAndStrike(source = 'poll') {
  if (!armed || betInFlight) return;

  const now = Date.now();
  if (now - lastStrikeAt < config.cooldownMs) return;

  let snap = null;
  let bridge = null;

  if (config.useArbBotBridge) {
    const found = await findTabs(config.leg2);
    bridge = await readArbBotBridgeState(found.btiTab, found.polyTab);
    if (bridge && Date.now() - (bridge.ts || 0) < 5000) {
      const direct = await readSnapshot(config.leg2, config.btiBetKrw, config.usdRate);
      const polyO = bridge.polyOdds > 1 ? bridge.polyOdds : direct.polyO;
      const btiO = bridge.btiOdds > 1 ? bridge.btiOdds : direct.btiO;
      if (polyO > 1 && btiO > 1) {
        snap = {
          ok: true,
          found: direct.found || found,
          polyO,
          btiO,
          profit: bridge.profit != null ? bridge.profit : calcProfit(btiO, polyO),
          polyUsd: calcPolyBetUsd(config.btiBetKrw, btiO, polyO, config.usdRate),
          hint: bridge.hint || direct.hint || {},
          fromBridge: true
        };
      } else if (direct.ok) {
        snap = { ...direct, fromBridge: false };
      }
    }
  }

  if (!snap?.ok) {
    snap = await readSnapshot(config.leg2, config.btiBetKrw, config.usdRate);
  }

  if (!snap.ok) {
    broadcast({ type: 'AUTOBET_STATUS', armed, profit: null, reason: snap.reason });
    return;
  }

  const { profit, btiO, polyO, polyUsd, found, hint } = snap;

  if (profit == null || btiO == null || polyO == null) {
    broadcast({
      type: 'AUTOBET_STATUS',
      armed,
      profit: null,
      btiO,
      polyO,
      reason: snap.reason || (!btiO ? '텐텐뱃 배당 없음' : '예측 배당 없음')
    });
    prewarmDone = false;
    return;
  }

  broadcast({
    type: 'AUTOBET_STATUS',
    armed,
    profit,
    btiO,
    polyO,
    polyUsd,
    minProfit: config.minProfit,
    source: snap.fromBridge ? 'arb-bot' : source
  });

  if (profit < config.minProfit) {
    prewarmDone = false;
    return;
  }

  const key = profitKey(btiO, polyO);
  if (key === lastProfitKey && now - lastStrikeAt < config.cooldownMs) return;

  if (!prewarmDone) {
    await prewarmTabs(found.btiTab, found.polyTab, hint);
    await tryPreSync(snap);
    prewarmDone = true;
  }

  betInFlight = true;
  lastProfitKey = key;
  const t0 = performance.now();
  logEntry(`⚡ 수익 ${profit.toFixed(2)}% — 동시 배팅 시작 (${source})`, 'strike');

  try {
    const result = await strikeBothSides({
      found,
      btiO,
      polyO,
      polyUsd,
      hint,
      btiBetKrw: config.btiBetKrw
    });

    lastStrikeAt = Date.now();
    const totalMs = Math.round((performance.now() - t0) * 100) / 100;

    if (result.ok) {
      logEntry(`✓ 동시 배팅 성공 — ${totalMs}ms (BTI+Poly 병렬 ${result.elapsedMs}ms)`, 'ok');
      broadcast({ type: 'AUTOBET_STRIKE', ok: true, result, totalMs, profit });
      armed = false;
      await saveConfig({ armed: false });
      broadcast({ type: 'AUTOBET_ARMED', armed: false });
    } else {
      const btiMsg = result.btiRes?.reason || (result.btiRes?.success ? 'OK' : '실패');
      const polyMsg = result.polyRes?.reason || (result.polyRes?.success ? 'OK' : '실패');
      logEntry(`✗ 배팅 실패 BTI:${btiMsg} / Poly:${polyMsg} (${totalMs}ms)`, 'err');
      broadcast({ type: 'AUTOBET_STRIKE', ok: false, result, totalMs, profit });
    }
  } catch (e) {
    logEntry(`✗ 오류: ${e.message}`, 'err');
    broadcast({ type: 'AUTOBET_STRIKE', ok: false, error: e.message });
  } finally {
    betInFlight = false;
    prewarmDone = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'AUTOBET_ARM') {
    armed = !!msg.armed;
    saveConfig({ armed }).then(() => {
      logEntry(armed ? '자동배팅 무장 — 수익 구간 대기' : '자동배팅 해제', 'info');
      broadcast({ type: 'AUTOBET_ARMED', armed });
      sendResponse({ ok: true, armed });
    });
    return true;
  }

  if (msg.type === 'AUTOBET_GET_STATE') {
    sendResponse({ ok: true, armed, config, betInFlight, lastStrikeAt });
    return false;
  }

  if (msg.type === 'AUTOBET_SET_CONFIG') {
    saveConfig(msg.config || {}).then(() => {
      if (msg.config?.armed != null) armed = !!msg.config.armed;
      sendResponse({ ok: true, config });
    });
    return true;
  }

  if (msg.type === 'AUTOBET_EVALUATE') {
    evaluateAndStrike('manual').then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'ODDS_CHANGED') {
    if (armed) evaluateAndStrike('odds');
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
      await chrome.windows.get(panelWindowId);
      await chrome.windows.update(panelWindowId, { focused: true });
      return panelWindowId;
    } catch (_) {
      panelWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('panel.html'),
    type: 'popup',
    width: 420,
    height: 640,
    focused: true
  });
  panelWindowId = win.id;
  return panelWindowId;
}

chrome.action.onClicked.addListener(() => {
  openPanel().catch((e) => console.error('[자동배팅] 패널 열기 실패:', e));
});
chrome.windows.onRemoved.addListener((id) => { if (id === panelWindowId) panelWindowId = null; });

loadConfig().then(() => {
  armed = !!config.armed;
  console.log('[양방 자동배팅] background loaded, armed=', armed);
});

// ODDS_CHANGED(16ms) + 패널 폴링 + 고속 루프
setInterval(() => {
  if (armed && !betInFlight) evaluateAndStrike('fast');
}, 16);
