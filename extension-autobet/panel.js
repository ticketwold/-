'use strict';

const $ = (id) => document.getElementById(id);

let armedLocal = false;
let strikeLock = false;
let lastStrikeAt = 0;

function logLine(text, cls = '') {
  const el = $('log');
  if (!el) return;
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.prepend(div);
  while (el.children.length > 80) el.lastChild.remove();
}

function getConfig() {
  return {
    minProfit: parseFloat($('minProfit').value),
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
  armedLocal = !!cfg.armed;
  setArmedUi(armedLocal);
}

function setArmedUi(armed) {
  armedLocal = !!armed;
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
  const cfg = getConfig();
  chrome.runtime.sendMessage({ type: 'AUTOBET_SET_CONFIG', config: cfg });
  return cfg;
}

function updateStatusFromSnap(snap, cfg) {
  if (snap.profit != null) {
    $('profitVal').textContent = `${snap.profit.toFixed(2)}%`;
    $('profitVal').className = snap.profit >= cfg.minProfit ? 'positive' : '';
  }
  if (snap.btiO != null || snap.polyO != null) {
    $('oddsVal').textContent = `${snap.btiO?.toFixed(3) || '-'} / ${snap.polyO?.toFixed(3) || '-'}`;
  }
  if (snap.reason) $('statusHint').textContent = snap.reason;
}

async function getSnap(cfg) {
  let snap = await readSnapshot(cfg.leg2, cfg.btiBetKrw, cfg.usdRate);
  if (cfg.useArbBotBridge && snap.found) {
    const bridge = await readArbBotBridgeState(snap.found.btiTab, snap.found.polyTab);
    if (bridge && Date.now() - (bridge.ts || 0) < 5000) {
      const polyO = bridge.polyOdds > 1 ? bridge.polyOdds : snap.polyO;
      const btiO = bridge.btiOdds > 1 ? bridge.btiOdds : snap.btiO;
      if (polyO > 1 && btiO > 1) {
        snap = {
          ...snap,
          polyO,
          btiO,
          profit: bridge.profit != null ? bridge.profit : calcProfit(btiO, polyO),
          polyUsd: calcPolyBetUsd(cfg.btiBetKrw, btiO, polyO, cfg.usdRate),
          hint: bridge.hint || snap.hint
        };
      }
    }
  }
  return snap;
}

async function executeStrike(snap, cfg, label) {
  if (strikeLock) return;
  strikeLock = true;
  lastStrikeAt = Date.now();
  logLine(`⚡ 수익 ${snap.profit.toFixed(2)}% — 동시 배팅 (${label})`, 'strike');

  try {
    if (cfg.preSyncAmount && snap.polyUsd > 0) {
      const sync = await setPolyAmount(snap.found.polyTab, snap.polyUsd);
      if (!sync?.ok) logLine(`Poly 금액 입력: ${sync?.reason || '실패'}`, 'err');
    }

    const result = await strikeBothSides({
      found: snap.found,
      btiO: snap.btiO,
      polyO: snap.polyO,
      polyUsd: snap.polyUsd,
      hint: snap.hint || {},
      btiBetKrw: cfg.btiBetKrw
    });

    if (result.ok) {
      logLine(`✓ 배팅 성공 ${result.elapsedMs}ms`, 'ok');
      logLine(`  BTI: ${result.btiRes?.btnText || result.btiRes?.reason || 'OK'}`, 'ok');
      logLine(`  Poly: ${result.polyRes?.btnText || result.polyRes?.reason || 'OK'}`, 'ok');
      setArmedUi(false);
      chrome.runtime.sendMessage({ type: 'AUTOBET_ARM', armed: false });
    } else {
      logLine(`✗ 텐텐뱃: ${result.btiRes?.reason || '실패'}`, 'err');
      logLine(`✗ Polymarket: ${result.polyRes?.reason || '실패'}`, 'err');
      if (result.polyRes?.probe) {
        logLine(`  Poly probe: Buy=${result.polyRes.probe.hasBuyBtn} trading=${result.polyRes.probe.hasTradingButton}`, 'err');
      }
    }
    chrome.runtime.sendMessage({ type: 'AUTOBET_STRIKE_RESULT', result, profit: snap.profit });
  } catch (e) {
    logLine(`✗ 오류: ${e.message}`, 'err');
  } finally {
    strikeLock = false;
  }
}

async function panelLoop() {
  if (!armedLocal || strikeLock) return;
  const cfg = saveConfig();
  if (Number.isNaN(cfg.minProfit)) cfg.minProfit = 1;

  const now = Date.now();
  if (now - lastStrikeAt < cfg.cooldownMs) return;

  const snap = await getSnap(cfg);
  if (!snap.ok) {
    $('statusHint').textContent = snap.reason || '탭 확인';
    return;
  }
  updateStatusFromSnap(snap, cfg);

  if (snap.profit == null || snap.btiO == null || snap.polyO == null) return;
  if (snap.profit < cfg.minProfit) return;

  await executeStrike(snap, cfg, 'panel');
}

function arm(armed) {
  saveConfig();
  chrome.runtime.sendMessage({ type: 'AUTOBET_ARM', armed }, (res) => {
    if (res?.ok) {
      setArmedUi(res.armed);
      logLine(armed ? '무장 — 패널에서 배팅 실행 (이 창 유지)' : '해제', armed ? 'strike' : 'info');
    }
  });
}

$('armBtn')?.addEventListener('click', () => arm(true));
$('disarmBtn')?.addEventListener('click', () => arm(false));

$('testBetBtn')?.addEventListener('click', async () => {
  const cfg = saveConfig();
  logLine('테스트 배팅 — 수익률 무시', 'info');
  const snap = await getSnap(cfg);
  if (!snap.ok || !snap.found?.btiTab || !snap.found?.polyTab) {
    logLine(snap.reason || '탭/배당 없음', 'err');
    return;
  }
  if (!snap.btiO || !snap.polyO) {
    logLine(`배당 부족 BTI:${snap.btiO || '-'} Poly:${snap.polyO || '-'}`, 'err');
    return;
  }
  if (snap.profit == null) snap.profit = calcProfit(snap.btiO, snap.polyO) || 0;
  if (!snap.polyUsd) snap.polyUsd = calcPolyBetUsd(cfg.btiBetKrw, snap.btiO, snap.polyO, cfg.usdRate);
  await executeStrike(snap, cfg, '테스트');
});

['minProfit', 'btiBet', 'usdRate', 'leg2Site', 'cooldownMs', 'useBridge', 'preSync'].forEach((id) => {
  $(id)?.addEventListener('change', saveConfig);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AUTOBET_ARMED') setArmedUi(msg.armed);
});

chrome.runtime.sendMessage({ type: 'AUTOBET_GET_STATE' }, (res) => {
  if (res?.config) applyConfig({ ...res.config, armed: res.armed });
  else if (res?.armed != null) setArmedUi(res.armed);
});

chrome.storage.local.get('autoBetLog', (data) => {
  (data.autoBetLog || []).slice(0, 15).reverse().forEach((e) => logLine(e.text, e.level));
});

setInterval(panelLoop, 400);

logLine('v1.0.4 — 패널에서 직접 배팅 (창 닫지 마세요)', 'info');
