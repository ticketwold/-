// popup.js v5.0.1 — 텐텐뱃 + Polymarket 전용

'use strict';

const POLL_MS = 400;
const IS_PANEL = document.body.classList.contains('panel-mode');
let botRunning = false;
let betInProgress = false;
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
  if (slip.needsStake) return '금액입력';
  if (!slip.odds || slip.odds <= 1) return '-';
  if (slip.displayLabel) return slip.displayLabel;
  if (slip.priceCents != null) return `${slip.priceCents}¢ (${slip.odds.toFixed(3)})`;
  return slip.odds.toFixed(3);
}

function formatMeta(slip) {
  if (!slip) return '-';
  const parts = [slip.selectionText || slip.teamLabel || ''];
  if (slip.hint) parts.push(slip.hint);
  return parts.filter(Boolean).join(' · ').slice(0, 100) || '-';
}

function updateSlipUI(bti, poly) {
  $('btiOdds').textContent = formatOdds(bti);
  $('polyOdds').textContent = formatOdds(poly);
  $('btiMeta').textContent = formatMeta(bti);
  $('polyMeta').textContent = formatMeta(poly);

  const profit = (bti?.odds > 1 && poly?.odds > 1) ? calcProfit(bti.odds, poly.odds) : null;
  const profitEl = $('profit');
  profitEl.textContent = profit !== null ? `${profit.toFixed(2)}%` : '-';
  profitEl.className = 'profit' + (profit !== null && profit >= getMinProfit() ? ' positive' : '');

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
      func: () => (typeof readPolymarketSlip === 'function' ? readPolymarketSlip() : null)
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function findBtiFrame(tabId) {
  const frames = await getAllFrames(tabId);
  const order = [];
  if (lastBtiFrame?.tabId === tabId) order.push(lastBtiFrame.frameId);
  for (const f of frames) {
    if (!order.includes(f.frameId)) order.push(f.frameId);
  }

  let best = null;
  let bestOdds = 0;

  for (const frameId of order) {
    await ensureBtiScript(tabId, frameId);
    const ping = await sendBti(tabId, frameId, { type: 'PING' });
    if (!ping) continue;

    const res = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: btiHintFromPoly(cachedPoly) });
    const odds = res?.slip?.odds || 0;
    if (odds > bestOdds) {
      bestOdds = odds;
      best = { frameId, ping, slip: res?.slip };
    } else if (!best && (ping.hasSlip || ping.buttonCount > 0)) {
      best = { frameId, ping, slip: res?.slip };
    }
  }
  return best;
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

  const frameId = btiTab.frameId || 0;
  const hint = btiHintFromPoly(cachedPoly);

  let res = await sendBti(btiTab.id, frameId, { type: 'READ_BTI_ODDS', hint });
  if (res?.slip?.odds > 1) {
    lastStatus.bti = '';
    return res.slip;
  }

  await ensureBtiScript(btiTab.id, frameId);
  res = await sendBti(btiTab.id, frameId, { type: 'READ_BTI_ODDS', hint });
  if (res?.slip?.odds > 1) {
    lastStatus.bti = '';
    return res.slip;
  }

  const frame = await findBtiFrame(btiTab.id);
  if (frame?.slip?.odds > 1) {
    lastBtiFrame = { tabId: btiTab.id, frameId: frame.frameId };
    lastStatus.bti = '';
    return frame.slip;
  }

  lastStatus.bti = res?.slip ? '텐텐뱃: 슬립 배당 없음' : '텐텐뱃: BTI iframe 미연결';
  return res?.slip || null;
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

async function refreshSlips() {
  const found = await findTabs();
  const poly = await readPolySlip(found.polyTab);
  const bti = await readBtiSlip(found.btiTab, found.btiSlip);

  if (poly?.odds > 1) cachedPoly = poly;
  else if (poly) cachedPoly = poly;
  if (bti?.odds > 1) cachedBti = bti;
  else if (bti) cachedBti = bti;

  updateSlipUI(cachedBti, cachedPoly);
  return { bti: cachedBti, poly: cachedPoly, btiTab: found.btiTab, polyTab: found.polyTab };
}

