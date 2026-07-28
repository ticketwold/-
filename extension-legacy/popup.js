// popup.js v5 — 텐텐뱃 + Polymarket 전용

'use strict';

const POLL_MS = 400;
let botRunning = false;
let betInProgress = false;
let pollTimer = null;
let cachedBti = null;
let cachedPoly = null;
let lastBtiFrame = null;

// ─── UI ───────────────────────────────────────────────
function log(text, cls = '') {
  const el = document.getElementById('log');
  if (!el) return;
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.prepend(div);
  while (el.children.length > 40) el.lastChild.remove();
}

function $(id) { return document.getElementById(id); }

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
  if (!slip?.odds || slip.odds <= 1) return '-';
  if (slip.displayLabel) return slip.displayLabel;
  if (slip.priceCents != null) return `${slip.priceCents}¢ (${slip.odds.toFixed(3)})`;
  return slip.odds.toFixed(3);
}

function formatMeta(slip) {
  if (!slip) return '-';
  const parts = [slip.selectionText || slip.teamLabel || ''];
  if (slip.hint) parts.push(slip.hint);
  return parts.filter(Boolean).join(' · ').slice(0, 90) || '-';
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
  if (!bti || !poly) hint.textContent = '양쪽 슬립에 담고 (Poly는 금액 입력)';
  else if (profit !== null && profit >= getMinProfit()) hint.textContent = '수익 구간 충족';
  else if (profit !== null) hint.textContent = `수익 구간 밖 (최소 ${getMinProfit()}%)`;
  else hint.textContent = '배당 확인 중...';

  if (bti?.odds > 1 && poly?.odds > 1) {
    const polyUsd = calcPolyBetUsd(getBtiBet(), bti.odds, poly.odds, getUsdRate());
    $('calcBti').textContent = `${getBtiBet().toLocaleString()}원`;
    $('calcPoly').textContent = `$${polyUsd.toFixed(2)}`;
  } else {
    $('calcBti').textContent = '-';
    $('calcPoly').textContent = '-';
  }
}

// ─── 탭 찾기 ─────────────────────────────────────────
async function findTabs() {
  const tabs = await chrome.tabs.query({});
  let btiTab = null;
  let polyTab = null;

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (isPolymarketUrl(tab.url) && !polyTab) {
      polyTab = { id: tab.id, url: tab.url, frameId: 0 };
    }
    if (isWrapperUrl(tab.url) && !btiTab) {
      btiTab = { id: tab.id, url: tab.url, frameId: 0 };
    }
  }

  if (btiTab) {
    const frame = await findBtiFrame(btiTab.id);
    if (frame) {
      btiTab.frameId = frame.frameId;
      lastBtiFrame = { tabId: btiTab.id, frameId: frame.frameId };
    } else if (lastBtiFrame?.tabId === btiTab.id) {
      btiTab.frameId = lastBtiFrame.frameId;
    }
  }

  return { btiTab, polyTab };
}

async function getAllFrames(tabId) {
  if (!chrome.webNavigation?.getAllFrames) return [{ frameId: 0 }];
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      resolve(frames?.length ? frames : [{ frameId: 0 }]);
    });
  });
}

