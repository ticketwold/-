// popup.js v5.7.0 — 텐텐뱃 + BC.Game

'use strict';

const POLL_MS = 16;
const FALLBACK_REFRESH_MS = 800;
const BTI_FULL_SCAN_MS = 2500;
const AUTO_BET_COOLDOWN_MS = 6000;
const IS_PANEL = document.body.classList.contains('panel-mode');
let autoSyncEnabled = true;
let syncRunning = false;
let autoBetRunning = false;
let autoBetWanted = false;
let autoBetPausedByClose = false;
let autoBetSessionId = 0;
let autoBetStateEpoch = 0;
let autoBetUiLocked = false;
let suppressStorageApplyUntil = 0;
let lastMarketCloseLogAt = 0;
let lastMarketOpenLogAt = 0;
let calcTimer = null;
let syncTimer = null;
let syncPending = false;
let autoBetTimer = null;
let strikePending = false;
let lastStrikeAt = 0;
let lastSyncedBtiKrw = 0;
let lastSyncedBcUsd = 0;
let lastSyncedAt = 0;
let lastSyncedBtiOdds = 0;
let lastSyncedBcOdds = 0;
let lastBcSyncAt = 0;
let lastBcStakeFrameId = null;
let lastBcPlaceFail = null;
let bcSyncPending = false;
let cachedBti = null;
let cachedBc = null;
let lastBtiFrame = null;
let lastBtiSlipFrame = null;
let lastBtiBoardFrame = null;
let lastBtiFullScanAt = 0;
let refreshPending = false;
let refreshQueued = false;
let bcCartEmptyConfirmed = false;
let bcScriptReady = new Set();
let btiScriptReady = new Set();
let lastStatus = { bti: '', bc: '' };
const SYNC_STATE_KEY = 'syncState';
const HISTORY_KEY = 'calcHistory';
const HISTORY_MAX = 100;
let historyEntries = [];
let lastHistoryKey = '';
let cachedUsdtRate = 1400;
let cachedUsdtSource = 'manual';
let usdtRateTimer = null;

function formatBcOddsForHistory(slip) {
  if (!slip?.odds || slip.odds <= 1) return '-';
  if (slip.fromPayout) return slip.odds.toFixed(3);
  if (slip.priceCents != null) return `${slip.priceCents}¢ (${slip.odds.toFixed(3)})`;
  return slip.odds.toFixed(3);
}

function formatHistoryLine(bti, poly, arbBti, profit) {
  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = bti?.odds > 1 ? bti.odds : null;
  const team = poly?.teamLabel || formatBtiMeta(bti) || '경기';
  const profitText = profit != null ? `${profit.toFixed(2)}%` : '-';
  return `${team} · 텐텐뱃 ${btiO?.toFixed(3) || '-'} · BC ${formatBcOddsForHistory(poly)} · 수익률 ${profitText}`;
}

function buildHistoryKey(btiO, polyO, team) {
  return `${team}|${btiO?.toFixed(4)}|${polyO?.toFixed(4)}`;
}

function renderHistory() {
  const el = $('historyList');
  if (!el) return;
  if (!historyEntries.length) {
    el.innerHTML = '<div class="hint">계산 시작 후 배당·수익률이 기록됩니다</div>';
    return;
  }
  el.innerHTML = historyEntries.map((entry) => {
    const t = new Date(entry.time).toLocaleTimeString();
    const profitCls = entry.profit != null && entry.profit >= getMinProfit()
      ? 'profit-pos'
      : (entry.profit != null && entry.profit < 0 ? 'profit-neg' : '');
    const parts = entry.text.split(' · 수익률 ');
    const head = parts[0] || entry.text;
    const tail = parts[1] || '';
    const profitHtml = tail
      ? ` · 수익률 <span class="${profitCls}">${tail}</span>`
      : '';
    return `<div class="history-item"><span class="history-time">${t}</span>${head}${profitHtml}</div>`;
  }).join('');
}

async function loadHistory() {
  try {
    const data = await chrome.storage.local.get(HISTORY_KEY);
    historyEntries = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  } catch (_) {
    historyEntries = [];
  }
  renderHistory();
}

async function saveHistory() {
  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: historyEntries.slice(0, HISTORY_MAX) });
  } catch (_) {}
}

function maybeRecordHistory(bti, poly, arbBti) {
  if (!shouldSyncAmounts()) return;
  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = bti?.odds > 1 ? bti.odds : null;
  if (!polyO || !btiO) return;

  const profit = calcProfit(btiO, polyO);
  if (profit == null) return;

  const team = poly?.teamLabel || formatBtiMeta(bti) || '경기';
  const key = buildHistoryKey(btiO, polyO, team);
  if (key === lastHistoryKey) return;
  lastHistoryKey = key;

  const entry = {
    time: Date.now(),
    profit,
    text: formatHistoryLine(bti, poly, arbBti, profit)
  };
  historyEntries.unshift(entry);
  if (historyEntries.length > HISTORY_MAX) historyEntries.length = HISTORY_MAX;
  saveHistory();
  renderHistory();
}

function clearHistory() {
  historyEntries = [];
  lastHistoryKey = '';
  saveHistory();
  renderHistory();
}

function log(text, cls = '') {
  const el = document.getElementById('log');
  if (!el) return;
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.prepend(div);
  while (el.children.length > 50) el.lastChild.remove();
}

function $(id) { return document.getElementById(id); }

function openPanel() {
  chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }, (res) => {
    if (res?.ok) log('별도 창 열림', 'info');
    else log(`창 열기 실패: ${res?.error || ''}`, 'err');
  });
}

function getMinProfit() {
  const v = parseFloat($('slipMinProfit')?.value || $('minProfit')?.value || '1');
  return Number.isFinite(v) ? v : 1;
}

function getBtiBet() {
  const v = parseInt($('btiBet')?.value || '10000', 10);
  return Number.isFinite(v) ? v : 10000;
}

async function readBtiStakeFromPage(btiTab) {
  if (!btiTab?.id) return 0;
  const frameIds = [
    btiSlipFrameId(btiTab.id),
    lastBtiFrame?.tabId === btiTab.id ? lastBtiFrame.frameId : 0,
    btiBoardFrameId(btiTab.id)
  ];
  const seen = new Set();
  for (const frameId of frameIds) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    const res = await sendBti(btiTab.id, frameId, { type: 'READ_BTI_STAKE' });
    if (res?.stake > 0) return res.stake;
  }
  return 0;
}

async function getBtiBetAmount(btiTab) {
  if ((shouldSyncAmounts()) && btiTab?.id) {
    const fromPage = await readBtiStakeFromPage(btiTab);
    if (fromPage > 0) {
      const input = $('btiBet');
      if (input) input.value = String(fromPage);
      return fromPage;
    }
  }
  return getBtiBet();
}

function getUsdRate() {
  const v = parseFloat($('usdRate')?.value || String(cachedUsdtRate) || '1400');
  return Number.isFinite(v) ? v : cachedUsdtRate || 1400;
}

function formatRateSource(source) {
  if (source === 'bithumb') return '빗썸';
  if (source === 'cache') return '빗썸(캐시)';
  return '수동';
}

function applyUsdtRate(rate) {
  if (!rate?.krw) return;
  cachedUsdtRate = rate.krw;
  cachedUsdtSource = rate.source || 'bithumb';
  const input = $('usdRate');
  if (input) {
    input.value = String(Math.round(rate.krw));
    input.readOnly = true;
  }
  const hint = $('usdRateHint');
  if (hint) {
    const t = rate.updatedAt ? new Date(rate.updatedAt).toLocaleTimeString() : '';
    hint.textContent = `${formatRateSource(cachedUsdtSource)} ${Math.round(rate.krw).toLocaleString()}원${t ? ` · ${t}` : ''}`;
  }
  updateSlipUI(cachedBti, cachedBc);
  persistSyncState({ usdRate: rate.krw });
}

async function refreshBithumbRate() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'REFRESH_USDT_RATE' });
    if (res?.rate) {
      applyUsdtRate(res.rate);
      return res.rate;
    }
  } catch (_) {}
  const rate = await getUsdtKrwRate(getUsdRate());
  applyUsdtRate(rate);
  return rate;
}

function startBithumbRateLoop() {
  refreshBithumbRate();
  if (usdtRateTimer) clearInterval(usdtRateTimer);
  usdtRateTimer = setInterval(refreshBithumbRate, 60_000);
}

function formatOdds(slip) {
  if (!slip) return '-';
  if (!slip.odds || slip.odds <= 1) {
    if (slip.needsStake) return '금액입력';
    return '-';
  }
  if (slip.fromPayout) {
    const lbl = slip.displayLabel || '';
    if (/당첨|to\s*win/i.test(lbl)) return lbl;
    return slip.odds.toFixed(3);
  }
  if (slip.priceCents != null) return `${slip.priceCents}¢ (${slip.odds.toFixed(3)})`;
  return slip.odds.toFixed(3);
}

function formatBcMeta(slip) {
  if (!slip) return '-';
  const parts = [slip.teamLabel || slip.selectionText || ''];
  if (slip.fromPayout) parts.push('당첨금 기준');
  else if (slip.hint) parts.push(slip.hint);
  return parts.filter(Boolean).join(' · ').slice(0, 100) || '-';
}

function formatBtiMeta(slip) {
  if (!slip) return '-';
  const team = slip.teamLabel || slip.selectionText || '';
  let label = team;
  if (team && !/^W[12]$/i.test(team)) label = team;
  else if (slip.homeTeam || slip.awayTeam) {
    if (slip.side === 'away' || slip.side === 'a') label = slip.awayTeam || team || '-';
    else label = slip.homeTeam || team || '-';
  } else label = team || '-';
  const mkt = slip.marketKind === 'ah' ? '핸디' : slip.marketKind === 'ou' ? 'OU' : '';
  const line = slip.line != null ? ` ${slip.line > 0 ? '+' : ''}${slip.line}` : '';
  const prefix = mkt ? `${mkt}${line} · ` : '';
  if (slip.source === 'board-live' || slip.source === 'board' || slip.source === 'main-scrape' || slip.source === 'slip-display' || slip.source === 'merged') {
    return `${prefix}${label} · 실시간`;
  }
  return `${prefix}${label}`;
}

function getBcSlipForUi() {
  if (bcCartEmptyConfirmed) return null;
  const odds = resolveBcOddsForSync();
  if (!odds || odds <= 1) return null;
  return { ...cachedBc, odds };
}

