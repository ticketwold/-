// popup.js v5.0.1 — 텐텐뱃 + Polymarket 전용

'use strict';

const POLL_MS = 16;
const FALLBACK_REFRESH_MS = 250;
const IS_PANEL = document.body.classList.contains('panel-mode');
let botRunning = false;
let betInProgress = false;
let tryBetTimer = null;
let lastBetAttemptAt = 0;
const BET_COOLDOWN_MS = 12000;
let pollTimer = null;
let cachedBti = null;
let cachedPoly = null;
let lastBtiFrame = null;
let lastStatus = { bti: '', poly: '' };

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
  if (slip.displayLabel) return slip.displayLabel;
  if (slip.priceCents != null) return `${slip.priceCents}¢ (${slip.odds.toFixed(3)})`;
  return slip.odds.toFixed(3);
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
  if (slip.source === 'board-live' || slip.source === 'board') {
    return `${label} · 실시간`;
  }
  return label;
}

function formatPolyMeta(slip) {
  if (!slip) return '-';
  const parts = [slip.teamLabel || slip.selectionText || ''];
  if (slip.hint) parts.push(slip.hint);
  return parts.filter(Boolean).join(' · ').slice(0, 100) || '-';
}

function updateSlipUI(bti, poly) {
  $('btiOdds').textContent = formatOdds(bti);
  $('polyOdds').textContent = formatOdds(poly);
  $('btiMeta').textContent = formatBtiMeta(bti);
  $('polyMeta').textContent = formatPolyMeta(poly);

  const btiO = bti?.odds > 1 ? bti.odds : null;
  const polyO = poly?.odds > 1 ? poly.odds : null;
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
  else if (!poly?.odds) hint.textContent = lastStatus.poly || 'Polymarket: 탭 열고 금액($) 입력';
  else if (poly?.needsStake) hint.textContent = 'Polymarket 금액 입력 시 To win 배당 반영';
  else if (profit !== null && profit >= getMinProfit()) hint.textContent = '수익 구간 충족';
  else if (profit !== null) hint.textContent = `수익 구간 밖 (최소 ${getMinProfit()}%)`;
  else hint.textContent = '배당 확인 중...';

  if (bti?.odds > 1 && poly?.odds > 1) {
    $('calcBti').textContent = `${getBtiBet().toLocaleString()}원`;
    $('calcPoly').textContent = `$${calcPolyBetUsd(getBtiBet(), bti.odds, poly.odds, getUsdRate()).toFixed(2)}`;
  } else {
    $('calcBti').textContent = '-';
    $('calcPoly').textContent = '-';
  }
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
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['bti_content.js']
    });
    await new Promise((r) => setTimeout(r, 150));
  } catch (_) {}
}

async function ensurePolyScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['polymarket_content.js']
    });
    await new Promise((r) => setTimeout(r, 200));
  } catch (_) {}
}

async function injectReadPoly(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function parseCents(txt) {
          const m = String(txt || '').match(/(\d+(?:\.\d+)?)\s*¢/);
          if (!m) return null;
          const c = parseFloat(m[1]);
          return c >= 1 && c < 100 ? c : null;
        }
        function norm(s) {
          return String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
        }
        function teamMatch(team, text) {
          const nt = norm(team);
          const bt = norm(text);
          if (!nt || !bt) return false;
          return bt.includes(nt) || nt.includes(bt);
        }

        let team = '';
        for (const btn of document.querySelectorAll('button, [role="button"]')) {
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          const m = t.match(/^buy\s+(.+)$/i);
          if (m) { team = m[1].trim(); break; }
        }

        const candidates = [];
        for (const btn of document.querySelectorAll('button, [role="button"], [role="radio"]')) {
          const r = btn.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          const cents = parseCents(t);
          if (!cents) continue;
          let score = 0;
          if (team && teamMatch(team, t)) score += 100;
          if (btn.getAttribute('aria-pressed') === 'true') score += 50;
          candidates.push({ cents, score, team: t });
        }
        candidates.sort((a, b) => b.score - a.score);
        const pick = candidates[0];
        if (!pick) return null;
        return {
          source: 'polymarket',
          odds: 100 / pick.cents,
          priceCents: pick.cents,
          teamLabel: team,
          marketKind: 'ml'
        };
      }
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function readBtiFromAllFrames(tabId, hint = {}) {
  const frames = await getAllFrames(tabId);
  let bestSlip = null;
  let bestScore = -1;
  let bestFrameId = lastBtiFrame?.tabId === tabId ? lastBtiFrame.frameId : 0;

  for (const { frameId } of frames) {
    await ensureBtiScript(tabId, frameId);
    const ping = await sendBti(tabId, frameId, { type: 'PING' });
    if (!ping?.ok) continue;

    const res = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint });
    const slip = res?.slip;
    let score = 0;
    if (slip?.odds > 1.01) score += 1000 + slip.odds;
    if (ping.hasInput) score += 500;
    if (ping.slipCount > 0) score += 300;
    if (ping.slipOdds > 1) score += 250;
    if (ping.buttonCount > 0) score += Math.min(ping.buttonCount, 100);

    if (score > bestScore) {
      bestScore = score;
      bestSlip = slip;
      bestFrameId = frameId;
    }
  }

  if (!(bestSlip?.odds > 1.01) && (hint.excludeTeam || hint.polyTeam)) {
    return readBtiFromAllFrames(tabId, {});
  }

  return { slip: bestSlip, frameId: bestFrameId };
}

