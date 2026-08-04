// popup.js v5.7.0 — 텐텐뱃 + BC.Game

'use strict';

const POLL_MS = 16;
const FALLBACK_REFRESH_MS = 800;
const BTI_FULL_SCAN_MS = 2500;
const AUTO_BET_COOLDOWN_MS = 6000;
const IS_PANEL = document.body.classList.contains('panel-mode');
let syncRunning = false;
let autoBetRunning = false;
let calcTimer = null;
let syncTimer = null;
let syncPending = false;
let autoBetTimer = null;
let strikePending = false;
let lastStrikeAt = 0;
let lastSyncedBtiKrw = 0;
let lastSyncedPolyUsd = 0;
let lastSyncedAt = 0;
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
let cachedUsdtRate = 1400;
let cachedUsdtSource = 'manual';
let usdtRateTimer = null;

function formatPolyOddsForHistory(slip) {
  if (!slip?.odds || slip.odds <= 1) return '-';
  if (slip.fromPayout) return slip.odds.toFixed(3);
  if (slip.priceCents != null) return `${slip.priceCents}¢ (${slip.odds.toFixed(3)})`;
  return slip.odds.toFixed(3);
}

function formatHistoryLine(bti, poly, arbBti, profit) {
  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = (arbBti?.odds > 1) ? arbBti.odds : (bti?.odds > 1 ? bti.odds : null);
  const team = poly?.teamLabel || formatBtiMeta(bti) || '경기';
  const profitText = profit != null ? `${profit.toFixed(2)}%` : '-';
  return `${team} · 텐텐뱃 ${btiO?.toFixed(3) || '-'} · BC ${formatPolyOddsForHistory(poly)} · 수익률 ${profitText}`;
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
  if (!syncRunning && !autoBetRunning) return;
  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = (arbBti?.odds > 1) ? arbBti.odds : (bti?.odds > 1 ? bti.odds : null);
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
  if ((syncRunning || autoBetRunning) && btiTab?.id) {
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
  updateSlipUI(cachedBti, cachedPoly);
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

function updateSlipUI(bti, poly, arbBti = null) {
  $('btiOdds').textContent = formatOdds(bti);
  $('polyOdds').textContent = formatOdds(poly);
  $('btiMeta').textContent = formatBtiMeta(bti);
  $('polyMeta').textContent = formatPolyMeta(poly);

  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = ((syncRunning || autoBetRunning) && arbBti?.odds > 1) ? arbBti.odds : (bti?.odds > 1 ? bti.odds : null);
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
  if (!bti?.odds) hint.textContent = lastStatus.bti || '텐텐뱃: x10x10s 슬립/배당판 확인';
  else if (!poly?.odds) hint.textContent = lastStatus.poly || 'BC.Game: 슬립/배당 확인';
  else if (poly?.needsStake) hint.textContent = (syncRunning || autoBetRunning) ? '금액 동기화 중...' : '금액 입력 시 당첨금 기준 배당';
  else if (profit !== null && profit >= getMinProfit()) {
    if (autoBetRunning) hint.textContent = `자동 배팅 대기 — 수익 ${profit.toFixed(2)}% (최소 ${getMinProfit()}%)`;
    else if (syncRunning) hint.textContent = `수익 구간 — 금액 동기화 중 (${profit.toFixed(2)}%)`;
    else hint.textContent = `수익 구간 충족 (${profit.toFixed(2)}%) — 자동 배팅 시작 가능`;
  }
  else if (profit !== null) hint.textContent = `수익 구간 밖 (최소 ${getMinProfit()}%)`;
  else hint.textContent = '배당 확인 중...';

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

async function ensurePolyScript(tabId, frameId = null) {
  const key = frameId != null ? `${tabId}:${frameId}` : String(tabId);
  if (polyScriptReady.has(key)) return;
  const mainFiles = ['bc_api_hook.js', 'bc_sports_scrape.js', 'bc_board_scrape.js'];
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
    polyScriptReady.add(key);
    if (frameId == null) polyScriptReady.add(String(tabId));
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['bc_content.js'] });
      polyScriptReady.add(String(tabId));
    } catch (_2) {}
  }
}

