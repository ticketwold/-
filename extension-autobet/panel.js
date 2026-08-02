'use strict';

const SNAP_TIMEOUT_MS = 20000;
const ODDS_POLL_MS = 250;
const AMOUNT_SYNC_INTERVAL_MS = 200;
const ODDS_GAP_FILL_MS = 5000;

const $ = (id) => document.getElementById(id);

let armedLocal = false;
let strikeLock = false;
let panelLoopBusy = false;
let haltAutoBet = false;
let lastStrikeAt = 0;
let amountSyncLock = false;
let oddsReadBusy = false;
let amountSyncQueued = true;
let lastSynced = { polyUsd: 0, btiKrw: 0, btiO: 0, polyO: 0, at: 0 };
let polyPreSynced = false;
let tabCache = null;
let btiSlipPaused = false;
let btiSlipPauseBusy = false;
let btiSlipEverOpen = false;
let pendingStrike = null;
let liveSnap = { ok: false };
let lastKnownOdds = { btiO: null, polyO: null, btiAt: 0, polyAt: 0 };

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
    if (armed && (btiSlipPaused || pendingStrike)) {
      st.textContent = '무장·대기';
      st.className = 'armed paused';
    } else {
      st.textContent = armed ? '무장' : '해제';
      st.className = armed ? 'armed' : 'disarmed';
    }
  }
  $('armBtn').disabled = armed;
  $('disarmBtn').disabled = !armed;
  $('statusBox').style.borderColor = armed ? '#dc2626' : '#2d3142';
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

  const ready = await verifyStrikeReady(snap.found, snap.hint || {}, snap.poly);
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
  if (hint) hint.textContent = '배팅 완료 — 자동 해제됨 (🔴 무장으로 재시작)';
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

function displayOdds(btiO, polyO, snapReason) {
  const now = Date.now();
  const bcMissing = snapReason && /BC\.Game 배당 없음/.test(snapReason);
  const bti = btiO > 1 ? btiO
    : (now - lastKnownOdds.btiAt < ODDS_GAP_FILL_MS && lastKnownOdds.btiO > 1 ? lastKnownOdds.btiO : null);
  const poly = polyO > 1 ? polyO
    : (!bcMissing && now - lastKnownOdds.polyAt < ODDS_GAP_FILL_MS && lastKnownOdds.polyO > 1 ? lastKnownOdds.polyO : null);
  $('oddsVal').textContent = `${bti > 1 ? bti.toFixed(3) : '-'} / ${poly > 1 ? poly.toFixed(3) : '-'}`;
}

function patchSnapFromKnown(snap, cfg) {
  const bcMissing = snap.reason && /BC\.Game 배당 없음/.test(snap.reason);
  const partial = {
    btiO: lastKnownOdds.btiO > 1 ? lastKnownOdds.btiO : snap.btiO,
    polyO: bcMissing ? snap.polyO : (lastKnownOdds.polyO > 1 ? lastKnownOdds.polyO : snap.polyO)
  };
  if (partial.btiO > 1 && partial.polyO > 1) {
    partial.profit = calcProfit(partial.btiO, partial.polyO);
    partial.polyUsd = calcPolyBetUsd(cfg.btiBetKrw, partial.btiO, partial.polyO, cfg.usdRate);
  }
  return { ...snap, ...partial };
}

