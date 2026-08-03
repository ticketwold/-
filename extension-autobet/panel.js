'use strict';

const SNAP_TIMEOUT_MS = 40000;
const SCAN_TIMEOUT_MS = 90000;
const ODDS_POLL_MS = 100;
const ODDS_POLL_ARMED_MS = 100;
const AMOUNT_SYNC_INTERVAL_MS = 100;
const AMOUNT_SYNC_ARMED_MS = 80;
const PANEL_LOOP_MS = 200;
const PANEL_LOOP_ARMED_MS = 16;
const ODDS_GAP_FILL_MS = 3000;
const ODDS_INSTANT_FRESH_MS = 800;
const ODDS_TRANSITION_MS = 700;
const ODDS_STABLE_EPS = typeof ODDS_NOISE_EPS === 'number' ? ODDS_NOISE_EPS : 0.008;
const BTI_REAL_CHANGE_EPS = 0.03;
let btiVerifyBusy = false;
let leg2SyncBusy = false;

function isBcSlipUiSource(slip) {
  if (!slip) return false;
  if (slip.fromSlip === true || slip.source === 'slip-latched') return true;
  if (slip.source === 'stake') return true;
  const kind = slip.sourceKind || '';
  return kind === 'bc-native-slip' || kind === 'sports-slip' || kind === 'bc-api'
    || kind === 'stake-native-slip' || kind === 'stake-api';
}

function isScanPolySlip(slip) {
  if (typeof isScanBcSlip === 'function') return isScanBcSlip(slip);
  if (typeof isTrustedBcSlip === 'function') return isTrustedBcSlip(slip);
  return !!(slip?.odds > 1.01);
}

const $ = (id) => document.getElementById(id);

let armedLocal = false;
let strikeLock = false;
let panelLoopBusy = false;
let haltAutoBet = false;
let lastStrikeAt = 0;
let amountSyncLock = false;
let oddsReadBusy = false;
let amountSyncQueued = true;
let lastPolySyncErr = '';
let lastPolySyncErrAt = 0;
let lastSynced = { polyUsd: 0, btiKrw: 0, btiO: 0, polyO: 0, at: 0 };
let polyPreSynced = false;
let tabCache = null;
let btiSlipPaused = false;
let btiSlipPauseBusy = false;
let btiSlipEverOpen = false;
let pendingStrike = null;
let liveSnap = { ok: false };
let lastKnownOdds = { btiO: null, polyO: null, btiAt: 0, polyAt: 0, polyTrusted: false };
let lastProfitStrikeKey = '';
let leg2Synced = false;
let leg2SyncedSite = '';
let btiSynced = false;
let cartOpen = { bti: false, poly: false };
let knownOddsMeta = { btiSel: '', polySel: '', transitionUntil: 0 };

function isLeg2Connected(cfg) {
  const c = cfg || getConfig();
  return leg2Synced && leg2SyncedSite === c.leg2;
}

function updateLeg2Labels(cfg) {
  const c = cfg || getConfig();
  const leg2 = leg2PrefLabel(c.leg2);
  const oddsLabel = $('oddsLabel');
  if (oddsLabel) oddsLabel.textContent = `${leg1Label()} / ${leg2PrefShort(c.leg2)}`;
  const preSyncLabel = $('preSyncLabel');
  if (preSyncLabel) preSyncLabel.textContent = `실시간 금액 동기화 (${leg1Label()} → ${leg2})`;
}

function updateBtiSyncUi(synced) {
  const el = $('btiSyncStatus');
  if (el) {
    el.textContent = synced ? '연결됨' : '미확인';
    el.className = synced ? 'sync-badge synced' : 'sync-badge';
  }
}

function updateSyncUi(cfg) {
  const c = cfg || getConfig();
  const connected = isLeg2Connected(c);
  const syncStatus = $('syncStatus');
  const syncBtn = $('syncBtn');
  if (syncStatus) {
    syncStatus.textContent = connected ? `연결됨 · ${leg2PrefLabel(c.leg2)}` : '미연결';
    syncStatus.className = connected ? 'sync-badge synced' : 'sync-badge';
  }
  if (syncBtn) syncBtn.textContent = connected ? '재연결' : '연결';
  $('scanBtn').disabled = !connected;
  $('testBetBtn').disabled = !connected;
  $('armBtn').disabled = armedLocal || !connected;
  updateLeg2Labels(c);
}

async function verifyBtiSite() {
  if (btiVerifyBusy) return;
  btiVerifyBusy = true;
  const cfg = getConfig();
  const btn = $('btiVerifyBtn');
  const status = $('btiSyncStatus');
  if (btn) btn.disabled = true;
  if (status) {
    status.textContent = '확인 중…';
    status.className = 'sync-badge';
  }
  logLine('텐텐뱃 연결 확인 중… (스포츠 탭을 먼저 클릭하세요)', 'info');
  try {
    const res = await withTimeout(
      new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'VERIFY_BTI', leg2: cfg.leg2 }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (!response) reject(new Error('연결확인 응답 없음'));
          else resolve(response);
        });
      }),
      45000,
      '텐텐뱃 연결확인'
    );
    if (!res.ok) {
      btiSynced = false;
      updateBtiSyncUi(false);
      logLine(res.reason || '텐텐뱃 탭을 찾을 수 없습니다', 'err');
      if (status) status.textContent = '미확인';
      return;
    }
    tabCache = { ...(tabCache || {}), btiTab: res.btiTab };
    btiSynced = true;
    chrome.runtime.sendMessage({ type: 'AUTOBET_SET_CONFIG', config: { btiSynced: true } });
    updateBtiSyncUi(true);
    logLine(`텐텐뱃 연결됨 (탭 ${res.btiTab.id})`, 'ok');
    logLine(
      `배당판 — 버튼 ${res.board?.buttonCount || 0} · 경기 ${res.board?.eventCount || 0}`,
      (res.board?.buttonCount || 0) > 0 ? 'ok' : 'info'
    );
    for (const p of res.probes || []) {
      const tag = p.widgetsX ? 'wx' : '  ';
      const line = `  f${p.frameId}${tag}: btn${p.buttons} slip${p.slipOdds > 1 ? p.slipOdds.toFixed(3) : '-'} in${p.hasInput ? 'Y' : 'N'}`;
      logLine(`${line} · ${(p.url || '(main)').slice(-48)}`, p.slipOdds > 1 ? 'ok' : 'info');
    }
    $('statusHint').textContent = '텐텐뱃 연결됨 — 오른쪽 사이트 [연결] 후 배당 클릭';
  } catch (e) {
    btiSynced = false;
    updateBtiSyncUi(false);
    logLine(`텐텐뱃 연결 실패: ${e.message}`, 'err');
    if (status) status.textContent = '미확인';
  } finally {
    if (btn) btn.disabled = false;
    btiVerifyBusy = false;
  }
}

async function findTabsViaBackground(leg2Pref) {
  return withTimeout(
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FIND_TABS', leg2: leg2Pref }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response) reject(new Error('탭 탐색 응답 없음'));
        else if (!response.ok) reject(new Error(response.reason || '탭 탐색 실패'));
        else resolve({ btiTab: response.btiTab, polyTab: response.polyTab });
      });
    }),
    60000,
    '탭 탐색'
  );
}