async function findBtiFrame(tabId) {
  const prefer = lastBtiFrame?.tabId === tabId ? lastBtiFrame.frameId : null;
  const frames = await getAllFrames(tabId);

  for (const frame of frames) {
    if (prefer != null && frame.frameId !== prefer) continue;
    try {
      const ping = await sendBti(tabId, frame.frameId, { type: 'PING' });
      if (ping?.hasSlip || ping?.buttonCount > 0) {
        return { frameId: frame.frameId, ping };
      }
    } catch (_) {}
  }

  for (const frame of frames.filter((f) => f.frameId > 0)) {
    try {
      const ping = await sendBti(tabId, frame.frameId, { type: 'PING' });
      if (ping?.hasSlip || ping?.buttonCount > 0) {
        return { frameId: frame.frameId, ping };
      }
    } catch (_) {}
  }
  return null;
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
    await new Promise((r) => setTimeout(r, 200));
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

// ─── 슬립 읽기 ───────────────────────────────────────
function btiHintFromPoly(poly) {
  if (!poly) return {};
  const team = poly.teamLabel || poly.outcome || '';
  return team ? { excludeTeam: team, polyTeam: team } : {};
}

async function readBtiSlip(btiTab) {
  if (!btiTab?.id) return null;
  const frameId = btiTab.frameId || 0;
  const hint = btiHintFromPoly(cachedPoly);

  let res = await sendBti(btiTab.id, frameId, { type: 'READ_BTI_ODDS', hint });
  if (res?.slip?.odds > 1) return res.slip;

  await ensureBtiScript(btiTab.id, frameId);
  res = await sendBti(btiTab.id, frameId, { type: 'READ_BTI_ODDS', hint });
  if (res?.slip?.odds > 1) return res.slip;

  // 다른 프레임 탐색
  const frames = await getAllFrames(btiTab.id);
  for (const f of frames.filter((x) => x.frameId > 0)) {
    await ensureBtiScript(btiTab.id, f.frameId);
    res = await sendBti(btiTab.id, f.frameId, { type: 'READ_BTI_ODDS', hint });
    if (res?.slip?.odds > 1) {
      lastBtiFrame = { tabId: btiTab.id, frameId: f.frameId };
      return res.slip;
    }
  }
  return res?.slip || null;
}

async function readPolySlip(polyTab) {
  if (!polyTab?.id) return null;
  let res = await sendPoly(polyTab.id, { type: 'READ_SLIP' });
  if (res?.slip?.odds > 1) return res.slip;

  await ensurePolyScript(polyTab.id);
  res = await sendPoly(polyTab.id, { type: 'READ_SLIP' });
  return res?.slip?.odds > 1 ? res.slip : (res?.slip || null);
}

async function refreshSlips() {
  const { btiTab, polyTab } = await findTabs();
  const poly = await readPolySlip(polyTab);
  const bti = await readBtiSlip(btiTab);

  if (poly) cachedPoly = poly;
  if (bti) cachedBti = bti;

  updateSlipUI(cachedBti, cachedPoly);
  return { bti: cachedBti, poly: cachedPoly, btiTab, polyTab };
}

// ─── 베팅 ────────────────────────────────────────────
async function placeBtiBet(btiTab, amount, targetOdds) {
  const frameId = btiTab.frameId || lastBtiFrame?.frameId || 0;
  const res = await sendBti(btiTab.id, frameId, {
    type: 'PLACE_BET',
    amount,
    targetOdds
  });
  return res || { success: false, reason: '응답 없음' };
}

async function placePolyBet(polyTab, amountUsd) {
  const res = await sendPoly(polyTab.id, { type: 'PLACE_BET', amount: amountUsd });
  return res || { success: false, reason: '응답 없음' };
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

  log(`⚡ 베팅: 텐텐뱃 ${btiBet.toLocaleString()}원 (${bti.odds.toFixed(3)}) / Poly $${polyUsd.toFixed(2)} (${poly.odds.toFixed(3)}) → ${profit.toFixed(2)}%`, 'ok');

  try {
    const [btiRes, polyRes] = await Promise.all([
      placeBtiBet(btiTab, btiBet, bti.odds),
      placePolyBet(polyTab, polyUsd)
    ]);
    if (btiRes?.success) log(`✅ 텐텐뱃 완료`, 'ok');
    else log(`❌ 텐텐뱃: ${btiRes?.reason || '실패'}`, 'err');
    if (polyRes?.success) log(`✅ Polymarket 완료`, 'ok');
    else log(`❌ Polymarket: ${polyRes?.reason || '실패'}`, 'err');
  } catch (e) {
    log(`❌ 베팅 오류: ${e.message}`, 'err');
  } finally {
    betInProgress = false;
  }
}

// ─── 봇 / 폴링 ───────────────────────────────────────
async function pollLoop() {
  if (!botRunning || betInProgress) return;
  const { bti, poly } = await refreshSlips();
  if (!bti?.odds || !poly?.odds) return;

  const profit = calcProfit(bti.odds, poly.odds);
  if (profit !== null && profit >= getMinProfit()) {
    await tryBet();
  }
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

// ─── 라이브 서치 ─────────────────────────────────────
function renderSearchResults(data) {
  const el = $('searchResults');
  const stats = $('searchStats');
  if (!data) return;

  const s = data.stats || {};
  stats.textContent = `텐텐뱃 ${s.btiTotal || 0}경기 / Poly ${s.polyTotal || 0}경기 → ${s.matched || 0}건 (BTI탭: ${s.btiTabFound ? 'O' : 'X'})`;

  el.innerHTML = '';
  const minP = parseFloat($('minProfit')?.value || '1');
  const opps = (data.opportunities || []).filter((o) => parseFloat(o.profit) >= minP);

  if (!opps.length) {
    el.innerHTML = '<div class="hint">기회 없음</div>';
    return;
  }

  for (const o of opps.slice(0, 30)) {
    const div = document.createElement('div');
    div.className = 'opp';
    div.innerHTML = `<strong>${o.home} vs ${o.away}</strong><br>
      Poly ${o.polyTeam} ${o.polyOdds} / 텐텐뱃 ${o.btiSide} ${o.btiOdds} → <strong>${o.profit}%</strong>`;
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
      log(`서치 실패: ${res?.error || 'unknown'}`, 'err');
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

// ─── 이벤트 ──────────────────────────────────────────
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

$('diagBtn')?.addEventListener('click', async () => {
  log('진단 중...', 'info');
  const { btiTab, polyTab } = await findTabs();
  log(`텐텐뱃 탭: ${btiTab ? 'OK (frame #' + (btiTab.frameId || 0) + ')' : '없음'}`, btiTab ? 'ok' : 'err');
  log(`Polymarket 탭: ${polyTab ? 'OK' : '없음'}`, polyTab ? 'ok' : 'err');

  chrome.runtime.sendMessage({ type: 'DIAG_BTI' }, (r) => {
    if (r?.ok) log(`BTI 프레임 ${r.frames}개, PING ${r.pings?.length || 0}개`, 'info');
    else log(`BTI 진단: ${r?.error || '실패'}`, 'err');
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

// 슬립 미리보기 (봇 꺼져 있을 때)
setInterval(() => { if (!botRunning) refreshSlips(); }, 500);
refreshSlips();
log('v5.0.0 로드됨 — 텐텐뱃 + Polymarket 전용', 'info');