function applyInstantOdds(msg) {
  if (!msg?.slip?.odds || msg.slip.odds <= 1) return false;
  const cfg = getConfig();
  const o = msg.slip.odds;
  const now = Date.now();
  if (msg.source === 'bti') {
    lastKnownOdds.btiO = o;
    lastKnownOdds.btiAt = now;
  } else {
    lastKnownOdds.polyO = o;
    lastKnownOdds.polyAt = now;
  }
  lastSynced.at = 0;
  amountSyncQueued = true;
  updateStatusFromSnap(patchSnapFromKnown(liveSnap.ok ? liveSnap : {}, cfg), cfg);
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
  if (snap.btiO > 1) {
    lastKnownOdds.btiO = snap.btiO;
    lastKnownOdds.btiAt = now;
  } else if (lastKnownOdds.btiO > 1 && now - lastKnownOdds.btiAt < ODDS_GAP_FILL_MS) {
    snap.btiO = lastKnownOdds.btiO;
  }
  if (snap.polyO > 1) {
    lastKnownOdds.polyO = snap.polyO;
    lastKnownOdds.polyAt = now;
  } else if (snap.reason && /BC\.Game 배당 없음/.test(snap.reason)) {
    lastKnownOdds.polyO = null;
    lastKnownOdds.polyAt = 0;
    snap.polyO = null;
    snap.poly = null;
  } else if (lastKnownOdds.polyO > 1 && now - lastKnownOdds.polyAt < ODDS_GAP_FILL_MS) {
    snap.polyO = lastKnownOdds.polyO;
  }

  if (snap.btiO > 1 && snap.polyO > 1) {
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

async function refreshOddsLive() {
  if (oddsReadBusy || strikeLock) return;
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
    updateStatusFromSnap(snap, cfg);
    if (snap.btiO > 1 && snap.polyO > 1 && needsAmountResync(snap, cfg)) {
      amountSyncQueued = true;
    }
  } catch (e) {
    if (e.message) $('statusHint').textContent = e.message;
  } finally {
    oddsReadBusy = false;
  }
}

async function getSnap(cfg, progressLabel, opts = {}) {
  if (progressLabel) logLine(progressLabel, 'info');
  let snap = await withTimeout(
    readSnapshot(cfg.leg2, cfg.btiBetKrw, cfg.usdRate, opts),
    SNAP_TIMEOUT_MS,
    '배당 읽기'
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
  if (Math.abs((snap.btiO || 0) - lastSynced.btiO) > 0.003) return true;
  if (Math.abs((snap.polyO || 0) - lastSynced.polyO) > 0.003) return true;
  return Date.now() - lastSynced.at > 1000;
}

async function liveAmountSync(force) {
  if (amountSyncLock || strikeLock) return;
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
    if (haltAutoBet) logLine('배팅 완료 상태 — 무장 후 재시작', 'err');
    else logLine('이미 배팅 진행 중', 'err');
    return;
  }

  const ready = await verifyStrikeReady(snap.found, snap.hint || {}, snap.poly);
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
        polyPreSynced
      }),
      90000,
      '배팅'
    );

    if (result.ok) {
      logLine(`✓ 배팅 성공 ${result.elapsedMs}ms`, 'ok');
      logLine(`  ${leg1Label()}: ${result.btiRes?.btnText || result.btiRes?.reason || 'OK'}`, 'ok');
      logLine(`  ${leg2PrefLabel(cfg.leg2)}: ${result.polyRes?.btnText || result.polyRes?.method || result.polyRes?.reason || 'OK'}`, 'ok');
      disarmAfterStrike('배팅 성공 — 자동 해제');
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
      await liveAmountSync(true);
    }

    if (!armedLocal || haltAutoBet || strikeLock) return;

    await executeStrike(snap, cfg, 'panel');
  } finally {
    panelLoopBusy = false;
  }
}

function arm(armed) {
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
      logLine(armed ? '무장 — 수익 구간 시 1회 배팅 후 자동 해제' : '해제', armed ? 'strike' : 'info');
      if (armed) {
        amountSyncQueued = true;
        refreshOddsLive();
        liveAmountSync(true);
      }
    }
  });
}

$('armBtn')?.addEventListener('click', () => arm(true));
$('disarmBtn')?.addEventListener('click', () => arm(false));