async function syncLeg2Site() {
  if (leg2SyncBusy) return;
  leg2SyncBusy = true;
  const cfg = getConfig();
  saveConfig();
  logLine(`${leg2PrefLabel(cfg.leg2)} 연결 중… (텐텐뱃·${leg2PrefShort(cfg.leg2)} 탭을 먼저 클릭하세요)`, 'info');
  $('syncBtn').disabled = true;
  try {
    const found = await findTabsViaBackground(cfg.leg2);
    if (!found.btiTab) {
      logLine('텐텐뱃 탭을 찾지 못했습니다 — 스포츠 페이지를 클릭한 뒤 다시 [연결확인]', 'err');
      return;
    }
    if (!found.polyTab) {
      logLine(`${leg2PrefLabel(cfg.leg2)} 탭을 찾지 못했습니다 — 스포츠 페이지를 클릭한 뒤 다시 [연결]`, 'err');
      return;
    }
    leg2Synced = true;
    leg2SyncedSite = cfg.leg2;
    tabCache = found;
    chrome.runtime.sendMessage({
      type: 'AUTOBET_SET_CONFIG',
      config: { leg2Synced: true, leg2SyncedSite: cfg.leg2, leg2: cfg.leg2 }
    });
    updateSyncUi(cfg);
    logLine(`${leg2PrefLabel(cfg.leg2)} 연결됨 (탭 ${found.polyTab.id})`, 'ok');
    $('statusHint').textContent = '연결됨 — 배당 클릭 후 [스캔]';
    getSnap(cfg, null, { connectLight: true }).then((snap) => {
      if (snap?.found) tabCache = snap.found;
    }).catch(() => {});
    getSnap(cfg, null, { fastScan: true }).then((snap) => {
      if (!snap?.ok) return;
      liveSnap = snap;
      updateStatusFromSnap(snap, cfg);
      if (snap.btiO > 1 && snap.polyO > 1) {
        amountSyncQueued = true;
        liveAmountSync(true);
      }
    }).catch(() => {});
  } catch (e) {
    logLine(`연결 실패: ${e.message}`, 'err');
  } finally {
    $('syncBtn').disabled = false;
    updateSyncUi(cfg);
    leg2SyncBusy = false;
  }
}

