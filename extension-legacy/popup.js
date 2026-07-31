// popup.js v5.7.0 — 텐텐뱃 + Polymarket / BC.Game

'use strict';

const POLL_MS = 16;
const FALLBACK_REFRESH_MS = 800;
const BTI_FULL_SCAN_MS = 2500;
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

function formatPolyOddsForHistory(slip) {
  if (!slip?.odds || slip.odds <= 1) return '-';
  if (slip.fromPayout) return slip.odds.toFixed(3);
  if (slip.priceCents != null) return `${slip.priceCents}¢ (${slip.odds.toFixed(3)})`;
  return slip.odds.toFixed(3);
}

let cachedLeg2Url = null;

function leg2ShortLabel() {
  return leg2SiteShort(cachedLeg2Url) || '폴리';
}

function leg2FullLabel() {
  return leg2SiteLabel(cachedLeg2Url) || 'Polymarket';
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
  if (!bti?.odds) hint.textContent = lastStatus.bti || '텐텐뱃: x10x10s 슬립/배당판 확인';
  else if (!poly?.odds) hint.textContent = lastStatus.poly || `${leg2FullLabel()}: Amount 입력 후 To win 확인`;
  else if (poly?.needsStake) hint.textContent = calcRunning ? `${leg2FullLabel()} Amount 입력 대기...` : 'Amount 입력 시 당첨금 기준 배당';
  else if (profit !== null && profit >= getMinProfit()) hint.textContent = calcRunning ? `수익 구간 — ${leg2FullLabel()} 금액 자동 갱신 (${profit.toFixed(2)}%)` : '수익 구간 충족';
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

function sendPoly(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
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

async function ensurePolyScript(tabId) {
  if (polyScriptReady.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['polymarket_content.js']
    });
    polyScriptReady.add(tabId);
  } catch (_) {}
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

async function findTabs() {
  const tabs = await chrome.tabs.query({});
  let btiTab = null;
  const leg2Tabs = [];

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (isLeg2PredictionUrl(tab.url)) leg2Tabs.push(tab);
    if (isWrapperUrl(tab.url) && !btiTab) btiTab = tab;
  }

  let polyTab = null;
  let bestScore = -1;
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = activeTabs[0]?.id;

  for (const t of leg2Tabs) {
    let score = 0;
    if (isLeg2EventUrl(t.url)) score += 20;
    if (/predictions/i.test(t.url || '')) score += 5;
    if (t.id === activeId) score += 15;
    if (score > bestScore) {
      bestScore = score;
      polyTab = t;
    }
  }

  if (polyTab?.url) cachedLeg2Url = polyTab.url;
  updateLeg2UiLabels();

  if (btiTab) {
    btiTab = {
      id: btiTab.id,
      url: btiTab.url,
      frameId: lastBtiFrame?.tabId === btiTab.id ? lastBtiFrame.frameId : 0
    };
  }

  return {
    btiTab,
    polyTab: polyTab ? { id: polyTab.id, url: polyTab.url } : null
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
  const leg2Label = leg2SiteLabel(polyTab?.url);
  if (!polyTab?.id) {
    lastStatus.poly = `${leg2FullLabel()}: 탭 없음 — Polymarket 또는 BC.Game 예측 페이지 열기`;
    return null;
  }

  cachedLeg2Url = polyTab.url;
  updateLeg2UiLabels();

  await ensurePolyScript(polyTab.id);

  let slip = null;
  const res = await sendPoly(polyTab.id, { type: 'READ_SLIP' });
  if (res?.slip) slip = res.slip;

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
    lastStatus.poly = slip.needsStake ? `${leg2Label}: Amount 입력 필요` : '';
    return slip;
  }

  const apiSlip = await readPolySlipFromApi(polyTab);
  if (apiSlip?.odds > 1 && !slip) {
    lastStatus.poly = 'Amount 입력 시 당첨금 기준 배당으로 전환';
    return apiSlip;
  }

  if (slip?.needsStake) {
    lastStatus.poly = `${leg2Label}: Amount + To win 입력 필요`;
    return slip;
  }

  lastStatus.poly = `${leg2Label}: 이벤트 페이지에서 팀 선택 (/event/ 또는 /predictions/event/)`;
  return slip || apiSlip || null;
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
  if (isLeg2Source(source)) {
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
    if (calcRunning && cachedPoly?.teamLabel && found.btiTab) {
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

async function placePolyBet(polyTab, amountUsd) {
  if (!polyTab?.id) return { success: false, reason: 'Polymarket 탭 없음' };

  await injectPolyMain(polyTab.id);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id },
      world: 'MAIN',
      func: async (amount) => {
        if (typeof window.__polyMainPlaceBet === 'function') {
          return await window.__polyMainPlaceBet(amount);
        }
        return { success: false, reason: 'MAIN 베팅 스크립트 로드 실패 — 탭 새로고침' };
      },
      args: [amountUsd]
    });
    const res = results?.[0]?.result;
    if (res) return res;
  } catch (e) {
    return { success: false, reason: `MAIN 베팅 실패: ${e.message}` };
  }

  return { success: false, reason: 'Polymarket MAIN 응답 없음' };
}

