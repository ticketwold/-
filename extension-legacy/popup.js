// popup.js v6.0.0 — 텐텐뱃 + Polymarket / BC.Game

'use strict';

const POLL_MS = 16;
const FALLBACK_REFRESH_MS = 800;
const BTI_FULL_SCAN_MS = 2500;
const BTI_MAX_FRAMES = 16;
const IS_PANEL = document.body.classList.contains('panel-mode');
let calcRunning = false;
let calcTimer = null;
let syncPolyTimer = null;
let syncPolyPending = false;
let lastSyncedPolyUsd = 0;
let lastSyncedPolyAt = 0;
let cachedBti = null;
let cachedPoly = null;
let lastBtiFrame = null;
let lastBtiSlipFrame = null;
let lastBtiBoardFrame = null;
let lastBtiFullScanAt = 0;
let refreshPending = false;
let refreshQueued = false;
let polyScriptReady = new Set();
let btiScriptReady = new Set();
let lastStatus = { bti: '', poly: '' };
const HISTORY_KEY = 'calcHistory';
const HISTORY_MAX = 100;
let historyEntries = [];
let lastHistoryKey = '';
let betLock = false;
let lastBetAt = 0;
let autoBetScheduleTimer = null;
let profitZoneSince = 0;
let polySyncGraceUntil = 0;
const PROFIT_ZONE_SETTLE_MS = 500;
const BET_PREF_KEY = 'betPrefs';

function formatPolyOddsForHistory(slip) {
  if (!slip?.odds || slip.odds <= 1) return '-';
  if (slip.fromPayout) return slip.odds.toFixed(3);
  if (slip.priceCents != null) return `${slip.priceCents}¢ (${slip.odds.toFixed(3)})`;
  return slip.odds.toFixed(3);
}

const SITE_PREF_KEY = 'sitePrefs';
let leg2SitePref = 'auto';

function getLeg2Pref() {
  const slip = $('slipLeg2Site')?.value;
  const search = $('searchLeg2Site')?.value;
  return slip || search || leg2SitePref || 'auto';
}

function applyLeg2PrefToUi(pref) {
  leg2SitePref = pref || 'auto';
  for (const id of ['slipLeg2Site', 'searchLeg2Site']) {
    const el = $(id);
    if (el) el.value = leg2SitePref;
  }
  updateLeg2UiLabels();
}

async function loadSitePrefs() {
  try {
    const data = await chrome.storage.local.get(SITE_PREF_KEY);
    const pref = data[SITE_PREF_KEY]?.leg2 || 'auto';
    applyLeg2PrefToUi(pref);
  } catch (_) {
    applyLeg2PrefToUi('auto');
  }
}

async function saveSitePrefs() {
  const pref = getLeg2Pref();
  leg2SitePref = pref;
  try {
    await chrome.storage.local.set({ [SITE_PREF_KEY]: { leg1: 'bti', leg2: pref } });
  } catch (_) {}
  applyLeg2PrefToUi(pref);
}

function bindSitePrefSelectors() {
  for (const id of ['slipLeg2Site', 'searchLeg2Site']) {
    $(id)?.addEventListener('change', () => {
      const v = $(id)?.value || 'auto';
      applyLeg2PrefToUi(v);
      saveSitePrefs();
      findTabs().then(() => refreshSlips());
      log(`오른쪽(B) 사이트: ${leg2PrefLabel(v)}`, 'info');
    });
  }
}

let cachedLeg2Url = null;

function leg2ShortLabel() {
  return leg2SiteShort(cachedLeg2Url) || '폴리';
}

function leg2FullLabel() {
  const pref = getLeg2Pref();
  if (pref !== 'auto') return leg2PrefLabel(pref);
  return leg2SiteLabel(cachedLeg2Url) || 'Polymarket / BC.Game';
}

function isLeg2Source(source) {
  return source === 'polymarket' || source === 'bcgame';
}

function updateLeg2UiLabels() {
  const label = leg2FullLabel();
  const short = leg2ShortLabel();
  const leg2LabelEl = $('leg2Label');
  if (leg2LabelEl) leg2LabelEl.textContent = label;
  const calcLeg2 = $('calcLeg2Label');
  if (calcLeg2) calcLeg2.textContent = label;
  const payoutLeg2 = $('payoutLeg2Label');
  if (payoutLeg2) payoutLeg2.textContent = `${label} 당첨금`;
}

function formatHistoryLine(bti, poly, arbBti, profit) {
  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = (arbBti?.odds > 1) ? arbBti.odds : (bti?.odds > 1 ? bti.odds : null);
  const team = poly?.teamLabel || formatBtiMeta(bti) || '경기';
  const profitText = profit != null ? `${profit.toFixed(2)}%` : '-';
  const leg2 = leg2ShortLabel();
  return `${team} · 텐텐뱃 ${btiO?.toFixed(3) || '-'} · ${leg2} ${formatPolyOddsForHistory(poly)} · 수익률 ${profitText}`;
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
  if (!calcRunning) return;
  if (poly?.pendingToWin) return;
  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = (arbBti?.odds > 1) ? arbBti.odds : (bti?.odds > 1 ? bti.odds : null);
  if (!polyO || !btiO) return;

  const profit = calcProfit(btiO, polyO);
  if (profit == null) return;
  if (profit > 12 && polyO > 3.5) return;

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
    if (res?.ok) log('패널 창 열림', 'info');
    else log(`창 열기 실패: ${res?.error || '권한 확인'}`, 'err');
  });
}

function switchTab(tabName) {
  if (!tabName) return;
  const panel = document.getElementById(`tab-${tabName}`);
  if (!panel) {
    log(`탭 없음: ${tabName}`, 'err');
    return;
  }
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('section.panel').forEach((p) => p.classList.remove('active'));
  panel.classList.add('active');
  try { sessionStorage.setItem('arbActiveTab', tabName); } catch (_) {}
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
  if (calcRunning && btiTab?.id) {
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
  const v = parseFloat($('usdRate')?.value || '1400');
  return Number.isFinite(v) ? v : 1400;
}

function formatOdds(slip) {
  if (!slip) return '-';
  if (!slip.odds || slip.odds <= 1) {
    if (slip.needsStake) return '금액입력';
    return '-';
  }
  if (slip.fromPayout) return slip.displayLabel || slip.odds.toFixed(3);
  if (slip.displayLabel) return slip.displayLabel;
  if (slip.priceCents != null) return `${slip.priceCents}¢ (${slip.odds.toFixed(3)})`;
  return slip.odds.toFixed(3);
}

function formatPolyMeta(slip) {
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

function broadcastAutoBetState(btiO, polyO, profit, poly) {
  if (btiO == null || polyO == null || profit == null) return;
  const state = {
    profit,
    btiOdds: btiO,
    polyOdds: polyO,
    polyTeam: poly?.teamLabel || '',
    hint: btiHintFromPoly(poly),
    calcRunning,
    minProfit: getMinProfit()
  };
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.url || !(isWrapperUrl(tab.url) || isLeg2PredictionUrl(tab.url))) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (s) => {
          if (typeof window.__arbAutoWriteState === 'function') window.__arbAutoWriteState(s);
          else {
            try { localStorage.setItem('__arbBotState_v1', JSON.stringify({ ...s, ts: Date.now() })); } catch (_) {}
          }
        },
        args: [state]
      }).catch(() => {});
    }
  });
}