function updateSlipUI(bti, poly, arbBti = null) {
  const polyUi = getBcSlipForUi();
  $('btiOdds').textContent = formatOdds(bti);
  $('polyOdds').textContent = formatOdds(polyUi);
  $('btiMeta').textContent = formatBtiMeta(bti);
  $('polyMeta').textContent = formatBcMeta(polyUi);

  const polyO = polyUi?.odds > 1 ? polyUi.odds : null;
  const btiO = bti?.odds > 1 ? bti.odds : null;
  const profit = (btiO && polyO) ? calcProfit(btiO, polyO) : null;
  const profitEl = $('profit');
  if (profitEl) {
    profitEl.textContent = profit !== null ? `${profit.toFixed(2)}%` : '-';
    let profitCls = 'profit';
    if (profit !== null && profit >= getMinProfit()) profitCls += ' positive';
    else if (profit !== null && profit < 0) profitCls += ' negative';
    profitEl.className = profitCls;
  }

  const hint = $('profitHint');
  if (autoBetPausedByClose) {
    hint.textContent = '배당 마감 — 자동배팅 일시정지 (재개 대기)';
  } else if (autoBetWanted && autoBetRunning) {
    if (profit !== null && profit >= getMinProfit()) {
      hint.textContent = `자동배팅 가동 — 수익 ${profit.toFixed(2)}% (최소 ${getMinProfit()}%)`;
    } else {
      hint.textContent = '자동배팅 가동 중 — 수익 조건 충족 시 즉시 배팅';
    }
  } else if (!bti?.odds) hint.textContent = lastStatus.bti || '텐텐뱃: x10x10s 슬립/배당판 확인';
  else if (!polyUi?.odds) hint.textContent = lastStatus.bc || 'BC.Game: 슬립/배당 확인';
  else if (polyUi?.needsStake) hint.textContent = shouldSyncAmounts() ? '금액 자동 입력 중...' : '금액 입력 시 당첨금 기준 배당';
  else if (profit !== null && profit >= getMinProfit()) {
    if (syncRunning) hint.textContent = `수익 구간 — 금액 동기화 중 (${profit.toFixed(2)}%)`;
    else hint.textContent = `수익 구간 충족 (${profit.toFixed(2)}%) — 자동 배팅 시작 가능`;
  }
  else if (profit !== null) hint.textContent = `수익 구간 밖 (최소 ${getMinProfit()}%)`;
  else hint.textContent = '배당 확인 중...';

  updateManualBetButton();

  if (btiO && polyO) {
    const btiBet = getBtiBet();
    const rate = getUsdRate();
    const polyStakeCalc = calcPolyBetUsd(btiBet, btiO, polyO, rate);
    const polyStakePage = polyUi?.stake > 0 ? polyUi.stake : null;
    const polyStake = polyStakeCalc;
    $('calcBti').textContent = `${btiBet.toLocaleString()}원`;
    $('calcPoly').textContent = `$${polyStake.toFixed(2)}`;

    const btiTotalKrw = calcBtiTotalPayoutKrw(btiBet, btiO);
    const polyTotalUsd = (polyUi?.fromPayout && polyUi?.payout)
      ? polyUi.payout
      : calcPolyTotalPayoutUsd(polyStake, polyO);
    const polyTotalKrw = usdToKrw(polyTotalUsd, rate);
    const totalInvest = calcTotalInvestKrw(btiBet, polyStake, rate);
    const netBti = calcNetProfitIfBtiWins(btiBet, btiO, polyStake, rate);
    const netPoly = calcNetProfitIfPolyWins(btiBet, polyStake, polyO, rate);
    const netRoiBti = calcNetRoiPercent(netBti, totalInvest);
    const netRoiPoly = calcNetRoiPercent(netPoly, totalInvest);

    if ($('payoutBti')) {
      $('payoutBti').textContent = btiTotalKrw ? `${btiTotalKrw.toLocaleString()}원` : '-';
      const btiPctEl = $('payoutBtiPct');
      if (btiPctEl) {
        btiPctEl.textContent = (netBti != null && netRoiBti != null)
          ? `양방 순수익 ${formatKrwSigned(netBti)} (${formatRoiPercent(netRoiBti)})`
          : '-';
        btiPctEl.className = `payout-pct${netBti != null && netBti < 0 ? ' negative' : ''}`;
      }

      $('payoutPoly').textContent = polyTotalKrw ? `${polyTotalKrw.toLocaleString()}원` : '-';
      const polyUsdEl = $('payoutPolyUsd');
      if (polyUsdEl) {
        polyUsdEl.textContent = polyTotalUsd
          ? `($${polyTotalUsd.toFixed(2)} USDT · ${formatRateSource(cachedUsdtSource)} ${rate.toLocaleString()}원)`
          : '-';
      }
      const polyPctEl = $('payoutPolyPct');
      if (polyPctEl) {
        polyPctEl.textContent = (netPoly != null && netRoiPoly != null)
          ? `양방 순수익 ${formatKrwSigned(netPoly)} (${formatRoiPercent(netRoiPoly)})`
          : '-';
        polyPctEl.className = `payout-pct${netPoly != null && netPoly < 0 ? ' negative' : ''}`;
      }

      const compareEl = $('payoutCompare');
      if (btiTotalKrw && polyTotalKrw) {
        const diffKrw = Math.abs(btiTotalKrw - polyTotalKrw);
        let msg = '';
        if (diffKrw < Math.max(200, rate * 0.15)) {
          msg = `✓ 당첨금 일치 · 양방 순수익률 ${formatRoiPercent(netRoiBti)}`;
          compareEl.className = 'payout-compare ok';
        } else {
          msg = `⚠ 당첨금 차이 ${diffKrw.toLocaleString()}원`;
          compareEl.className = 'payout-compare warn';
        }
        if (polyStakePage && Math.abs(polyStakePage - polyStakeCalc) >= 0.05) {
          msg += ` — BC 페이지 $${polyStakePage.toFixed(2)} ≠ 계산 $${polyStakeCalc.toFixed(2)}`;
          compareEl.className = 'payout-compare warn';
        }
        compareEl.textContent = msg;
      } else {
        compareEl.textContent = 'BC.Game 금액 입력 후 비교';
        compareEl.className = 'payout-compare muted';
      }
    }
  } else {
    $('calcBti').textContent = '-';
    $('calcPoly').textContent = '-';
    ['payoutBti', 'payoutPoly', 'payoutBtiPct', 'payoutPolyUsd', 'payoutPolyPct'].forEach((id) => {
      const el = $(id);
      if (el) {
        el.textContent = '-';
        if (id.endsWith('Pct')) el.className = 'payout-pct';
      }
    });
    const compareEl = $('payoutCompare');
    if (compareEl) {
      compareEl.textContent = '양쪽 배당 확인 후 표시';
      compareEl.className = 'payout-compare muted';
    }
  }

  maybeRecordHistory(bti, poly, arbBti);
}

async function getAllFrames(tabId) {
  if (!chrome.webNavigation?.getAllFrames) return [{ frameId: 0 }];
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      resolve(frames?.length ? frames : [{ frameId: 0 }]);
    });
  });
}

function sendBti(tabId, frameId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: frameId || 0 }, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

function sendBc(tabId, msg, frameId = 0) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: frameId || 0 }, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

async function ensureBtiScript(tabId, frameId) {
  const key = `${tabId}:${frameId}`;
  if (btiScriptReady.has(key)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['bti_content.js']
    });
    btiScriptReady.add(key);
  } catch (_) {}
}

async function ensureBcScript(tabId, frameId = null) {
  const key = frameId != null ? `${tabId}:${frameId}` : String(tabId);
  if (bcScriptReady.has(key)) return;
  const mainFiles = ['bc_slip_direct.js', 'bc_api_hook.js', 'bc_sports_scrape.js', 'bc_board_scrape.js', 'bc_stake_set.js', 'bc_place_bet.js'];
  for (const file of mainFiles) {
    try {
      const target = frameId != null
        ? { tabId, frameIds: [frameId] }
        : { tabId, allFrames: true };
      await chrome.scripting.executeScript({ target, files: [file], world: 'MAIN' });
    } catch (_) {}
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['bc_betby_bridge.js'],
      world: 'MAIN'
    });
  } catch (_) {}
  try {
    const target = frameId != null
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['bc_content.js'] });
    try {
      await chrome.scripting.executeScript({ target, files: ['bc_slip_read.js'] });
    } catch (_) {}
    bcScriptReady.add(key);
    if (frameId == null) bcScriptReady.add(String(tabId));
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['bc_content.js'] });
      bcScriptReady.add(String(tabId));
    } catch (_2) {}
  }
}

