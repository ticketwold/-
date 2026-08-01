'use strict';

const $ = (id) => document.getElementById(id);

function logLine(text, cls = '') {
  const el = $('log');
  if (!el) return;
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.prepend(div);
  while (el.children.length > 40) el.lastChild.remove();
}

function getConfig() {
  return {
    minProfit: parseFloat($('minProfit').value) || 1,
    btiBetKrw: parseInt($('btiBet').value, 10) || 10000,
    usdRate: parseFloat($('usdRate').value) || 1400,
    leg2: $('leg2Site').value || 'auto',
    cooldownMs: parseInt($('cooldownMs').value, 10) || 8000,
    useArbBotBridge: $('useBridge').checked,
    preSyncAmount: $('preSync').checked
  };
}

function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.minProfit != null) $('minProfit').value = cfg.minProfit;
  if (cfg.btiBetKrw != null) $('btiBet').value = cfg.btiBetKrw;
  if (cfg.usdRate != null) $('usdRate').value = cfg.usdRate;
  if (cfg.leg2) $('leg2Site').value = cfg.leg2;
  if (cfg.cooldownMs != null) $('cooldownMs').value = cfg.cooldownMs;
  if (cfg.useArbBotBridge != null) $('useBridge').checked = cfg.useArbBotBridge;
  if (cfg.preSyncAmount != null) $('preSync').checked = cfg.preSyncAmount;
  setArmedUi(!!cfg.armed);
}

function setArmedUi(armed) {
  const st = $('armStatus');
  if (st) {
    st.textContent = armed ? '무장' : '해제';
    st.className = armed ? 'armed' : 'disarmed';
  }
  $('armBtn').disabled = armed;
  $('disarmBtn').disabled = !armed;
  $('statusBox').style.borderColor = armed ? '#dc2626' : '#2d3142';
}

function saveConfig() {
  chrome.runtime.sendMessage({ type: 'AUTOBET_SET_CONFIG', config: getConfig() });
}

function arm(armed) {
  saveConfig();
  chrome.runtime.sendMessage({ type: 'AUTOBET_ARM', armed }, (res) => {
    if (res?.ok) {
      setArmedUi(res.armed);
      logLine(armed ? '무장 — 수익 구간 즉시 동시 배팅' : '해제', armed ? 'strike' : 'info');
    }
  });
}

function updateStatus(msg) {
  if (msg.profit != null) {
    const el = $('profitVal');
    el.textContent = `${msg.profit.toFixed(2)}%`;
    el.className = msg.profit >= (parseFloat($('minProfit').value) || 1) ? 'positive' : '';
  }
  if (msg.btiO != null || msg.polyO != null) {
    $('oddsVal').textContent = `${msg.btiO?.toFixed(3) || '-'} / ${msg.polyO?.toFixed(3) || '-'}`;
  }
  if (msg.source === 'arb-bot') {
    $('statusHint').textContent = '양방배팅봇 신호 연동 중';
  } else if (msg.reason) {
    $('statusHint').textContent = msg.reason;
  }
}

$('armBtn')?.addEventListener('click', () => arm(true));
$('disarmBtn')?.addEventListener('click', () => arm(false));
['minProfit', 'btiBet', 'usdRate', 'leg2Site', 'cooldownMs', 'useBridge', 'preSync'].forEach((id) => {
  $(id)?.addEventListener('change', saveConfig);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AUTOBET_STATUS') updateStatus(msg);
  if (msg.type === 'AUTOBET_ARMED') setArmedUi(msg.armed);
  if (msg.type === 'AUTOBET_LOG' && msg.entry) {
    logLine(msg.entry.text, msg.entry.level);
  }
  if (msg.type === 'AUTOBET_STRIKE') {
    logLine(msg.ok ? `배팅 완료 ${msg.totalMs}ms` : '배팅 실패', msg.ok ? 'ok' : 'err');
    if (msg.ok) setArmedUi(false);
  }
});

chrome.runtime.sendMessage({ type: 'AUTOBET_GET_STATE' }, (res) => {
  if (res?.config) applyConfig(res.config);
  if (res?.armed != null) setArmedUi(res.armed);
});

chrome.storage.local.get('autoBetLog', (data) => {
  const list = data.autoBetLog || [];
  list.slice(0, 10).reverse().forEach((e) => logLine(e.text, e.level));
});

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'AUTOBET_EVALUATE' });
}, 50);

logLine('패널 로드 — 양방배팅봇 + 이 확장 함께 사용', 'info');