async function findBtiFrame(tabId) {
  const merged = await readBtiFromAllFrames(tabId, btiHintFromPoly(cachedPoly));
  if (!merged.slip && merged.frameId === 0) {
    const frames = await getAllFrames(tabId);
    for (const { frameId } of frames) {
      const ping = await sendBti(tabId, frameId, { type: 'PING' });
      if (ping?.ok && (ping.hasInput || ping.buttonCount > 0)) {
        return { frameId, ping, slip: null };
      }
    }
  }
  const ping = await sendBti(tabId, merged.frameId, { type: 'PING' });
  return { frameId: merged.frameId, ping, slip: merged.slip };
}

async function findTabs() {
  const tabs = await chrome.tabs.query({});
  let btiTab = null;
  const polyTabs = [];

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (isPolymarketUrl(tab.url)) polyTabs.push(tab);
    if (isWrapperUrl(tab.url) && !btiTab) btiTab = tab;
  }

  let polyTab = null;
  for (const t of polyTabs) {
    if (/\/event\//i.test(t.url || '')) { polyTab = t; break; }
  }
  if (!polyTab && polyTabs.length) polyTab = polyTabs[0];

  if (btiTab) {
    const frame = await findBtiFrame(btiTab.id);
    if (frame) {
      btiTab = { id: btiTab.id, url: btiTab.url, frameId: frame.frameId };
      lastBtiFrame = { tabId: btiTab.id, frameId: frame.frameId };
      if (frame.slip?.odds > 1) return { btiTab, polyTab: polyTab ? { id: polyTab.id, url: polyTab.url } : null, btiSlip: frame.slip };
    } else {
      btiTab = { id: btiTab.id, url: btiTab.url, frameId: lastBtiFrame?.frameId || 0 };
    }
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

async function readBtiSlip(btiTab, prefilled) {
  if (prefilled?.odds > 1) return prefilled;
  if (!btiTab?.id) {
    lastStatus.bti = '텐텐뱃: x10x10s 탭 없음';
    return null;
  }

  const hint = btiHintFromPoly(cachedPoly);
  const merged = await readBtiFromAllFrames(btiTab.id, hint);
  if (merged.slip?.odds > 1) {
    lastBtiFrame = { tabId: btiTab.id, frameId: merged.frameId };
    btiTab.frameId = merged.frameId;
    lastStatus.bti = '';
    return merged.slip;
  }

  lastStatus.bti = merged.frameId != null ? '텐텐뱃: 배당판 배당 없음' : '텐텐뱃: BTI iframe 미연결';
  return merged.slip || null;
}

async function readPolySlip(polyTab) {
  if (!polyTab?.id) {
    lastStatus.poly = 'Polymarket: 탭 없음 — polymarket.com 열기';
    return null;
  }

  let res = await sendPoly(polyTab.id, { type: 'READ_SLIP' });
  if (res?.slip?.odds > 1) {
    lastStatus.poly = '';
    return res.slip;
  }

  await ensurePolyScript(polyTab.id);
  res = await sendPoly(polyTab.id, { type: 'READ_SLIP' });
  if (res?.slip?.odds > 1) {
    lastStatus.poly = '';
    return res.slip;
  }

  const injected = await injectReadPoly(polyTab.id);
  if (injected?.odds > 1) {
    lastStatus.poly = '';
    return injected;
  }

  if (injected?.needsStake || res?.slip?.needsStake) {
    lastStatus.poly = 'Polymarket: 금액($) 입력 필요';
    return injected || res?.slip;
  }

  lastStatus.poly = 'Polymarket: 배당 읽기 실패 — 탭 새로고침';
  return injected || res?.slip || null;
}

function slipOdds(slip) {
  if (!slip) return null;
  if (slip.odds > 1 && slip.odds <= 50) return slip.odds;
  if (slip.priceCents >= 1 && slip.priceCents < 100) return 100 / slip.priceCents;
  return null;
}

function mergeSlipCached(cached, fresh) {
  if (!fresh || !slipOdds(fresh)) return null;
  const freshOdds = slipOdds(fresh);
  if (!cached) return { ...fresh, odds: freshOdds };
  if (cached.teamLabel && fresh.teamLabel && cached.teamLabel !== fresh.teamLabel) {
    return { ...fresh, odds: freshOdds };
  }
  const cachedCents = cached.priceCents;
  if (fresh.priceCents && fresh.priceCents !== cachedCents) {
    return { ...cached, ...fresh, odds: freshOdds };
  }
  if (!cached.odds || Math.abs(freshOdds - cached.odds) > 0.0001) {
    return { ...cached, ...fresh, odds: freshOdds };
  }
  return { ...cached, ...fresh, odds: freshOdds };
}

function applySlipUpdate(source, slip) {
  if (source === 'bti') {
    cachedBti = slipOdds(slip) ? mergeSlipCached(cachedBti, slip) : null;
  }
  if (source === 'polymarket') {
    cachedPoly = slipOdds(slip) ? mergeSlipCached(cachedPoly, slip) : null;
  }
  updateSlipUI(cachedBti, cachedPoly);
}

async function refreshSlips() {
  const found = await findTabs();
  const poly = await readPolySlip(found.polyTab);
  const bti = await readBtiSlip(found.btiTab, found.btiSlip);

  cachedPoly = mergeSlipCached(cachedPoly, poly);
  cachedBti = mergeSlipCached(cachedBti, bti);

  updateSlipUI(cachedBti, cachedPoly);
  return { bti: cachedBti, poly: cachedPoly, btiTab: found.btiTab, polyTab: found.polyTab };
}

async function placeBtiBet(btiTab, amount, targetOdds, hint = {}) {
  const frameId = btiTab.frameId || lastBtiFrame?.frameId || 0;
  return await sendBti(btiTab.id, frameId, { type: 'PLACE_BET', amount, targetOdds, hint })
    || { success: false, reason: '응답 없음' };
}

async function ensureBtiSlip(btiTab, hint = {}) {
  const frameId = btiTab.frameId || lastBtiFrame?.frameId || 0;
  return await sendBti(btiTab.id, frameId, { type: 'ENSURE_BTI_SLIP', hint })
    || { ok: false, reason: '응답 없음' };
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

function scheduleTryBet() {
  if (!botRunning || betInProgress) return;
  if (tryBetTimer) clearTimeout(tryBetTimer);
  tryBetTimer = setTimeout(() => {
    tryBetTimer = null;
    tryBet();
  }, 80);
}

async function tryBet() {
  if (betInProgress) return;
  if (Date.now() - lastBetAttemptAt < BET_COOLDOWN_MS) return;

  const { bti, poly, btiTab, polyTab } = await refreshSlips();
  if (!bti?.odds || !poly?.odds || !btiTab || !polyTab) return;

  const profit = calcProfit(bti.odds, poly.odds);
  if (profit === null || profit < getMinProfit()) return;

  betInProgress = true;
  lastBetAttemptAt = Date.now();
  const btiBet = getBtiBet();
  const polyUsd = calcPolyBetUsd(btiBet, bti.odds, poly.odds, getUsdRate());
  const hint = btiHintFromPoly(poly);
  log(`⚡ 베팅: 텐텐뱃 ${btiBet.toLocaleString()}원 / Poly $${polyUsd.toFixed(2)} → ${profit.toFixed(2)}%`, 'ok');

  try {
    log('① Polymarket 베팅...', 'info');
    const polyRes = await placePolyBet(polyTab, polyUsd);
    if (!polyRes?.success) {
      const probe = polyRes?.probe || await probePolyMain(polyTab.id);
      const extra = probe?.btnText
        ? ` [버튼: "${probe.btnText}"${probe.btnDisabled ? ' 비활성' : ''}]`
        : (probe ? ` [Buy버튼:${probe.hasBuyBtn ? 'O' : 'X'}]` : '');
      log(`❌ Polymarket: ${polyRes?.reason || '실패'}${extra}`, 'err');
      stopBot();
      return;
    }
    log(`✅ Polymarket: "${polyRes.btnText || 'Buy'}" 클릭 완료`, 'ok');

    log('② 텐텐뱃 슬립 준비...', 'info');
    const prep = await ensureBtiSlip(btiTab, hint);
    if (!prep?.ok) {
      log(`❌ 텐텐뱃 슬립 준비 실패: ${prep?.reason || '알 수 없음'}`, 'err');
      stopBot();
      return;
    }

    log('③ 텐텐뱃 베팅...', 'info');
    const btiRes = await placeBtiBet(btiTab, btiBet, bti.odds, hint);
    log(btiRes?.success ? '✅ 텐텐뱃 완료' : `❌ 텐텐뱃: ${btiRes?.reason}`, btiRes?.success ? 'ok' : 'err');

    if (btiRes?.success && polyRes?.success) {
      log('🎯 양쪽 베팅 완료 — 봇 정지', 'ok');
    } else {
      log('⚠️ 한쪽 실패 — 봇 정지 (수동 확인 필요)', 'err');
    }
    stopBot();
  } catch (e) {
    log(`❌ ${e.message}`, 'err');
    stopBot();
  } finally {
    betInProgress = false;
  }
}

async function pollLoop() {
  if (!botRunning || betInProgress) return;
  const { bti, poly } = await refreshSlips();
  if (!bti?.odds || !poly?.odds) return;
  const profit = calcProfit(bti.odds, poly.odds);
  if (profit !== null && profit >= getMinProfit()) scheduleTryBet();
}

function onOddsChanged(msg) {
  if (msg.source === 'bti') applySlipUpdate('bti', msg.slip);
  if (msg.source === 'polymarket') applySlipUpdate('polymarket', msg.slip);

  if (!botRunning || betInProgress) return;
  const profit = calcProfit(cachedBti?.odds, cachedPoly?.odds);
  if (profit !== null && profit >= getMinProfit()) scheduleTryBet();
}

function startBot() {
  if (botRunning) return;
  botRunning = true;
  lastBetAttemptAt = 0;
  $('botStart').disabled = true;
  $('botStop').disabled = false;
  log('봇 시작', 'info');
  refreshSlips();
  pollTimer = setInterval(pollLoop, POLL_MS);
}

function stopBot() {
  botRunning = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  $('botStart').disabled = false;
  $('botStop').disabled = true;
  log('봇 정지', 'info');
}

function renderSearchResults(data) {
  const el = $('searchResults');
  const stats = $('searchStats');
  if (!data) return;

  const s = data.stats || {};
  stats.textContent = `텐텐뱃 ${s.btiTotal || 0}경기 · Poly ${s.polyTotal || 0}경기 · 매칭 ${s.matched || 0}건 (BTI ${s.btiTabFound ? 'O' : 'X'} / Poly ${s.polyTabFound ? 'O' : 'X'})`;

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

$('botStart')?.addEventListener('click', startBot);
$('botStop')?.addEventListener('click', stopBot);
$('searchStart')?.addEventListener('click', startSearch);
$('searchStop')?.addEventListener('click', stopSearch);
$('openPanelBtn')?.addEventListener('click', openPanel);
$('openPanelFromSearch')?.addEventListener('click', openPanel);
$('refreshBtn')?.addEventListener('click', () => { refreshSlips(); log('새로고침', 'info'); });
['slipMinProfit', 'minProfit', 'btiBet', 'usdRate'].forEach((id) => {
  $(id)?.addEventListener('input', () => updateSlipUI(cachedBti, cachedPoly));
});

$('diagBtn')?.addEventListener('click', async () => {
  log('진단...', 'info');
  const found = await findTabs();
  log(`텐텐뱃: ${found.btiTab ? `탭 OK frame#${found.btiTab.frameId}` : '탭 없음'}`, found.btiTab ? 'ok' : 'err');
  log(`Polymarket: ${found.polyTab ? '탭 OK' : '탭 없음'}`, found.polyTab ? 'ok' : 'err');
  if (found.polyTab) {
    const probe = await probePolyMain(found.polyTab.id);
    if (probe) {
      log(`Poly MAIN: Buy버튼${probe.hasBuyBtn ? 'O' : 'X'}${probe.btnText ? ` "${probe.btnText}"` : ''}`, probe.hasBuyBtn ? 'ok' : 'err');
    }
    await ensurePolyScript(found.polyTab.id);
    const probeIso = await sendPoly(found.polyTab.id, { type: 'PROBE_POLY' });
    if (probeIso?.probe) {
      const p = probeIso.probe;
      log(`Poly UI: 패널${p.hasPanel ? 'O' : 'X'} $${p.stake || 0}`, p.hasPanel ? 'info' : 'err');
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
});

setInterval(() => { if (!botRunning) refreshSlips(); }, FALLBACK_REFRESH_MS);
refreshSlips();
log(`v5.3.2 ${IS_PANEL ? '패널' : '팝업'} 로드`, 'info');
