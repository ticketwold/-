'use strict';

const POLL_MS = 500;
const FALLBACK_REFRESH_MS = 3000;
const BET_COOLDOWN_MS = 12000;

let botRunning = false;
let betInProgress = false;
let tryBetTimer = null;
let lastBetAttemptAt = 0;
let pollTimer = null;
let searchTimer = null;
let cachedBti = null;
let cachedPoly = null;
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
  if (team && !/^W[12]$/i.test(team)) return team;
  if (slip.homeTeam || slip.awayTeam) {
    if (slip.side === 'away' || slip.side === 'a') return slip.awayTeam || team || '-';
    return slip.homeTeam || team || '-';
  }
  return team || '-';
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
  if (!bti?.odds) hint.textContent = lastStatus.bti || '텐텐뱃 탭에서 로그인·슬립 확인';
  else if (!poly?.odds) hint.textContent = lastStatus.poly || 'Polymarket 탭에서 outcome·금액 입력';
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

function btiHintFromPoly(poly) {
  if (!poly) return {};
  const team = poly.teamLabel || poly.outcome || '';
  return team ? { excludeTeam: team, polyTeam: team } : {};
}

async function readBtiSlip() {
  if (!MobileBridge.isSiteReady('bti')) {
    lastStatus.bti = '텐텐뱃: 하단 탭에서 로그인';
    return null;
  }
  const hint = btiHintFromPoly(cachedPoly);
  const res = await MobileBridge.send('bti', { type: 'READ_BTI_ODDS', hint });
  if (res?.slip?.odds > 1) {
    lastStatus.bti = '';
    return res.slip;
  }
  lastStatus.bti = res?.slip ? '텐텐뱃: 슬립 배당 없음' : '텐텐뱃: 페이지 로딩 중';
  return res?.slip || null;
}

async function readPolySlip() {
  if (!MobileBridge.isSiteReady('poly')) {
    lastStatus.poly = 'Polymarket: 하단 탭에서 /event/ 열기';
    return null;
  }
  let res = await MobileBridge.send('poly', { type: 'READ_SLIP' });
  if (res?.slip?.odds > 1) {
    lastStatus.poly = '';
    return res.slip;
  }
  const injected = await MobileBridge.evalMain('poly', 'typeof readPolymarketSlip==="function"?JSON.stringify(readPolymarketSlip()):null');
  if (injected?.odds > 1) {
    lastStatus.poly = '';
    return injected;
  }
  if (injected?.needsStake || res?.slip?.needsStake) {
    lastStatus.poly = 'Polymarket: 금액($) 입력 필요';
    return injected || res?.slip;
  }
  lastStatus.poly = 'Polymarket: 배당 읽기 실패';
  return injected || res?.slip || null;
}

async function refreshSlips() {
  const poly = await readPolySlip();
  const bti = await readBtiSlip();

  if (poly?.odds > 1) cachedPoly = poly;
  else if (poly) {
    if (cachedPoly?.odds > 1) cachedPoly = { ...cachedPoly, ...poly, odds: cachedPoly.odds };
    else cachedPoly = poly;
  }

  if (bti?.odds > 1) cachedBti = bti;
  else if (bti) {
    if (cachedBti?.odds > 1) cachedBti = { ...cachedBti, ...bti, odds: cachedBti.odds };
    else cachedBti = bti;
  }

  updateSlipUI(cachedBti, cachedPoly);
  return { bti: cachedBti, poly: cachedPoly };
}

async function ensureBtiSlip(hint) {
  return MobileBridge.send('bti', { type: 'ENSURE_BTI_SLIP', hint: hint || btiHintFromPoly(cachedPoly) });
}

async function placeBtiBet(amount, odds, hint) {
  return MobileBridge.send('bti', { type: 'PLACE_BET', amount, odds, hint: hint || btiHintFromPoly(cachedPoly) });
}