function updateSlipUI(bti, poly, arbBti = null) {
  $('btiOdds').textContent = formatOdds(bti);
  $('polyOdds').textContent = formatOdds(poly);
  $('btiMeta').textContent = formatBtiMeta(bti);
  $('polyMeta').textContent = formatPolyMeta(poly);

  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = (calcRunning && arbBti?.odds > 1) ? arbBti.odds : (bti?.odds > 1 ? bti.odds : null);
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
  if (hint) {
    if (!bti?.odds) hint.textContent = lastStatus.bti || '텐텐뱃: x10x10s 슬립/배당판 확인';
    else if (!poly?.odds) hint.textContent = lastStatus.poly || `${leg2FullLabel()}: Amount 입력 후 To win 확인`;
    else if (poly?.needsStake) hint.textContent = calcRunning ? `${leg2FullLabel()} Amount 입력 대기...` : 'Amount 입력 시 당첨금 기준 배당';
    else if (profit !== null && profit >= getMinProfit()) {
      hint.textContent = calcRunning && $('autoBet')?.checked
        ? `수익 구간 — 자동 배팅 대기 (${profit.toFixed(2)}%)`
        : `수익 구간 충족 (${profit.toFixed(2)}%)`;
    }
    else if (profit !== null) hint.textContent = `수익 구간 밖 (최소 ${getMinProfit()}%)`;
    else hint.textContent = '배당 확인 중...';
  }

  broadcastAutoBetState(btiO, polyO, profit, poly);

  if (btiO && polyO) {
    const btiBet = getBtiBet();
    const rate = getUsdRate();
    const polyStakeCalc = calcPolyBetUsd(btiBet, btiO, polyO, rate);
    const polyStakePage = poly?.stake > 0 ? poly.stake : null;
    const polyStake = polyStakeCalc;
    $('calcBti').textContent = `${btiBet.toLocaleString()}원`;
    $('calcPoly').textContent = `$${polyStake.toFixed(2)}`;

    const btiTotalKrw = calcBtiTotalPayoutKrw(btiBet, btiO);
    const polyTotalUsd = (poly?.fromPayout && poly?.payout)
      ? poly.payout
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
          ? `($${polyTotalUsd.toFixed(2)} USDT · 환율 ${rate.toLocaleString()}원)`
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
          msg += ` — ${leg2FullLabel()} 페이지 $${polyStakePage.toFixed(2)} ≠ 계산 $${polyStakeCalc.toFixed(2)}`;
          compareEl.className = 'payout-compare warn';
        }
        compareEl.textContent = msg;
      } else {
        compareEl.textContent = `${leg2FullLabel()} 금액 입력 후 비교`;
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
  scheduleAutoBetCheck();
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

function sendPoly(tabId, msg, frameId = 0) {
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

async function ensurePolyScript(tabId, frameId = 0) {
  const key = frameId ? `${tabId}:${frameId}` : String(tabId);
  if (polyScriptReady.has(key)) return;
  try {
    const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
    await chrome.scripting.executeScript({
      target,
      files: ['polymarket_content.js']
    });
    polyScriptReady.add(key);
    if (!frameId) polyScriptReady.add(String(tabId));
  } catch (_) {}
}

async function readPolySlipAllFrames(polyTab) {
  const frames = await getAllFrames(polyTab.id);
  const order = [0, ...frames.map((f) => f.frameId).filter((id) => id !== 0)];
  const seen = new Set();
  let best = null;

  for (const frameId of order) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    await ensurePolyScript(polyTab.id, frameId);
    const res = await sendPoly(polyTab.id, { type: 'READ_SLIP' }, frameId);
    const slip = res?.slip;
    if (slip?.fromPayout && slip.odds > 1) return slip;
    if (slip?.odds > 1 || slip?.needsStake) {
      if (!best || slip.fromPayout || (slip.odds > 1 && !best.odds)) best = slip;
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

async function injectReadPoly(tabId, siteKey = 'polymarket') {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (site) => {
        function vis(el) {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        function parseMoney(t) {
          const s = String(t || '').trim();
          let m = s.match(/^\+?\s*([\d,]+(?:\.\d+)?)\s*USDT/i);
          if (m) {
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (Number.isFinite(v) && v > 0) return v;
          }
          m = s.match(/\$?\s*([\d,]+(?:\.\d+)?)/);
          if (m) {
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (Number.isFinite(v) && v > 0) return v;
          }
          return null;
        }
        function findWinIdx(raw) {
          const patterns = [/\bto\s*win\b/i, /우승/, /당첨(?:금)?/];
          let best = -1;
          for (const re of patterns) {
            const m = raw.match(re);
            if (m && (best < 0 || m.index < best)) best = m.index;
          }
          return best;
        }
        function findPanel() {
          function scoreTradePanelText(t) {
            const hasToWin = /\bto\s*win\b|우승|당첨|획득/i.test(t);
            const hasAmount = /\bamount\b|금액/i.test(t);
            const hasBuy = /\bbuy\b|매수|구매/i.test(t);
            if (!hasToWin || !hasAmount) return -1;
            let score = 70;
            if (hasBuy) score += 20;
            if (t.length <= 450) score += 160;
            else if (t.length > 2000) score -= 280;
            if (/(?:amount|금액)\s*\(\s*usdt\s*\)/i.test(t)) score += 45;
            const amtIdx = t.search(/\bamount\b|금액/i);
            const winIdx = findWinIdx(t);
            if (amtIdx >= 0 && winIdx >= 0 && Math.abs(amtIdx - winIdx) < 450) score += 75;
            return score;
          }
          let best = null;
          let bestScore = -1;
          for (const el of document.querySelectorAll('div, section, aside, form')) {
            if (!vis(el)) continue;
            const t = el.innerText || '';
            if (!el.querySelector('input, [contenteditable="true"]')) continue;
            const score = scoreTradePanelText(t);
            if (score < 0) continue;
            if (score > bestScore) { bestScore = score; best = el; }
          }
          return best;
        }
        function readStake(panel) {
          if (!panel) return null;
          for (const inp of panel.querySelectorAll('input, [contenteditable="true"]')) {
            if (!vis(inp)) continue;
            const ph = (inp.placeholder || '').toLowerCase();
            if (/search|검색/.test(ph)) continue;
            const v = parseMoney(inp.value || inp.textContent || inp.getAttribute('value'));
            if (v) return v;
          }
          const m = (panel.innerText || '').match(/(?:Amount|금액)(?:\(USDT\))?\s*\n?\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
          if (m) return parseFloat(m[1].replace(/,/g, '')) || null;
          return null;
        }
        function readToWin(panel) {
          if (!panel) return null;
          const raw = (panel.innerText || '').replace(/\s+/g, ' ');
          const idx = findWinIdx(raw);
          if (idx < 0) return null;
          const section = raw.slice(idx, idx + 200);
          const patterns = [
            /(?:to\s*win|우승|당첨(?:금)?)[\s\S]{0,100}?([+]?\s*[\d,]+(?:\.\d+)?)\s*USDT/i,
            /(?:to\s*win|우승|당첨(?:금)?)[\s\S]{0,100}?≈\s*US?\$?\s*([\d,]+(?:\.\d+)?)/i
          ];
          for (const re of patterns) {
            const m = section.match(re);
            if (!m) continue;
            const v = parseFloat(String(m[1]).replace(/,/g, '').replace(/[+,\s]/g, ''));
            if (v > 0) return v;
          }
          return null;
        }

        const panel = findPanel();
        const stake = readStake(panel);
        const toWin = readToWin(panel);
        if (stake && toWin) {
          const total = toWin >= stake ? toWin : stake + toWin;
          const odds = total / stake;
          if (odds > 1.001 && odds <= 100) {
            return {
              source: site,
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
      },
      args: [siteKey]
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

async function probeBtiFrame(tabId, frameId, hint = {}) {
  let ping = await sendBti(tabId, frameId, { type: 'PING' });
  if (!ping?.ok) {
    await ensureBtiScript(tabId, frameId);
    ping = await sendBti(tabId, frameId, { type: 'PING' });
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

  return { frameId, ping, slip, score: scoreBtiProbe(ping, slip), hasInput: !!(ping?.hasInput || slip?.hasInput), hasBoard: !!((ping?.buttonCount || 0) > 0 || (slip?.buttonCount || 0) > 0) };
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

async function readBtiFromAllFrames(tabId, hint = {}, forceFull = false) {
  const frames = await getAllFrames(tabId);
  const order = [];
  if (lastBtiFrame?.tabId === tabId) order.push(lastBtiFrame.frameId);
  for (const f of frames) {
    if (!order.includes(f.frameId)) order.push(f.frameId);
  }

  if (!forceFull && lastBtiFrame?.tabId === tabId) {
    const fast = await probeBtiFrame(tabId, lastBtiFrame.frameId, hint);
    if (fast.slip?.odds > 1.01) {
      lastBtiFrame = { tabId, frameId: fast.frameId };
      return { slip: fast.slip, frameId: fast.frameId };
    }
  }

  const results = await Promise.all(order.map((frameId) => probeBtiFrame(tabId, frameId, hint)));
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
  const hint = btiHintFromPoly(poly);
  const merged = await readBtiFromAllFrames(btiTab.id, hint);
  return merged.slip?.odds > 1.01 ? merged.slip : null;
}

async function findBtiFrame(tabId) {
  const merged = await readBtiFromAllFrames(tabId, btiHintFromPoly(cachedPoly), true);
  const ping = await sendBti(tabId, merged.frameId, { type: 'PING' });
  return { frameId: merged.frameId, ping, slip: merged.slip };
}

async function findTabsLocal(leg2Pref) {
  const tabs = await chrome.tabs.query({});
  let btiTab = null;
  const leg2Tabs = [];

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (urlMatchesLeg2Pref(tab.url, leg2Pref)) leg2Tabs.push(tab);
    if (isWrapperUrl(tab.url)) {
      const score = scoreWrapperBtiTab(tab.url);
      if (!btiTab || score > (btiTab._score || 0)) {
        btiTab = { tab, _score: score };
      }
    }
  }

  let polyTab = null;
  let bestScore = -1;
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = activeTabs[0]?.id;

  for (const t of leg2Tabs) {
    const score = scoreLeg2Tab(t.url, activeId, t.id, leg2Pref);
    if (score > bestScore) {
      bestScore = score;
      polyTab = t;
    }
  }

  if (polyTab?.url) cachedLeg2Url = polyTab.url;
  else if (leg2Pref !== 'auto') cachedLeg2Url = null;
  updateLeg2UiLabels();

  const bti = btiTab?.tab;
  return {
    btiTab: bti ? {
      id: bti.id,
      url: bti.url,
      frameId: lastBtiFrame?.tabId === bti.id ? lastBtiFrame.frameId : 0
    } : null,
    polyTab: polyTab ? { id: polyTab.id, url: polyTab.url } : null,
    leg2Pref
  };
}

async function findTabs() {
  const leg2Pref = getLeg2Pref();
  let btiTab = null;
  let polyTab = null;

  try {
    const remote = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_TABS', leg2Pref }, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    });
    if (remote?.btiTab) {
      btiTab = {
        id: remote.btiTab.id,
        url: remote.btiTab.url,
        frameId: lastBtiFrame?.tabId === remote.btiTab.id ? lastBtiFrame.frameId : 0
      };
    }
    if (remote?.polyTab) polyTab = { id: remote.polyTab.id, url: remote.polyTab.url };
  } catch (_) {}

  const local = await findTabsLocal(leg2Pref);
  if (!btiTab && local.btiTab) btiTab = local.btiTab;
  if (!polyTab && local.polyTab) polyTab = local.polyTab;

  if (polyTab?.url) cachedLeg2Url = polyTab.url;
  updateLeg2UiLabels();

  return { btiTab, polyTab, leg2Pref };
}

function btiHintFromPoly(poly) {
  if (!poly) return {};
  const team = poly.teamLabel || poly.outcome || '';
  return team ? { excludeTeam: team, polyTeam: team } : {};
}

async function readBtiSlip(btiTab) {
  if (!btiTab?.id) {
    lastStatus.bti = '텐텐뱃: x10x10s 탭 없음';
    return null;
  }

  // 슬립 비교 UI: hint 없이 현재 슬립/배당판 배당 표시
  const merged = await readBtiFromAllFrames(btiTab.id, {});
  if (merged.slip?.odds > 1) {
    lastBtiFrame = { tabId: btiTab.id, frameId: merged.frameId };
    btiTab.frameId = merged.frameId;
    lastStatus.bti = '';
    return merged.slip;
  }

  const forced = await readBtiFromAllFrames(btiTab.id, {}, true);
  if (forced.slip?.odds > 1) {
    lastBtiFrame = { tabId: btiTab.id, frameId: forced.frameId };
    lastStatus.bti = '';
    return forced.slip;
  }

  lastStatus.bti = '텐텐뱃: 배당판 배당 없음 — 슬립에 담고 ↻';
  return null;
}

async function readPolySlipFromApi(polyTab) {
  if (!polyTab?.url) return null;
  const slug = slugFromPolyUrl(polyTab.url);
  if (!slug) return null;
  try {
    const event = await fetchPolyEventBySlug(slug);
    if (!event) return null;
    const teamHint = polyTeamHintFromUrl(polyTab.url);
    return polyEventToSlip(event, teamHint, leg2SiteKey(polyTab.url) || 'polymarket');
  } catch (_) {
    return null;
  }
}

async function readPolySlip(polyTab) {
  const leg2Pref = getLeg2Pref();
  const leg2Label = leg2Pref === 'auto' ? leg2SiteLabel(polyTab?.url) : leg2PrefLabel(leg2Pref);
  if (!polyTab?.id) {
    const need = leg2Pref === 'auto' ? 'Polymarket 또는 BC.Game' : leg2PrefLabel(leg2Pref);
    lastStatus.poly = `오른쪽(B) ${leg2PrefLabel(leg2Pref)}: 탭 없음 — ${need} 예측 페이지를 열어주세요`;
    return null;
  }

  cachedLeg2Url = polyTab.url;
  updateLeg2UiLabels();

  let slip = await readPolySlipAllFrames(polyTab);

  const siteKey = leg2SiteKey(polyTab.url) || 'polymarket';
  if (!slip?.fromPayout) {
    const injected = await injectReadPoly(polyTab.id, siteKey);
    if (injected?.fromPayout) slip = { ...slip, ...injected };
  }

  if (slip?.fromPayout) {
    lastStatus.poly = '';
    return slip;
  }

  if (slip?.odds > 1) {
    lastStatus.poly = slip.needsStake ? `${leg2Label}: 금액(USDT) 입력 필요` : '';
    return slip;
  }

  const apiSlip = await readPolySlipFromApi(polyTab);
  if (apiSlip?.odds > 1 && !slip) {
    lastStatus.poly = '금액 입력 시 우승/당첨금 기준 배당으로 전환';
    return apiSlip;
  }

  if (slip?.needsStake) {
    lastStatus.poly = `${leg2Label}: 금액(USDT) + 우승(당첨) 확인 필요 — 마켓 클릭 후 금액 입력`;
    return slip;
  }

  lastStatus.poly = `${leg2Label}: predictions 페이지에서 마켓 클릭 → 금액(USDT) 입력`;
  return slip || apiSlip || null;
}

function slipOdds(slip) {
  if (!slip) return null;
  if (slip.odds > 1 && slip.odds <= 50) return slip.odds;
  if (slip.priceCents >= 1 && slip.priceCents < 100) return 100 / slip.priceCents;
  return null;
}

function mergeSlipCached(cached, fresh) {
  if (fresh?.pendingToWin) {
    if (cached?.odds > 1) {
      return {
        ...cached,
        stake: fresh.stake > 0 ? fresh.stake : cached.stake,
        pendingToWin: true,
        hint: fresh.hint || cached.hint
      };
    }
    return slipOdds(fresh) ? { ...fresh, odds: slipOdds(fresh) } : cached;
  }
  if (!fresh || !slipOdds(fresh)) return cached?.fromPayout ? cached : null;
  const freshOdds = slipOdds(fresh);
  if (!cached) return { ...fresh, odds: freshOdds };
  if (cached.odds > 1 && fresh.fromPayout) {
    const ratio = freshOdds / cached.odds;
    if (ratio > 1.18 || ratio < 0.85) {
      return {
        ...cached,
        stake: fresh.stake > 0 ? fresh.stake : cached.stake,
        odds: slipOdds(cached),
        pendingToWin: Date.now() < polySyncGraceUntil
      };
    }
  }
  if (fresh.fromPayout && !cached.fromPayout) return { ...fresh, odds: freshOdds };
  if (cached.fromPayout && !fresh.fromPayout) return { ...cached, odds: slipOdds(cached) };
  if (cached.teamLabel && fresh.teamLabel && cached.teamLabel !== fresh.teamLabel) {
    return { ...fresh, odds: freshOdds, teamSwitched: true };
  }
  return { ...cached, ...fresh, odds: freshOdds };
}

function applySlipUpdate(source, slip) {
  if (source === 'bti') {
    cachedBti = slipOdds(slip) ? mergeSlipCached(cachedBti, slip) : null;
  }
  if (isLeg2Source(source)) {
    const prevTeam = cachedPoly?.teamLabel;
    const merged = (slipOdds(slip) || slip?.pendingToWin) ? mergeSlipCached(cachedPoly, slip) : null;
    if (merged) {
      if (prevTeam && merged.teamLabel && prevTeam !== merged.teamLabel) {
        lastSyncedPolyUsd = 0;
        lastSyncedPolyAt = 0;
        polySyncGraceUntil = Date.now() + 1200;
      }
      cachedPoly = merged;
    } else if (!slip?.pendingToWin) {
      cachedPoly = null;
    }
  }
  refreshSlipUiWithArb();
}

async function refreshSlipUiWithArb() {
  let arbBti = null;
  if (calcRunning && cachedPoly?.teamLabel) {
    const found = await findTabs();
    if (found.btiTab) arbBti = await readBtiArbOdds(found.btiTab, cachedPoly);
  }
  updateSlipUI(cachedBti, cachedPoly, arbBti);
  if (calcRunning) scheduleAutoBetCheck();
}

async function refreshSlips() {
  if (refreshPending) {
    refreshQueued = true;
    return { bti: cachedBti, poly: cachedPoly };
  }
  refreshPending = true;
  try {
    const found = await findTabs();
    const [poly, bti] = await Promise.all([
      readPolySlip(found.polyTab),
      readBtiSlip(found.btiTab)
    ]);

    const prevPolyTeam = cachedPoly?.teamLabel;
    cachedPoly = mergeSlipCached(cachedPoly, poly);
    cachedBti = mergeSlipCached(cachedBti, bti);

    if (poly?.teamLabel && prevPolyTeam && prevPolyTeam !== cachedPoly?.teamLabel) {
      lastSyncedPolyUsd = 0;
      lastSyncedPolyAt = 0;
    }

    let arbBti = null;
    if (calcRunning && cachedPoly?.teamLabel && found.btiTab) {
      arbBti = await readBtiArbOdds(found.btiTab, cachedPoly);
    }

    updateSlipUI(cachedBti, cachedPoly, arbBti);
    scheduleSyncPolyAmount();
    return { bti: cachedBti, poly: cachedPoly, btiTab: found.btiTab, polyTab: found.polyTab };
  } finally {
    refreshPending = false;
    if (refreshQueued) {
      refreshQueued = false;
      refreshSlips();
    }
  }
}

async function placeBtiBet(btiTab, amount, targetOdds, hint = {}, lineOpts = {}) {
  const frameIds = await resolveBtiBetFrameIds(btiTab.id);
  const msg = {
    type: 'PLACE_BET',
    amount,
    targetOdds,
    targetLine: lineOpts.targetLine,
    lineTolerance: lineOpts.lineTolerance ?? 0.05,
    hint
  };
  let lastRes = null;
  let bestRes = null;
  for (const frameId of frameIds) {
    const res = await sendBti(btiTab.id, frameId, msg);
    if (!res) continue;
    lastRes = res;
    if (res.success) return { ...res, frameId };
    if (!bestRes || (res.hasSlip && !bestRes.hasSlip)) bestRes = { ...res, frameId };
  }
  return bestRes || lastRes || { success: false, reason: '텐텐뱃 응답 없음 — 슬립/iframe 확인' };
}

async function ensureBtiSlip(btiTab, hint = {}) {
  const frameIds = await resolveBtiBetFrameIds(btiTab.id);
  const { res } = await sendBtiToFrames(btiTab.id, frameIds, { type: 'ENSURE_BTI_SLIP', hint });
  return res || { ok: false, reason: '응답 없음' };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} (${ms}ms 초과)`)), ms))
  ]);
}

async function orderBtiFrameIds(tabId) {
  const frames = await getAllFrames(tabId);
  const scored = [];

  for (const f of frames) {
    if (f.frameId !== 0 && !isInjectableBtiUrl(f.url)) continue;
    let score = scoreBtiFrameUrl(f.url || '');
    if (f.frameId === 0) score += 3;
    scored.push({ frameId: f.frameId, score, url: f.url || '' });
  }

  if (!scored.length) {
    for (const f of frames) {
      scored.push({ frameId: f.frameId, score: f.frameId === 0 ? 1 : 0, url: f.url || '' });
    }
  }

  if (lastBtiFrame?.tabId === tabId) {
    const hit = scored.find((s) => s.frameId === lastBtiFrame.frameId);
    if (hit) hit.score += 120;
  }
  if (lastBtiSlipFrame?.tabId === tabId) {
    const hit = scored.find((s) => s.frameId === lastBtiSlipFrame.frameId);
    if (hit) hit.score += 100;
  }
  if (lastBtiBoardFrame?.tabId === tabId) {
    const hit = scored.find((s) => s.frameId === lastBtiBoardFrame.frameId);
    if (hit) hit.score += 80;
  }

  scored.sort((a, b) => b.score - a.score);
  const ids = [];
  for (const s of scored) {
    if (!ids.includes(s.frameId)) ids.push(s.frameId);
  }
  return ids.length ? ids : [0];
}

async function resolveBtiBetFrameIds(tabId) {
  const order = await orderBtiFrameIds(tabId);
  const scored = [];
  const frames = await getAllFrames(tabId);

  for (const frameId of order.slice(0, BTI_MAX_FRAMES)) {
    await ensureBtiScript(tabId, frameId);
    let probe = null;
    try {
      probe = await withTimeout(sendBti(tabId, frameId, { type: 'PROBE_BET_FRAME' }), 2500, 'BTI탐색');
    } catch (_) {}
    const frameUrl = frames.find((f) => f.frameId === frameId)?.url || '';
    let score = scoreBtiFrameUrl(frameUrl);
    if (probe?.hasInput) score += 500;
    if (probe?.hasBtn) score += 400;
    if (probe?.hasSlip) score += 200;
    if (probe?.slipOdds > 1) score += Math.min(probe.slipOdds, 50);
    if (probe?.hasInput && probe?.hasBtn) score += 300;
    if (score > 0) scored.push({ frameId, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const ids = scored.filter((s) => s.score >= 200).map((s) => s.frameId);
  return ids.length ? ids : order.slice(0, 4);
}

async function setBtiAmount(btiTab, amountKrw) {
  if (!btiTab?.id) return { ok: false, reason: '탭 없음' };
  const frameIds = await resolveBtiBetFrameIds(btiTab.id);
  for (const frameId of frameIds) {
    const res = await sendBti(btiTab.id, frameId, { type: 'SET_BTI_AMOUNT', amount: amountKrw });
    if (res?.ok) return res;
  }
  return { ok: false, reason: '텐텐뱃 금액 입력 실패 — 슬립 열기' };
}

async function prepBetAmounts(found, btiBetKrw, polyUsd) {
  const [btiRes, polyRes] = await Promise.all([
    setBtiAmount(found.btiTab, btiBetKrw),
    setPolyAmount(found.polyTab, polyUsd)
  ]);
  return { btiOk: !!btiRes?.ok, polyOk: !!polyRes?.ok, btiRes, polyRes };
}

async function injectPolyMain(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['polymarket_bet_main.js'],
      world: 'MAIN'
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function probePolyMain(tabId) {
  await injectPolyMain(tabId);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => (typeof window.__polyMainProbe === 'function' ? window.__polyMainProbe() : null)
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function prewarmTabs(btiTab, polyTab, hint, btiBetKrw, polyUsd) {
  const tasks = [];
  if (btiTab?.id) {
    tasks.push(ensureBtiScript(btiTab.id, btiSlipFrameId(btiTab.id)));
    if (hint) tasks.push(ensureBtiSlip(btiTab, hint).catch(() => null));
    if (btiBetKrw > 0) tasks.push(setBtiAmount(btiTab, btiBetKrw));
  }
  if (polyTab?.id) {
    tasks.push(ensurePolyScript(polyTab.id));
    tasks.push(injectPolyMain(polyTab.id));
    if (polyUsd > 0) tasks.push(setPolyAmount(polyTab, polyUsd));
  }
  await Promise.all(tasks);
}

async function placePolyBet(polyTab, amountUsd, opts = {}) {
  if (!polyTab?.id) return { success: false, reason: 'Polymarket 탭 없음' };
  const skipFill = !!opts.skipFill;

  await injectPolyMain(polyTab.id);

  const runMainBet = async (fast) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id },
      world: 'MAIN',
      func: async (amount, useFast) => {
        if (typeof window.__polyMainPlaceBet === 'function') {
          return await window.__polyMainPlaceBet(amount, { skipFill: useFast });
        }
        return { success: false, reason: 'MAIN 베팅 스크립트 로드 실패 — 탭 새로고침' };
      },
      args: [amountUsd, fast]
    });
    return results?.[0]?.result;
  };

  let lastErr = null;
  try {
    const res = await runMainBet(skipFill);
    if (res?.success) return res;
    lastErr = res;
    await setPolyAmount(polyTab, amountUsd);
    await new Promise((r) => setTimeout(r, 220));
    const retryRes = await runMainBet(false);
    if (retryRes?.success) return retryRes;
    lastErr = retryRes || res;
  } catch (e) {
    lastErr = { success: false, reason: `MAIN 베팅 실패: ${e.message}` };
  }

  await ensurePolyScript(polyTab.id);
  const fallback = await sendPoly(polyTab.id, { type: 'PLACE_BET', amount: amountUsd, skipFill });
  if (fallback?.success) return fallback;

  if (skipFill) {
    await setPolyAmount(polyTab, amountUsd);
    await new Promise((r) => setTimeout(r, 220));
    const fallbackFull = await sendPoly(polyTab.id, { type: 'PLACE_BET', amount: amountUsd, skipFill: false });
    if (fallbackFull?.success) return fallbackFull;
    return fallbackFull || fallback || lastErr || { success: false, reason: 'Polymarket 배팅 실패' };
  }

  return fallback || lastErr || { success: false, reason: 'Polymarket MAIN 응답 없음' };
}

function getBetCooldownMs() {
  const sec = parseInt($('betCooldown')?.value || '8', 10);
  return (Number.isFinite(sec) && sec >= 3 ? sec : 8) * 1000;
}

function setBetUiBusy(busy) {
  const btn = $('betNowBtn');
  if (btn) btn.disabled = !!busy;
}

async function getStrikeContext() {
  await refreshSlips();
  const found = await findTabs();
  if (!found.btiTab || !found.polyTab) {
    return { ok: false, reason: '텐텐뱃 + 예측 탭을 열어주세요' };
  }

  let arbBti = null;
  if (cachedPoly?.teamLabel) {
    arbBti = await readBtiArbOdds(found.btiTab, cachedPoly);
  }
  const polyO = cachedPoly?.odds > 1 ? cachedPoly.odds : null;
  const btiO = arbBti?.odds > 1 ? arbBti.odds : (cachedBti?.odds > 1 ? cachedBti.odds : null);
  if (!btiO || !polyO) {
    return {
      ok: false,
      reason: `배당 확인 — 텐텐뱃 ${btiO?.toFixed(3) || '-'} / ${leg2ShortLabel()} ${formatPolyOddsForHistory(cachedPoly)}`
    };
  }

  const btiBetKrw = await getBtiBetAmount(found.btiTab);
  const polyUsd = Math.max(1, calcPolyBetUsd(btiBetKrw, btiO, polyO, getUsdRate()));
  const profit = calcProfit(btiO, polyO);
  const hint = btiHintFromPoly(cachedPoly);
  const polyPreSynced = calcRunning
    && Math.abs(lastSyncedPolyUsd - polyUsd) < 0.08
    && Date.now() - lastSyncedPolyAt < 8000;

  return {
    ok: true,
    found,
    btiO,
    polyO,
    polyUsd,
    btiBetKrw,
    profit,
    hint,
    polyPreSynced
  };
}

async function strikeBothSides(ctx) {
  const { found, btiO, polyUsd, btiBetKrw, hint } = ctx;
  const t0 = performance.now();
  const lineOpts = {
    targetLine: cachedBti?.line,
    lineTolerance: cachedBti?.marketKind === 'ah' ? 0.05 : 0.15
  };

  try {
    await withTimeout(ensureBtiSlip(found.btiTab, hint), 8000, 'BTI 슬립 준비');
  } catch (e) {
    log(`텐텐뱃 슬립 준비: ${e.message}`, 'err');
  }

  await prewarmTabs(found.btiTab, found.polyTab, hint, btiBetKrw, polyUsd);
  await new Promise((r) => setTimeout(r, 200));

  const btiHint = { ...hint, skipEnsure: true, forceBet: true };
  log('① 텐텐뱃 배팅…', 'info');
  const btiRes = await withTimeout(
    placeBtiBet(found.btiTab, btiBetKrw, btiO || null, btiHint, lineOpts),
    35000,
    '텐텐뱃 배팅'
  ).catch((e) => ({ success: false, reason: e.message }));

  if (!btiRes?.success) {
    return {
      ok: false,
      btiRes,
      polyRes: { success: false, reason: '텐텐뱃 실패 — Polymarket 미실행' },
      elapsedMs: Math.round(performance.now() - t0)
    };
  }

  log('② 텐텐뱃 OK → Polymarket 배팅…', 'info');
  await setPolyAmount(found.polyTab, polyUsd);
  await new Promise((r) => setTimeout(r, 180));
  const polyRes = await withTimeout(
    placePolyBet(found.polyTab, polyUsd, { skipFill: false }),
    35000,
    'Polymarket 배팅'
  ).catch((e) => ({ success: false, reason: e.message }));

  if (btiRes?.success && !polyRes?.success) {
    log('⚠️ 텐텐뱃만 체결됨 — Polymarket 수동 확인 필요', 'err');
  }

  return {
    ok: !!(btiRes?.success && polyRes?.success),
    btiRes,
    polyRes,
    elapsedMs: Math.round(performance.now() - t0)
  };
}

async function executeBet(label, options = {}) {
  const isManual = label === '수동';
  const ignoreProfit = options.ignoreProfit != null
    ? options.ignoreProfit
    : (!!$('ignoreProfit')?.checked || isManual);
  if (betLock) {
    log('이미 배팅 진행 중', 'err');
    return;
  }
  const now = Date.now();
  if (now - lastBetAt < getBetCooldownMs()) {
    log('배팅 쿨다운 중', 'info');
    return;
  }

  betLock = true;
  setBetUiBusy(true);
  log(`⚡ ${label} 배팅 준비…`, 'info');

  try {
    const ctx = await getStrikeContext();
    if (!ctx.ok) {
      log(ctx.reason, 'err');
      const hint = $('betHint');
      if (hint) hint.textContent = ctx.reason;
      return;
    }

    if (!ignoreProfit && ctx.profit != null && ctx.profit < getMinProfit()) {
      log(`수익률 ${ctx.profit.toFixed(2)}% — 최소 ${getMinProfit()}% 미달 (배팅 취소)`, 'err');
      const hint = $('betHint');
      if (hint) hint.textContent = `수익 구간 밖 (${ctx.profit.toFixed(2)}%) — 배팅 안 함`;
      return;
    }

    log(
      `BTI ${ctx.btiO.toFixed(3)} · ${leg2ShortLabel()} ${ctx.polyO.toFixed(3)} · Poly $${ctx.polyUsd.toFixed(2)}`,
      'info'
    );
    const result = await strikeBothSides(ctx);
    lastBetAt = Date.now();

    const hint = $('betHint');
    if (result.ok) {
      log(`✓ 배팅 성공 ${result.elapsedMs}ms`, 'ok');
      log(`  BTI: ${result.btiRes?.btnText || 'OK'}`, 'ok');
      log(`  ${leg2FullLabel()}: ${result.polyRes?.btnText || result.polyRes?.method || 'OK'}`, 'ok');
      if (hint) hint.textContent = '배팅 완료';
      if (label === '자동') stopCalc();
      saveBetPrefs();
    } else {
      log(`✗ 텐텐뱃: ${result.btiRes?.reason || '실패'}`, 'err');
      const polyProbe = result.polyRes?.probe;
      const polyDetail = polyProbe
        ? ` (${polyProbe.btnText || 'no-btn'} stake=$${polyProbe.stake ?? '?'})`
        : '';
      log(`✗ ${leg2FullLabel()}: ${result.polyRes?.reason || '실패'}${polyDetail}`, 'err');
      if (hint) {
        if (result.btiRes?.success && !result.polyRes?.success) {
          hint.textContent = '⚠️ 텐텐뱃만 체결 — Poly 수동 확인';
        } else {
          hint.textContent = '배팅 실패 — 로그 확인';
        }
      }
    }
  } catch (e) {
    log(`배팅 오류: ${e.message}`, 'err');
  } finally {
    betLock = false;
    setBetUiBusy(false);
  }
}

function isAutoBetEnabled() {
  return calcRunning && !!$('autoBet')?.checked;
}

async function scheduleAutoBetCheck() {
  if (!isAutoBetEnabled()) return;
  if (autoBetScheduleTimer) clearTimeout(autoBetScheduleTimer);
  autoBetScheduleTimer = setTimeout(() => {
    autoBetScheduleTimer = null;
    checkProfitZoneAndBet();
  }, 200);
}

async function checkProfitZoneAndBet() {
  if (!isAutoBetEnabled() || betLock) return;
  if ($('ignoreProfit')?.checked) return;

  const found = await findTabs();
  let arbBti = null;
  if (cachedPoly?.teamLabel && found.btiTab) {
    arbBti = await readBtiArbOdds(found.btiTab, cachedPoly);
  }
  const polyO = cachedPoly?.odds > 1 ? cachedPoly.odds : null;
  const btiO = arbBti?.odds > 1 ? arbBti.odds : (cachedBti?.odds > 1 ? cachedBti.odds : null);
  const profit = (btiO && polyO) ? calcProfit(btiO, polyO) : null;
  const minP = getMinProfit();
  const betHint = $('betHint');

  if (cachedPoly?.pendingToWin) {
    const graceLeft = polySyncGraceUntil - Date.now();
    if (graceLeft > 0) {
      profitZoneSince = 0;
      if (betHint) betHint.textContent = 'Poly 금액 동기화 중 — 배당 안정화 대기';
      return;
    }
  }

  if (!btiO || !polyO || profit == null) {
    profitZoneSince = 0;
    if (betHint) betHint.textContent = '배당 모니터링 중…';
    return;
  }

  if (profit < minP) {
    profitZoneSince = 0;
    if (betHint) betHint.textContent = `모니터링 중 — 수익률 ${profit.toFixed(2)}% (최소 ${minP}%)`;
    return;
  }

  if (!profitZoneSince) profitZoneSince = Date.now();
  const waited = Date.now() - profitZoneSince;
  if (betHint) {
    betHint.textContent = waited >= PROFIT_ZONE_SETTLE_MS
      ? `⚡ 수익 구간 ${profit.toFixed(2)}% — 자동 배팅!`
      : `수익 구간 ${profit.toFixed(2)}% — ${((PROFIT_ZONE_SETTLE_MS - waited) / 1000).toFixed(1)}초 후 배팅`;
  }

  if (waited < PROFIT_ZONE_SETTLE_MS) {
    scheduleAutoBetCheck();
    return;
  }

  profitZoneSince = 0;
  executeBet('자동');
}

function maybeAutoBet(btiO, polyO, profit) {
  if (!isAutoBetEnabled() || betLock) return;
  if ($('ignoreProfit')?.checked) return;
  if (!btiO || !polyO || profit == null || profit < getMinProfit()) return;
  if (Date.now() - lastBetAt < getBetCooldownMs()) return;
  scheduleAutoBetCheck();
}

async function loadBetPrefs() {
  try {
    const data = await chrome.storage.local.get(BET_PREF_KEY);
    const prefs = data[BET_PREF_KEY] || {};
    if ($('autoBet')) $('autoBet').checked = prefs.autoBet !== false;
    if (prefs.cooldownSec != null && $('betCooldown')) $('betCooldown').value = String(prefs.cooldownSec);
  } catch (_) {
    if ($('autoBet')) $('autoBet').checked = true;
  }
}

function saveBetPrefs() {
  try {
    chrome.storage.local.set({
      [BET_PREF_KEY]: {
        autoBet: !!$('autoBet')?.checked,
        cooldownSec: parseInt($('betCooldown')?.value || '8', 10) || 8
      }
    });
  } catch (_) {}
}

async function setPolyAmount(polyTab, amountUsd) {
  if (!polyTab?.id) return { ok: false, reason: 'Polymarket 탭 없음' };
  await ensurePolyScript(polyTab.id);
  const res = await sendPoly(polyTab.id, { type: 'SET_POLY_AMOUNT', amount: amountUsd, force: true });
  return res || { ok: false, reason: '응답 없음' };
}

function scheduleSyncPolyAmount() {
  if (syncPolyTimer) clearTimeout(syncPolyTimer);
  syncPolyTimer = setTimeout(() => {
    syncPolyTimer = null;
    syncPolyAmount();
  }, 80);
}

async function syncPolyAmount() {
  if (syncPolyPending) return;

  const found = await findTabs();
  if (!found.polyTab?.id || !found.btiTab?.id) return;

  const polyO = cachedPoly?.odds > 1 ? cachedPoly.odds : null;
  if (!polyO) return;

  const btiArb = cachedPoly?.teamLabel ? await readBtiArbOdds(found.btiTab, cachedPoly) : null;
  const btiOdds = btiArb?.odds > 1 ? btiArb.odds : cachedBti?.odds;
  if (!btiOdds || btiOdds <= 1) return;

  const btiBet = calcRunning ? await getBtiBetAmount(found.btiTab) : getBtiBet();
  if (!btiBet) return;

  const polyUsd = Math.max(1, calcPolyBetUsd(btiBet, btiOdds, polyO, getUsdRate()));
  const teamChanged = cachedPoly?.teamSwitched;
  const stale = teamChanged || Math.abs(lastSyncedPolyUsd - polyUsd) >= 0.02 || Date.now() - lastSyncedPolyAt > 2500;
  if (!stale) {
    updateSlipUI(cachedBti, cachedPoly, btiArb);
    return;
  }

  syncPolyPending = true;
  polySyncGraceUntil = Date.now() + 1800;
  try {
    const res = await setPolyAmount(found.polyTab, polyUsd);
    if (res?.ok) {
      const changed = teamChanged || Math.abs(lastSyncedPolyUsd - polyUsd) >= 0.02;
      lastSyncedPolyUsd = polyUsd;
      lastSyncedPolyAt = Date.now();
      if (cachedPoly?.teamSwitched) delete cachedPoly.teamSwitched;
      updateSlipUI(cachedBti, cachedPoly, btiArb);
      if (changed) {
        const profit = calcProfit(btiOdds, polyO);
        log(`배당 갱신 — 텐텐뱃 ${btiOdds.toFixed(3)} · ${leg2ShortLabel()} ${formatPolyOddsForHistory(cachedPoly)} · 수익률 ${profit != null ? profit.toFixed(2) : '-'}%`, 'info');
      }
    } else if (res?.reason) {
      log(`${leg2FullLabel()} 금액 입력: ${res.reason}`, 'err');
    }
    scheduleAutoBetCheck();
  } finally {
    syncPolyPending = false;
  }
}

async function calcPollLoop() {
  if (!calcRunning) return;
  await refreshSlips();
  scheduleSyncPolyAmount();
  scheduleAutoBetCheck();
}

function onOddsChanged(msg) {
  if (msg.source === 'bti') applySlipUpdate('bti', msg.slip);
  if (isLeg2Source(msg.source)) applySlipUpdate(msg.source, msg.slip);
  scheduleSyncPolyAmount();
}

function onBtiStakeChanged(msg) {
  if (!calcRunning || !msg?.stake) return;
  const input = $('btiBet');
  if (input) input.value = String(msg.stake);
  scheduleSyncPolyAmount();
}

function startCalc() {
  if (calcRunning) return;
  calcRunning = true;
  lastSyncedPolyUsd = 0;
  lastSyncedPolyAt = 0;
  lastHistoryKey = '';
  profitZoneSince = 0;
  if ($('autoBet')) $('autoBet').checked = true;
  $('botStart').disabled = true;
  $('botStop').disabled = false;
  const betHint = $('betHint');
  if (betHint) betHint.textContent = '배당 모니터링 중 — 수익 구간 시 자동 배팅';
  log('모니터링·자동배팅 시작 — 수익 구간 감지 시 배팅', 'strike');
  saveBetPrefs();
  refreshSlips().then(() => {
    scheduleSyncPolyAmount();
    scheduleAutoBetCheck();
  });
  calcTimer = setInterval(calcPollLoop, 400);
}

function stopCalc() {
  calcRunning = false;
  profitZoneSince = 0;
  if (autoBetScheduleTimer) {
    clearTimeout(autoBetScheduleTimer);
    autoBetScheduleTimer = null;
  }
  if (calcTimer) { clearInterval(calcTimer); calcTimer = null; }
  if (syncPolyTimer) { clearTimeout(syncPolyTimer); syncPolyTimer = null; }
  $('botStart').disabled = false;
  $('botStop').disabled = true;
  log('계산 정지', 'info');
}

function renderSearchResults(data) {
  const el = $('searchResults');
  const stats = $('searchStats');
  if (!data) return;

  const s = data.stats || {};
  const leg2Name = s.leg2Source || s.leg2Site || '예측';
  const leg2Pref = s.leg2Pref || getLeg2Pref();
  const btiOk = s.btiTabFound ? 'O' : 'X';
  const leg2TabOk = s.polyTabFound ? 'O' : 'X';
  stats.textContent = `텐텐뱃 ${s.btiTotal || 0}경기 · ${leg2Name} ${s.polyTotal || 0}경기 · 팀매칭 ${s.pairsMatched || 0} · 수익 ${s.matched || 0}건 (A:${btiOk} / B:${leg2TabOk})`;

  el.innerHTML = '';
  const minP = parseFloat($('minProfit')?.value || '1');
  const opps = (data.opportunities || []).filter((o) => parseFloat(o.profit) >= minP);
  const leg2Short = leg2Pref === 'bcgame' ? 'BC' : (leg2Pref === 'polymarket' ? '폴리' : 'B');

  if (!opps.length) {
    let hint = '조건 충족 기회 없음 — 팀명 매칭/최소 수익률 확인';
    if (!s.btiTabFound) {
      hint = '왼쪽(A) 텐텐뱃: x10x10s.com 스포츠 탭을 열어주세요';
    } else if ((s.btiTotal || 0) === 0) {
      hint = '텐텐뱃 경기 0건 — 스포츠 배당판을 열거나 라이브/프리매치 탭 확인';
    } else if (s.leg2ApiError) {
      hint = `오른쪽(B) ${leg2PrefLabel(leg2Pref)} API 오류: ${s.leg2ApiError}`;
    } else if ((s.polyTotal || 0) === 0) {
      hint = `오른쪽(B) ${leg2PrefLabel(leg2Pref)} 경기 데이터 없음 — 확장 새로고침 후 재시도`;
    } else if ((s.pairsMatched || 0) > 0) {
      hint = `팀 매칭 ${s.pairsMatched}건 있으나 수익 ${minP}% 이상 없음 — 최소 수익률을 낮춰보세요`;
    } else if (!s.polyTabFound && (leg2Pref === 'bcgame' || leg2Pref === 'polymarket')) {
      hint = `서치 데이터 ${s.polyTotal}경기 로드됨 (탭 없음) — 슬립 비교는 ${leg2PrefLabel(leg2Pref)} 탭 필요`;
    } else if ((s.btiTotal || 0) > 0 && (s.polyTotal || 0) > 0) {
      hint = `텐텐뱃 ${s.btiTotal}경기 · ${leg2Name} ${s.polyTotal}경기 — 팀명 매칭 실패 (종목/팀명 확인)`;
    }
    el.innerHTML = `<div class="hint" style="padding:12px">${hint}</div>`;
    return;
  }

  for (const o of opps.slice(0, IS_PANEL ? 80 : 40)) {
    const div = document.createElement('div');
    div.className = 'opp';
    div.innerHTML = `<strong>${o.home} vs ${o.away}</strong><br>
      ${leg2Short} <b>${o.polyTeam}</b> ${o.polyOdds} · 텐텐뱃 ${o.btiSide} ${o.btiOdds}
      <span class="profit-tag"> → ${o.profit}%</span>`;
    el.appendChild(div);
  }
}

function startSearch() {
  const leg2Pref = getLeg2Pref();
  chrome.runtime.sendMessage({ type: 'START_SEARCH', leg1Site: 'bti', leg2Site: leg2Pref }, (res) => {
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
  chrome.runtime.sendMessage({ type: 'STOP_SEARCH' }, () => {
    $('searchStart').disabled = false;
    $('searchStop').disabled = true;
    log('서치 정지', 'info');
  });
}

function bindUi() {
  document.querySelector('nav.tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn?.dataset?.tab) return;
    e.preventDefault();
    switchTab(btn.dataset.tab);
  });

  try {
    const savedTab = sessionStorage.getItem('arbActiveTab');
    if (savedTab === 'slip' || savedTab === 'search') switchTab(savedTab);
  } catch (_) {}

  $('botStart')?.addEventListener('click', startCalc);
  $('botStop')?.addEventListener('click', stopCalc);
  $('betNowBtn')?.addEventListener('click', () => executeBet('수동'));
  $('autoBet')?.addEventListener('change', saveBetPrefs);
  $('betCooldown')?.addEventListener('change', saveBetPrefs);
  $('clearHistoryBtn')?.addEventListener('click', clearHistory);
  $('searchStart')?.addEventListener('click', startSearch);
  $('searchStop')?.addEventListener('click', stopSearch);
  $('openPanelBtn')?.addEventListener('click', openPanel);
  $('openPanelFromSearch')?.addEventListener('click', openPanel);
  $('refreshBtn')?.addEventListener('click', () => { refreshSlips(); log('새로고침', 'info'); });
  ['slipMinProfit', 'minProfit', 'btiBet', 'usdRate'].forEach((id) => {
    $(id)?.addEventListener('input', () => {
      lastSyncedPolyUsd = 0;
      updateSlipUI(cachedBti, cachedPoly);
      scheduleSyncPolyAmount();
    });
  });

  $('diagBtn')?.addEventListener('click', async () => {
    log('진단...', 'info');
    const found = await findTabs();
    log(`텐텐뱃: ${found.btiTab ? `탭 OK #${found.btiTab.id}` : '탭 없음'}`, found.btiTab ? 'ok' : 'err');
    log(`Polymarket/BC.Game: ${found.polyTab ? `${leg2SiteLabel(found.polyTab.url)} 탭 OK` : '탭 없음'}`, found.polyTab ? 'ok' : 'err');
    if (found.polyTab) {
      const probe = await probePolyMain(found.polyTab.id);
      if (probe) {
        log(`Poly MAIN: Buy버튼${probe.hasBuyBtn ? 'O' : 'X'}${probe.btnText ? ` "${probe.btnText}"` : ''}`, probe.hasBuyBtn ? 'ok' : 'err');
      }
      await ensurePolyScript(found.polyTab.id);
      const probeIso = await sendPoly(found.polyTab.id, { type: 'PROBE_POLY' });
      if (probeIso?.probe) {
        const p = probeIso.probe;
        log(`Poly UI: 패널${p.hasPanel ? 'O' : 'X'} 금액$${p.stake ?? '?'}`, p.hasPanel ? 'info' : 'err');
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
  });

  setInterval(() => {
    refreshSlips().then(() => {
      if (calcRunning) scheduleSyncPolyAmount();
    });
  }, FALLBACK_REFRESH_MS);
}

async function bootApp() {
  bindUi();
  await Promise.all([loadHistory(), loadSitePrefs(), loadBetPrefs()]);
  bindSitePrefSelectors();
  updateLeg2UiLabels();
  await refreshSlips();
  log(`v6.2.0 ${IS_PANEL ? '패널' : '팝업'} — 배당서치 강화`, 'info');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { bootApp().catch((e) => log(`초기화 오류: ${e.message}`, 'err')); });
} else {
  bootApp().catch((e) => log(`초기화 오류: ${e.message}`, 'err'));
}