async function placeBtiBet(btiTab, amount, targetOdds) {
  const frameId = btiTab.frameId || lastBtiFrame?.frameId || 0;
  return await sendBti(btiTab.id, frameId, { type: 'PLACE_BET', amount, targetOdds })
    || { success: false, reason: '응답 없음' };
}

async function placePolyBet(polyTab, amountUsd) {
  return await sendPoly(polyTab.id, { type: 'PLACE_BET', amount: amountUsd })
    || { success: false, reason: '응답 없음' };
}

async function tryBet() {
  if (betInProgress) return;
  const { bti, poly, btiTab, polyTab } = await refreshSlips();
  if (!bti?.odds || !poly?.odds || !btiTab || !polyTab) return;

  const profit = calcProfit(bti.odds, poly.odds);
  if (profit === null || profit < getMinProfit()) return;

  betInProgress = true;
  const btiBet = getBtiBet();
  const polyUsd = calcPolyBetUsd(btiBet, bti.odds, poly.odds, getUsdRate());
  log(`⚡ 베팅: 텐텐뱃 ${btiBet.toLocaleString()}원 / Poly $${polyUsd.toFixed(2)} → ${profit.toFixed(2)}%`, 'ok');

  try {
    const [btiRes, polyRes] = await Promise.all([
      placeBtiBet(btiTab, btiBet, bti.odds),
      placePolyBet(polyTab, polyUsd)
    ]);
    log(btiRes?.success ? '✅ 텐텐뱃 완료' : `❌ 텐텐뱃: ${btiRes?.reason}`, btiRes?.success ? 'ok' : 'err');
    log(polyRes?.success ? '✅ Polymarket 완료' : `❌ Poly: ${polyRes?.reason}`, polyRes?.success ? 'ok' : 'err');
  } catch (e) {
    log(`❌ ${e.message}`, 'err');
  } finally {
    betInProgress = false;
  }
}

async function pollLoop() {
  if (!botRunning || betInProgress) return;
  const { bti, poly } = await refreshSlips();
  if (!bti?.odds || !poly?.odds) return;
  const profit = calcProfit(bti.odds, poly.odds);
  if (profit !== null && profit >= getMinProfit()) await tryBet();
}

function startBot() {
  if (botRunning) return;
  botRunning = true;
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

$('diagBtn')?.addEventListener('click', async () => {
  log('진단...', 'info');
  const found = await findTabs();
  log(`텐텐뱃: ${found.btiTab ? `탭 OK frame#${found.btiTab.frameId}` : '탭 없음'}`, found.btiTab ? 'ok' : 'err');
  log(`Polymarket: ${found.polyTab ? '탭 OK' : '탭 없음'}`, found.polyTab ? 'ok' : 'err');
  chrome.runtime.sendMessage({ type: 'DIAG_BTI' }, (r) => {
    if (r?.ok) log(`BTI iframe ${r.frames}개 / PING ${r.pings?.length || 0}개`, 'info');
    else log(`BTI: ${r?.error}`, 'err');
  });
  await refreshSlips();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SEARCH_RESULT') renderSearchResults(msg);
  if (msg.type === 'ODDS_CHANGED') {
    if (msg.source === 'bti' && msg.slip) cachedBti = msg.slip;
    if (msg.source === 'polymarket' && msg.slip) cachedPoly = msg.slip;
    updateSlipUI(cachedBti, cachedPoly);
    if (botRunning && !betInProgress) pollLoop();
  }
});

setInterval(() => { if (!botRunning) refreshSlips(); }, 500);
refreshSlips();
log(`v5.0.1 ${IS_PANEL ? '패널' : '팝업'} 로드`, 'info');

if (!IS_PANEL) {
  chrome.runtime.sendMessage({ type: 'OPEN_PANEL' });
}