async function injectReadBcSports(tabId, frameId = 0) {
  try {
    await ensurePolyScript(tabId, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => {
        try {
          if (typeof window.__bcScrapeOdds === 'function') {
            const r = window.__bcScrapeOdds();
            if (r && (r.odds > 1.01 || (r.ok && r.odds > 1.01))) {
              const odds = r.odds;
              const team = r.teamLabel || r.selectionText || r.outcome || '';
              const stake = r.stake > 0 ? r.stake : null;
              const payout = r.payout > 0 ? r.payout : null;
              return {
                source: 'bcgame',
                odds,
                teamLabel: team,
                outcome: team,
                selectionText: r.selectionText || team,
                displayLabel: r.displayLabel || `${odds.toFixed(3)}${stake ? ` · ${stake} USDT` : ''}`,
                stake,
                payout,
                fromPayout: !!r.fromPayout || (stake > 0 && payout > stake),
                fromSlip: true,
                sourceKind: r.sourceKind || 'sports-slip',
                marketKind: 'ml'
              };
            }
          }
          if (window.__bcApiSlip?.odds > 1.01) {
            const r = window.__bcApiSlip;
            return {
              source: 'bcgame',
              odds: r.odds,
              teamLabel: r.teamLabel || '',
              fromPayout: !!r.fromPayout,
              fromSlip: true,
              sourceKind: 'bc-api',
              marketKind: 'ml'
            };
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

async function readPolySlipAllFrames(bcTab) {
  const order = await orderBcFrames(bcTab.id);
  const seen = new Set();
  let best = null;

  for (const frameId of order) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    await ensurePolyScript(bcTab.id, frameId);
    const res = await sendPoly(bcTab.id, { type: 'READ_SLIP' }, frameId);
    let slip = res?.slip;
    if (!slip?.odds && !slip?.fromPayout) {
      const injected = await injectReadBcSports(bcTab.id, frameId);
      if (injected?.odds > 1) slip = injected;
    }
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

async function injectReadPoly(tabId) {
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
    polyTab: bcTab ? { id: bcTab.id, url: bcTab.url } : null
  };
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

async function readPolySlip(polyTab) {
  if (!polyTab?.id) {
    lastStatus.poly = 'BC.Game: 탭 없음 — bc.game/sports 열기';
    return null;
  }

  await ensurePolyScript(polyTab.id);

  let slip = await readPolySlipAllFrames(polyTab);

  if (!slip?.fromPayout) {
    const injected = await injectReadPoly(polyTab.id);
    if (injected?.fromPayout) slip = { ...slip, ...injected };
  }

  if (slip?.fromPayout) {
    lastStatus.poly = '';
    return slip;
  }

  if (slip?.odds > 1) {
    lastStatus.poly = slip.needsStake ? 'BC.Game: 금액 입력 필요' : '';
    return slip;
  }

  if (slip?.needsStake) {
    lastStatus.poly = 'BC.Game: 금액 입력 후 배당 확인';
    return slip;
  }

  lastStatus.poly = 'BC.Game: 스포츠 배당 클릭 또는 예측 팀 선택';
  return slip || null;
}

function slipOdds(slip) {
  if (!slip) return null;
  if (slip.odds > 1 && slip.odds <= 50) return slip.odds;
  if (slip.priceCents >= 1 && slip.priceCents < 100) return 100 / slip.priceCents;
  return null;
}

function mergeSlipCached(cached, fresh) {
  if (!fresh || !slipOdds(fresh)) return cached?.fromPayout ? cached : null;
  const freshOdds = slipOdds(fresh);
  if (!cached) return { ...fresh, odds: freshOdds };
  if (fresh.fromPayout && !cached.fromPayout) return { ...fresh, odds: freshOdds };
  if (cached.fromPayout && !fresh.fromPayout) return { ...cached, odds: slipOdds(cached) };
  if (cached.teamLabel && fresh.teamLabel && cached.teamLabel !== fresh.teamLabel) {
    return { ...fresh, odds: freshOdds };
  }
  return { ...cached, ...fresh, odds: freshOdds };
}

function applySlipUpdate(source, slip) {
  if (source === 'bti') {
    cachedBti = slipOdds(slip) ? mergeSlipCached(cachedBti, slip) : null;
  }
  if (source === 'polymarket' || source === 'bcgame') {
    cachedPoly = slipOdds(slip) ? mergeSlipCached(cachedPoly, slip) : null;
  }
  updateSlipUI(cachedBti, cachedPoly);
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

    cachedPoly = mergeSlipCached(cachedPoly, poly);
    cachedBti = mergeSlipCached(cachedBti, bti);

    let arbBti = null;
    if ((syncRunning || autoBetRunning) && cachedPoly?.teamLabel && found.btiTab) {
      arbBti = await readBtiArbOdds(found.btiTab, cachedPoly);
    }

    updateSlipUI(cachedBti, cachedPoly, arbBti);
    return { bti: cachedBti, poly: cachedPoly, btiTab: found.btiTab, polyTab: found.polyTab };
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

async function placeBcSportsBetMain(tabId, frameId, amountUsd) {
  try {
    await ensurePolyScript(tabId, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: async (amount) => {
        const rounded = Math.max(0.01, Math.round(amount * 100) / 100);
        if (typeof window.__bcPlaceSportsBet === 'function') {
          return await window.__bcPlaceSportsBet(rounded);
        }
        return null;
      },
      args: [amountUsd]
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function placePolyBet(polyTab, amountUsd, opts = {}) {
  if (!polyTab?.id) return { success: false, reason: 'BC.Game 탭 없음' };
  await ensurePolyScript(polyTab.id);
  const frames = await getAllFrames(polyTab.id);
  const order = [0, ...frames.map((f) => f.frameId).filter((id) => id !== 0)];
  const seen = new Set();

  const sportsPromises = [];
  for (const frameId of order) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    sportsPromises.push(placeBcSportsBetMain(polyTab.id, frameId, amountUsd));
  }
  const sportsResults = await Promise.all(sportsPromises);
  const sportsHit = sportsResults.find((r) => r?.success);
  if (sportsHit) return sportsHit;

  const res = await sendPoly(polyTab.id, {
    type: 'PLACE_BET',
    amount: amountUsd,
    skipFill: !!opts.skipFill,
    teamHint: cachedPoly?.teamLabel || ''
  });
  return res || { success: false, reason: '응답 없음' };
}

async function orderBcFrames(tabId) {
  const frames = await getAllFrames(tabId);
  const sorted = [...frames].sort((a, b) => scoreBcFrameUrl(b.url) - scoreBcFrameUrl(a.url));
  const order = sorted.map((f) => f.frameId);
  if (!order.includes(0)) order.unshift(0);
  return [...new Set(order)];
}

function scoreBcFrameUrl(url) {
  if (!url) return 0;
  if (/betby\.com|sptpub\.com|sptsportscdn|biahosted|cocoesports/i.test(url)) return 100;
  if (/bc\.game/i.test(url) && /sports/i.test(url)) return 80;
  return 5;
}

async function setBcStakeMain(tabId, frameId, amountUsd) {
  try {
    await ensurePolyScript(tabId, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: async (amount) => {
        const rounded = Math.max(0.01, Math.round(amount * 100) / 100);
        if (typeof window.__bcSetStake === 'function') {
          const res = await window.__bcSetStake(rounded);
          if (res?.ok || res?.partial) return res;
        }
        return null;
      },
      args: [amountUsd]
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function setPolyAmount(polyTab, amountUsd) {
  if (!polyTab?.id) return { ok: false, reason: 'BC.Game 탭 없음' };
  await ensurePolyScript(polyTab.id);
  const order = await orderBcFrames(polyTab.id);
  let lastRes = null;

  const mainTries = await Promise.all(
    order.slice(0, 10).map(async (frameId) => {
      const res = await setBcStakeMain(polyTab.id, frameId, amountUsd);
      return { frameId, res };
    })
  );
  for (const { res } of mainTries) {
    if (res?.ok) return res;
    if (res?.stake > 0) lastRes = res;
  }

  for (const frameId of order) {
    const res = await sendPoly(polyTab.id, { type: 'SET_POLY_AMOUNT', amount: amountUsd, force: true }, frameId);
    if (res?.ok) return res;
    if (res?.stake > 0 || res?.partial) lastRes = res;
  }
  return lastRes || { ok: false, reason: '금액 입력 실패 — BC 슬립 선택 후 재시도' };
}

function scheduleSyncAmounts() {
  if (!syncRunning && !autoBetRunning) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncAmounts();
  }, 80);
}

async function syncAmounts(force = false) {
  if ((!syncRunning && !autoBetRunning) || syncPending) return;

  const found = await findTabs();
  if (!found.polyTab?.id || !found.btiTab?.id) return;

  const polyO = cachedPoly?.odds > 1 ? cachedPoly.odds : null;
  if (!polyO) return;

  const btiArb = cachedPoly?.teamLabel ? await readBtiArbOdds(found.btiTab, cachedPoly) : null;
  const btiOdds = btiArb?.odds > 1 ? btiArb.odds : cachedBti?.odds;
  if (!btiOdds || btiOdds <= 1) return;

  const btiBet = getBtiBet();
  if (!btiBet) return;

  await refreshBithumbRate();
  const polyUsd = calcPolyBetUsd(btiBet, btiOdds, polyO, getUsdRate());
  const btiChanged = Math.abs(lastSyncedBtiKrw - btiBet) >= 100;
  const polyChanged = Math.abs(lastSyncedPolyUsd - polyUsd) >= 0.02;
  if (!force && !btiChanged && !polyChanged && Date.now() - lastSyncedAt < 2500) {
    updateSlipUI(cachedBti, cachedPoly, btiArb);
    return;
  }

  syncPending = true;
  try {
    const [btiRes, polyRes] = await Promise.all([
      setBtiAmount(found.btiTab, btiBet),
      setPolyAmount(found.polyTab, polyUsd)
    ]);
    const btiOk = btiRes?.ok;
    const polyOk = polyRes?.ok || polyRes?.partial;
    if (btiOk || polyOk) {
      const changed = btiChanged || polyChanged;
      if (btiOk) lastSyncedBtiKrw = btiBet;
      if (polyOk) lastSyncedPolyUsd = polyUsd;
      lastSyncedAt = Date.now();
      setTimeout(() => refreshSlips().then(() => {
        updateSlipUI(cachedBti, cachedPoly, btiArb);
      }), 250);
      if (changed && syncRunning) {
        const profit = calcProfit(btiOdds, polyO);
        log(`금액 동기화 — 텐텐뱃 ${btiBet.toLocaleString()}원 · BC $${polyUsd.toFixed(2)} · 수익률 ${profit != null ? profit.toFixed(2) : '-'}%`, 'info');
      }
    } else {
      const reasons = [];
      if (!btiOk) reasons.push(`텐텐뱃: ${btiRes?.reason || '실패'}`);
      if (!polyOk) reasons.push(`BC: ${polyRes?.reason || '실패'}`);
      if (reasons.length) log(`금액 동기화: ${reasons.join(' / ')}`, 'err');
    }
  } finally {
    syncPending = false;
  }
}

function scheduleAutoBetCheck() {
  if (!autoBetRunning) return;
  if (autoBetTimer) clearTimeout(autoBetTimer);
  autoBetTimer = setTimeout(() => {
    autoBetTimer = null;
    tryAutoBet();
  }, 30);
}

function polyOLabel() {
  return cachedPoly?.odds > 1 ? formatPolyOddsForHistory(cachedPoly) : '-';
}

async function tryAutoBet() {
  if (!autoBetRunning || strikePending) return;
  if (Date.now() - lastStrikeAt < AUTO_BET_COOLDOWN_MS) return;

  const polyO = cachedPoly?.odds > 1 ? cachedPoly.odds : null;
  if (!polyO) return;

  const found = await findTabs();
  if (!found.polyTab?.id || !found.btiTab?.id) return;

  const btiArb = cachedPoly?.teamLabel ? await readBtiArbOdds(found.btiTab, cachedPoly) : null;
  const btiOdds = btiArb?.odds > 1 ? btiArb.odds : cachedBti?.odds;
  if (!btiOdds || btiOdds <= 1) return;

  const profit = calcProfit(btiOdds, polyO);
  if (profit == null || profit < getMinProfit()) return;

  const btiBet = getBtiBet();
  const polyUsd = calcPolyBetUsd(btiBet, btiOdds, polyO, getUsdRate());
  if (Math.abs(lastSyncedBtiKrw - btiBet) >= 100 || Math.abs(lastSyncedPolyUsd - polyUsd) >= 0.02) {
    await syncAmounts(true);
    return;
  }

  await strikeBothBets(found, btiBet, polyUsd, btiOdds, btiArb);
}

async function strikeBothBets(found, btiBet, polyUsd, btiOdds, btiArb) {
  if (strikePending) return;
  strikePending = true;
  const hint = {
    excludeTeam: cachedPoly?.teamLabel,
    polyTeam: cachedPoly?.teamLabel,
    skipEnsure: true
  };
  log(`동시 배팅 — 텐텐뱃 ${btiOdds.toFixed(3)} · BC ${polyOLabel()} · ${btiBet.toLocaleString()}원 / $${polyUsd.toFixed(2)}`, 'info');

  try {
    const [btiRes, polyRes] = await Promise.all([
      placeBtiBet(found.btiTab, btiBet, btiOdds, hint),
      placePolyBet(found.polyTab, polyUsd, { skipFill: true })
    ]);

    if (btiRes?.success && polyRes?.success) {
      lastStrikeAt = Date.now();
      log('동시 배팅 성공', 'ok');
      stopAutoBet();
    } else {
      const parts = [];
      if (!btiRes?.success) parts.push(`텐텐뱃: ${btiRes?.reason || '실패'}`);
      if (!polyRes?.success) parts.push(`BC: ${polyRes?.reason || '실패'}`);
      log(`동시 배팅 실패 — ${parts.join(' / ')}`, 'err');
    }
  } finally {
    strikePending = false;
    setTimeout(() => refreshSlips().then(() => updateSlipUI(cachedBti, cachedPoly, btiArb)), 400);
  }
}

async function pollLoop() {
  if (!syncRunning && !autoBetRunning) return;
  await refreshSlips();
  scheduleSyncAmounts();
  scheduleAutoBetCheck();
}

function onOddsChanged(msg) {
  if (msg.source === 'bti') applySlipUpdate('bti', msg.slip);
  if (msg.source === 'polymarket' || msg.source === 'bcgame') applySlipUpdate('polymarket', msg.slip);
  if (!syncRunning && !autoBetRunning) return;
  scheduleSyncAmounts();
  scheduleAutoBetCheck();
}

function onBtiStakeChanged(msg) {
  if ((!syncRunning && !autoBetRunning) || !msg?.stake) return;
  const input = $('btiBet');
  if (input) input.value = String(msg.stake);
  scheduleSyncAmounts();
}

function startSync() {
  if (syncRunning) return;
  syncRunning = true;
  lastSyncedBtiKrw = 0;
  lastSyncedPolyUsd = 0;
  lastSyncedAt = 0;
  $('syncStart').disabled = true;
  $('syncStop').disabled = false;
  log('금액 동기화 시작 — 텐텐뱃·BC 슬립 실시간 입력', 'info');
  refreshBithumbRate().then(() => refreshSlips().then(() => scheduleSyncAmounts()));
  if (!calcTimer) calcTimer = setInterval(pollLoop, 400);
}

function stopSync() {
  syncRunning = false;
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  $('syncStart').disabled = false;
  $('syncStop').disabled = true;
  if (!autoBetRunning && calcTimer) {
    clearInterval(calcTimer);
    calcTimer = null;
  }
  log('금액 동기화 정지', 'info');
}

function startAutoBet() {
  if (autoBetRunning) return;
  autoBetRunning = true;
  lastStrikeAt = 0;
  lastHistoryKey = '';
  $('autoBetStart').disabled = true;
  $('autoBetStop').disabled = false;
  log(`자동 배팅 시작 — 수익 ${getMinProfit()}% 이상 시 동시 즉시 배팅`, 'info');
  if (!syncRunning) startSync();
  else refreshSlips().then(() => scheduleAutoBetCheck());
  if (!calcTimer) calcTimer = setInterval(pollLoop, 400);
}

function stopAutoBet() {
  autoBetRunning = false;
  if (autoBetTimer) { clearTimeout(autoBetTimer); autoBetTimer = null; }
  $('autoBetStart').disabled = false;
  $('autoBetStop').disabled = true;
  if (!syncRunning && calcTimer) {
    clearInterval(calcTimer);
    calcTimer = null;
  }
  log('자동 배팅 정지', 'info');
}

function renderSearchResults(data) {
  const el = $('searchResults');
  const stats = $('searchStats');
  if (!data) return;

  const s = data.stats || {};
  const btiSrc = s.btiSource === 'dom' ? ' · DOM' : (s.btiSource === 'api' ? ' · API' : '');
  stats.textContent = `텐텐뱃 ${s.btiTotal || 0}경기${btiSrc} · BC ${s.bcTotal || s.polyTotal || 0}경기 · 매칭 ${s.matched || 0}건 (BTI ${s.btiTabFound ? 'O' : 'X'} / BC ${(s.bcTabFound || s.polyTabFound) ? 'O' : 'X'})`;
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
  chrome.runtime.sendMessage({ type: 'STOP_SEARCH' }, () => {
    $('searchStart').disabled = false;
    $('searchStop').disabled = true;
    log('서치 정지', 'info');
  });
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

$('syncStart')?.addEventListener('click', startSync);
$('syncStop')?.addEventListener('click', stopSync);
$('autoBetStart')?.addEventListener('click', startAutoBet);
$('autoBetStop')?.addEventListener('click', stopAutoBet);
$('clearHistoryBtn')?.addEventListener('click', clearHistory);
$('searchStart')?.addEventListener('click', startSearch);
$('searchStop')?.addEventListener('click', stopSearch);
$('openPanelBtn')?.addEventListener('click', openPanel);
$('openPanelFromSearch')?.addEventListener('click', openPanel);
$('refreshBtn')?.addEventListener('click', () => { refreshSlips(); log('새로고침', 'info'); });
['slipMinProfit', 'minProfit', 'btiBet'].forEach((id) => {
  $(id)?.addEventListener('input', () => {
    updateSlipUI(cachedBti, cachedPoly);
    if (syncRunning || autoBetRunning) scheduleSyncAmounts();
  });
});

$('diagBtn')?.addEventListener('click', async () => {
  log('진단...', 'info');
  const found = await findTabs();
  log(`텐텐뱃: ${found.btiTab ? `탭 OK frame#${found.btiTab.frameId}` : '탭 없음'}`, found.btiTab ? 'ok' : 'err');
  log(`BC.Game: ${found.polyTab ? '탭 OK' : '탭 없음'}`, found.polyTab ? 'ok' : 'err');
  if (found.polyTab) {
    await ensurePolyScript(found.polyTab.id);
    const probeIso = await sendPoly(found.polyTab.id, { type: 'PROBE_POLY' });
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
});

setInterval(() => {
  refreshSlips().then(() => {
    if (syncRunning || autoBetRunning) {
      scheduleSyncAmounts();
      scheduleAutoBetCheck();
    }
  });
}, FALLBACK_REFRESH_MS);
loadHistory();
startBithumbRateLoop();
refreshSlips();
log(`v5.7.2 ${IS_PANEL ? '패널' : '팝업'} 로드 — BC 스포츠 서치/금액동기화`, 'info');