async function placePolyBet(amountUsd) {
  const res = await MobileBridge.send('poly', { type: 'PLACE_BET_MAIN', amount: amountUsd });
  if (res?.success) return res;
  return MobileBridge.send('poly', { type: 'PLACE_BET', amount: amountUsd });
}

async function probePolyMain() {
  const res = await MobileBridge.send('poly', { type: 'PROBE_POLY_MAIN' });
  return res?.probe || null;
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

  const { bti, poly } = await refreshSlips();
  if (!bti?.odds || !poly?.odds) return;

  const profit = calcProfit(bti.odds, poly.odds);
  if (profit === null || profit < getMinProfit()) return;

  betInProgress = true;
  lastBetAttemptAt = Date.now();
  const btiBet = getBtiBet();
  const polyUsd = calcPolyBetUsd(btiBet, bti.odds, poly.odds, getUsdRate());
  log(`⚡ 베팅: 텐텐뱃 ${btiBet.toLocaleString()}원 / Poly $${polyUsd.toFixed(2)} → ${profit.toFixed(2)}%`, 'ok');

  try {
    log('① Polymarket 베팅...', 'info');
    const polyRes = await placePolyBet(polyUsd);
    if (!polyRes?.success) {
      const probe = await probePolyMain();
      const extra = probe?.btnText ? ` [버튼: "${probe.btnText}"]` : '';
      log(`❌ Polymarket: ${polyRes?.reason || '실패'}${extra}`, 'err');
      stopBot();
      return;
    }
    log(`✅ Polymarket: "${polyRes.btnText || 'Buy'}" 클릭 완료`, 'ok');

    log('② 텐텐뱃 슬립 준비...', 'info');
    const prep = await ensureBtiSlip();
    if (!prep?.ok) {
      log(`❌ 텐텐뱃 슬립 준비 실패: ${prep?.reason || '알 수 없음'}`, 'err');
      stopBot();
      return;
    }

    log('③ 텐텐뱃 베팅...', 'info');
    const btiRes = await placeBtiBet(btiBet, bti.odds);
    log(btiRes?.success ? '✅ 텐텐뱃 완료' : `❌ 텐텐뱃: ${btiRes?.reason}`, btiRes?.success ? 'ok' : 'err');

    if (btiRes?.success && polyRes?.success) log('🎯 양쪽 베팅 완료 — 봇 정지', 'ok');
    else log('⚠️ 한쪽 실패 — 봇 정지 (수동 확인 필요)', 'err');
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

function applySlipUpdate(source, slip) {
  if (source === 'bti') {
    if (slip?.odds > 1) cachedBti = slip;
    else if (slip) {
      if (cachedBti?.odds > 1) cachedBti = { ...cachedBti, ...slip, odds: cachedBti.odds };
      else cachedBti = slip;
    } else cachedBti = null;
  }
  if (source === 'polymarket') {
    if (slip?.odds > 1) cachedPoly = slip;
    else if (slip) {
      if (cachedPoly?.odds > 1) cachedPoly = { ...cachedPoly, ...slip, odds: cachedPoly.odds };
      else cachedPoly = slip;
    } else cachedPoly = null;
  }
  updateSlipUI(cachedBti, cachedPoly);
}

function onOddsChanged(msg) {
  if (msg.source === 'bti') applySlipUpdate('bti', msg.slip);
  if (msg.source === 'polymarket') applySlipUpdate('polymarket', msg.slip);
  if (!botRunning || betInProgress) return;
  const profit = calcProfit(cachedBti?.odds, cachedPoly?.odds);
  if (profit !== null && profit >= getMinProfit()) scheduleTryBet();
}

window.__onOddsChanged = onOddsChanged;

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
  stats.textContent = `텐텐뱃 ${s.btiTotal || 0}경기 · Poly ${s.polyTotal || 0}경기 · 매칭 ${s.matched || 0}건 (BTI ${s.btiTabFound ? 'O' : 'X'})`;

  el.innerHTML = '';
  const minP = parseFloat($('minProfit')?.value || '1');
  const opps = (data.opportunities || []).filter((o) => parseFloat(o.profit) >= minP);
  if (!opps.length) {
    el.innerHTML = '<div class="hint" style="padding:12px">조건 충족 기회 없음 — 하단 탭에서 로그인 후 재시도</div>';
    return;
  }
  for (const o of opps.slice(0, 60)) {
    const div = document.createElement('div');
    div.className = 'opp';
    div.innerHTML = `<strong>${o.home} vs ${o.away}</strong><br>
      Poly <b>${o.polyTeam}</b> ${o.polyOdds} · 텐텐뱃 ${o.btiSide} ${o.btiOdds}
      <span class="profit-tag"> → ${o.profit}%</span>`;
    el.appendChild(div);
  }
}

async function runSearchTick() {
  try {
    const result = await runArbSearch();
    renderSearchResults(result);
  } catch (e) {
    $('searchStats').textContent = `서치 오류: ${e.message}`;
  }
}

function startSearch() {
  if (searchTimer) return;
  $('searchStart').disabled = true;
  $('searchStop').disabled = false;
  log('서치 시작', 'info');
  runSearchTick();
  searchTimer = setInterval(runSearchTick, 1500);
}

function stopSearch() {
  if (searchTimer) { clearInterval(searchTimer); searchTimer = null; }
  $('searchStart').disabled = false;
  $('searchStop').disabled = true;
  log('서치 정지', 'info');
}

function updateSiteStatus() {
  const el = $('siteStatus');
  if (!el) return;
  const bti = MobileBridge.isSiteReady('bti') ? 'O' : 'X';
  const poly = MobileBridge.isSiteReady('poly') ? 'O' : 'X';
  el.textContent = `연결: 텐텐뱃 ${bti} · Poly ${poly}`;
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
$('openBtiBtn')?.addEventListener('click', () => MobileBridge.showSite('bti'));
$('openPolyBtn')?.addEventListener('click', () => MobileBridge.showSite('poly'));
$('refreshBtn')?.addEventListener('click', () => { refreshSlips(); log('새로고침', 'info'); });

['slipMinProfit', 'minProfit', 'btiBet', 'usdRate'].forEach((id) => {
  $(id)?.addEventListener('input', () => updateSlipUI(cachedBti, cachedPoly));
});

$('diagBtn')?.addEventListener('click', async () => {
  log('진단...', 'info');
  log(`텐텐뱃 WebView: ${MobileBridge.isSiteReady('bti') ? '연결됨' : '미연결'}`, MobileBridge.isSiteReady('bti') ? 'ok' : 'err');
  log(`Polymarket WebView: ${MobileBridge.isSiteReady('poly') ? '연결됨' : '미연결'}`, MobileBridge.isSiteReady('poly') ? 'ok' : 'err');
  const probe = await probePolyMain();
  if (probe) {
    log(`Poly MAIN: Buy버튼${probe.hasBuyBtn ? 'O' : 'X'}${probe.btnText ? ` "${probe.btnText}"` : ''}`, probe.hasBuyBtn ? 'ok' : 'err');
  }
  const probeIso = await MobileBridge.send('poly', { type: 'PROBE_POLY' });
  if (probeIso?.probe) {
    const p = probeIso.probe;
    log(`Poly UI: 패널${p.hasPanel ? 'O' : 'X'} $${p.stake || 0}`, p.hasPanel ? 'info' : 'err');
  }
  const ping = await MobileBridge.send('bti', { type: 'PING' });
  if (ping) log(`BTI PING: 버튼 ${ping.buttonCount || 0}개 / 슬립 ${ping.hasSlip ? 'O' : 'X'}`, 'info');
  await refreshSlips();
});

setInterval(() => { if (!botRunning) refreshSlips(); }, FALLBACK_REFRESH_MS);
setInterval(updateSiteStatus, 1000);
refreshSlips();
updateSiteStatus();
log('모바일 v1.0.0 로드', 'info');