async function setPolyAmount(polyTab, amountUsd) {
  if (!polyTab?.id) return { ok: false, reason: 'Polymarket 탭 없음' };
  await ensurePolyScript(polyTab.id);
  const res = await sendPoly(polyTab.id, { type: 'SET_POLY_AMOUNT', amount: amountUsd, force: true });
  return res || { ok: false, reason: '응답 없음' };
}

function scheduleSyncPolyAmount() {
  if (!calcRunning) return;
  if (syncPolyTimer) clearTimeout(syncPolyTimer);
  syncPolyTimer = setTimeout(() => {
    syncPolyTimer = null;
    syncPolyAmount();
  }, 120);
}

async function syncPolyAmount() {
  if (!calcRunning || syncPolyPending) return;

  const found = await findTabs();
  if (!found.polyTab?.id || !found.btiTab?.id) return;

  const polyO = cachedPoly?.odds > 1 ? cachedPoly.odds : null;
  if (!polyO) return;

  const btiArb = cachedPoly?.teamLabel ? await readBtiArbOdds(found.btiTab, cachedPoly) : null;
  const btiOdds = btiArb?.odds > 1 ? btiArb.odds : cachedBti?.odds;
  if (!btiOdds || btiOdds <= 1) return;

  const btiBet = await getBtiBetAmount(found.btiTab);
  if (!btiBet) return;

  const polyUsd = calcPolyBetUsd(btiBet, btiOdds, polyO, getUsdRate());
  if (Math.abs(lastSyncedPolyUsd - polyUsd) < 0.02 && Date.now() - lastSyncedPolyAt < 3000) {
    updateSlipUI(cachedBti, cachedPoly, btiArb);
    return;
  }

  syncPolyPending = true;
  try {
    const res = await setPolyAmount(found.polyTab, polyUsd);
    if (res?.ok) {
      const changed = Math.abs(lastSyncedPolyUsd - polyUsd) >= 0.02;
      lastSyncedPolyUsd = polyUsd;
      lastSyncedPolyAt = Date.now();
      updateSlipUI(cachedBti, cachedPoly, btiArb);
      if (changed) {
        const profit = calcProfit(btiOdds, polyO);
        log(`배당 갱신 — 텐텐뱃 ${btiOdds.toFixed(3)} · 폴리 ${formatPolyOddsForHistory(cachedPoly)} · 수익률 ${profit != null ? profit.toFixed(2) : '-'}%`, 'info');
      }
    } else if (res?.reason) {
      log(`Poly 금액 입력: ${res.reason}`, 'err');
    }
  } finally {
    syncPolyPending = false;
  }
}

async function calcPollLoop() {
  if (!calcRunning) return;
  await refreshSlips();
  scheduleSyncPolyAmount();
}

function onOddsChanged(msg) {
  if (msg.source === 'bti') applySlipUpdate('bti', msg.slip);
  if (isLeg2Source(msg.source)) applySlipUpdate(msg.source, msg.slip);
  if (!calcRunning) return;
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
  $('botStart').disabled = true;
  $('botStop').disabled = false;
  log('계산 시작 — 배당 변경 시 히스토리에 기록', 'info');
  refreshSlips().then(() => scheduleSyncPolyAmount());
  calcTimer = setInterval(calcPollLoop, 400);
}

function stopCalc() {
  calcRunning = false;
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
  stats.textContent = `텐텐뱃 ${s.btiTotal || 0}경기 · 예측 ${s.polyTotal || 0}경기 · 매칭 ${s.matched || 0}건 (BTI ${s.btiTabFound ? 'O' : 'X'} / ${s.leg2Site || '예측'} ${s.polyTabFound ? 'O' : 'X'})`;

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
      Poly <b>${o.polyTeam}</b> ${o.polyOdds} · 텐텐뱃 ${o.btiSide} ${o.btiOdds}
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

$('botStart')?.addEventListener('click', startCalc);
$('botStop')?.addEventListener('click', stopCalc);
$('clearHistoryBtn')?.addEventListener('click', clearHistory);
$('searchStart')?.addEventListener('click', startSearch);
$('searchStop')?.addEventListener('click', stopSearch);
$('openPanelBtn')?.addEventListener('click', openPanel);
$('openPanelFromSearch')?.addEventListener('click', openPanel);
$('refreshBtn')?.addEventListener('click', () => { refreshSlips(); log('새로고침', 'info'); });
['slipMinProfit', 'minProfit', 'btiBet', 'usdRate'].forEach((id) => {
  $(id)?.addEventListener('input', () => {
    updateSlipUI(cachedBti, cachedPoly);
    if (calcRunning) scheduleSyncPolyAmount();
  });
});

$('diagBtn')?.addEventListener('click', async () => {
  log('진단...', 'info');
  const found = await findTabs();
  log(`텐텐뱃: ${found.btiTab ? `탭 OK frame#${found.btiTab.frameId}` : '탭 없음'}`, found.btiTab ? 'ok' : 'err');
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
      log(`Poly UI: 패널${p.hasPanel ? 'O' : 'X'}`, p.hasPanel ? 'info' : 'err');
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
loadHistory();
refreshSlips();
log(`v5.7.0 ${IS_PANEL ? '패널' : '팝업'} 로드`, 'info');