function logLine(text, cls = '') {
  const el = $('log');
  if (!el) return;
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.prepend(div);
  while (el.children.length > 80) el.lastChild.remove();
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} (${ms}ms 초과)`)), ms)
    )
  ]);
}

function getConfig() {
  return {
    minProfit: parseFloat($('minProfit').value),
    btiBetKrw: parseInt($('btiBet').value, 10) || 10000,
    usdRate: parseFloat($('usdRate').value) || 1400,
    leg2: $('leg2Site').value || 'bcgame',
    cooldownMs: parseInt($('cooldownMs').value, 10) || 0,
    useArbBotBridge: $('useBridge').checked,
    preSyncAmount: $('preSync').checked,
    leg2Synced: leg2Synced && leg2SyncedSite === ($('leg2Site').value || 'bcgame'),
    leg2SyncedSite
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
  if (cfg.leg2Synced != null) leg2Synced = !!cfg.leg2Synced;
  if (cfg.leg2SyncedSite) leg2SyncedSite = cfg.leg2SyncedSite;
  if (cfg.btiSynced != null) {
    btiSynced = !!cfg.btiSynced;
    updateBtiSyncUi(btiSynced);
  }
  armedLocal = !!cfg.armed;
  setArmedUi(armedLocal);
  updateSyncUi(cfg);
  const ver = $('versionLabel');
  if (ver) ver.textContent = `Pro · v${chrome.runtime.getManifest().version}`;
}

function setArmedUi(armed) {
  armedLocal = !!armed;
  const st = $('armStatus');
  if (st) {
    if (armed && (btiSlipPaused || pendingStrike)) {
      st.textContent = '오토·대기';
      st.className = 'armed paused';
    } else {
      st.textContent = armed ? '오토' : '대기';
      st.className = armed ? 'armed' : 'disarmed';
    }
  }
  $('armBtn').disabled = armed || !isLeg2Connected();
  $('disarmBtn').disabled = !armed;
}

function clearPendingStrike() {
  pendingStrike = null;
}

function queuePendingStrike(snap, cfg, label) {
  pendingStrike = {
    cfg: { ...cfg },
    label: label || 'panel',
    minProfit: cfg.minProfit,
    profit: snap.profit,
    at: Date.now()
  };
  btiSlipEverOpen = true;
  btiSlipPaused = true;
  setArmedUi(true);
  const hint = $('statusHint');
  if (hint) hint.textContent = '⏸ 텐텐뱃 슬립 닫힘 — 열리면 배팅 재개';
}

async function retryPendingStrike() {
  if (!pendingStrike || strikeLock || haltAutoBet || !armedLocal) return;

  const cfg = pendingStrike.cfg || getConfig();
  let snap;
  try {
    snap = liveSnap?.ok ? liveSnap : await getSnap(cfg);
  } catch (_) {
    return;
  }
  if (!snap?.ok || snap.profit == null || snap.profit < (pendingStrike.minProfit ?? cfg.minProfit)) {
    logLine('대기 중 수익 구간 이탈 — 배팅 대기 해제', 'info');
    clearPendingStrike();
    btiSlipPaused = false;
    setArmedUi(true);
    return;
  }

  const ready = await verifyStrikeReady(snap.found, snap.hint || {}, snap.poly, { fast: !!polyPreSynced });
  if (!ready.ok) return;

  const label = pendingStrike.label || 'panel';
  clearPendingStrike();
  btiSlipPaused = false;
  setArmedUi(true);
  logLine('▶ 텐텐뱃 슬립 열림 — 배팅 재개', 'ok');
  await executeStrike(snap, cfg, label);
}

function disarmAfterStrike(reason) {
  clearPendingStrike();
  haltAutoBet = true;
  armedLocal = false;
  setArmedUi(false);
  amountSyncQueued = false;
  polyPreSynced = false;
  lastStrikeAt = Date.now();
  chrome.runtime.sendMessage({ type: 'AUTOBET_ARM', armed: false });
  const hint = $('statusHint');
  if (hint) hint.textContent = '배팅 완료 — 자동 중지됨 ([오토시작]으로 재개)';
  if (reason) logLine(reason, 'info');
}

function setTestBtnBusy(busy) {
  const btn = $('testBetBtn');
  if (btn) btn.disabled = !!busy;
}

function saveConfig() {
  const cfg = getConfig();
  chrome.runtime.sendMessage({ type: 'AUTOBET_SET_CONFIG', config: cfg });
  return cfg;
}

function isLeg2SlipMissingReason(reason, cfg) {
  const leg2 = leg2PrefLabel((cfg || getConfig()).leg2);
  return !!(reason && new RegExp(`${leg2.replace('.', '\\.')}|BC\\.Game|Stake\\.com`).test(reason) && /(배당 없음|슬립 없음|미연결|검증 실패)/.test(reason));
}

function isBcSlipMissingReason(reason) {
  return isLeg2SlipMissingReason(reason);
}

function slipSelectionKey(slip) {
  if (!slip) return '';
  return `${slip.selectionText || slip.teamLabel || ''}|${slip.marketKey || slip.eventText || ''}`.trim();
}

function isOddsTransition(now = Date.now()) {
  return now < knownOddsMeta.transitionUntil;
}

function beginOddsTransition(side = 'all') {
  if (side === 'bti' || side === 'all') {
    lastKnownOdds.btiO = null;
    lastKnownOdds.btiAt = 0;
    knownOddsMeta.btiSel = '';
  }
  if (side === 'poly' || side === 'all') {
    lastKnownOdds.polyO = null;
    lastKnownOdds.polyAt = 0;
    lastKnownOdds.polyTrusted = false;
    knownOddsMeta.polySel = '';
    if (typeof clearPolyOddsCache === 'function') clearPolyOddsCache();
  }
  knownOddsMeta.transitionUntil = Date.now() + ODDS_TRANSITION_MS;
  lastSynced.at = 0;
  amountSyncQueued = true;
  const cur = ($('oddsVal')?.textContent || '- / -').split('/').map((s) => s.trim());
  if (side === 'bti') {
    renderOddsDisplay(null, cur[1] === '0.000' ? 0 : parseFloat(cur[1]) || null);
  } else if (side === 'poly') {
    renderOddsDisplay(cur[0] === '0.000' ? 0 : parseFloat(cur[0]) || null, null);
  } else {
    renderOddsDisplay(null, null);
  }
  if (liveSnap?.ok) {
    liveSnap = {
      ...liveSnap,
      btiO: side === 'poly' ? liveSnap.btiO : null,
      polyO: side === 'bti' ? liveSnap.polyO : null,
      profit: null
    };
  }
}

function formatOddsSide(v) {
  if (v > 1.01) return v.toFixed(3);
  if (v === 0) return '0.000';
  return '-';
}

function renderOddsDisplay(btiO, polyO) {
  $('oddsVal').textContent = `${formatOddsSide(btiO)} / ${formatOddsSide(polyO)}`;
}

function setCartClosedOdds(side) {
  knownOddsMeta.transitionUntil = 0;
  if (side === 'bti' || side === 'all') {
    cartOpen.bti = false;
    lastKnownOdds.btiO = 0;
    lastKnownOdds.btiAt = Date.now();
    knownOddsMeta.btiSel = '';
  }
  if (side === 'poly' || side === 'all') {
    cartOpen.poly = false;
    lastKnownOdds.polyO = 0;
    lastKnownOdds.polyAt = Date.now();
    lastKnownOdds.polyTrusted = true;
    knownOddsMeta.polySel = '';
    if (typeof clearPolyOddsCache === 'function') clearPolyOddsCache();
  }
  lastSynced.at = 0;
  amountSyncQueued = true;
  polyPreSynced = false;
  const bti = side === 'poly' ? (liveSnap?.btiO ?? lastKnownOdds.btiO ?? 0) : 0;
  const poly = side === 'bti' ? (liveSnap?.polyO ?? lastKnownOdds.polyO ?? 0) : 0;
  renderOddsDisplay(
    side === 'bti' || side === 'all' ? 0 : bti,
    side === 'poly' || side === 'all' ? 0 : poly
  );
  if (liveSnap?.ok) {
    liveSnap = {
      ...liveSnap,
      btiO: side === 'poly' ? liveSnap.btiO : 0,
      polyO: side === 'bti' ? liveSnap.polyO : 0,
      profit: null
    };
  }
  $('profitVal').textContent = '—';
}
function clearKnownOdds(side = 'all') {
  if (side === 'bti' || side === 'all') {
    cartOpen.bti = false;
    lastKnownOdds.btiO = null;
    lastKnownOdds.btiAt = 0;
  }
  if (side === 'poly' || side === 'all') {
    cartOpen.poly = false;
    lastKnownOdds.polyO = null;
    lastKnownOdds.polyAt = 0;
    lastKnownOdds.polyTrusted = false;
  }
}

function isKnownOddsFresh(side, now = Date.now()) {
  if (side === 'bti') return lastKnownOdds.btiO > 1 && now - lastKnownOdds.btiAt < ODDS_INSTANT_FRESH_MS;
  return lastKnownOdds.polyO > 1 && lastKnownOdds.polyTrusted && now - lastKnownOdds.polyAt < ODDS_INSTANT_FRESH_MS;
}

function isBtiSlipMissingReason(reason) {
  return !!(reason && /텐텐뱃.*(배당 없음|슬립)/.test(reason));
}

function displayOdds(btiO, polyO, snapReason) {
  const now = Date.now();
  const inTransition = isOddsTransition(now);
  const bcMissing = isBcSlipMissingReason(snapReason);
  const btiMissing = isBtiSlipMissingReason(snapReason);
  let bti = btiO > 1.01 ? btiO : null;
  let poly = polyO > 1.01 ? polyO : null;
  if (bti == null && !inTransition) {
    if (cartOpen.bti === false && lastKnownOdds.btiO === 0) bti = 0;
    else if (!btiMissing && cartOpen.bti && now - lastKnownOdds.btiAt < ODDS_GAP_FILL_MS && lastKnownOdds.btiO > 1) {
      bti = lastKnownOdds.btiO;
    }
  }
  if (poly == null && !inTransition) {
    if (cartOpen.poly === false && lastKnownOdds.polyO === 0) poly = 0;
    else if (!bcMissing && cartOpen.poly && lastKnownOdds.polyTrusted && now - lastKnownOdds.polyAt < ODDS_GAP_FILL_MS && lastKnownOdds.polyO > 1) {
      poly = lastKnownOdds.polyO;
    }
  }
  renderOddsDisplay(bti, poly);
}

function patchSnapFromKnown(snap, cfg) {
  const inTransition = isOddsTransition();
  const bcMissing = isBcSlipMissingReason(snap.reason);
  const btiMissing = isBtiSlipMissingReason(snap.reason);
  const snapBti = snap.btiO > 1.01 ? snap.btiO : (snap.btiO === 0 ? 0 : null);
  const snapPoly = snap.polyO > 1.01 ? snap.polyO : (snap.polyO === 0 ? 0 : null);
  const partial = {
    btiO: inTransition ? snapBti : (btiMissing ? snapBti : (
      lastKnownOdds.btiO > 1.01 ? lastKnownOdds.btiO : (lastKnownOdds.btiO === 0 ? 0 : snapBti)
    )),
    polyO: inTransition ? snapPoly : (bcMissing || !lastKnownOdds.polyTrusted ? snapPoly : (
      lastKnownOdds.polyO > 1.01 ? lastKnownOdds.polyO : (lastKnownOdds.polyO === 0 ? 0 : snapPoly)
    ))
  };
  if (partial.btiO > 1.01 && partial.polyO > 1.01) {
    partial.profit = calcProfit(partial.btiO, partial.polyO);
    partial.polyUsd = calcPolyBetUsd(cfg.btiBetKrw, partial.btiO, partial.polyO, cfg.usdRate);
  }
  return { ...snap, ...partial };
}

function selectionLabelChanged(a, b) {
  const na = String(a || '').replace(/\s+/g, '').toLowerCase();
  const nb = String(b || '').replace(/\s+/g, '').toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return false;
  if (na.length >= 2 && nb.length >= 2) {
    const minLen = Math.min(na.length, nb.length, 5);
    if (na.slice(0, minLen) === nb.slice(0, minLen)) return false;
    if (na.includes(nb) || nb.includes(na)) return false;
  }
  return true;
}

function applyInstantOdds(msg) {
  if (msg.suspended || !msg?.slip?.odds || msg.slip.odds <= 1) {
    if (msg.cartChange) {
      if (isLeg2Connected() || msg.source === 'bti') {
        beginOddsTransition(msg.source === 'bti' ? 'bti' : 'poly');
      }
    } else {
      setCartClosedOdds(msg.source === 'bti' ? 'bti' : 'poly');
    }
    return false;
  }
  if (!isLeg2Connected() && msg.source !== 'bti') return false;
  if (msg.source !== 'bti') {
    const cfgLeg2 = getConfig().leg2;
    if (msg.source === 'bcgame' && cfgLeg2 !== 'bcgame') return false;
    if (msg.source === 'stake' && cfgLeg2 !== 'stake') return false;
  }
  if (msg.source !== 'bti' && typeof isScanPolySlip === 'function' && !isScanPolySlip(msg.slip)) return false;
  const cfg = getConfig();
  const o = normalizeSportsOdds(msg.slip.odds);
  if (!o) return false;
  const now = Date.now();
  if (msg.source === 'bti') {
    const selKey = slipSelectionKey(msg.slip);
    if (knownOddsMeta.btiSel && selKey && selKey !== knownOddsMeta.btiSel) {
      beginOddsTransition('bti');
    }
    knownOddsMeta.btiSel = selKey;
    const newSel = msg.slip?.selectionText || msg.slip?.teamLabel || '';
    const oldSel = liveSnap?.bti?.selectionText || liveSnap?.bti?.teamLabel || '';
    if (selectionLabelChanged(newSel, oldSel)) {
      beginOddsTransition('bti');
    }
    const slipSource = msg.slip?.source || '';
    const fromSlipUi = slipSource === 'slip-display' || slipSource === 'slip-card' || slipSource === 'slip-latched'
      || slipSource === 'board-live' || slipSource === 'board' || slipSource === 'board-emergency' || slipSource === 'board-slip-match' || slipSource === 'scan-any'
      || slipSource === 'brute-dom' || slipSource === 'brute-inject'
      || slipSource === 'widgets-x-slip' || slipSource === 'widgets-x-at'
      || slipSource === 'bti-api' || String(slipSource).includes('bti-api');
    if (!fromSlipUi && lastKnownOdds.btiO > 1 && oddsDelta(lastKnownOdds.btiO, o) >= 0.5) return false;
    if (!fromSlipUi && lastKnownOdds.btiO > 1 && !oddsChangedSignificantly(lastKnownOdds.btiO, o, ODDS_STABLE_EPS)) return false;
    cartOpen.bti = true;
    lastKnownOdds.btiO = o;
    lastKnownOdds.btiAt = now;
  } else {
    const selKey = slipSelectionKey(msg.slip);
    if (knownOddsMeta.polySel && selKey && selKey !== knownOddsMeta.polySel) {
      beginOddsTransition('poly');
    }
    knownOddsMeta.polySel = selKey;
    const fromSlipUi = isBcSlipUiSource(msg.slip);
    if (!fromSlipUi && lastKnownOdds.polyO > 1 && !oddsChangedSignificantly(lastKnownOdds.polyO, o, ODDS_STABLE_EPS)) return false;
    cartOpen.poly = true;
    lastKnownOdds.polyO = o;
    lastKnownOdds.polyAt = now;
    lastKnownOdds.polyTrusted = true;
  }
  lastSynced.at = 0;
  amountSyncQueued = true;
  const patched = patchSnapFromKnown(liveSnap.ok ? liveSnap : {}, cfg);
  liveSnap = patched;
  updateStatusFromSnap(patched, cfg);
  return true;
}

function updateStatusFromSnap(snap, cfg) {
  if (snap.profit != null) {
    $('profitVal').textContent = `${snap.profit.toFixed(2)}%`;
    $('profitVal').className = snap.profit >= cfg.minProfit ? 'positive' : '';
  }
  displayOdds(snap.btiO, snap.polyO, snap.reason);
  const hint = $('statusHint');
  if (snap.reason && !polyPreSynced) hint.textContent = snap.reason;
  else if (polyPreSynced && snap.polyUsd > 0) {
    hint.textContent = `실시간 동기화 — ${leg2PrefLabel(cfg.leg2)} $${snap.polyUsd.toFixed(2)} · ${leg1Label()} ${cfg.btiBetKrw.toLocaleString()}원`;
  }
}

function stabilizeSnap(snap, cfg) {
  const now = Date.now();
  const btiMissing = isBtiSlipMissingReason(snap.reason);
  const bcMissing = isBcSlipMissingReason(snap.reason);

  if (btiMissing) clearKnownOdds('bti');
  if (bcMissing) clearKnownOdds('poly');

  if (snap.btiO > 1.01) {
    cartOpen.bti = true;
    const next = normalizeSportsOdds(snap.btiO);
    const slipSource = snap.bti?.source || '';
    const fromSlipUi = slipSource === 'slip-display' || slipSource === 'slip-card' || slipSource === 'slip-latched'
      || slipSource === 'board-live' || slipSource === 'board' || slipSource === 'board-emergency' || slipSource === 'board-slip-match' || slipSource === 'scan-any'
      || slipSource === 'brute-dom' || slipSource === 'brute-inject'
      || slipSource === 'widgets-x-slip' || slipSource === 'widgets-x-at'
      || slipSource === 'bti-api' || String(slipSource).includes('bti-api');
    const selKey = slipSelectionKey(snap.bti);
    if (selKey && knownOddsMeta.btiSel && selKey !== knownOddsMeta.btiSel) {
      snap.btiO = next;
      lastKnownOdds.btiO = next;
      lastKnownOdds.btiAt = now;
      knownOddsMeta.btiSel = selKey;
    } else if (lastKnownOdds.btiO > 1 && next) {
      const delta = oddsDelta(lastKnownOdds.btiO, next);
      if (fromSlipUi || delta >= BTI_REAL_CHANGE_EPS) {
        snap.btiO = next;
        lastKnownOdds.btiO = next;
        lastKnownOdds.btiAt = now;
      } else if (!oddsChangedSignificantly(lastKnownOdds.btiO, next, ODDS_STABLE_EPS)) {
        snap.btiO = lastKnownOdds.btiO;
      } else {
        snap.btiO = next;
        lastKnownOdds.btiO = next;
        lastKnownOdds.btiAt = now;
      }
    } else if (next) {
      snap.btiO = next;
      lastKnownOdds.btiO = next;
      lastKnownOdds.btiAt = now;
      if (selKey) knownOddsMeta.btiSel = selKey;
    }
  } else if (!btiMissing && !isOddsTransition(now) && cartOpen.bti && lastKnownOdds.btiO > 1 && now - lastKnownOdds.btiAt < ODDS_GAP_FILL_MS) {
    snap.btiO = lastKnownOdds.btiO;
  } else if (!btiMissing && !isOddsTransition(now)) {
    cartOpen.bti = false;
    snap.btiO = 0;
    lastKnownOdds.btiO = 0;
    lastKnownOdds.btiAt = now;
  } else {
    snap.btiO = snap.btiO === 0 ? 0 : null;
  }

  if (snap.polyO > 1.01 && isScanPolySlip(snap.poly)) {
    cartOpen.poly = true;
    const next = normalizeSportsOdds(snap.polyO);
    const fromSlipUi = isBcSlipUiSource(snap.poly);
    const selKey = slipSelectionKey(snap.poly);
    if (selKey && knownOddsMeta.polySel && selKey !== knownOddsMeta.polySel) {
      snap.polyO = next;
      lastKnownOdds.polyO = next;
      lastKnownOdds.polyAt = now;
      lastKnownOdds.polyTrusted = true;
      knownOddsMeta.polySel = selKey;
    } else if (lastKnownOdds.polyO > 1 && next) {
      const delta = oddsDelta(lastKnownOdds.polyO, next);
      if (fromSlipUi || delta >= BTI_REAL_CHANGE_EPS) {
        snap.polyO = next;
        lastKnownOdds.polyO = next;
        lastKnownOdds.polyAt = now;
        lastKnownOdds.polyTrusted = true;
      } else if (!oddsChangedSignificantly(lastKnownOdds.polyO, next, ODDS_STABLE_EPS)) {
        snap.polyO = lastKnownOdds.polyO;
      } else {
        snap.polyO = next;
        lastKnownOdds.polyO = next;
        lastKnownOdds.polyAt = now;
        lastKnownOdds.polyTrusted = true;
      }
    } else if (next) {
      snap.polyO = next;
      lastKnownOdds.polyO = next;
      lastKnownOdds.polyAt = now;
      lastKnownOdds.polyTrusted = true;
      if (selKey) knownOddsMeta.polySel = selKey;
    }
  } else if (bcMissing || (snap.reason && /BC\.Game.*(배당|슬립)/.test(snap.reason))) {
    setCartClosedOdds('poly');
    snap.polyO = 0;
    snap.poly = null;
  } else if (!bcMissing && !isOddsTransition(now) && cartOpen.poly && lastKnownOdds.polyO > 1 && lastKnownOdds.polyTrusted && now - lastKnownOdds.polyAt < ODDS_GAP_FILL_MS) {
    snap.polyO = lastKnownOdds.polyO;
  } else if (!bcMissing && !isOddsTransition(now) && snap.polyO <= 1.01) {
    cartOpen.poly = false;
    snap.polyO = 0;
    lastKnownOdds.polyO = 0;
    lastKnownOdds.polyAt = now;
    lastKnownOdds.polyTrusted = true;
  } else if (snap.polyO > 1 && !isScanPolySlip(snap.poly)) {
    snap.polyO = 0;
    snap.poly = null;
  } else {
    snap.polyO = snap.polyO === 0 ? 0 : null;
  }

  if (snap.btiO > 1.01 && snap.polyO > 1.01) {
    snap.profit = calcProfit(snap.btiO, snap.polyO);
    snap.polyUsd = calcPolyBetUsd(cfg.btiBetKrw, snap.btiO, snap.polyO, cfg.usdRate);
    snap.reason = '';
  }
  return snap;
}

async function updateBtiSlipPauseState() {
  if (!armedLocal || haltAutoBet || strikeLock || btiSlipPauseBusy) return;
  const tab = tabCache?.btiTab || liveSnap?.found?.btiTab;
  if (!tab?.id) return;

  btiSlipPauseBusy = true;
  try {
    const ui = await checkBtiSlipUi(tab);
    const wasPaused = btiSlipPaused;
    const isReady = !!ui.strikeReady;

    if (isReady) {
      btiSlipEverOpen = true;
      btiSlipPaused = false;
      if (wasPaused) {
        amountSyncQueued = true;
        setArmedUi(true);
        liveAmountSync(true);
        refreshOddsLive();
        if (pendingStrike) {
          setTimeout(() => retryPendingStrike(), 80);
        } else {
          logLine('▶ 텐텐뱃 슬립 열림 — 자동 재개', 'ok');
        }
      } else if (pendingStrike) {
        setTimeout(() => retryPendingStrike(), 80);
      }
      return;
    }

    if (!btiSlipEverOpen) {
      btiSlipPaused = false;
      return;
    }

    btiSlipPaused = true;
    if (!wasPaused) {
      logLine('⏸ 텐텐뱃 슬립 닫힘 — 열리면 자동 재개', 'info');
      polyPreSynced = false;
    }
    const hint = $('statusHint');
    if (hint) hint.textContent = '⏸ 텐텐뱃 슬립 닫힘 — 베팅슬립 열면 자동 재개';
    setArmedUi(true);
  } catch (_) {
    /* ignore probe errors */
  } finally {
    btiSlipPauseBusy = false;
  }
}

async function maybeStrikeOnSnap(snap, cfg, label = 'instant') {
  if (!armedLocal || strikeLock || haltAutoBet || panelLoopBusy || !snap?.ok) return false;
  if (snap.profit == null || snap.btiO == null || snap.polyO == null) return false;
  if (typeof isStrikeBcSlip === 'function' && !isStrikeBcSlip(snap.poly)) return false;
  if (snap.profit < cfg.minProfit) return false;
  if (btiSlipPaused) return false;
  if (Date.now() - lastStrikeAt < cfg.cooldownMs) return false;

  const strikeKey = `${snap.btiO.toFixed(3)}_${snap.polyO.toFixed(3)}_${cfg.minProfit}`;
  if (strikeKey === lastProfitStrikeKey) return false;

  if (cfg.preSyncAmount && !polyPreSynced && snap.polyUsd > 0) {
    amountSyncQueued = true;
    return false;
  }

  lastProfitStrikeKey = strikeKey;
  executeStrike(snap, cfg, label);
  return true;
}

async function refreshOddsLive() {
  if (oddsReadBusy || strikeLock || !isLeg2Connected()) return;
  oddsReadBusy = true;
  const cfg = getConfig();
  try {
    const snap = await getSnap(cfg);
    liveSnap = snap;
    if (!snap.ok) {
      polyPreSynced = false;
      if (snap.reason) $('statusHint').textContent = snap.reason;
      return;
    }
    if (!snap.polyO || isBcSlipMissingReason(snap.reason)) polyPreSynced = false;
    updateStatusFromSnap(snap, cfg);
    if (snap.btiO > 1 && snap.polyO > 1 && needsAmountResync(snap, cfg)) {
      amountSyncQueued = true;
    }
    if (armedLocal && !haltAutoBet && snap.profit != null && snap.profit >= cfg.minProfit) {
      maybeStrikeOnSnap(snap, cfg, 'instant');
    }
  } catch (e) {
    if (e.message) $('statusHint').textContent = e.message;
  } finally {
    oddsReadBusy = false;
  }
}

async function getSnap(cfg, progressLabel, opts = {}) {
  if (!isLeg2Connected(cfg)) {
    return {
      ok: false,
      reason: `${leg2PrefLabel(cfg.leg2)} 미연결 — 사이트 선택 후 [연결] 버튼을 눌러주세요`
    };
  }
  if (progressLabel) logLine(progressLabel, 'info');
  const snapOpts = {
    leg2Synced: true,
    fastScan: opts.connectLight ? true : (opts.focusTab ? false : (opts.fastScan !== false)),
    ...opts
  };
  const timeoutMs = opts.focusTab ? SCAN_TIMEOUT_MS : SNAP_TIMEOUT_MS;
  let snap = await withTimeout(
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'READ_SNAPSHOT',
        leg2: cfg.leg2,
        btiBetKrw: cfg.btiBetKrw,
        usdRate: cfg.usdRate,
        opts: snapOpts
      }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response) reject(new Error('배당 읽기 응답 없음'));
        else resolve(response);
      });
    }),
    timeoutMs,
    opts.connectLight ? '연결' : '배당 읽기'
  );
  if (snap.found) tabCache = snap.found;
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
  return stabilizeSnap(snap, cfg);
}

function needsAmountResync(snap, cfg) {
  if (!snap?.polyUsd || !snap.btiO || !snap.polyO) return false;
  if (Math.abs(snap.polyUsd - lastSynced.polyUsd) >= 0.01) return true;
  if (cfg.btiBetKrw !== lastSynced.btiKrw) return true;
  if (Math.abs((snap.btiO || 0) - lastSynced.btiO) > ODDS_STABLE_EPS) return true;
  if (Math.abs((snap.polyO || 0) - lastSynced.polyO) > ODDS_STABLE_EPS) return true;
  return Date.now() - lastSynced.at > 1000;
}

async function liveAmountSync(force) {
  if (amountSyncLock || strikeLock || !isLeg2Connected()) return;
  if (btiSlipPaused && !force) return;
  const cfg = getConfig();
  const syncOn = cfg.preSyncAmount || armedLocal;
  if (!syncOn && !force) return;
  if (!force && !amountSyncQueued && !cfg.preSyncAmount) return;

  amountSyncLock = true;
  try {
    let snap = liveSnap?.ok ? liveSnap : await getSnap(cfg);
    if (!snap.ok || !snap.found?.btiTab || !snap.found?.polyTab) {
      polyPreSynced = false;
      if (snap.reason) $('statusHint').textContent = snap.reason;
      return;
    }
    liveSnap = snap;
    updateStatusFromSnap(snap, cfg);

    if (!snap.btiO || !snap.polyO) {
      if (!snap.btiO && !snap.polyO) polyPreSynced = false;
      if (cfg.preSyncAmount && snap.btiO && !snap.polyO) {
        $('statusHint').textContent = snap.reason || 'BC.Game 배당 읽는 중 — 배당 클릭/슬립 확인';
      }
      return;
    }

    if (!force && !needsAmountResync(snap, cfg) && polyPreSynced) {
      amountSyncQueued = false;
      return;
    }

    const syncBtiO = snap.btiO;
    const syncPolyO = snap.polyO;
    const syncPolyUsd = snap.polyUsd;

    const [btiRes, polyRes] = await Promise.all([
      setBtiAmount(snap.found.btiTab, cfg.btiBetKrw),
      setPolyAmount(snap.found.polyTab, syncPolyUsd)
    ]);

    lastSynced = {
      polyUsd: syncPolyUsd,
      btiKrw: cfg.btiBetKrw,
      btiO: syncBtiO,
      polyO: syncPolyO,
      at: Date.now()
    };
    lastKnownOdds.btiO = syncBtiO;
    lastKnownOdds.polyO = syncPolyO;
    lastKnownOdds.btiAt = Date.now();
    lastKnownOdds.polyAt = Date.now();
    lastKnownOdds.polyTrusted = !!(syncPolyO > 1 && (!snap.poly || !isStrikeBcSlip || isStrikeBcSlip(snap.poly)));

    snap.btiO = syncBtiO;
    snap.polyO = syncPolyO;
    snap.polyUsd = syncPolyUsd;
    snap.profit = calcProfit(syncBtiO, syncPolyO);
    liveSnap = snap;
    updateStatusFromSnap(snap, cfg);
    polyPreSynced = !!(polyRes?.ok && btiRes?.ok);
    amountSyncQueued = false;
    if (polyPreSynced) {
      $('statusHint').textContent = `동기화 OK — ${leg2PrefLabel(cfg.leg2)} $${snap.polyUsd.toFixed(2)} · ${leg1Label()} ${cfg.btiBetKrw.toLocaleString()}원`;
      lastPolySyncErr = '';
      if (armedLocal && snap.profit != null && snap.profit >= cfg.minProfit) {
        maybeStrikeOnSnap(snap, cfg, 'sync-ready');
      }
    } else if (!polyRes?.ok) {
      const detail = polyRes?.inputVal && polyRes?.stake && Math.abs(polyRes.inputVal - polyRes.stake) > 0.2
        ? ` (입력 ${polyRes.inputVal} ≠ 총베팅 ${polyRes.stake})`
        : '';
      const msg = (polyRes?.reason || 'BC.Game 금액 동기화 실패 — 슬립 금액란 확인') + detail;
      $('statusHint').textContent = msg;
      const now = Date.now();
      if (msg !== lastPolySyncErr || now - lastPolySyncErrAt > 12000) {
        logLine(msg, 'err');
        lastPolySyncErr = msg;
        lastPolySyncErrAt = now;
      }
    } else if (polyRes?.partial) {
      polyPreSynced = !!btiRes?.ok;
      $('statusHint').textContent = `BC 입력됨(총베팅 미반영) — 슬립 금액란 탭 후 확인 · $${snap.polyUsd.toFixed(2)}`;
    }
    setTimeout(() => refreshOddsLive(), 120);
  } catch (e) {
    polyPreSynced = false;
  } finally {
    amountSyncLock = false;
  }
}

async function executeStrike(snap, cfg, label) {
  if (strikeLock || haltAutoBet) {
    if (haltAutoBet) logLine('배팅 완료 상태 — [오토시작] 후 재개', 'err');
    else logLine('이미 배팅 진행 중', 'err');
    return;
  }

  const ready = await verifyStrikeReady(snap.found, snap.hint || {}, snap.poly, { fast: polyPreSynced });
  if (!ready.ok) {
    if (ready.btiClosed || /슬립 닫힘|슬립 미준비/.test(ready.reason || '')) {
      queuePendingStrike(snap, cfg, label);
      if (!btiSlipPaused) {
        logLine(`⏸ ${ready.reason} — 배팅 대기 (슬립 열리면 재개)`, 'info');
      }
    } else {
      logLine(ready.reason, 'err');
    }
    return;
  }
  clearPendingStrike();
  btiSlipPaused = false;

  strikeLock = true;
  setTestBtnBusy(true);
  lastStrikeAt = Date.now();
  const profitText = snap.profit != null ? `${snap.profit.toFixed(2)}%` : '테스트';
  logLine(`⚡ ${profitText} — 동시 배팅 (${label})`, 'strike');

  try {
    if (cfg.preSyncAmount && !polyPreSynced && snap.polyUsd > 0) {
      logLine('금액 동기화 중…', 'info');
      await liveAmountSync(true);
    }

    logLine(polyPreSynced ? '즉시 배팅 (금액 사전입력됨)' : '양쪽 배팅 실행 중…', 'info');
    const result = await withTimeout(
      strikeBothSides({
        found: snap.found,
        btiO: snap.btiO,
        polyO: snap.polyO,
        polyUsd: snap.polyUsd,
        hint: snap.hint || {},
        poly: snap.poly,
        btiBetKrw: cfg.btiBetKrw,
        polyPreSynced,
        fastStrike: polyPreSynced,
        gate: ready
      }),
      90000,
      '배팅'
    );

    if (result.ok) {
      logLine(`✓ 배팅 성공 ${result.elapsedMs}ms`, 'ok');
      logLine(`  ${leg1Label()}: ${result.btiRes?.btnText || result.btiRes?.reason || 'OK'}`, 'ok');
      logLine(`  ${leg2PrefLabel(cfg.leg2)}: ${result.polyRes?.btnText || result.polyRes?.method || result.polyRes?.reason || 'OK'}`, 'ok');
      disarmAfterStrike('배팅 성공 — 자동 해제');
    } else if (result.oneSided) {
      logLine(`⚠️ 한쪽만 배팅됨 — 수동 확인`, 'err');
      logLine(`  ${leg1Label()}: ${result.btiRes?.success ? 'OK' : (result.btiRes?.reason || '실패')}`, 'err');
      logLine(`  ${leg2PrefLabel(cfg.leg2)}: ${result.polyRes?.success ? 'OK' : (result.polyRes?.reason || '실패')}`, 'err');
    } else if (result.oneSidedPrevented) {
      logLine(`⛔ BC 실패 — 텐텐뱃 배팅 차단됨`, 'err');
      logLine(`  BC: ${result.polyRes?.reason || result.polyRes?.btnText || '실패'}`, 'err');
    } else if (result.gated) {
      queuePendingStrike(snap, cfg, label);
      logLine(`⏸ ${result.btiRes?.reason || '텐텐뱃 미준비'} — 배팅 대기`, 'info');
    } else {
      logLine(formatStrikeFailLine(result.btiRes, result.polyRes, cfg.leg2), 'err');
      if (result.btiRes?.frameId != null) {
        logLine(`  ${leg1Label()} iframe: ${result.btiRes.frameId}`, 'err');
      }
      if (result.polyRes?.probe) {
        logLine(`  ${leg2PrefLabel(cfg.leg2)} UI: btn=${result.polyRes.probe.hasBtn}`, 'err');
      }
    }
    chrome.runtime.sendMessage({ type: 'AUTOBET_STRIKE_RESULT', result, profit: snap.profit });
  } catch (e) {
    logLine(`✗ 오류: ${e.message}`, 'err');
  } finally {
    strikeLock = false;
    setTestBtnBusy(false);
    polyPreSynced = false;
  }
}

async function panelLoop() {
  if (!armedLocal || strikeLock || panelLoopBusy || haltAutoBet) return;

  panelLoopBusy = true;
  try {
    const cfg = saveConfig();
    if (Number.isNaN(cfg.minProfit)) cfg.minProfit = 1;

    const now = Date.now();
    if (now - lastStrikeAt < cfg.cooldownMs) return;

    const snap = liveSnap?.ok ? liveSnap : await getSnap(cfg);
    if (!armedLocal || haltAutoBet) return;
    if (!snap.ok) {
      $('statusHint').textContent = snap.reason || '탭 확인';
      return;
    }
    liveSnap = snap;
    updateStatusFromSnap(snap, cfg);

    if (snap.profit == null || snap.btiO == null || snap.polyO == null) return;
    if (typeof isStrikeBcSlip === 'function' && !isStrikeBcSlip(snap.poly)) return;
    if (snap.profit < cfg.minProfit) {
      if (pendingStrike) {
        logLine('수익 구간 이탈 — 배팅 대기 해제', 'info');
        clearPendingStrike();
        btiSlipPaused = false;
      }
      return;
    }

    if (btiSlipPaused && pendingStrike) return;

    if (btiSlipPaused) return;

    if (cfg.preSyncAmount && !polyPreSynced && snap.polyUsd > 0) {
      amountSyncQueued = true;
      await liveAmountSync(true);
      if (!polyPreSynced) return;
    }

    if (!armedLocal || haltAutoBet || strikeLock) return;

    await executeStrike(snap, cfg, 'panel');
  } finally {
    panelLoopBusy = false;
  }
}

function arm(armed) {
  if (armed && !isLeg2Connected()) {
    logLine('먼저 오른쪽 사이트 [연결]을 눌러주세요', 'err');
    return;
  }
  saveConfig();
  chrome.runtime.sendMessage({ type: 'AUTOBET_ARM', armed }, (res) => {
    if (res?.ok) {
      if (armed) {
        haltAutoBet = false;
        btiSlipPaused = false;
        btiSlipEverOpen = false;
        lastStrikeAt = 0;
      } else {
        clearPendingStrike();
        btiSlipPaused = false;
      }
      setArmedUi(res.armed);
      logLine(armed ? '오토시작 — 수익 구간 시 1회 배팅 후 자동 중지' : '오토 멈춤', armed ? 'strike' : 'info');
      if (armed) {
        lastProfitStrikeKey = '';
        amountSyncQueued = true;
        refreshOddsLive();
        liveAmountSync(true);
        getSnap(getConfig()).then((snap) => {
          if (!snap?.found) return;
          const cfg = getConfig();
          prewarmTabs(snap.found.btiTab, snap.found.polyTab, snap.hint, cfg.btiBetKrw, snap.polyUsd || 0).catch(() => {});
        });
      }
    }
  });
}

$('armBtn')?.addEventListener('click', () => arm(true));
$('disarmBtn')?.addEventListener('click', () => arm(false));

$('scanBtn')?.addEventListener('click', async () => {
  if (!isLeg2Connected()) {
    logLine('먼저 [연결] 버튼을 눌러주세요', 'err');
    return;
  }
  saveConfig();
  const cfg = getConfig();
  logLine('배당 스캔…', 'info');
  try {
    const snap = await getSnap(cfg, null, { focusTab: true, waitMs: 1200 });
    liveSnap = snap;
    updateStatusFromSnap(snap, cfg);

    if (snap.found?.btiTab) {
      const board = await searchBtiBoardFromFrames(snap.found.btiTab);
      const events = board.hits?.length ? board.hits : (board.events || []);
      logLine(
        `${leg1Label()} 배당판 — 버튼 ${board.buttonCount || 0} · 경기 ${board.eventCount || events.length}`,
        (board.buttonCount || events.length) ? 'ok' : 'err'
      );
      for (const ev of events.slice(0, 6)) {
        const ml = ev.moneyline?.length ? ev.moneyline : (ev.selections || []).filter((s) => s.marketKind === 'ml');
        const odds = ml.map((s) => s.odds?.toFixed(2)).filter(Boolean).join(' / ');
        logLine(`  ${ev.homeTeam || '?'} vs ${ev.awayTeam || '?'}${odds ? ` · ${odds}` : ''}`, 'info');
      }
    }

    if (snap.btiO > 1.01) {
      const dbg = snap.btiDebug;
      const src = dbg?.source ? ` [${dbg.source}${dbg.frameId != null ? ` f${dbg.frameId}` : ''}]` : '';
      logLine(`${leg1Label()} ${snap.btiO.toFixed(3)}${src}`, 'ok');
    } else if (snap.btiO === 0) {
      logLine(`${leg1Label()} 0.000 — 슬립 닫힘`, 'info');
    } else {
      logLine(`${leg1Label()} 배당 없음 — 스포츠 페이지·배당 클릭`, 'err');
      if (snap.btiDebug) logLine(`  debug: ${JSON.stringify(snap.btiDebug)}`, 'info');
      if (snap.found?.btiTab?.id && typeof probeBtiFramesDiagnostic === 'function') {
        try {
          const probes = await probeBtiFramesDiagnostic(snap.found.btiTab);
          for (const p of probes.slice(0, 8)) {
            const tag = p.widgetsX ? 'wx' : '  ';
            const line = `  f${p.frameId}${tag}: btn${p.buttons} slip${p.slipOdds > 1 ? p.slipOdds.toFixed(3) : '-'} in${p.hasInput ? 'Y' : 'N'} ping${p.pingOk ? 'Y' : 'N'}`;
            logLine(`${line} · ${(p.url || '(main)').slice(-48)}`, p.slipOdds > 1 ? 'ok' : 'info');
          }
        } catch (_) {}
      }
    }
    if (snap.polyO > 1.01) {
      const kind = snap.poly?.sourceKind ? ` [${snap.poly.sourceKind}]` : '';
      const cents = snap.poly?.priceCents ? `${snap.poly.priceCents}¢ · ` : '';
      logLine(`${leg2PrefLabel(cfg.leg2)}${kind} ${cents}${snap.polyO.toFixed(3)}`, 'ok');
    } else if (snap.polyO === 0) {
      logLine(`${leg2PrefLabel(cfg.leg2)} 0.000 — 슬립 닫힘`, 'info');
    } else {
      if (snap.found?.polyTab?.id) {
        try {
          const probes = typeof probeLeg2SlipFrames === 'function'
            ? await probeLeg2SlipFrames(snap.found.polyTab, cfg.leg2)
            : await probeBcSlipFrames(snap.found.polyTab);
          for (const p of probes) {
            if (p.odds > 1.01) {
              logLine(`  f${p.frameId}: ${p.odds.toFixed(3)} [${p.kind}] in${p.inputs} · ${p.url || '(main)'}`, 'ok');
            } else {
              let extra = '';
              if (p.selectedOdds) extra += ` sel[${p.selectedOdds}]`;
              if (p.scrapeOdds > 1.01) extra += ` scr${p.scrapeOdds.toFixed(3)}`;
              if (p.apiOdds > 1.01) extra += ` api${p.apiOdds.toFixed(3)}`;
              if (p.stake) extra += ` stake${p.stake}`;
              if (p.iframeHint) extra += ` ifr[${p.iframeHint.slice(0, 50)}]`;
              if (p.placeBtnText) extra += ` btn[${p.placeBtnText}]`;
              if (p.oddsPreview) extra += ` odds[${p.oddsPreview}]`;
              if (p.panelSample) extra += ` "${p.panelSample.slice(0, 50)}"`;
              logLine(`  f${p.frameId}: ${p.kind} in${p.inputs} len${p.len || 0}${p.flags || ''}${extra} · ${p.url || '(main)'}`, 'info');
              if (p.frameId === 0 && p.sample) logLine(`    "${p.sample.slice(0, 80)}…"`, 'info');
            }
          }
        } catch (_) {}
      }
      logLine(snap.reason || `${leg2PrefLabel(cfg.leg2)} 배당 없음 — 배당 선택 후 스캔`, 'err');
      logLine('  ※ 슬립 없어도 초록 선택 배당에서 읽기 시도함', 'info');
    }
    if (snap.btiO > 1 && snap.polyO > 1) {
      logLine(`수익률 ${snap.profit?.toFixed(2) ?? '-'}% · ${leg2PrefShort(cfg.leg2)} $${snap.polyUsd?.toFixed(2) ?? '-'}`, snap.profit >= cfg.minProfit ? 'ok' : 'info');
      amountSyncQueued = true;
      liveAmountSync(true);
    }
  } catch (e) {
    logLine(`스캔 실패: ${e.message}`, 'err');
  }
});

$('testBetBtn')?.addEventListener('click', async () => {
  if (strikeLock) {
    logLine('이미 실행 중 — 잠시만 기다리세요', 'err');
    return;
  }
  strikeLock = true;
  setTestBtnBusy(true);
  const cfg = saveConfig();
  logLine('테스트 배팅 — 수익률 무시', 'info');

  try {
    logLine('탭·배당 읽는 중…', 'info');
    await liveAmountSync(true);
    const snap = await getSnap(cfg);
    if (!snap.ok || !snap.found?.btiTab || !snap.found?.polyTab) {
      logLine(snap.reason || '탭/배당 없음', 'err');
      return;
    }
    logLine(
      `탭 A:${snap.found.btiTab.id} B:${snap.found.polyTab.id} | ${snap.btiO || '-'} / ${snap.polyO || '-'} | BC $${snap.polyUsd || '-'}`,
      'info'
    );
    if (!snap.btiO || !snap.polyO) {
      logLine(`배당 부족 — ${leg1Label()}: ${snap.btiO || '-'} · ${leg2PrefLabel(cfg.leg2)}: ${snap.polyO || '-'}`, 'err');
      return;
    }
    if (snap.profit == null) snap.profit = calcProfit(snap.btiO, snap.polyO) || 0;
    if (!snap.polyUsd) snap.polyUsd = calcPolyBetUsd(cfg.btiBetKrw, snap.btiO, snap.polyO, cfg.usdRate);
    strikeLock = false;
    await executeStrike(snap, cfg, '테스트');
  } catch (e) {
    logLine(`테스트 실패: ${e.message}`, 'err');
  } finally {
    strikeLock = false;
    setTestBtnBusy(false);
  }
});

['minProfit', 'btiBet', 'usdRate', 'cooldownMs', 'useBridge', 'preSync'].forEach((id) => {
  $(id)?.addEventListener('change', () => {
    saveConfig();
    lastSynced.at = 0;
    amountSyncQueued = true;
    if (isLeg2Connected()) liveAmountSync(true);
  });
});

$('leg2Site')?.addEventListener('change', () => {
  leg2Synced = false;
  leg2SyncedSite = '';
  polyPreSynced = false;
  clearKnownOdds('all');
  saveConfig();
  updateSyncUi();
  $('statusHint').textContent = `${leg2PrefLabel(getConfig().leg2)} 선택됨 — [연결] 버튼을 눌러주세요`;
});

$('btiVerifyBtn')?.addEventListener('click', () => verifyBtiSite());
$('syncBtn')?.addEventListener('click', () => syncLeg2Site());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AUTOBET_ARMED') {
    setArmedUi(msg.armed);
    haltAutoBet = !msg.armed;
    if (msg.armed) lastStrikeAt = 0;
  }
  if (msg.type === 'AUTOBET_LOG' && msg.entry) logLine(msg.entry.text, msg.entry.level);
  if (msg.type === 'ODDS_CHANGED') {
    applyInstantOdds(msg);
    amountSyncQueued = true;
    if (armedLocal && liveSnap?.ok) {
      maybeStrikeOnSnap(patchSnapFromKnown(liveSnap, getConfig()), getConfig(), 'odds-event');
    }
    if ($('preSync')?.checked) liveAmountSync(true);
  }
  if (msg.type === 'BTI_STAKE_CHANGED') {
    lastSynced.at = 0;
    amountSyncQueued = true;
  }
});

chrome.runtime.sendMessage({ type: 'AUTOBET_GET_STATE' }, (res) => {
  if (res?.config) applyConfig({ ...res.config, armed: res.armed });
  else if (res?.armed != null) setArmedUi(res.armed);
  haltAutoBet = !res?.armed;
  updateSyncUi();
  if (isLeg2Connected()) {
    amountSyncQueued = true;
    refreshOddsLive();
    liveAmountSync(true);
  }
});

chrome.storage.local.get('autoBetLog', (data) => {
  (data.autoBetLog || []).slice(0, 15).reverse().forEach((e) => logLine(e.text, e.level));
});

setInterval(() => {
  if (armedLocal && !haltAutoBet) updateBtiSlipPauseState();
}, 200);
setInterval(() => {
  if (armedLocal) refreshOddsLive();
}, ODDS_POLL_ARMED_MS);
setInterval(() => {
  if (!armedLocal && isLeg2Connected()) refreshOddsLive();
}, ODDS_POLL_MS);
setInterval(() => {
  if (($('preSync')?.checked || armedLocal) && isLeg2Connected()) liveAmountSync(false);
}, AMOUNT_SYNC_ARMED_MS);
setInterval(panelLoop, PANEL_LOOP_ARMED_MS);

logLine(`v${chrome.runtime.getManifest().version} — BC.Game · Stake.com 지원`, 'info');