$('scanBtn')?.addEventListener('click', async () => {
  const cfg = saveConfig();
  logLine('배당 스캔… (BC 탭 활성화)', 'info');
  try {
    const snap = await getSnap(cfg, null, { focusTab: true, waitMs: 1600 });
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
      if (!snap.btiO && board.buttonCount > 0) {
        const boardSlip = await readBtiBoardOddsFromFrames(snap.found.btiTab, snap.hint || {});
        if (boardSlip?.odds > 1.01) {
          snap.btiO = boardSlip.odds;
          snap.bti = boardSlip;
          if (snap.polyO > 1) {
            snap.profit = calcProfit(snap.btiO, snap.polyO);
            snap.polyUsd = calcPolyBetUsd(cfg.btiBetKrw, snap.btiO, snap.polyO, cfg.usdRate);
          }
          liveSnap = snap;
          updateStatusFromSnap(snap, cfg);
        }
      }
    }

    if (snap.btiO > 1) logLine(`${leg1Label()} ${snap.btiO.toFixed(3)}`, 'ok');
    else logLine(`${leg1Label()} 배당 없음 — 스포츠 페이지·배당 클릭`, 'err');
    if (snap.polyO > 1) {
      const kind = snap.poly?.sourceKind ? ` [${snap.poly.sourceKind}]` : '';
      const cents = snap.poly?.priceCents ? `${snap.poly.priceCents}¢ · ` : '';
      logLine(`BC.Game${kind} ${cents}${snap.polyO.toFixed(3)}`, 'ok');
    } else {
      if (snap.found?.polyTab?.id) {
        try {
          const probes = await probeBcSlipFrames(snap.found.polyTab);
          for (const p of probes) {
            if (p.odds > 1.01) {
              logLine(`  f${p.frameId}: ${p.odds.toFixed(3)} [${p.kind}] in${p.inputs} · ${p.url || '(main)'}`, 'ok');
            } else {
              let extra = '';
              if (p.selectedOdds) extra += ` sel[${p.selectedOdds}]`;
              if (p.scrapeOdds > 1.01) extra += ` scr${p.scrapeOdds.toFixed(3)}`;
              if (p.apiOdds > 1.01) extra += ` api${p.apiOdds.toFixed(3)}`;
              logLine(`  f${p.frameId}: ${p.kind} in${p.inputs} len${p.len || 0}${p.flags || ''}${extra} · ${p.url || '(main)'}`, 'info');
              if (p.frameId === 0 && p.sample) logLine(`    "${p.sample.slice(0, 80)}…"`, 'info');
            }
          }
        } catch (_) {}
      }
      logLine(snap.reason || 'BC.Game 배당 없음 — BC에서 배당(초록) 클릭 후 스캔', 'err');
      logLine('  ※ 슬립 없어도 초록 선택 배당에서 읽기 시도함', 'info');
    }
    if (snap.btiO > 1 && snap.polyO > 1) {
      logLine(`수익률 ${snap.profit?.toFixed(2) ?? '-'}% · BC $${snap.polyUsd?.toFixed(2) ?? '-'}`, snap.profit >= cfg.minProfit ? 'ok' : 'info');
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

['minProfit', 'btiBet', 'usdRate', 'leg2Site', 'cooldownMs', 'useBridge', 'preSync'].forEach((id) => {
  $(id)?.addEventListener('change', () => {
    saveConfig();
    lastSynced.at = 0;
    amountSyncQueued = true;
    liveAmountSync(true);
  });
});

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
    refreshOddsLive();
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
  amountSyncQueued = true;
  refreshOddsLive();
  liveAmountSync(true);
});

chrome.storage.local.get('autoBetLog', (data) => {
  (data.autoBetLog || []).slice(0, 15).reverse().forEach((e) => logLine(e.text, e.level));
});

setInterval(() => {
  if (armedLocal && !haltAutoBet) updateBtiSlipPauseState();
}, 500);
setInterval(refreshOddsLive, ODDS_POLL_MS);
setInterval(() => {
  if ($('preSync')?.checked || armedLocal) liveAmountSync(false);
}, AMOUNT_SYNC_INTERVAL_MS);
setInterval(panelLoop, 400);

logLine('v1.5.1 — 초록 선택 배당 + 텐텐뱃 팀 자동클릭', 'info');