async function injectReadBcSports(tabId, frameId = 0) {
  try {
    await ensureBcScript(tabId, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => {
        function pack(r) {
          if (!r || !(r.odds > 1.01 || (r.ok && r.odds > 1.01))) return null;
          const odds = r.odds;
          const team = r.teamLabel || r.selectionText || r.outcome || '';
          const t = `${team} ${r.eventText || ''}`;
          const ouLineM = t.match(/(?:오버|언더|over|under)\s*([+-]?\d+(?:\.\d+)?)/i);
          const ouLine = r.ouLine || (ouLineM ? parseFloat(ouLineM[1]) : null);
          const isOu = r.marketKind === 'ou' || !!ouLineM;
          if (isOu && ouLine != null && Math.abs(odds - ouLine) < 0.02) return null;
          if (isOu && odds > 15) return null;
          const stake = r.stake > 0 ? r.stake : null;
          const payout = r.payout > 0 ? r.payout : null;
          return {
            source: 'bcgame',
            odds,
            teamLabel: team,
            outcome: team,
            eventText: r.eventText || '',
            selectionText: r.selectionText || team,
            displayLabel: odds.toFixed(3),
            stake,
            payout,
            capturedAt: r.capturedAt || null,
            fromPayout: !!r.fromPayout || (stake > 0 && payout > stake),
            fromSlip: true,
            sourceKind: r.sourceKind || 'sports-slip',
            marketKind: r.marketKind || (isOu ? 'ou' : 'ml'),
            ouLine: ouLine || undefined
          };
        }
        try {
          if (typeof window.__bcProbeCartEmpty === 'function') {
            const probe = window.__bcProbeCartEmpty();
            if (probe?.empty && probe?.hasSelection === false) {
              return { empty: true, cartEmpty: true };
            }
          }
          if (typeof window.__bcReadDirectSlip === 'function') {
            const d = window.__bcReadDirectSlip();
            if (d?.empty) return { empty: true, cartEmpty: true };
            const packed = pack(d);
            if (packed) return packed;
          }
          if (typeof window.__bcScrapeOdds === 'function') {
            const scraped = window.__bcScrapeOdds();
            if (scraped?.ok && scraped.odds > 1.01) {
              const kind = scraped.sourceKind || 'sports-slip';
              const packed = pack({ ...scraped, fromSlip: true });
              if (packed && kind !== 'sports-board-selected') return packed;
            }
          }
          const api = window.__bcApiSlip;
          if (api?.odds > 1.01 && api.capturedAt && Date.now() - api.capturedAt < 8000) {
            const packed = pack({
              ...api,
              ok: true,
              fromSlip: true,
              sourceKind: 'bc-api-fresh'
            });
            if (packed) return packed;
          }
        } catch (_) {}
        return null;
      }
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

function isCartSlip(slip) {
  if (!slip?.odds || slip.odds <= 1) return false;
  if (slip.fromSlip) return true;
  const src = slip.source || '';
  const kind = slip.sourceKind || '';
  if (kind === 'sports-board-selected') return false;
  if (src === 'main-scrape') return false;
  if (src === 'slip-display' || src === 'board-live' || src === 'merged' || src === 'slip') return true;
  if (src === 'board' || src === 'board-emergency') return true;
  if (kind === 'bc-native-slip' || kind === 'sports-slip' || kind === 'bc-direct-slip' || kind === 'bc-api-fresh') return true;
  if (slip.fromPayout) return true;
  return false;
}

function normalizeCartSlip(slip) {
  if (!isCartSlip(slip)) return null;
  const odds = slipOdds(slip);
  if (!odds) return null;
  return { ...slip, odds };
}

function scoreBcSlip(slip) {
  if (!slip?.odds || slip.odds <= 1) return -1;
  let s = slip.odds;
  if (slip.fromSlip) s += 1000;
  if (slip.sourceKind === 'bc-direct-slip') s += 1200;
  else if (slip.sourceKind === 'bc-native-slip') s += 900;
  else if (slip.sourceKind === 'sports-slip') s += 500;
  else if (slip.sourceKind === 'bc-api-fresh') s += 350;
  else if (slip.sourceKind === 'sports-board-selected') s -= 600;
  else if (slip.sourceKind === 'bc-api') s -= 900;
  if (slip.fromPayout) s += 200;
  if (slip.teamLabel) s += 150;
  if (slip.stake > 0) s += 50;
  return s;
}

function extractBcOuLine(slip) {
  if (slip?.ouLine > 0) return slip.ouLine;
  const t = `${slip?.teamLabel || ''} ${slip?.selectionText || ''} ${slip?.eventText || ''}`;
  const m = t.match(/(?:오버|언더|over|under)\s*([+-]?\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

function isOuLineMistakenAsOdds(slip) {
  if (!slip?.odds || slip.odds <= 1) return false;
  const isOu = slip.marketKind === 'ou'
    || /오버|언더|over|under|total|O\/U|합계/i.test(`${slip.teamLabel || ''} ${slip.selectionText || ''} ${slip.eventText || ''}`);
  if (!isOu) return false;
  const line = extractBcOuLine(slip);
  if (line != null && Math.abs(slip.odds - line) < 0.02) return true;
  if (slip.odds > 15) return true;
  return false;
}

function sanitizeBcSlipOdds(slip) {
  if (!slip) return slip;
  if (isOuLineMistakenAsOdds(slip)) {
    return { ...slip, odds: null, _ouLineRejected: true };
  }
  return slip;
}

function coerceSlipCached(slip) {
  if (!slip || slip.empty || slip.cartEmpty) return null;
  slip = sanitizeBcSlipOdds(slip);
  if (!slip?.odds || slip.odds <= 1) return null;
  if (slip.suspended) {
    return { ...slip, odds: slip.odds > 1 ? slip.odds : null, suspended: true };
  }
  const o = slipOdds(slip);
  if (!o || o <= 1) return null;
  if (slip.source === 'bcgame' || slip.sourceKind) {
    if (isStaleBcSource(slip)) return null;
    if (!isCartSlip(slip) && !slip.fromPayout) return null;
  }
  const norm = normalizeCartSlip(slip);
  if (norm) return norm;
  if (slip.fromSlip || slip.sourceKind === 'bc-direct-slip') return { ...slip, odds: o };
  return null;
}

function getActiveBetOdds() {
  const btiOdds = cachedBti?.odds > 1 ? cachedBti.odds : null;
  const polyO = resolveBcOddsForSync();
  if (cachedBc?.suspended && !(cachedBc?.odds > 1)) {
    return { ok: false, btiOdds, polyO, reason: 'BC 배당 마감' };
  }
  if (!btiOdds || btiOdds <= 1) {
    return { ok: false, btiOdds, polyO, reason: '텐텐뱃 배당 없음' };
  }
  if (!polyO || polyO <= 1) {
    return { ok: false, btiOdds, polyO, reason: 'BC 배당 없음' };
  }
  return { ok: true, btiOdds, polyO, profit: calcProfit(btiOdds, polyO) };
}

function amountsSyncedForBet(btiBet, polyUsd) {
  if (Math.abs(lastSyncedBtiKrw - btiBet) >= 100) return false;
  if (Math.abs(lastSyncedBcUsd - polyUsd) >= 0.05) return false;
  if (cachedBc?.stake > 0 && Math.abs(cachedBc.stake - polyUsd) >= 0.05) return false;
  return true;
}

async function readBcLiveStake(bcTab) {
  if (!bcTab?.id) return 0;
  const order = await orderBcFrames(bcTab.id);
  const tryFrames = [];
  if (lastBcStakeFrameId != null) tryFrames.push(lastBcStakeFrameId);
  for (const frameId of order) {
    if (!tryFrames.includes(frameId)) tryFrames.push(frameId);
  }
  for (const frameId of tryFrames.slice(0, 10)) {
    const probe = await probeBcStakeFrame(bcTab.id, frameId);
    if (probe.stake > 0) return probe.stake;
  }
  return cachedBc?.stake > 0 ? cachedBc.stake : 0;
}

async function verifyBcStakeForBet(bcTab, polyUsd) {
  const live = await readBcLiveStake(bcTab);
  if (!live || live <= 0) return { ok: false, stake: live, reason: 'stake-read-empty' };
  const tol = Math.max(0.12, polyUsd * 0.04);
  if (Math.abs(live - polyUsd) <= tol) return { ok: true, stake: live };
  return { ok: false, stake: live, reason: 'stake-mismatch' };
}

function applySyncedBcStake(polyUsd) {
  if (cachedBc && polyUsd > 0) {
    cachedBc = { ...cachedBc, stake: polyUsd };
  }
}

function isStaleBcSource(slip) {
  if (!slip) return true;
  const kind = slip.sourceKind || '';
  if (kind === 'bc-api-fresh') return false;
  if (kind === 'bc-api') {
    if (slip.capturedAt && Date.now() - slip.capturedAt < 8000) return false;
    return true;
  }
  if (kind === 'sports-board-selected') return true;
  if (slip.method === 'api-cache' || slip.source === 'main-scrape') return true;
  return false;
}

async function probeBcCartEmptyFrame(tabId, frameId) {
  try {
    await ensureBcScript(tabId, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => {
        if (typeof window.__bcProbeCartEmpty !== 'function') {
          return { hasShell: false, empty: false };
        }
        const p = window.__bcProbeCartEmpty();
        return {
          hasShell: !!p.hasSlipShell,
          empty: !!p.empty,
          hasSelection: !!p.hasSelection
        };
      }
    });
    return results?.[0]?.result || { hasShell: false, empty: false };
  } catch (_) {
    return { hasShell: false, empty: false };
  }
}

async function probeBcCartEmptyAnyFrame(bcTab) {
  if (!bcTab?.id) return false;
  const order = await orderBcFrames(bcTab.id);
  const seen = new Set();
  let sawShell = false;
  let sawSelection = false;
  for (const frameId of order) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    const probe = await probeBcCartEmptyFrame(bcTab.id, frameId);
    if (probe.hasShell) {
      sawShell = true;
      if (probe.hasSelection || !probe.empty) sawSelection = true;
    }
  }
  return sawShell && !sawSelection;
}

async function readBcSlipAllFrames(bcTab) {
  const order = await orderBcFrames(bcTab.id);
  const seen = new Set();
  let sawShell = false;
  let sawSelection = false;

  for (const frameId of order) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    await ensureBcScript(bcTab.id, frameId);
    const probe = await probeBcCartEmptyFrame(bcTab.id, frameId);
    if (probe.hasShell) {
      sawShell = true;
      if (probe.hasSelection || !probe.empty) sawSelection = true;
    }
  }
  if (sawShell && !sawSelection) return null;

  let best = null;
  let bestScore = -1;
  seen.clear();

  for (const frameId of order) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    await ensureBcScript(bcTab.id, frameId);

    const injected = await injectReadBcSports(bcTab.id, frameId);
    if (injected?.empty || injected?.cartEmpty) continue;
    if (injected?.odds > 1) {
      const sc = scoreBcSlip(injected);
      if (sc > bestScore) {
        bestScore = sc;
        best = injected;
      }
    }

    const res = await sendBc(bcTab.id, { type: 'READ_SLIP' }, frameId);
    const slip = res?.slip;
    if (slip?.empty || slip?.cartEmpty) continue;
    if (!slip?.odds || slip.odds <= 1) continue;
    if (isStaleBcSource(slip)) continue;
    if (!isCartSlip(slip) && !slip.fromPayout) continue;
    const sc = scoreBcSlip(slip);
    if (sc > bestScore) {
      bestScore = sc;
      best = slip;
    }
  }

  return best;
}

async function injectReadBtiFrame(tabId, frameId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        function vis(el) {
          const r = el?.getBoundingClientRect?.();
          return !!(r && r.width > 2 && r.height > 2);
        }
        function parseOdds(t) {
          const n = parseFloat(String(t || '').trim());
          if (!n || n <= 1.01 || n >= 100) return null;
          return n;
        }
        function norm(s) {
          return String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
        }
        function teamMatch(a, b) {
          const na = norm(a);
          const nb = norm(b);
          if (!na || !nb) return false;
          return na.includes(nb) || nb.includes(na);
        }

        let hasInput = false;
        for (const inp of document.querySelectorAll('input, textarea')) {
          if (!vis(inp)) continue;
          const blob = `${inp.id || ''} ${inp.className || ''} ${inp.placeholder || ''}`;
          if (/counter|Counter|베팅/i.test(blob)) { hasInput = true; break; }
        }

        function readSlipPanel() {
          if (!hasInput) return null;
          const roots = [...document.querySelectorAll('[class*="betslip"], [class*="Betslip"]')];
          if (!roots.length) roots.push(document.body);
          for (const root of roots) {
            for (const card of root.querySelectorAll('[class*="bet"], [class*="Bet"]')) {
              if (!vis(card)) continue;
              const txt = (card.textContent || '').trim();
              if (txt.length < 6 || txt.length > 900) continue;
              if (card.querySelector('input')) continue;
              if (!/W[12]|betInformation|우승|winner|맵|map/i.test(txt)) continue;

              const title = card.querySelector('[class*="betInformation__title"]');
              const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
              const selectionText = titleEls[0]?.textContent?.trim() || title?.textContent?.trim() || (/\bW1\b/i.test(txt) ? 'W1' : /\bW2\b/i.test(txt) ? 'W2' : '');
              const marketTitleText = titleEls[1]?.textContent?.trim() || '';
              const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
              const eventText = eventEl?.textContent?.trim() || '';
              const allText = `${selectionText} ${marketTitleText} ${eventText} ${txt}`;
              let marketKind = 'ml';
              const lt = allText.toLowerCase();
              if (lt.includes('핸디') || lt.includes('handicap') || lt.includes('hdp') || lt.includes('spread')) marketKind = 'ah';
              else if (lt.includes('오버') || lt.includes('언더') || lt.includes('over') || lt.includes('under') || lt.includes('총계') || lt.includes('total')) marketKind = 'ou';

              for (const sp of card.querySelectorAll('[class*="odds"], [class*="Odds"], [class*="UpdateNotification"]')) {
                const o = parseOdds(sp.textContent);
                if (o) return { odds: o, selectionText, eventText, mktText: marketTitleText, source: 'slip-display', hasInput: true, marketKind };
              }
              const nums = [];
              for (const sp of card.querySelectorAll('span, div, b, strong')) {
                const t = (sp.textContent || '').trim();
                if (!/^\d+\.\d{2,3}$/.test(t)) continue;
                const o = parseOdds(t);
                if (o) nums.push(o);
              }
              if (nums.length) {
                return { odds: nums[nums.length - 1], selectionText, eventText, source: 'slip-display', hasInput: true };
              }
            }
          }
          return null;
        }

        const slipPanel = readSlipPanel();
        if (slipPanel?.odds > 1.01) {
          let homeTeam = '';
          let awayTeam = '';
          if (slipPanel.eventText) {
            for (const sep of [' vs ', ' VS ', ' 대 ']) {
              if (slipPanel.eventText.includes(sep)) {
                [homeTeam, awayTeam] = slipPanel.eventText.split(sep, 2).map((s) => s.trim());
                break;
              }
            }
          }
          let teamLabel = slipPanel.selectionText;
          if (/^W1$/i.test(teamLabel)) teamLabel = homeTeam || teamLabel;
          if (/^W2$/i.test(teamLabel)) teamLabel = awayTeam || teamLabel;
          return {
            ...slipPanel,
            teamLabel,
            homeTeam,
            awayTeam,
            marketKind: 'ml',
            buttonCount: 0
          };
        }

        const board = [];
        for (const btn of document.querySelectorAll('button')) {
          if (!vis(btn)) continue;
          const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (!txt) continue;
          let odds = null;
          const oddsEl = btn.querySelector('[class*="odds"], [class*="Odds"]');
          if (oddsEl) odds = parseOdds(oddsEl.textContent);
          if (!odds) {
            const m = txt.match(/(\d+\.\d{2,3})\s*$/);
            if (m) odds = parseOdds(m[1]);
          }
          if (!odds) continue;
          let marketKind = 'ml';
          if (/오버|언더|over|under/i.test(txt)) marketKind = 'ou';
          else if (/[+-]\d/.test(txt)) marketKind = 'ah';
          const selected = btn.getAttribute('aria-pressed') === 'true'
            || /selected|active|pressed|highlight/i.test(btn.className || '');
          board.push({ odds, txt, selected, marketKind });
        }

        if (!board.length) return null;

        const sel = board.find((b) => b.selected) || board[0];
        return {
          odds: sel.odds,
          selectionText: sel.txt,
          teamLabel: sel.txt,
          source: 'main-scrape',
          hasInput,
          buttonCount: board.length,
          marketKind: sel.marketKind || 'ml'
        };
      }
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function injectReadBc(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function vis(el) {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        function parseMoney(t) {
          const m = String(t || '').trim().match(/\$?\s*([\d,]+(?:\.\d+)?)/);
          if (!m) return null;
          const v = parseFloat(m[1].replace(/,/g, ''));
          return Number.isFinite(v) && v > 0 ? v : null;
        }
        function findPanel() {
          let best = null;
          let bestScore = -1;
          for (const el of document.querySelectorAll('div, section, aside, form')) {
            if (!vis(el)) continue;
            const t = el.innerText || '';
            if (!el.querySelector('input, [contenteditable="true"]')) continue;
            if (!/to\s*win/i.test(t) || !/\bamount\b/i.test(t)) continue;
            let score = 0;
            if (/\bamount\b/i.test(t)) score += 40;
            if (/to\s*win/i.test(t)) score += 40;
            if (score > bestScore) { bestScore = score; best = el; }
          }
          return best;
        }
        function readStake(panel) {
          if (!panel) return null;
          for (const inp of panel.querySelectorAll('input, [contenteditable="true"]')) {
            if (!vis(inp)) continue;
            const v = parseMoney(inp.value || inp.textContent || inp.getAttribute('value'));
            if (v) return v;
          }
          const m = (panel.innerText || '').match(/Amount\s*\n?\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
          if (m) return parseFloat(m[1].replace(/,/g, '')) || null;
          return null;
        }
        function readToWin(panel) {
          if (!panel) return null;
          const raw = panel.innerText || '';
          const idx = raw.search(/to\s*win/i);
          if (idx < 0) return null;
          const section = raw.slice(idx, idx + 500);
          const vals = [];
          for (const m of section.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)) {
            const ctx = section.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20);
            if (/avg\.?\s*price|¢/i.test(ctx)) continue;
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (v >= 0.5) vals.push(v);
          }
          return vals.length ? Math.max(...vals) : null;
        }

        const panel = findPanel();
        const stake = readStake(panel);
        const toWin = readToWin(panel);
        if (stake && toWin) {
          const total = toWin >= stake ? toWin : stake + toWin;
          const odds = total / stake;
          if (odds > 1.001 && odds <= 100) {
            return {
              source: 'bcgame',
              odds,
              priceCents: Math.round((stake / total) * 1000) / 10,
              displayLabel: `${odds.toFixed(3)} · 당첨 $${toWin.toFixed(2)}`,
              stake,
              payout: total,
              fromPayout: true,
              marketKind: 'ml'
            };
          }
        }
        return null;
      }
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

function scoreBtiProbe(ping, slip) {
  let score = 0;
  if (slip?.odds > 1.01) score += 1000 + slip.odds;
  if (slip?.source === 'slip-display') score += 400;
  if (slip?.source === 'merged') score += 350;
  if (ping?.hasInput || slip?.hasInput) score += 500;
  if (ping?.slipCount > 0) score += 300;
  if (ping?.slipOdds > 1) score += 250;
  if (ping?.buttonCount > 0) score += Math.min(ping.buttonCount, 100);
  if (slip?.buttonCount > 0) score += Math.min(slip.buttonCount, 80);
  return score;
}

async function probeBtiFrame(tabId, frameId, hint = {}, cartOnly = false) {
  let ping = await sendBti(tabId, frameId, { type: 'PING' });
  if (!ping?.ok) {
    await ensureBtiScript(tabId, frameId);
    ping = await sendBti(tabId, frameId, { type: 'PING' });
  }

  if (cartOnly) {
    let slip = null;
    let cartEmpty = false;
    let deferToChild = false;
    if (ping?.ok) {
      const res = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', cartOnly: true, hint });
      slip = res?.slip || null;
      cartEmpty = !!res?.cartEmpty;
      deferToChild = !!res?.deferToChild;
    }
    return {
      frameId,
      ping,
      slip,
      cartEmpty,
      deferToChild,
      score: scoreBtiProbe(ping, slip),
      hasInput: !!(ping?.hasInput || slip?.hasInput),
      hasBoard: !!((ping?.buttonCount || 0) > 0 || (slip?.buttonCount || 0) > 0)
    };
  }

  const contentPromise = ping?.ok
    ? sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint }).then((res) => res?.slip || null)
    : Promise.resolve(null);
  const scrapePromise = injectReadBtiFrame(tabId, frameId);

  let [contentSlip, scraped] = await Promise.all([contentPromise, scrapePromise]);
  let slip = (contentSlip?.odds > 1.01) ? contentSlip : scraped;

  if (!(slip?.odds > 1.01) && contentSlip?.odds > 1.01) slip = contentSlip;
  if (!(slip?.odds > 1.01) && scraped?.odds > 1.01) slip = scraped;

  if (!(slip?.odds > 1.01) && ping?.ok && (hint.excludeTeam || hint.polyTeam)) {
    const res2 = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: {} });
    if (res2?.slip?.odds > 1.01) slip = res2.slip;
    else {
      const scraped2 = await injectReadBtiFrame(tabId, frameId);
      if (scraped2?.odds > 1.01) slip = scraped2;
    }
  }

  return {
    frameId,
    ping,
    slip,
    cartEmpty: false,
    deferToChild: false,
    score: scoreBtiProbe(ping, slip),
    hasInput: !!(ping?.hasInput || slip?.hasInput),
    hasBoard: !!((ping?.buttonCount || 0) > 0 || (slip?.buttonCount || 0) > 0)
  };
}

function updateBtiFrameRoles(tabId, results) {
  let slipFrame = null;
  let slipScore = -1;
  let boardFrame = null;
  let boardScore = -1;

  for (const r of results) {
    if (r.hasInput) {
      const s = (r.slip?.odds > 1.01 ? 1000 : 0) + (r.ping?.hasInput ? 500 : 0);
      if (s > slipScore) { slipScore = s; slipFrame = r.frameId; }
    }
    if (r.hasBoard) {
      const s = (r.ping?.buttonCount || r.slip?.buttonCount || 0) + (r.slip?.odds > 1.01 ? 100 : 0);
      if (s > boardScore) { boardScore = s; boardFrame = r.frameId; }
    }
  }

  if (slipFrame != null) lastBtiSlipFrame = { tabId, frameId: slipFrame };
  if (boardFrame != null) lastBtiBoardFrame = { tabId, frameId: boardFrame };
}

function btiSlipFrameId(tabId) {
  if (lastBtiSlipFrame?.tabId === tabId) return lastBtiSlipFrame.frameId;
  if (lastBtiFrame?.tabId === tabId) return lastBtiFrame.frameId;
  return 0;
}

function btiBoardFrameId(tabId) {
  if (lastBtiBoardFrame?.tabId === tabId) return lastBtiBoardFrame.frameId;
  if (lastBtiFrame?.tabId === tabId) return lastBtiFrame.frameId;
  return 0;
}

function isBtiFrameSuccess(msg, res) {
  if (!res) return false;
  if (msg.type === 'PLACE_BET') return res.success === true;
  if (msg.type === 'SET_BTI_AMOUNT') return res.ok === true;
  if (msg.type === 'ENSURE_BTI_SLIP') return res.ok === true;
  return true;
}

async function sendBtiToFrames(tabId, frameIds, msg) {
  const seen = new Set();
  let lastRes = null;
  let lastFrameId = frameIds[0] || 0;

  for (const frameId of frameIds) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    const res = await sendBti(tabId, frameId, msg);
    if (!res) continue;
    lastRes = res;
    lastFrameId = frameId;
    if (isBtiFrameSuccess(msg, res)) return { res, frameId };
  }
  return { res: lastRes, frameId: lastFrameId };
}

function pickBestCartSlip(results) {
  if (!results.length) return { slip: null, frameId: 0 };

  const withSlip = results
    .map((r) => ({ ...r, slip: normalizeCartSlip(r.slip) }))
    .filter((r) => r.slip?.odds > 1.01);
  if (withSlip.length) {
    withSlip.sort((a, b) => scoreBtiProbe(b.ping, b.slip) - scoreBtiProbe(a.ping, a.slip));
    const best = withSlip[0];
    return { slip: best.slip, frameId: best.frameId };
  }

  const slipFrames = results.filter((r) => r.hasInput || r.ping?.hasInput);
  if (slipFrames.length && slipFrames.every((r) => r.cartEmpty)) {
    return { slip: null, frameId: slipFrames[0].frameId, cartEmpty: true };
  }

  const decisive = results.filter((r) => !r.deferToChild);
  if (decisive.length && decisive.every((r) => r.cartEmpty && !(r.slip?.odds > 1.01))) {
    return { slip: null, frameId: decisive[0]?.frameId || 0, cartEmpty: true };
  }

  return { slip: null, frameId: results[0]?.frameId || 0 };
}

function mergeBtiFrameResults(results) {
  if (!results.length) return { slip: null, frameId: 0 };

  const sorted = [...results].sort((a, b) => b.score - a.score);
  const best = sorted[0];

  const slipPanel = sorted.find((r) => r.slip?.source === 'slip-display' && r.slip?.odds > 1.01);
  const boardHit = sorted.find((r) => r.slip?.odds > 1.01 && (r.slip?.buttonCount > 0 || r.ping?.buttonCount > 0));

  if (slipPanel?.slip && boardHit?.slip && slipPanel.frameId !== boardHit.frameId) {
    const merged = {
      ...slipPanel.slip,
      odds: boardHit.slip.odds,
      source: 'merged',
      buttonCount: boardHit.slip.buttonCount || boardHit.ping?.buttonCount || 0
    };
    return { slip: merged, frameId: boardHit.frameId };
  }

  const pick = sorted.find((r) => r.slip?.odds > 1.01) || best;
  return { slip: pick?.slip || null, frameId: pick?.frameId ?? 0 };
}

async function readBtiFromAllFrames(tabId, hint = {}, forceFull = false, cartOnly = false) {
  const frames = await getAllFrames(tabId);
  const order = [];
  if (lastBtiFrame?.tabId === tabId) order.push(lastBtiFrame.frameId);
  for (const f of frames) {
    if (!order.includes(f.frameId)) order.push(f.frameId);
  }

  if (!forceFull && lastBtiFrame?.tabId === tabId) {
    const fast = await probeBtiFrame(tabId, lastBtiFrame.frameId, hint, cartOnly);
    if (cartOnly) {
      const cartSlip = normalizeCartSlip(fast.slip);
      if (cartSlip?.odds > 1.01) {
        lastBtiFrame = { tabId, frameId: fast.frameId };
        return { slip: cartSlip, frameId: fast.frameId };
      }
    } else if (fast.slip?.odds > 1.01) {
      lastBtiFrame = { tabId, frameId: fast.frameId };
      return { slip: fast.slip, frameId: fast.frameId };
    }
  }

  const results = await Promise.all(order.map((frameId) => probeBtiFrame(tabId, frameId, hint, cartOnly)));
  if (cartOnly) {
    updateBtiFrameRoles(tabId, results);
    const picked = pickBestCartSlip(results);
    if (picked.slip?.odds > 1.01) {
      lastBtiFrame = { tabId, frameId: picked.frameId };
    }
    return picked;
  }
  updateBtiFrameRoles(tabId, results);
  const merged = mergeBtiFrameResults(results);
  lastBtiFullScanAt = Date.now();
  if (merged.slip?.odds > 1.01) {
    lastBtiFrame = { tabId, frameId: merged.frameId };
  }
  return merged;
}

async function readBtiArbOdds(btiTab, poly) {
  if (!btiTab?.id) return null;
  const hint = btiHintFromBc(poly);
  const merged = await readBtiFromAllFrames(btiTab.id, hint);
  return merged.slip?.odds > 1.01 ? merged.slip : null;
}

async function findBtiFrame(tabId) {
  const merged = await readBtiFromAllFrames(tabId, btiHintFromBc(cachedBc), true);
  const ping = await sendBti(tabId, merged.frameId, { type: 'PING' });
  return { frameId: merged.frameId, ping, slip: merged.slip };
}

async function findTabs() {
  const tabs = await chrome.tabs.query({});
  let btiTab = null;
  let bcTab = null;
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = activeTabs[0]?.id;
  let bestBcScore = -1;

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (isWrapperUrl(tab.url) && !btiTab) btiTab = tab;
    const bcScore = scoreBcTab(tab.url, activeId, tab.id);
    if (bcScore >= 0 && bcScore > bestBcScore) {
      bestBcScore = bcScore;
      bcTab = tab;
    }
  }

  if (btiTab) {
    btiTab = {
      id: btiTab.id,
      url: btiTab.url,
      frameId: lastBtiFrame?.tabId === btiTab.id ? lastBtiFrame.frameId : 0
    };
  }

  return {
    btiTab,
    bcTab: bcTab ? { id: bcTab.id, url: bcTab.url } : null
  };
}

function btiHintFromBc(bc) {
  if (!bc) return {};
  const team = bc.teamLabel || bc.outcome || '';
  return team ? { excludeTeam: team, polyTeam: team, bcTeam: team } : {};
}

async function readBtiCartOddsForSync(btiTab) {
  if (!btiTab?.id) return null;
  const merged = await readBtiFromAllFrames(btiTab.id, {}, false, true);
  if (merged.cartEmpty) return null;
  return normalizeCartSlip(merged.slip) || (merged.slip?.odds > 1 ? merged.slip : null);
}

async function resolveBtiOddsForSync(btiTab) {
  const fresh = btiTab?.id ? await readBtiSlip(btiTab) : null;
  if (fresh?.odds > 1) return fresh.odds;
  if (cachedBti?.odds > 1) return cachedBti.odds;
  return null;
}

function resolveBcOddsForSync() {
  if (bcCartEmptyConfirmed) return null;
  if (!cachedBc?.odds || cachedBc.odds <= 1) return null;
  if (isOuLineMistakenAsOdds(cachedBc)) return null;
  if (cachedBc.suspended && !(cachedBc.odds > 1)) return null;
  if (isStaleBcSource(cachedBc)) return null;
  if (!isCartSlip(cachedBc) && !cachedBc.fromPayout) return null;
  return cachedBc.odds;
}

function resolveBcOddsForAmountSync() {
  const direct = resolveBcOddsForSync();
  if (direct > 1) return direct;
  const slip = cachedBc;
  if (!slip || bcCartEmptyConfirmed) return null;
  if (slip.fromPayout && slip.stake > 0 && slip.payout > slip.stake) {
    const o = Math.round((slip.payout / slip.stake) * 1000) / 1000;
    if (o > 1.01 && o <= 15 && !isOuLineMistakenAsOdds({ ...slip, odds: o })) return o;
  }
  if (slip.odds > 1.01 && slip.odds <= 15 && (isCartSlip(slip) || slip.fromPayout)) {
    if (!isOuLineMistakenAsOdds(slip)) return slip.odds;
  }
  return null;
}

async function prepareAmountSyncTargets(found) {
  if (!found?.btiTab?.id || !found?.bcTab?.id) return null;
  await refreshBithumbRate();
  await refreshSlips();
  const btiOdds = await resolveBtiOddsForSync(found.btiTab);
  const btiBet = getBtiBet();
  if (!btiBet || !btiOdds || btiOdds <= 1) return null;
  let polyO = resolveBcOddsForAmountSync();
  if (!polyO) {
    const fresh = await readBcSlip(found.bcTab);
    const coerced = coerceSlipCached(fresh);
    if (coerced?.odds > 1) {
      cachedBc = coerced;
      polyO = resolveBcOddsForAmountSync();
    }
  }
  if (!polyO || polyO <= 1) return null;
  const polyUsd = calcPolyBetUsd(btiBet, btiOdds, polyO, getUsdRate());
  return { btiBet, btiOdds, polyO, polyUsd };
}

function isBcStakeCloseEnough(targetUsd, res) {
  if (!res) return false;
  const stake = res.stake > 0 ? res.stake : 0;
  const tol = Math.max(0.12, targetUsd * 0.04);
  if (res.ok && stake > 0 && Math.abs(stake - targetUsd) <= tol) return true;
  return stake > 0 && Math.abs(stake - targetUsd) <= tol;
}

async function readBtiMarketStatus(btiTab) {
  if (!btiTab?.id) return { open: false };
  const frameIds = [
    btiSlipFrameId(btiTab.id),
    lastBtiFrame?.tabId === btiTab.id ? lastBtiFrame.frameId : 0,
    btiBoardFrameId(btiTab.id)
  ];
  const seen = new Set();
  for (const frameId of frameIds) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    const res = await sendBti(btiTab.id, frameId, { type: 'READ_BTI_MARKET_STATUS' });
    if (res?.open) return res;
    if (res?.suspended) return res;
  }
  const btiO = cachedBti?.odds > 1 ? cachedBti.odds : null;
  if (btiO) return { open: true, odds: btiO };
  return { open: false, suspended: !!cachedBti?.suspended };
}

async function readBcMarketStatus(bcTab) {
  if (cachedBc?.suspended && !(cachedBc?.odds > 1)) {
    return { open: false, suspended: true };
  }
  const polyO = resolveBcOddsForSync();
  if (polyO > 1) return { open: true, odds: polyO };
  if (!bcTab?.id) return { open: false };
  const slip = await readBcSlip(bcTab);
  if (slip?.suspended) return { open: false, suspended: true };
  if (slip?.odds > 1) return { open: true, odds: slip.odds };
  return { open: false };
}

async function checkMarketOpenForAutoBet() {
  const found = await findTabs();
  if (!found.btiTab?.id || !found.bcTab?.id) return false;

  const active = getActiveBetOdds();
  if (active.ok) return true;

  const [btiSt, bcSt] = await Promise.all([
    readBtiMarketStatus(found.btiTab),
    readBcMarketStatus(found.bcTab)
  ]);
  return !!(btiSt?.open && bcSt?.open);
}

function isAutoBetLooping() {
  return !!(autoBetWanted && autoBetRunning && !autoBetPausedByClose);
}

function isAutoBetEngaged() {
  return !!autoBetWanted;
}

function syncAutoBetButtonUi() {
  const betStartBtn = $('autoBetStart');
  const betStopBtn = $('autoBetStop');
  const wanted = !!autoBetWanted;
  const looping = isAutoBetLooping();
  const paused = !!autoBetPausedByClose;

  if (betStartBtn) {
    betStartBtn.disabled = looping;
    betStartBtn.classList.toggle('is-armed', wanted && !paused);
    betStartBtn.classList.toggle('is-looping', looping);
    betStartBtn.textContent = paused ? '자동 배팅 재개' : '자동 배팅';
  }
  if (betStopBtn) {
    betStopBtn.disabled = false;
    betStopBtn.removeAttribute('disabled');
    betStopBtn.classList.toggle('is-armed', wanted);
    betStopBtn.setAttribute('aria-pressed', wanted ? 'true' : 'false');
  }
  updateManualBetButton();
}

function updateAutomationButtons() {
  syncAutoBetButtonUi();
}

function pauseAutoBetByMarketClose() {
  if (!autoBetWanted || autoBetPausedByClose) return;
  autoBetRunning = false;
  autoBetPausedByClose = true;
  if (autoBetTimer) { clearTimeout(autoBetTimer); autoBetTimer = null; }
  persistSyncState({ autoBetRunning: false, autoBetWanted: true, autoBetPausedByClose: true });
  updateAutomationButtons();
  updateSlipUI(cachedBti, cachedBc);
  if (Date.now() - lastMarketCloseLogAt > 3000) {
    lastMarketCloseLogAt = Date.now();
    log('배당 마감 — 자동배팅 일시정지', 'info');
  }
}

function resumeAutoBetByMarketOpen() {
  if (!autoBetWanted || !autoBetPausedByClose) return;
  autoBetUiLocked = true;
  autoBetPausedByClose = false;
  autoBetRunning = true;
  const stateEpoch = bumpAutoBetStateEpoch();
  chrome.runtime.sendMessage({
    type: 'SET_AUTO_BET',
    enabled: true,
    wanted: true,
    pausedByClose: false,
    stateEpoch
  }).catch(() => {});
  persistSyncState({
    autoBetRunning: true,
    autoBetWanted: true,
    autoBetPausedByClose: false,
    autoBetStateEpoch: stateEpoch
  });
  updateAutomationButtons();
  updateSlipUI(cachedBti, cachedBc);
  if (Date.now() - lastMarketOpenLogAt > 3000) {
    lastMarketOpenLogAt = Date.now();
    log('배당 재개 — 자동배팅 가동', 'ok');
  }
  scheduleAutoBetCheck();
}

async function updateAutoBetMarketState() {
  if (!autoBetWanted) return;
  const session = autoBetSessionId;
  const open = await checkMarketOpenForAutoBet();
  if (session !== autoBetSessionId || !autoBetWanted) return;
  if (!open) {
    const active = getActiveBetOdds();
    if (active.ok) {
      if (!autoBetRunning) {
        autoBetRunning = true;
        autoBetPausedByClose = false;
        updateAutomationButtons();
        scheduleAutoBetCheck();
      }
      return;
    }
    if (autoBetRunning) pauseAutoBetByMarketClose();
    return;
  }
  if (autoBetPausedByClose) resumeAutoBetByMarketOpen();
  else if (!autoBetRunning) {
    autoBetRunning = true;
    updateAutomationButtons();
    updateSlipUI(cachedBti, cachedBc);
    scheduleAutoBetCheck();
  }
}

async function ensureBcStakeScripts(tabId) {
  const frames = await getAllFrames(tabId);
  const frameIds = [...new Set([0, ...frames.map((f) => f.frameId)])];
  const files = ['bc_slip_direct.js', 'bc_stake_set.js', 'bc_slip_read.js'];
  for (const frameId of frameIds) {
    for (const file of files) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          files: [file],
          world: 'MAIN'
        });
      } catch (_) {}
    }
  }
}

async function probeBcStakeFrame(tabId, frameId) {
  try {
    await ensureBcScript(tabId, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => {
        if (typeof window.__bcProbeStakeFrame === 'function') {
          const p = window.__bcProbeStakeFrame();
          let score = p.score || 0;
          if (p.hasSlip) score += 400;
          if (p.hasInput) score += 300;
          if (p.stake > 0) score += 80;
          return { ...p, score };
        }
        const body = document.body?.innerText || '';
        let score = 0;
        if (/베팅\s*슬립|bet\s*slip/i.test(body)) score += 80;
        if (/USDT/i.test(body)) score += 40;
        return { score, hasSlip: false, hasInput: false, stake: 0 };
      }
    });
    return { frameId, ...(results?.[0]?.result || { score: 0 }) };
  } catch (_) {
    return { frameId, score: 0, hasSlip: false, hasInput: false };
  }
}

async function readBtiSlip(btiTab) {
  if (!btiTab?.id) {
    lastStatus.bti = '텐텐뱃: x10x10s 탭 없음';
    return null;
  }

  const merged = await readBtiFromAllFrames(btiTab.id, {}, true);
  if (merged.slip?.odds > 1) {
    lastBtiFrame = { tabId: btiTab.id, frameId: merged.frameId };
    btiTab.frameId = merged.frameId;
    lastStatus.bti = '';
    return merged.slip;
  }

  lastStatus.bti = '텐텐뱃: 배당판/슬립 배당 없음 — 선택 후 ↻';
  return null;
}

async function readBcSlip(bcTab) {
  if (!bcTab?.id) {
    lastStatus.bc = 'BC.Game: 탭 없음 — bc.game/sports 열기';
    bcCartEmptyConfirmed = false;
    return null;
  }

  await ensureBcScript(bcTab.id);

  if (await probeBcCartEmptyAnyFrame(bcTab)) {
    bcCartEmptyConfirmed = true;
    lastStatus.bc = 'BC.Game: 배팅카트 비어 있음';
    return { source: 'bcgame', odds: null, cartEmpty: true, empty: true };
  }
  bcCartEmptyConfirmed = false;

  const slip = await readBcSlipAllFrames(bcTab);
  if (!slip?.odds || slip.odds <= 1 || slip.empty || slip.cartEmpty) {
    if (await probeBcCartEmptyAnyFrame(bcTab)) {
      bcCartEmptyConfirmed = true;
      lastStatus.bc = 'BC.Game: 배팅카트 비어 있음';
      return { source: 'bcgame', odds: null, cartEmpty: true, empty: true };
    }
    lastStatus.bc = 'BC.Game: 배당 읽기 실패 — 슬립·마켓 확인';
    return null;
  }

  if (slip.suspended) {
    lastStatus.bc = 'BC.Game: 배당 마감';
    return { ...slip, odds: slip.odds > 1 ? slip.odds : null, suspended: true };
  }

  if (!isCartSlip(slip) && !slip.fromPayout) {
    lastStatus.bc = 'BC.Game: 배팅카트 비어 있음';
    return { source: 'bcgame', odds: null, cartEmpty: true, empty: true };
  }

  lastStatus.bc = slip.needsStake ? 'BC.Game: 금액 입력 필요' : '';
  return slip;
}

function slipOdds(slip) {
  if (!slip) return null;
  if (slip.odds > 1 && slip.odds <= 50) return slip.odds;
  if (slip.priceCents >= 1 && slip.priceCents < 100) return 100 / slip.priceCents;
  return null;
}

function slipSourceRank(slip) {
  if (!slip) return 0;
  if (slip.sourceKind === 'bc-direct-slip') return 5;
  if (slip.sourceKind === 'bc-native-slip') return 4;
  if (slip.sourceKind === 'sports-slip') return 3;
  if (slip.sourceKind === 'bc-api-fresh') return 2;
  if (slip.fromPayout) return 2;
  if (slip.sourceKind === 'sports-board-selected') return 1;
  if (slip.sourceKind === 'bc-api') return -1;
  return 0;
}

function mergeSlipCached(cached, fresh) {
  if (fresh?.empty || fresh?.cartEmpty) return null;
  if (!fresh || !slipOdds(fresh)) return cached || null;
  if (!isCartSlip(fresh) && !fresh.fromPayout) return cached || null;
  const freshOdds = slipOdds(fresh);
  if (!cached) return { ...fresh, odds: freshOdds };
  const freshTeam = fresh.teamLabel || fresh.eventText || fresh.selectionText || '';
  const cachedTeam = cached.teamLabel || cached.eventText || cached.selectionText || '';
  if (freshTeam && cachedTeam && freshTeam !== cachedTeam) return { ...fresh, odds: freshOdds };
  if (slipSourceRank(fresh) > slipSourceRank(cached)) return { ...fresh, odds: freshOdds };
  if (slipSourceRank(cached) > slipSourceRank(fresh)) return { ...cached, odds: slipOdds(cached) };
  if (fresh.fromPayout && !cached.fromPayout) return { ...fresh, odds: freshOdds };
  if (cached.fromPayout && !fresh.fromPayout) return { ...cached, odds: slipOdds(cached) };
  if (cached.teamLabel && fresh.teamLabel && cached.teamLabel !== fresh.teamLabel) {
    return { ...fresh, odds: freshOdds };
  }
  if (cached.odds && freshOdds && Math.abs(cached.odds - freshOdds) / Math.max(cached.odds, freshOdds) > 0.12) {
    return { ...fresh, odds: freshOdds };
  }
  return { ...cached, ...fresh, odds: freshOdds };
}

function applySlipUpdate(source, slip, opts = {}) {
  if (source === 'bti') {
    if (opts.cartEmpty) {
      if (!cachedBti || cachedBti.fromSlip || isCartSlip(cachedBti)) cachedBti = null;
    } else if (slipOdds(slip)) {
      cachedBti = { ...slip, odds: slipOdds(slip) };
    }
  }
  if (source === 'bcgame') {
    if (opts.cartEmpty || slip?.empty || slip?.cartEmpty || !slip) {
      bcCartEmptyConfirmed = true;
      cachedBc = null;
    } else if (slip.suspended) {
      cachedBc = { ...slip, odds: slip.odds > 1 ? slip.odds : null, suspended: true };
    } else {
      bcCartEmptyConfirmed = false;
      const coerced = coerceSlipCached(slip);
      if (coerced) cachedBc = coerced;
    }
  }
  updateSlipUI(cachedBti, cachedBc);
  if (shouldSyncAmounts()) scheduleSyncAmounts();
}

async function refreshSlips() {
  if (refreshPending) {
    refreshQueued = true;
    return { bti: cachedBti, poly: cachedBc };
  }
  refreshPending = true;
  try {
    const found = await findTabs();
    const [poly, bti] = await Promise.all([
      readBcSlip(found.bcTab),
      readBtiSlip(found.btiTab)
    ]);

    if (found.btiTab?.id) {
      const cartCheck = await readBtiFromAllFrames(found.btiTab.id, {}, true, true);
      if (cartCheck.cartEmpty && !bti?.odds && cachedBti && isCartSlip(cachedBti)) cachedBti = null;
    }

    if (found.bcTab?.id && await probeBcCartEmptyAnyFrame(found.bcTab)) {
      bcCartEmptyConfirmed = true;
      cachedBc = null;
      lastStatus.bc = 'BC.Game: 배팅카트 비어 있음';
    } else if (poly?.empty || poly?.cartEmpty) {
      bcCartEmptyConfirmed = true;
      cachedBc = null;
    } else {
      bcCartEmptyConfirmed = false;
      cachedBc = coerceSlipCached(poly);
    }
    cachedBti = coerceSlipCached(bti);

    updateSlipUI(cachedBti, cachedBc);
    if (shouldSyncAmounts()) scheduleSyncAmounts();
    updateAutoBetMarketState();
    return { bti: cachedBti, poly: cachedBc, btiTab: found.btiTab, bcTab: found.bcTab };
  } finally {
    refreshPending = false;
    if (refreshQueued) {
      refreshQueued = false;
      refreshSlips();
    }
  }
}

async function setBtiAmount(btiTab, amount) {
  const frameIds = [
    btiSlipFrameId(btiTab.id),
    lastBtiFrame?.tabId === btiTab.id ? lastBtiFrame.frameId : 0,
    btiBoardFrameId(btiTab.id)
  ];
  const { res } = await sendBtiToFrames(btiTab.id, frameIds, { type: 'SET_BTI_AMOUNT', amount });
  return res || { ok: false, reason: '응답 없음' };
}

async function placeBtiBet(btiTab, amount, targetOdds, hint = {}) {
  const frameIds = [
    btiSlipFrameId(btiTab.id),
    lastBtiFrame?.tabId === btiTab.id ? lastBtiFrame.frameId : 0,
    btiBoardFrameId(btiTab.id)
  ];
  const { res } = await sendBtiToFrames(btiTab.id, frameIds, {
    type: 'PLACE_BET', amount, targetOdds, hint
  });
  return res || { success: false, reason: '응답 없음' };
}

async function ensureBtiSlip(btiTab, hint = {}) {
  const frameIds = [
    btiBoardFrameId(btiTab.id),
    btiSlipFrameId(btiTab.id),
    lastBtiFrame?.tabId === btiTab.id ? lastBtiFrame.frameId : 0
  ];
  const { res } = await sendBtiToFrames(btiTab.id, frameIds, { type: 'ENSURE_BTI_SLIP', hint });
  return res || { ok: false, reason: '응답 없음' };
}

async function placeBcSportsBetMain(tabId, frameId, amountUsd, opts = {}) {
  try {
    await ensureBcScript(tabId, frameId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ['bc_place_bet.js'],
        world: 'MAIN'
      });
    } catch (_) {}
    const placeOpts = { skipFill: !!opts.skipFill };
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: async (amount, pOpts) => {
        const rounded = Math.max(0.01, Math.round(amount * 100) / 100);
        if (typeof window.__bcPlaceSportsBet === 'function') {
          return await window.__bcPlaceSportsBet(rounded, pOpts || {});
        }
        return { success: false, reason: 'no-place-handler' };
      },
      args: [amountUsd, placeOpts]
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function placeBcBet(bcTab, amountUsd, opts = {}) {
  if (!bcTab?.id) return { success: false, reason: 'BC.Game 탭 없음' };
  await ensureBcScript(bcTab.id);
  const stakeFrame = opts.frameId ?? lastBcStakeFrameId;
  const ordered = opts.fast ? [] : await orderBcFrames(bcTab.id);
  const tryFrames = [];
  if (stakeFrame != null) tryFrames.push(stakeFrame);
  for (const frameId of ordered) {
    if (!tryFrames.includes(frameId)) tryFrames.push(frameId);
  }
  if (!tryFrames.length) tryFrames.push(0);

  const mainLimit = opts.fast ? 1 : 10;
  for (const frameId of tryFrames.slice(0, mainLimit)) {
    const res = await placeBcSportsBetMain(bcTab.id, frameId, amountUsd, opts);
    if (res?.success) return res;
    lastBcPlaceFail = res;
  }
  if (opts.fast) {
    const detail = lastBcPlaceFail?.reason || lastBcPlaceFail?.fill?.reason || '';
    return { success: false, reason: detail ? `BC 배팅 실패 — ${detail}` : 'BC.Game 스포츠 배팅 실패 — 배팅카트·금액 확인' };
  }

  for (const frameId of tryFrames.slice(0, 8)) {
    const res = await sendBc(bcTab.id, {
      type: 'PLACE_BET',
      amount: amountUsd,
      skipFill: !!opts.skipFill,
      teamHint: cachedBc?.teamLabel || ''
    }, frameId);
    if (res?.success) return res;
    lastBcPlaceFail = res;
  }

  const detail = lastBcPlaceFail?.reason || lastBcPlaceFail?.fill?.reason || '';
  return { success: false, reason: detail ? `BC 배팅 실패 — ${detail}` : 'BC.Game 스포츠 배팅 실패 — 배팅카트·금액 확인' };
}

async function probeBcFrame(tabId, frameId, url) {
  let score = scoreBcFrameUrl(url, frameId);
  try {
    await ensureBcScript(tabId, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => {
        let score = 0;
        let slipOdds = 0;
        let sourceKind = '';
        if (typeof window.__bcProbeDirectSlip === 'function') {
          const d = window.__bcProbeDirectSlip();
          if (d.cartEmpty) {
            return { score: -1, slipOdds: 0, sourceKind: '', cartEmpty: true };
          }
          score += d.score || 0;
          if (d.odds > 1) {
            slipOdds = d.odds;
            sourceKind = 'bc-direct-slip';
          }
        }
        if (typeof window.__bcProbeCartEmpty === 'function') {
          const emptyProbe = window.__bcProbeCartEmpty();
          if (emptyProbe?.empty) {
            return { score: -1, slipOdds: 0, sourceKind: '', cartEmpty: true };
          }
        }
        if (typeof window.__bcProbeStakeFrame === 'function') {
          const p = window.__bcProbeStakeFrame();
          score += p.score || 0;
          if (p.hasSlip && p.hasInput) score += 300;
          if (p.isTop && p.isBcHost) score += 100;
        } else {
          const body = document.body?.innerText || '';
          if (/베팅\s*슬립|bet\s*slip/i.test(body)) score += 50;
          if (/USDT/i.test(body)) score += 30;
        }
        return { score, slipOdds, sourceKind };
      }
    });
    const probe = results?.[0]?.result || {};
    score += probe.score || 0;
    return { score, ...probe };
  } catch (_) {
    return { score, slipOdds: 0, sourceKind: '' };
  }
}

async function orderBcFrames(tabId) {
  const frames = await getAllFrames(tabId);
  const probed = await Promise.all(frames.map(async (f) => {
    const p = await probeBcFrame(tabId, f.frameId, f.url);
    return { frameId: f.frameId, ...p };
  }));
  probed.sort((a, b) => b.score - a.score);
  const order = probed.map((p) => p.frameId);
  if (!order.includes(0)) order.unshift(0);
  return [...new Set(order)];
}

function scoreBcFrameUrl(url, frameId = 0) {
  if (!url) return frameId === 0 ? 40 : 0;
  if (/bc\.game/i.test(url) && /sports/i.test(url)) return frameId === 0 ? 220 : 100;
  if (/betby\.com|sptpub\.com|sptsportscdn|biahosted|cocoesports/i.test(url)) return 50;
  return 5;
}

async function setBcStakeMain(tabId, frameId, amountUsd) {
  try {
    await ensureBcScript(tabId, frameId);
    await ensureBcStakeScripts(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: (amount) => {
        const rounded = Math.max(0.01, Math.round(amount * 100) / 100);
        const tol = Math.max(0.12, rounded * 0.04);
        const closeEnough = (res) => {
          if (!res?.stake || res.stake <= 0) return false;
          return Math.abs(res.stake - rounded) <= tol;
        };
        const trySet = (fn) => {
          if (typeof fn !== 'function') return null;
          const res = fn(rounded);
          if (res?.ok && closeEnough(res)) return { ...res, ok: true };
          if (closeEnough(res)) return { ...res, ok: true };
          return null;
        };
        return trySet(window.__bcSetStake) || trySet(window.__bcSetStakeNative) || { ok: false, reason: 'stake-mismatch', stake: 0, target: rounded };
      },
      args: [amountUsd]
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function setBcAmount(bcTab, amountUsd) {
  if (!bcTab?.id) return { ok: false, reason: 'BC.Game 탭 없음' };
  await ensureBcScript(bcTab.id);
  await ensureBcStakeScripts(bcTab.id);
  const order = await orderBcFrames(bcTab.id);
  let lastRes = null;

  const probes = await Promise.all(order.slice(0, 16).map((frameId) => probeBcStakeFrame(bcTab.id, frameId)));
  probes.sort((a, b) => {
    const aIn = a.hasInput && a.hasSlip ? 10000 : (a.hasInput ? 5000 : 0);
    const bIn = b.hasInput && b.hasSlip ? 10000 : (b.hasInput ? 5000 : 0);
    return (bIn + (b.score || 0)) - (aIn + (a.score || 0));
  });

  const tryOrder = [];
  if (lastBcStakeFrameId != null) tryOrder.push(lastBcStakeFrameId);
  for (const probe of probes) {
    if (probe.hasInput && !tryOrder.includes(probe.frameId)) tryOrder.push(probe.frameId);
  }
  for (const probe of probes) {
    if (!tryOrder.includes(probe.frameId)) tryOrder.push(probe.frameId);
  }
  for (const frameId of order) {
    if (!tryOrder.includes(frameId)) tryOrder.push(frameId);
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    for (const frameId of tryOrder) {
      const probe = probes.find((p) => p.frameId === frameId) || {};
      if (attempt < 2 && !probe.hasInput && frameId !== lastBcStakeFrameId) continue;

      const res = await setBcStakeMain(bcTab.id, frameId, amountUsd);
      if (isBcStakeCloseEnough(amountUsd, res)) {
        lastBcStakeFrameId = frameId;
        return { ...res, ok: true, frameId };
      }
      if (res?.stake > 0) {
        lastRes = { ...res, frameId };
        lastBcStakeFrameId = frameId;
      }

      const viaMsg = await sendBc(bcTab.id, { type: 'SET_BC_AMOUNT', amount: amountUsd, force: true }, frameId);
      if (isBcStakeCloseEnough(amountUsd, viaMsg)) {
        lastBcStakeFrameId = frameId;
        return { ...viaMsg, ok: true, frameId };
      }
      if (viaMsg?.stake > 0) lastRes = viaMsg;
    }
    await delay(attempt < 3 ? 120 : 0);
  }

  return lastRes || { ok: false, reason: '금액 입력 실패 — BC 배팅카트 열고 슬립 선택' };
}

function shouldSyncAmounts() {
  return autoSyncEnabled || syncRunning || autoBetWanted;
}
function needsAmountSync(btiBet, btiOdds, polyO, polyUsd, force = false) {
  if (force) return true;
  if (Math.abs(lastSyncedBtiKrw - btiBet) >= 100) return true;
  if (Math.abs(lastSyncedBcUsd - polyUsd) >= 0.01) return true;
  if (cachedBc?.stake > 0 && Math.abs(cachedBc.stake - polyUsd) >= 0.05) return true;
  if (Math.abs((lastSyncedBtiOdds || 0) - btiOdds) >= 0.006) return true;
  if (Math.abs((lastSyncedBcOdds || 0) - polyO) >= 0.006) return true;
  if (Date.now() - lastBcSyncAt > 700) return true;
  if (Date.now() - lastSyncedAt > 1200) return true;
  return false;
}

async function syncBcAmountOnly(force = false, always = false) {
  if (!always && !shouldSyncAmounts()) return null;
  if (bcSyncPending) return null;
  const found = await findTabs();
  if (!found.bcTab?.id) return null;

  const targets = await prepareAmountSyncTargets(found);
  if (!targets) {
    if (always || force) log('BC 금액 동기화 대기 — 배당 확인 필요', 'err');
    return null;
  }
  const { btiBet, btiOdds, polyO, polyUsd } = targets;
  if (!force && !always && !needsAmountSync(btiBet, btiOdds, polyO, polyUsd, false)) return null;

  bcSyncPending = true;
  let polyRes = null;
  try {
    polyRes = await setBcAmount(found.bcTab, polyUsd);
    if (isBcStakeCloseEnough(polyUsd, polyRes)) {
      lastSyncedBtiKrw = btiBet;
      lastSyncedBcUsd = polyUsd;
      lastSyncedBcOdds = polyO;
      lastSyncedBtiOdds = btiOdds;
      lastBcSyncAt = Date.now();
      lastSyncedAt = Date.now();
      applySyncedBcStake(polyUsd);
    } else if (always || force) {
      const got = polyRes?.stake > 0 ? `$${polyRes.stake}` : '-';
      log(`BC 금액 동기화 실패 — 목표 $${polyUsd.toFixed(2)}, 현재 ${got}`, 'err');
    }
    return polyRes;
  } finally {
    bcSyncPending = false;
  }
}

function scheduleSyncAmounts() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncAmounts();
  }, 40);
}

let btiBetSyncTimer = null;

function onBtiBetInput() {
  lastSyncedBtiKrw = 0;
  lastSyncedBcUsd = 0;
  updateSlipUI(cachedBti, cachedBc);
  persistSyncState();
  syncBcAmountOnly(true, true);
  if (btiBetSyncTimer) clearTimeout(btiBetSyncTimer);
  btiBetSyncTimer = setTimeout(() => {
    btiBetSyncTimer = null;
    syncAmounts(true);
  }, 24);
}

let lastAutoBetHintAt = 0;

async function syncAmounts(force = false) {
  if (!force && syncPending) return;
  if (!force && !autoSyncEnabled && !syncRunning && !autoBetWanted) return;

  const found = await findTabs();
  if (!found.bcTab?.id || !found.btiTab?.id) {
    if (force) log('동기화 실패 — 텐텐뱃/BC 탭을 열어주세요', 'err');
    return;
  }

  const targets = await prepareAmountSyncTargets(found);
  if (!targets) {
    if (force) log('동기화 대기 — BC 배당 확인 (OU는 기준점≠배당)', 'err');
    return;
  }
  const { btiBet, btiOdds, polyO, polyUsd } = targets;
  if (!needsAmountSync(btiBet, btiOdds, polyO, polyUsd, force)) {
    updateSlipUI(cachedBti, cachedBc);
    return;
  }

  syncPending = true;
  try {
    const [btiRes, polyRes] = await Promise.all([
      setBtiAmount(found.btiTab, btiBet),
      setBcAmount(found.bcTab, polyUsd)
    ]);
    const polyOk = isBcStakeCloseEnough(polyUsd, polyRes);
    const btiOk = btiRes?.ok;
    if (btiOk || polyOk) {
      const changed = needsAmountSync(btiBet, btiOdds, polyO, polyUsd, true);
      if (btiOk) lastSyncedBtiKrw = btiBet;
      if (polyOk) {
        lastSyncedBcUsd = polyUsd;
        lastSyncedBcOdds = polyO;
        lastBcSyncAt = Date.now();
        applySyncedBcStake(polyUsd);
      }
      lastSyncedBtiOdds = btiOdds;
      lastSyncedAt = Date.now();
      setTimeout(() => refreshSlips().then(() => {
        updateSlipUI(cachedBti, cachedBc);
      }), 150);
      if (changed || force) {
        const profit = calcProfit(btiOdds, polyO);
        log(`금액 동기화 — 텐텐뱃 ${btiBet.toLocaleString()}원 · BC $${polyUsd.toFixed(2)} · 수익률 ${profit != null ? profit.toFixed(2) : '-'}%`, 'info');
      }
    } else {
      const reasons = [];
      if (!btiOk) reasons.push(`텐텐뱃: ${btiRes?.reason || '실패'}`);
      if (!polyOk) {
        const got = polyRes?.stake > 0 ? `$${polyRes.stake}` : '-';
        reasons.push(`BC: ${polyRes?.reason || '실패'} (목표 $${polyUsd.toFixed(2)}, 현재 ${got})`);
      }
      if (reasons.length && (force || Date.now() - lastSyncedAt > 3000)) {
        log(`금액 동기화: ${reasons.join(' / ')}`, 'err');
      }
    }
  } finally {
    syncPending = false;
  }
}

function scheduleAutoBetCheck() {
  if (!isAutoBetLooping()) return;
  if (autoBetTimer) clearTimeout(autoBetTimer);
  const session = autoBetSessionId;
  autoBetTimer = setTimeout(() => {
    autoBetTimer = null;
    if (session !== autoBetSessionId) return;
    tryAutoBet();
  }, 30);
}

function bcOLabel() {
  return cachedBc?.odds > 1 ? formatBcOddsForHistory(cachedBc) : '-';
}

async function tryAutoBet() {
  if (!isAutoBetLooping() || strikePending) return;
  if (Date.now() - lastStrikeAt < AUTO_BET_COOLDOWN_MS) {
    scheduleAutoBetCheck();
    return;
  }
  const session = autoBetSessionId;

  try {
    const found = await findTabs();
    if (session !== autoBetSessionId || !isAutoBetLooping()) return;
    if (!found.bcTab?.id || !found.btiTab?.id) {
      if (Date.now() - lastAutoBetHintAt > 4000) {
        lastAutoBetHintAt = Date.now();
        log('자동배팅 대기 — 텐텐뱃/BC 탭을 열어주세요', 'info');
      }
      return;
    }

    const active = getActiveBetOdds();
    const polyO = active.polyO || resolveBcOddsForSync();
    const btiOdds = active.btiOdds || await resolveBtiOddsForSync(found.btiTab);
    if (session !== autoBetSessionId || !isAutoBetLooping()) return;
    if (!polyO || !btiOdds || btiOdds <= 1) {
      if (!autoBetPausedByClose && Date.now() - lastAutoBetHintAt > 4000) {
        lastAutoBetHintAt = Date.now();
        log(`자동배팅 대기 — 배당 확인 (텐텐 ${btiOdds?.toFixed(3) || '-'} / BC ${polyO?.toFixed(3) || '-'})`, 'info');
      }
      return;
    }

    const profit = calcProfit(btiOdds, polyO);
    if (profit == null || profit < getMinProfit()) {
      if (Date.now() - lastAutoBetHintAt > 4000) {
        lastAutoBetHintAt = Date.now();
        log(`자동배팅 대기 — 수익 ${profit != null ? profit.toFixed(2) : '-'}% (최소 ${getMinProfit()}%)`, 'info');
      }
      return;
    }

    const btiBet = getBtiBet();
    const polyUsd = calcPolyBetUsd(btiBet, btiOdds, polyO, getUsdRate());
    if (!amountsSyncedForBet(btiBet, polyUsd)) {
      await syncAmounts(true);
      if (session !== autoBetSessionId || !isAutoBetLooping()) return;
      if (!amountsSyncedForBet(btiBet, polyUsd)) {
        if (Date.now() - lastAutoBetHintAt > 4000) {
          lastAutoBetHintAt = Date.now();
          log('자동배팅 — 금액 동기화 후 재시도', 'info');
        }
        return;
      }
    }

    const hint = {
      excludeTeam: cachedBc?.teamLabel,
      polyTeam: cachedBc?.teamLabel
    };
    const ensured = await ensureBtiSlip(found.btiTab, hint);
    if (!ensured?.ok && !ensured?.alreadyHad) {
      log(`자동 배팅: 슬립 준비 실패 — ${ensured?.reason || '카트에 담기 필요'}`, 'err');
      return;
    }

    await strikeBothBets(found, btiBet, polyUsd, btiOdds, null, { manual: false });
  } catch (e) {
    log(`자동배팅 오류 — ${e?.message || e}`, 'err');
  } finally {
    if (session === autoBetSessionId && isAutoBetLooping()) scheduleAutoBetCheck();
  }
}

function getManualBetReadiness() {
  return getActiveBetOdds();
}

function updateManualBetButton() {
  const btn = $('manualBetBtn');
  if (!btn) return;
  if (strikePending) {
    btn.disabled = true;
    btn.textContent = '배팅 중...';
    return;
  }
  const ready = getManualBetReadiness();
  btn.disabled = false;
  btn.textContent = '수동 배팅';
  if (ready.ok && ready.profit != null) {
    btn.title = `예상 수익 ${ready.profit.toFixed(2)}% — 클릭 시 양쪽 동시 배팅`;
  } else {
    btn.title = ready.reason || '클릭 후 배당·탭 상태를 확인합니다';
  }
}

async function manualBet() {
  if (strikePending) {
    log('수동 배팅: 다른 배팅 진행 중', 'err');
    return;
  }
  log('수동 배팅 — 즉시 실행', 'info');

  try {
    const found = await findTabs();
    if (!found.btiTab?.id || !found.bcTab?.id) {
      log('수동 배팅: 텐텐뱃·BC.Game 탭을 열어주세요', 'err');
      return;
    }

    const polyO = resolveBcOddsForSync();
    const btiOdds = cachedBti?.odds > 1
      ? cachedBti.odds
      : await resolveBtiOddsForSync(found.btiTab);
    if (!polyO || !btiOdds || btiOdds <= 1) {
      log(`수동 배팅: 배당 확인 (텐텐 ${btiOdds?.toFixed(3) || '-'} / BC ${polyO?.toFixed(3) || '-'})`, 'err');
      return;
    }
    if (cachedBc?.suspended) {
      log('수동 배팅: BC 배당 마감', 'err');
      return;
    }

    const btiBet = getBtiBet();
    const polyUsd = calcPolyBetUsd(btiBet, btiOdds, polyO, getUsdRate());
    const profit = calcProfit(btiOdds, polyO);
    const minP = getMinProfit();
    if (profit != null && profit < minP) {
      log(`수동 배팅 — 수익 ${profit.toFixed(2)}% (최소 ${minP}% 미만, 진행)`, 'info');
    }

    await strikeBothBets(found, btiBet, polyUsd, btiOdds, null, { manual: true, immediate: true });
  } catch (e) {
    log(`수동 배팅 오류 — ${e?.message || e}`, 'err');
  } finally {
    updateManualBetButton();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function strikeBothBets(found, btiBet, polyUsd, btiOdds, btiArb, opts = {}) {
  if (strikePending) return { ok: false, reason: 'busy' };
  strikePending = true;
  updateManualBetButton();
  const amountsReady = amountsSyncedForBet(btiBet, polyUsd);
  const hint = {
    excludeTeam: cachedBc?.teamLabel,
    polyTeam: cachedBc?.teamLabel,
    skipEnsure: !!opts.immediate,
    skipStable: true
  };
  const frameId = lastBcStakeFrameId;
  const label = opts.manual ? '수동 배팅' : '동시 배팅';
  log(`${label} — 텐텐뱃 ${btiOdds.toFixed(3)} · BC ${bcOLabel()} · ${btiBet.toLocaleString()}원 / $${polyUsd.toFixed(2)}`, 'info');

  try {
    let stakeReady = amountsReady;
    if (!stakeReady) {
      await syncAmounts(true);
      await refreshSlips();
      stakeReady = amountsSyncedForBet(btiBet, polyUsd);
    }

    let stakeCheck = await verifyBcStakeForBet(found.bcTab, polyUsd);
    if (!stakeCheck.ok) {
      await setBcAmount(found.bcTab, polyUsd);
      await delay(100);
      stakeCheck = await verifyBcStakeForBet(found.bcTab, polyUsd);
    }

    if (!stakeCheck.ok) {
      log(`${label} 중단 — BC 금액 동기화 실패 (목표 $${polyUsd.toFixed(2)}, 슬립 $${(stakeCheck.stake || 0).toFixed(2)})`, 'err');
      return { ok: false, reason: 'bc-stake-not-synced' };
    }

    lastSyncedBcUsd = polyUsd;
    applySyncedBcStake(polyUsd);
    stakeReady = true;

    const [btiRes, polyRes] = await Promise.all([
      placeBtiBet(found.btiTab, btiBet, btiOdds, hint),
      placeBcBet(found.bcTab, polyUsd, {
        skipFill: stakeReady,
        frameId,
        fast: true
      })
    ]);

    let finalPolyRes = polyRes;
    if (!finalPolyRes?.success) {
      const retry = await placeBcBet(found.bcTab, polyUsd, {
        skipFill: false,
        frameId
      });
      if (retry?.success) finalPolyRes = retry;
    }

    if (btiRes?.success || finalPolyRes?.success) {
      lastSyncedBtiKrw = btiBet;
      lastSyncedBcUsd = polyUsd;
      lastSyncedAt = Date.now();
    }

    if (btiRes?.success || finalPolyRes?.success) {
      lastStrikeAt = Date.now();
      const parts = [];
      if (btiRes?.success) parts.push('텐텐뱃');
      if (finalPolyRes?.success) parts.push('BC');
      log(`${label} 완료 — ${parts.join(' + ')}`, 'ok');
      if (isAutoBetEngaged()) {
        stopAutoBetOnly(true);
        log('자동 배팅 정지', 'info');
      }
      return { ok: true, btiRes, polyRes: finalPolyRes };
    }
    const parts = [];
    if (!btiRes?.success) parts.push(`텐텐뱃: ${btiRes?.reason || '실패'}`);
    if (!finalPolyRes?.success) parts.push(`BC: ${finalPolyRes?.reason || '실패'}`);
    log(`${label} 실패 — ${parts.join(' / ')}`, 'err');
    return { ok: false, btiRes, polyRes: finalPolyRes };
  } finally {
    strikePending = false;
    updateManualBetButton();
    setTimeout(() => refreshSlips().then(() => updateSlipUI(cachedBti, cachedBc, btiArb)), 400);
  }
}

let lastPollRefreshAt = 0;

async function pollLoop() {
  if (autoBetWanted) {
    syncAutoBetButtonUi();
    await updateAutoBetMarketState();
  }
  if (!shouldSyncAmounts() && !autoBetWanted) return;
  const now = Date.now();
  if (now - lastPollRefreshAt > 900) {
    lastPollRefreshAt = now;
    await refreshSlips();
  }
  if (shouldSyncAmounts()) {
    await syncAmounts();
  }
  if (isAutoBetLooping()) scheduleAutoBetCheck();
}

function onOddsChanged(msg) {
  const opts = { cartEmpty: !!msg.cartEmpty };
  if (msg.source === 'bti') applySlipUpdate('bti', msg.slip, opts);
  if (msg.source === 'bcgame') applySlipUpdate('bcgame', msg.slip, opts);
  lastSyncedBcOdds = 0;
  lastSyncedBtiOdds = 0;
  syncBcAmountOnly(true);
  scheduleSyncAmounts();
  updateAutoBetMarketState();
  if (isAutoBetLooping()) scheduleAutoBetCheck();
}

function onBtiStakeChanged(msg) {
  if (!shouldSyncAmounts() || !msg?.stake) return;
  const input = $('btiBet');
  if (input) input.value = String(msg.stake);
  scheduleSyncAmounts();
}

function bumpAutoBetStateEpoch() {
  autoBetStateEpoch += 1;
  return autoBetStateEpoch;
}

function persistSyncState(extra = {}) {
  suppressStorageApplyUntil = Date.now() + 2500;
  const epoch = extra.autoBetStateEpoch ?? autoBetStateEpoch;
  chrome.storage.local.get(SYNC_STATE_KEY, (data) => {
    const cur = data[SYNC_STATE_KEY] || {};
    chrome.storage.local.set({
      [SYNC_STATE_KEY]: {
        ...cur,
        autoSyncEnabled,
        autoBetRunning,
        autoBetWanted,
        autoBetPausedByClose,
        autoBetStateEpoch: epoch,
        btiBet: getBtiBet(),
        usdRate: getUsdRate(),
        ...extra,
        autoBetStateEpoch: extra.autoBetStateEpoch ?? epoch
      }
    });
  });
}

function applySyncStateFromStorage(s, fromRemote = false) {
  if (!s) return;
  if (fromRemote) {
    if (Date.now() < suppressStorageApplyUntil) return;
    const remoteEpoch = Number(s.autoBetStateEpoch) || 0;
    if (remoteEpoch < autoBetStateEpoch) return;
    if (autoBetUiLocked && autoBetWanted && s.autoBetWanted === false) return;
    const remoteEngaged = !!(s.autoBetWanted || s.autoBetRunning || s.autoBetPausedByClose);
    if (autoBetWanted && !remoteEngaged && s.autoBetWanted !== true) return;
  }
  const incomingEpoch = Number(s.autoBetStateEpoch) || 0;
  if (incomingEpoch > autoBetStateEpoch) autoBetStateEpoch = incomingEpoch;
  const wasLooping = isAutoBetLooping();
  if (s.autoBetWanted !== undefined) autoBetWanted = !!s.autoBetWanted;
  if (s.autoBetPausedByClose !== undefined) autoBetPausedByClose = !!s.autoBetPausedByClose;
  if (s.autoBetRunning !== undefined) autoBetRunning = !!s.autoBetRunning && !autoBetPausedByClose;
  if (autoBetWanted && !autoBetRunning && !autoBetPausedByClose) autoBetRunning = true;

  if (!autoBetWanted && !autoBetRunning) {
    autoBetSessionId++;
    strikePending = false;
    if (autoBetTimer) { clearTimeout(autoBetTimer); autoBetTimer = null; }
  } else if (fromRemote && isAutoBetLooping() && !wasLooping) {
    scheduleAutoBetCheck();
  }

  updateAutomationButtons();
  updateSlipUI(cachedBti, cachedBc);
}

async function initSyncFromStorage() {
  try {
    const data = await chrome.storage.local.get(SYNC_STATE_KEY);
    const s = data[SYNC_STATE_KEY] || {};
    if (s.btiBet && $('btiBet')) $('btiBet').value = String(s.btiBet);
    if (s.autoBetStateEpoch) autoBetStateEpoch = Number(s.autoBetStateEpoch) || 0;
    if (s.autoBetWanted || s.autoBetRunning) {
      autoBetUiLocked = true;
      applySyncStateFromStorage({
        autoBetWanted: !!(s.autoBetWanted ?? s.autoBetRunning),
        autoBetPausedByClose: !!s.autoBetPausedByClose,
        autoBetRunning: !!s.autoBetRunning,
        autoBetStateEpoch: autoBetStateEpoch
      });
      if (isAutoBetLooping()) {
        chrome.runtime.sendMessage({
          type: 'SET_AUTO_BET',
          enabled: true,
          wanted: true,
          pausedByClose: false
        }).catch(() => {});
      }
    }
  } catch (_) {}
  enableAutoSync();
}

function enableAutoSync() {
  autoSyncEnabled = true;
  if (!calcTimer) calcTimer = setInterval(pollLoop, 250);
  chrome.runtime.sendMessage({ type: 'SET_AUTO_SYNC', enabled: true }).catch(() => {});
  persistSyncState();
  updateSyncButtons();
}

function isAutomationActive() {
  return isAutoBetEngaged();
}

const updateSyncButtons = updateAutomationButtons;

function startAutoBet() {
  if (autoBetPausedByClose) {
    resumeAutoBetByMarketOpen();
    return;
  }
  if (isAutoBetLooping()) return;
  autoBetSessionId++;
  const session = autoBetSessionId;
  const stateEpoch = bumpAutoBetStateEpoch();
  autoBetUiLocked = true;
  suppressStorageApplyUntil = Date.now() + 2500;
  document.querySelector('.tab[data-tab="slip"]')?.click();
  autoBetWanted = true;
  autoBetPausedByClose = false;
  autoBetRunning = true;
  lastStrikeAt = 0;
  lastHistoryKey = '';
  lastAutoBetHintAt = 0;
  lastMarketCloseLogAt = 0;
  lastMarketOpenLogAt = 0;
  updateAutomationButtons();
  updateSlipUI(cachedBti, cachedBc);
  enableAutoSync();
  chrome.runtime.sendMessage({
    type: 'SET_AUTO_BET',
    enabled: true,
    wanted: true,
    pausedByClose: false,
    stateEpoch
  }).catch(() => {});
  persistSyncState({
    autoBetRunning: true,
    autoBetWanted: true,
    autoBetPausedByClose: false,
    autoBetStateEpoch: stateEpoch
  });
  log(`자동 배팅 시작 — 수익 ${getMinProfit()}% 이상 시 동시 즉시 배팅`, 'info');
  scheduleAutoBetCheck();
  refreshSlips().then(async () => {
    if (session !== autoBetSessionId || !autoBetWanted) return;
    await updateAutoBetMarketState();
    if (session !== autoBetSessionId || !isAutoBetLooping()) return;
    const found = await findTabs();
    const polyO = resolveBcOddsForSync();
    const btiOdds = await resolveBtiOddsForSync(found.btiTab);
    const profit = (polyO && btiOdds) ? calcProfit(btiOdds, polyO) : null;
    log(`상태 — 텐텐 ${btiOdds?.toFixed(3) || '-'} · BC ${polyO?.toFixed(3) || '-'} · 수익 ${profit != null ? profit.toFixed(2) : '-'}%`, 'info');
    await syncAmounts(true);
    if (session === autoBetSessionId) scheduleAutoBetCheck();
  });
}

function stopAutoBetOnly(clearWanted = true) {
  autoBetSessionId++;
  const stateEpoch = bumpAutoBetStateEpoch();
  if (clearWanted) autoBetUiLocked = false;
  suppressStorageApplyUntil = Date.now() + 2500;
  autoBetRunning = false;
  if (clearWanted) autoBetWanted = false;
  autoBetPausedByClose = false;
  strikePending = false;
  if (autoBetTimer) { clearTimeout(autoBetTimer); autoBetTimer = null; }
  updateAutomationButtons();
  chrome.runtime.sendMessage({
    type: 'STOP_AUTO_BET',
    clearWanted,
    stateEpoch
  }).catch(() => {});
  persistSyncState({
    autoBetRunning: false,
    autoBetWanted: clearWanted ? false : autoBetWanted,
    autoBetPausedByClose: false,
    autoBetStateEpoch: stateEpoch
  });
  updateAutomationButtons();
  updateSlipUI(cachedBti, cachedBc);
}

function stopAutoBet() {
  if (!isAutoBetEngaged()) return;
  stopAutoBetOnly(true);
  log('자동 배팅 정지', 'info');
}

function renderSearchResults(data) {
  const el = $('searchResults');
  const stats = $('searchStats');
  if (!data) return;

  const s = data.stats || {};
  const btiSrc = s.btiSource === 'dom' ? ' · DOM' : (s.btiSource === 'api' ? ' · API' : '');
  stats.textContent = `텐텐뱃 ${s.btiTotal || 0}경기${btiSrc} · BC ${s.bcTotal || 0}경기 · 매칭 ${s.matched || 0}건 (BTI ${s.btiTabFound ? 'O' : 'X'} / BC ${s.bcTabFound ? 'O' : 'X'})`;
  if (!s.btiTotal && s.btiTabFound) {
    stats.textContent += ' — 배당판이 보이는 10벳 스포츠 탭인지 확인';
  }

  el.innerHTML = '';
  const minP = parseFloat($('minProfit')?.value || '1');
  const opps = (data.opportunities || []).filter((o) => parseFloat(o.profit) >= minP);

  if (!opps.length) {
    el.innerHTML = '<div class="hint" style="padding:12px">조건 충족 기회 없음 — 탭 열림/팀명 매칭 확인</div>';
    return;
  }

  for (const o of opps.slice(0, IS_PANEL ? 80 : 40)) {
    const div = document.createElement('div');
    div.className = 'opp';
    div.innerHTML = `<strong>${o.home} vs ${o.away}</strong><br>
      BC <b>${o.bcTeam || o.polyTeam}</b> ${o.bcOdds || o.polyOdds} · 텐텐뱃 ${o.btiSide} ${o.btiOdds}
      <span class="profit-tag"> → ${o.profit}%</span>`;
    el.appendChild(div);
  }
}

function startSearch() {
  chrome.runtime.sendMessage({ type: 'START_SEARCH' }, (res) => {
    if (res?.ok) {
      $('searchStart').disabled = true;
      $('searchStop').disabled = false;
      if (res.result) renderSearchResults(res.result);
      log('서치 시작', 'info');
    } else {
      log(`서치 실패: ${res?.error || ''}`, 'err');
    }
  });
}

function stopSearch() {
  chrome.runtime.sendMessage({ type: 'STOP_SEARCH' }, (res) => {
    $('searchStart').disabled = false;
    $('searchStop').disabled = true;
    if (res?.ok !== false) log('서치 정지', 'info');
    else log('서치 정지 요청', 'info');
  });
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = $(`tab-${btn.dataset.tab}`);
    if (panel) panel.classList.add('active');
  });
});

$('manualBetBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  manualBet().catch((err) => log(`수동 배팅 오류 — ${err?.message || err}`, 'err'));
});
$('autoBetStart')?.addEventListener('click', startAutoBet);
$('autoBetStop')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  stopAutoBet();
});
$('clearHistoryBtn')?.addEventListener('click', clearHistory);
$('searchStart')?.addEventListener('click', startSearch);
$('searchStop')?.addEventListener('click', stopSearch);
$('openPanelBtn')?.addEventListener('click', openPanel);
$('openPanelFromSearch')?.addEventListener('click', openPanel);
$('refreshBtn')?.addEventListener('click', () => { refreshSlips(); log('새로고침', 'info'); });
['slipMinProfit', 'minProfit'].forEach((id) => {
  $(id)?.addEventListener('input', () => {
    updateSlipUI(cachedBti, cachedBc);
    if (shouldSyncAmounts()) scheduleSyncAmounts();
  });
});
$('btiBet')?.addEventListener('input', onBtiBetInput);
$('btiBet')?.addEventListener('change', onBtiBetInput);

$('diagBtn')?.addEventListener('click', async () => {
  log('진단...', 'info');
  const found = await findTabs();
  log(`텐텐뱃: ${found.btiTab ? `탭 OK frame#${found.btiTab.frameId}` : '탭 없음'}`, found.btiTab ? 'ok' : 'err');
  log(`BC.Game: ${found.bcTab ? '탭 OK' : '탭 없음'}`, found.bcTab ? 'ok' : 'err');
  if (found.bcTab) {
    await ensureBcScript(found.bcTab.id);
    const probeIso = await sendBc(found.bcTab.id, { type: 'PROBE_BC' });
    if (probeIso?.probe) {
      const p = probeIso.probe;
      log(`BC UI: 슬립${p.hasPanel || p.hasSlipSelection ? 'O' : 'X'} · 입력${p.hasInput ? 'O' : 'X'} · ${p.mode || ''}`, (p.hasPanel || p.hasSlipSelection) ? 'info' : 'err');
    }
  }
  chrome.runtime.sendMessage({ type: 'DIAG_BTI' }, (r) => {
    if (r?.ok) log(`BTI iframe ${r.frames}개 / PING ${r.pings?.length || 0}개`, 'info');
    else log(`BTI: ${r?.error}`, 'err');
  });
  await refreshSlips();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SEARCH_RESULT') renderSearchResults(msg);
  if (msg.type === 'ODDS_CHANGED') onOddsChanged(msg);
  if (msg.type === 'BTI_STAKE_CHANGED') onBtiStakeChanged(msg);
  if (msg.type === 'USDT_RATE_UPDATED' && msg.rate) applyUsdtRate(msg.rate);
  if (msg.type === 'AUTO_BET_STATE' && msg.state) {
    if (Date.now() < suppressStorageApplyUntil) return;
    applySyncStateFromStorage(msg.state, true);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SYNC_STATE_KEY]) return;
  if (Date.now() < suppressStorageApplyUntil) return;
  applySyncStateFromStorage(changes[SYNC_STATE_KEY].newValue, true);
});

setInterval(() => {
  refreshSlips().then(() => {
    if (autoBetWanted) updateAutoBetMarketState();
    if (shouldSyncAmounts()) scheduleSyncAmounts();
    if (isAutoBetLooping()) scheduleAutoBetCheck();
  });
}, FALLBACK_REFRESH_MS);
loadHistory();
startBithumbRateLoop();
initSyncFromStorage().then(() => refreshSlips().then(() => scheduleSyncAmounts()));
updateAutomationButtons();
log(`v5.9.26 ${IS_PANEL ? '패널' : '팝업'} 로드 — OU 라인≠배당`, 'info');
