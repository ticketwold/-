// engine.js — 탭 탐색, 슬립 읽기, 동시 배팅
'use strict';

let lastBtiFrame = null;
let lastBtiSlipFrame = null;
let lastBtiBoardFrame = null;
let lastBcLeg2Frame = null;
let polyScriptReady = new Set();
let btiScriptReady = new Set();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const BTI_PROBE_MS = 5000;
const BTI_MAX_FRAMES = 16;
const POLY_FRAME_MS = 3000;
const POLY_MAX_FRAMES = 6;

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

function slipToProbeResult(frameId, slip, ping) {
  return {
    frameId,
    ping: ping || null,
    slip,
    score: slip?.odds > 1.01 ? scoreBtiProbe(ping, slip) : 0,
    hasInput: !!(ping?.hasInput || slip?.hasInput),
    hasBoard: !!((ping?.buttonCount || 0) > 0 || (slip?.buttonCount || 0) > 0)
  };
}

async function scrapeBtiFromAllFrames(tabId) {
  const order = await orderBtiFrameIds(tabId);
  const toProbe = order.slice(0, BTI_MAX_FRAMES);
  const results = await Promise.all(toProbe.map(async (frameId) => {
    try {
      await ensureBtiApiHook(tabId, frameId);
      const apiHook = await readBtiApiSlipHook(tabId, frameId);
      if (apiHook?.odds > 1.01) return slipToProbeResult(frameId, apiHook, null);
      const scraped = await withTimeout(injectReadBtiFrame(tabId, frameId), BTI_PROBE_MS, '텐텐뱃 스크랩');
      if (scraped?.odds > 1.01) return slipToProbeResult(frameId, scraped, null);
    } catch (_) {}
    return slipToProbeResult(frameId, null, null);
  }));
  updateBtiFrameRoles(tabId, results);
  const merged = mergeBtiFrameResults(results);
  if (merged.slip?.odds > 1.01) lastBtiFrame = { tabId, frameId: merged.frameId };
  return merged;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} (${ms}ms 초과)`)), ms))
  ]);
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
      resolve(chrome.runtime.lastError ? null : res);
    });
  });
}

function sendPoly(tabId, msg, frameId = 0) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: frameId || 0 }, (res) => {
      resolve(chrome.runtime.lastError ? null : res);
    });
  });
}

async function ensureBtiScript(tabId, frameId) {
  const key = `${tabId}:${frameId}`;
  if (btiScriptReady.has(key)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['bti_content.js'] });
    btiScriptReady.add(key);
  } catch (_) {}
}

async function ensurePolyScript(tabId, frameId) {
  const allFrames = frameId === undefined || frameId === null;
  const key = allFrames ? String(tabId) : `${tabId}:${frameId}`;
  if (polyScriptReady.has(key)) return;
  try {
    const target = allFrames ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
    await chrome.scripting.executeScript({ target, files: ['polymarket_content.js'] });
    polyScriptReady.add(key);
    if (allFrames) polyScriptReady.add(String(tabId));
  } catch (_) {}
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

async function ensureAllBtiScripts(tabId) {
  const frames = await getAllFrames(tabId);
  await Promise.all(frames.map((f) => ensureBtiScript(tabId, f.frameId)));
}

async function findTabs(leg2Pref = 'bcgame') {
  const tabs = await chrome.tabs.query({});
  let btiTab = null;
  let btiBestScore = -1;
  const leg2Tabs = [];
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = activeTabs[0]?.id;

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (urlMatchesLeg2Pref(tab.url, leg2Pref)) leg2Tabs.push(tab);
    if (isWrapperUrl(tab.url)) {
      let score = scoreWrapperBtiTab(tab.url);
      if (tab.id === activeId) score += 5;
      if (score > btiBestScore) {
        btiBestScore = score;
        btiTab = tab;
      }
    }
  }

  let polyTab = null;
  let bestScore = -1;
  for (const t of leg2Tabs) {
    const score = scoreLeg2Tab(t.url, activeId, t.id, leg2Pref);
    if (score > bestScore) { bestScore = score; polyTab = t; }
  }

  return {
    btiTab: btiTab ? { id: btiTab.id, url: btiTab.url } : null,
    polyTab: polyTab ? { id: polyTab.id, url: polyTab.url } : null
  };
}

function scoreBtiProbe(ping, slip) {
  let score = 0;
  if (slip?.odds > 1.01) score += 1000;
  if (slip?.fromSlip || slip?.source === 'slip-display' || slip?.source === 'slip-card' || slip?.source === 'slip-latched') score += 500;
  if (slip?.source === 'slip-display') score += 400;
  if (slip?.source === 'slip-card' || slip?.source === 'slip-latched') score += 350;
  if (ping?.hasInput || slip?.hasInput) score += 500;
  if (ping?.slipCount > 0) score += 300;
  if (ping?.slipOdds > 1) score += 250;
  if (ping?.buttonCount > 0) score += Math.min(ping.buttonCount, 100);
  if (slip?.buttonCount > 0) score += Math.min(slip.buttonCount, 80);
  return score;
}

function isBtiSlipOddsSource(slip) {
  if (!slip) return false;
  if (slip.fromSlip === true) return true;
  const src = slip.source || slip.sourceKind || '';
  return src === 'slip-display' || src === 'slip-card' || src === 'slip-latched'
    || src === 'board-live' || src === 'board' || src === 'board-emergency'
    || src === 'bti-api' || String(src).includes('bti-api');
}

async function ensureBtiApiHook(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['bti_api_hook.js'],
      world: 'MAIN'
    });
  } catch (_) {}
}

async function probeBtiFrameInner(tabId, frameId, hint = {}) {
  await ensureBtiApiHook(tabId, frameId);
  let ping = await sendBti(tabId, frameId, { type: 'PING' });
  if (!ping?.ok) {
    await ensureBtiScript(tabId, frameId);
    ping = await sendBti(tabId, frameId, { type: 'PING' });
  }

  const readHint = { preferActiveSlip: true, ...hint };
  const contentPromise = ping?.ok
    ? sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: readHint }).then((res) => res?.slip || null)
    : Promise.resolve(null);
  const scrapePromise = injectReadBtiFrame(tabId, frameId);

  let [contentSlip, scraped] = await Promise.all([contentPromise, scrapePromise]);
  let slip = (contentSlip?.odds > 1.01 && isBtiSlipOddsSource(contentSlip)) ? contentSlip : null;
  if (!slip && scraped?.odds > 1.01 && isBtiSlipOddsSource(scraped)) slip = scraped;

  if (!slip && ping?.ok) {
    const res2 = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: { preferActiveSlip: true, ...hint } });
    if (res2?.slip?.odds > 1.01 && isBtiSlipOddsSource(res2.slip)) slip = res2.slip;
    else if (hint.excludeTeam || hint.polyTeam) {
      const res3 = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: { ...hint, forArbPick: true } });
      if (res3?.slip?.odds > 1.01 && isBtiSlipOddsSource(res3.slip)) slip = res3.slip;
    }
    if (!slip) {
      const scraped2 = await injectReadBtiFrame(tabId, frameId);
      if (scraped2?.odds > 1.01 && isBtiSlipOddsSource(scraped2)) slip = scraped2;
    }
    if (!slip) {
      const apiHook = await readBtiApiSlipHook(tabId, frameId);
      if (apiHook?.odds > 1.01) slip = apiHook;
    }
  }

  return {
    frameId,
    ping,
    slip,
    score: scoreBtiProbe(ping, slip),
    hasInput: !!(ping?.hasInput || slip?.hasInput),
    hasBoard: !!((ping?.buttonCount || 0) > 0 || (slip?.buttonCount || 0) > 0)
  };
}

async function probeBtiFrame(tabId, frameId, hint = {}) {
  try {
    return await withTimeout(probeBtiFrameInner(tabId, frameId, hint), BTI_PROBE_MS, `텐텐뱃 iframe ${frameId}`);
  } catch (_) {
    return { frameId, ping: null, slip: null, score: 0, hasInput: false, hasBoard: false };
  }
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

function mergeBtiFrameResults(results) {
  if (!results.length) return { slip: null, frameId: 0 };
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const slipHit = sorted.find((r) => r.slip?.odds > 1.01 && isBtiSlipOddsSource(r.slip));
  return slipHit ? { slip: slipHit.slip, frameId: slipHit.frameId } : { slip: null, frameId: 0 };
}

async function readBtiFromAllFrames(tabId, hint = {}, forceFull = false) {
  const order = await orderBtiFrameIds(tabId);
  const limit = forceFull ? BTI_MAX_FRAMES : Math.min(order.length, 8);
  const toProbe = order.slice(0, limit);

  if (!forceFull && lastBtiFrame?.tabId === tabId && order.includes(lastBtiFrame.frameId)) {
    await ensureBtiScript(tabId, lastBtiFrame.frameId);
    const fast = await probeBtiFrame(tabId, lastBtiFrame.frameId, hint);
    if (fast.slip?.odds > 1.01) {
      lastBtiFrame = { tabId, frameId: fast.frameId };
      return { slip: fast.slip, frameId: fast.frameId };
    }
  }

  await Promise.all(toProbe.map((fid) => ensureBtiScript(tabId, fid)));
  const results = await Promise.all(toProbe.map((fid) => probeBtiFrame(tabId, fid, hint)));
  updateBtiFrameRoles(tabId, results);
  let merged = mergeBtiFrameResults(results);

  if (!(merged.slip?.odds > 1.01) && toProbe.length < order.length) {
    const rest = order.slice(toProbe.length, BTI_MAX_FRAMES);
    const more = await Promise.all(rest.map((fid) => probeBtiFrame(tabId, fid, hint)));
    updateBtiFrameRoles(tabId, more);
    merged = mergeBtiFrameResults([...results, ...more]);
  }

  if (!(merged.slip?.odds > 1.01)) {
    const scraped = await scrapeBtiFromAllFrames(tabId);
    if (scraped.slip?.odds > 1.01 && isBtiSlipOddsSource(scraped.slip)) return scraped;
  }

  if (!(merged.slip?.odds > 1.01)) {
    const api = await fetchBtiSlipViaApi(tabId);
    if (api.slip?.odds > 1.01) {
      lastBtiFrame = { tabId, frameId: api.frameId };
      return { slip: api.slip, frameId: api.frameId };
    }
  }

  if (merged.slip?.odds > 1.01) lastBtiFrame = { tabId, frameId: merged.frameId };
  return merged;
}

function btiHintFromPoly(poly) {
  const team = poly?.teamLabel || poly?.outcome || '';
  return team ? { excludeTeam: team, polyTeam: team } : {};
}

async function readPolySlipAllBcTabs(leg2Pref = 'bcgame', opts = {}) {
  const tabs = await chrome.tabs.query({});
  const leg2Tabs = tabs
    .filter((t) => t.url && urlMatchesLeg2Pref(t.url, leg2Pref))
    .map((t) => ({ tab: t, score: scoreLeg2Tab(t.url, null, t.id, leg2Pref) }))
    .sort((a, b) => b.score - a.score);

  let best = null;
  for (const { tab } of leg2Tabs) {
    const slip = await readPolyOddsOnce({ id: tab.id, url: tab.url }, opts);
    if (!isTrustedBcSlip(slip)) continue;
    const s = scorePolySlip(slip);
    if (s > (best?._score ?? -1)) {
      best = { slip, tab: { id: tab.id, url: tab.url }, _score: s };
    }
    if (slip.sourceKind === 'bc-native-slip' || slip.fromPayout) break;
  }
  return best;
}

async function readPolySlipAllFrames(polyTab) {
  if (!polyTab?.id) return null;
  const multi = await readPolySlipAllBcTabs('bcgame');
  if (multi?.slip?.odds > 1.01) return multi.slip;
  return readPolyOddsOnce(polyTab);
}

async function readBtiBoardOddsFromFrames(btiTab, hint = {}) {
  if (!btiTab?.id) return null;
  const order = await orderBtiFrameIds(btiTab.id);
  let best = null;
  let bestScore = 0;
  for (const frameId of order.slice(0, BTI_MAX_FRAMES)) {
    await ensureBtiScript(btiTab.id, frameId);
    const res = await sendBti(btiTab.id, frameId, { type: 'READ_BTI_BOARD', hint });
    const slip = res?.slip;
    if (slip?.odds > 1.01) {
      const score = (slip.source === 'board' ? 400 : 300) + (slip.homeTeam ? 50 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = slip;
      }
    }
  }
  return best;
}

async function searchBtiBoardFromFrames(btiTab, query = '') {
  if (!btiTab?.id) {
    return { ok: false, events: [], hits: [], hitCount: 0, buttonCount: 0, eventCount: 0 };
  }
  const order = await orderBtiFrameIds(btiTab.id);
  let best = null;
  for (const frameId of order.slice(0, BTI_MAX_FRAMES)) {
    await ensureBtiScript(btiTab.id, frameId);
    const board = await sendBti(
      btiTab.id,
      frameId,
      query ? { type: 'SEARCH_ODDS', query } : { type: 'SCRAPE_BOARD' }
    );
    if (!board) continue;
    const score = (board.eventCount || 0) * 25 + (board.buttonCount || 0) + (board.hitCount || 0) * 10;
    if (!best || score > best.score) best = { ...board, frameId, score };
  }
  return best || { ok: false, events: [], hits: [], hitCount: 0, buttonCount: 0, eventCount: 0 };
}

async function readBtiOddsOnce(btiTab, poly) {
  if (!btiTab?.id) return null;

  const hint = poly ? btiHintFromPoly(poly) : {};
  let merged = await readBtiFromAllFrames(btiTab.id, { preferActiveSlip: true, ...hint }, true);
  if (merged.slip?.odds > 1.01 && isBtiSlipOddsSource(merged.slip)) return merged.slip;

  const api = await fetchBtiSlipViaApi(btiTab.id, btiTab.url);
  if (api.slip?.odds > 1.01) return api.slip;

  return null;
}

async function sendBtiToFrames(tabId, frameIds, msg) {
  const seen = new Set();
  for (const frameId of frameIds) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    const res = await sendBti(tabId, frameId, msg);
    if (!res) continue;
    if (msg.type === 'PLACE_BET' && res.success) return { res, frameId };
    if (msg.type === 'ENSURE_BTI_SLIP' && res.ok) return { res, frameId };
    if (msg.type !== 'PLACE_BET' && msg.type !== 'ENSURE_BTI_SLIP') return { res, frameId };
  }
  return { res: null, frameId: frameIds[0] || 0 };
}

async function ensureBtiSlip(btiTab, hint = {}) {
  const frameIds = await resolveBtiBetFrameIds(btiTab.id);
  let best = null;

  for (const frameId of frameIds) {
    await ensureBtiScript(btiTab.id, frameId);
    const res = await sendBti(btiTab.id, frameId, { type: 'ENSURE_BTI_SLIP', hint });
    if (!res?.ok) continue;
    const probe = await sendBti(btiTab.id, frameId, { type: 'PROBE_BET_FRAME' });
    const score = (probe?.hasInput ? 700 : 0) + (probe?.hasSlip ? 350 : 0) + (probe?.hasBtn ? 250 : 0)
      + (probe?.slipOdds > 1 ? Math.min(probe.slipOdds, 80) : 0);
    if (!best || score > best.score) best = { res, frameId, score };
  }

  if (best?.frameId != null) {
    lastBtiSlipFrame = { tabId: btiTab.id, frameId: best.frameId };
    lastBtiFrame = { tabId: btiTab.id, frameId: best.frameId };
    return best.res;
  }
  return { ok: false, reason: '슬립 준비 실패 — 베팅슬립 열기' };
}

async function resolveBtiBetFrameIds(tabId) {
  const order = await orderBtiFrameIds(tabId);
  const scored = [];

  for (const frameId of order.slice(0, BTI_MAX_FRAMES)) {
    await ensureBtiScript(tabId, frameId);
    let probe = null;
    try {
      probe = await withTimeout(sendBti(tabId, frameId, { type: 'PROBE_BET_FRAME' }), 2500, '텐텐뱃 탐색');
    } catch (_) {}
    let score = scoreBtiFrameUrl((await getAllFrames(tabId)).find((f) => f.frameId === frameId)?.url || '');
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

function isBtiStrikeReady(probe) {
  if (!probe) return false;
  if (!probe.hasInput || !probe.hasBtn) return false;
  return !!(probe.slipOpen || probe.slipCount > 0 || probe.hasSlip);
}

function isBtiProbeOpen(probe) {
  if (!probe) return false;
  if (probe.slipOpen) return true;
  if (probe.hasInput && (probe.hasBtn || probe.hasSlip)) return true;
  if (probe.hasSlip && probe.slipCount > 0 && probe.slipOdds > 1.01) return true;
  return false;
}

async function checkBtiSlipUi(btiTab) {
  if (!btiTab?.id) return { open: false, ready: false, reason: '탭 없음' };
  const frameIds = await resolveBtiBetFrameIds(btiTab.id);
  let bestOpen = null;
  let sawClosed = false;

  for (const frameId of frameIds.slice(0, BTI_MAX_FRAMES)) {
    await ensureBtiScript(btiTab.id, frameId);
    const probe = await sendBti(btiTab.id, frameId, { type: 'PROBE_BET_FRAME' });
    if (!probe) continue;
    if (isBtiProbeOpen(probe)) {
      const score = (isBtiStrikeReady(probe) ? 2000 : 0) + (probe.hasInput ? 500 : 0) + (probe.hasBtn ? 200 : 0)
        + (probe.hasSlip ? 100 : 0) + (probe.slipOdds > 1 ? Math.min(probe.slipOdds, 50) : 0);
      if (!bestOpen || score > bestOpen.score) {
        bestOpen = {
          open: true,
          ready: !!(probe.ready || (probe.hasInput && probe.hasBtn)),
          strikeReady: isBtiStrikeReady(probe),
          frameId,
          probe,
          score,
          slipCount: probe.slipCount || 0
        };
      }
    } else if (!probe.hasInput && !probe.hasSlip && !probe.slipOpen) {
      sawClosed = true;
    }
  }

  if (bestOpen) return bestOpen;
  return {
    open: false,
    ready: false,
    strikeReady: false,
    reason: sawClosed ? '슬립 닫힘' : '베팅슬립 없음'
  };
}

async function orderBcAmountFrameIds(tabId, tabUrl) {
  const ordered = await orderBcLeg2FrameIds(tabId, tabUrl);
  const ids = [0];
  if (lastBcLeg2Frame?.tabId === tabId && !ids.includes(lastBcLeg2Frame.frameId)) {
    ids.push(lastBcLeg2Frame.frameId);
  }
  for (const id of ordered) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function probeBcMainFrame(polyTab) {
  if (!polyTab?.id) return null;
  try {
    await ensurePolyScript(polyTab.id, 0);
    const res = await sendPoly(polyTab.id, { type: 'PROBE_POLY' }, 0);
    return res?.probe || null;
  } catch (_) {
    return null;
  }
}

async function setPolyAmountOnFrame(polyTab, amountUsd, frameId) {
  const slipRead = await setPolyAmountViaSlipRead(polyTab, amountUsd, frameId);
  if (slipRead?.ok) return slipRead;
  const deep = await setPolyAmountViaDeep(polyTab, amountUsd, frameId);
  if (deep?.ok) return deep;
  await ensurePolyScript(polyTab.id, frameId);
  const res = await sendPoly(polyTab.id, { type: 'SET_POLY_AMOUNT', amount: amountUsd, force: true }, frameId);
  if (res?.ok || res?.partial) return res;
  return null;
}

async function placePolyBetOnFrame(polyTab, amountUsd, frameId, opts = {}) {
  const skipFill = !!opts.skipFill;
  const fastStrike = !!opts.fastStrike;
  const teamHint = opts.teamHint || '';
  if (!skipFill && !fastStrike) {
    const fill = await setPolyAmountOnFrame(polyTab, amountUsd, frameId);
    if (!fill?.ok && !fill?.partial) return { success: false, reason: fill?.reason || 'stake-fill-fail', frameId };
  }
  await ensurePolyScript(polyTab.id, frameId);
  const res = await sendPoly(polyTab.id, {
    type: 'PLACE_BET',
    amount: amountUsd,
    skipFill: skipFill || fastStrike,
    fastStrike,
    teamHint
  }, frameId);
  if (res?.success) return { ...res, frameId, method: 'poly-cs' };
  try {
    await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [frameId] },
      files: ['bc_slip_read.js']
    });
    const slipBet = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [frameId] },
      func: async (amount) => (typeof window.__bcPlaceBet === 'function' ? window.__bcPlaceBet(amount) : null),
      args: [amountUsd]
    });
    const hit = slipBet?.[0]?.result;
    if (hit?.success) return { ...hit, frameId, method: 'slip-read-bet' };
  } catch (_) {}
  const deepRes = await placePolyBetViaDeep(polyTab, amountUsd, frameId);
  if (deepRes?.success) return { ...deepRes, frameId, method: 'sports-deep' };
  return res || deepRes || { success: false, reason: 'bet-fail', frameId };
}

async function orderBcLeg2FrameIds(tabId, tabUrl) {
  const frames = await getAllFrames(tabId);
  const scored = frames.map((f) => ({
    frameId: f.frameId,
    score: scoreBcLeg2FrameUrl(f.url || '', tabUrl) + (f.frameId === 0 ? 2 : 0),
    url: f.url || ''
  }));
  if (tabUrl && isBcGameSportsUrl(tabUrl)) {
    const main = scored.find((s) => s.frameId === 0);
    if (main) main.score += 500;
  }
  if (lastBcLeg2Frame?.tabId === tabId) {
    const hit = scored.find((s) => s.frameId === lastBcLeg2Frame.frameId);
    if (hit) hit.score += 120;
  }
  scored.sort((a, b) => b.score - a.score);
  const ids = scored.filter((s) => s.score >= 15).map((s) => s.frameId);
  const allIds = frames.map((f) => f.frameId);
  return [...new Set([...ids, ...allIds])];
}

function mapBtiProbeToPolyProbe(probe) {
  if (!probe) return null;
  return {
    hasPanel: !!(probe.hasInput || probe.hasSlip || probe.slipOpen),
    hasInput: !!probe.hasInput,
    hasBtn: !!probe.hasBtn,
    stake: probe.stake || null,
    btnText: probe.btnText || '',
    btnDisabled: probe.btnDisabled ?? null,
    team: probe.team || '',
    mode: 'sports-bti',
    slipCount: probe.slipCount || 0,
    slipOdds: probe.slipOdds || 0
  };
}

async function probeBcLeg2Frames(polyTab) {
  if (!polyTab?.id) return null;
  const frameIds = await orderBcLeg2FrameIds(polyTab.id, polyTab.url);
  let best = null;

  for (const frameId of frameIds.slice(0, BTI_MAX_FRAMES)) {
    let probe = null;
    try {
      await ensureBcScrapeScript(polyTab.id, frameId);
      const deep = await chrome.scripting.executeScript({
        target: { tabId: polyTab.id, frameIds: [frameId] },
        world: 'MAIN',
        func: () => {
          if (typeof window.__bcScrapeOdds !== 'function') return null;
          const slip = window.__bcScrapeOdds();
          if (!slip?.ok) return null;
          return {
            hasPanel: !!(slip.hasInput && slip.odds > 1.01 && (slip.sourceKind === 'bc-native-slip' || slip.sourceKind === 'sports-slip')),
            hasInput: !!slip.hasInput,
            hasBtn: false,
            stake: slip.stake || null,
            team: slip.teamLabel || '',
            mode: 'sports-deep',
            slipOdds: slip.odds || 0
          };
        }
      });
      probe = deep?.[0]?.result;
    } catch (_) {}

    if (!probe?.hasBtn) {
      await ensureBtiScript(polyTab.id, frameId);
      const btiProbe = await sendBti(polyTab.id, frameId, { type: 'PROBE_BET_FRAME' });
      if (btiProbe) probe = mapBtiProbeToPolyProbe(btiProbe);
    }
    if (!probe) continue;

    const score = (probe.hasInput ? 700 : 0) + (probe.hasBtn ? 500 : 0) + (probe.hasPanel ? 200 : 0)
      + (probe.slipOdds > 1 ? Math.min(probe.slipOdds, 80) : 0);
    if (!best || score > best.score) best = { probe, score, frameId };
  }

  if (best?.frameId != null) {
    lastBcLeg2Frame = { tabId: polyTab.id, frameId: best.frameId };
    return best.probe;
  }
  return null;
}

async function probePolyStrikeUi(polyTab) {
  if (!polyTab?.id) return null;
  if (isBcGameSportsUrl(polyTab.url)) {
    const mainProbe = await probeBcMainFrame(polyTab);
    if (mainProbe?.hasInput && mainProbe?.hasBtn) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: 0 };
      return mainProbe;
    }
    const btiProbe = await probeBcLeg2Frames(polyTab);
    if (btiProbe?.hasPanel || btiProbe?.hasBtn) return btiProbe;
    if (mainProbe?.hasInput || mainProbe?.hasPanel) return mainProbe;
  }
  await ensurePolyScript(polyTab.id);
  const res = await sendPoly(polyTab.id, { type: 'PROBE_POLY' });
  return res?.probe || null;
}

async function verifyStrikeReady(found, hint = {}, poly = null, opts = {}) {
  if (!found?.btiTab?.id || !found?.polyTab?.id) {
    return { ok: false, reason: '탭 없음', btiClosed: false };
  }
  const fast = !!opts.fast;
  const polyTeam = poly?.teamLabel || poly?.outcome || hint?.polyTeam || hint?.excludeTeam || '';
  const probes = [
    checkBtiSlipUi(found.btiTab),
    probePolyStrikeUi(found.polyTab)
  ];
  if (!fast) probes.push(readPolyOddsOnce(found.polyTab));
  const results = await Promise.all(probes);
  const btiUi = results[0];
  const polyProbe = results[1];
  const freshPoly = fast ? null : results[2];

  if (!btiUi?.strikeReady) {
    const closed = !btiUi?.probe?.hasInput || btiUi?.reason === '슬립 닫힘';
    return {
      ok: false,
      btiClosed: closed,
      reason: closed ? '텐텐뱃 슬립 닫힘' : '텐텐뱃 슬립 미준비 — 베팅슬립 열기',
      btiUi,
      polyProbe
    };
  }

  const strikePoly = isStrikeBcSlip(freshPoly) ? freshPoly : (isStrikeBcSlip(poly) ? poly : null);
  if (!strikePoly) {
    return {
      ok: false,
      btiClosed: false,
      reason: 'BC.Game 슬립 없음 — 카트에 배당 선택 후 스캔',
      btiUi,
      polyProbe
    };
  }

  if (!polyProbe?.hasInput || !polyProbe?.hasBtn || polyProbe?.btnDisabled) {
    return {
      ok: false,
      btiClosed: false,
      reason: 'BC.Game 배팅 준비 안됨 — 슬립 열기·금액 입력 확인',
      btiUi,
      polyProbe
    };
  }

  if (polyProbe?.slipOdds > 1.01 && Math.abs(polyProbe.slipOdds - strikePoly.odds) > 0.2) {
    return {
      ok: false,
      btiClosed: false,
      reason: 'BC.Game 배당 불일치 — 슬립 다시 확인',
      btiUi,
      polyProbe
    };
  }

  return { ok: true, btiUi, polyProbe, polyTeam, strikePoly };
}

async function placeBtiBet(btiTab, amount, targetOdds, hint = {}) {
  const msg = { type: 'PLACE_BET', amount, targetOdds, hint };
  if (hint.fastStrike && lastBtiSlipFrame?.tabId === btiTab.id) {
    await ensureBtiScript(btiTab.id, lastBtiSlipFrame.frameId);
    const fastRes = await sendBti(btiTab.id, lastBtiSlipFrame.frameId, msg);
    if (fastRes?.success) return { ...fastRes, frameId: lastBtiSlipFrame.frameId };
  }

  const baseIds = await resolveBtiBetFrameIds(btiTab.id);
  const frameIds = [];
  if (lastBtiSlipFrame?.tabId === btiTab.id) frameIds.push(lastBtiSlipFrame.frameId);
  for (const id of baseIds) if (!frameIds.includes(id)) frameIds.push(id);

  let lastRes = null;
  for (const frameId of frameIds) {
    await ensureBtiScript(btiTab.id, frameId);
    const res = await sendBti(btiTab.id, frameId, msg);
    if (!res) continue;
    lastRes = res;
    if (res.success) {
      lastBtiSlipFrame = { tabId: btiTab.id, frameId };
      return { ...res, frameId };
    }
  }
  return lastRes || { success: false, reason: '텐텐뱃 응답 없음 — 슬립/iframe 확인' };
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

async function setPolyAmountViaSlipRead(polyTab, amountUsd, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [frameId] },
      files: ['bc_slip_read.js']
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [frameId] },
      func: async (amount) => {
        if (typeof window.__bcSetStake !== 'function') return { ok: false, reason: 'no-set-stake' };
        return await window.__bcSetStake(amount);
      },
      args: [amountUsd]
    });
    return results?.[0]?.result || { ok: false, reason: 'slip-read-set-fail' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function setPolyAmountViaDeep(polyTab, amountUsd, frameId) {
  try {
    await ensureBcScrapeScript(polyTab.id, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [frameId] },
      world: 'MAIN',
      func: (amount) => window.__bcSetStake?.(amount),
      args: [amountUsd]
    });
    return results?.[0]?.result || { ok: false, reason: 'deep-set-fail' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function placePolyBetViaDeep(polyTab, amountUsd, frameId) {
  try {
    await ensureBcScrapeScript(polyTab.id, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [frameId] },
      world: 'MAIN',
      func: async (amount) => window.__bcPlaceSportsBet?.(amount),
      args: [amountUsd]
    });
    return results?.[0]?.result || { success: false, reason: 'deep-bet-fail' };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

async function setPolyAmount(polyTab, amountUsd) {
  if (!polyTab?.id) return { ok: false, reason: '탭 없음' };
  if (isBcGameSportsUrl(polyTab.url)) {
    const frameIds = await orderBcAmountFrameIds(polyTab.id, polyTab.url);
    let bestPartial = null;
    for (const frameId of frameIds.slice(0, BTI_MAX_FRAMES)) {
      const hit = await setPolyAmountOnFrame(polyTab, amountUsd, frameId);
      if (hit?.ok) {
        lastBcLeg2Frame = { tabId: polyTab.id, frameId };
        return hit;
      }
      if (hit?.partial && !bestPartial) bestPartial = { ...hit, frameId };
    }
    if (bestPartial) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: bestPartial.frameId };
      return bestPartial;
    }
    return { ok: false, reason: 'BC.Game 금액 입력 실패 — 슬립 금액란 클릭 후 재시도' };
  }
  await ensurePolyScript(polyTab.id);
  const res = await sendPoly(polyTab.id, { type: 'SET_POLY_AMOUNT', amount: amountUsd, force: true });
  return res || { ok: false, reason: '응답 없음' };
}

async function ensurePolyPanel(polyTab, teamHint) {
  if (!polyTab?.id) return { ok: false, reason: '탭 없음' };
  if (isBcGameSportsUrl(polyTab.url)) {
    await ensurePolyScript(polyTab.id, 0);
    const main = await sendPoly(polyTab.id, { type: 'ENSURE_POLY_PANEL', team: teamHint || '' }, 0);
    if (main?.ok) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: 0 };
      return { ...main, frameId: 0 };
    }
    const probe = await probeBcMainFrame(polyTab);
    if (probe?.hasInput && probe?.hasBtn) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: 0 };
      return { ok: true, alreadyOpen: true, frameId: 0 };
    }
    const frameIds = await orderBcAmountFrameIds(polyTab.id, polyTab.url);
    for (const frameId of frameIds.slice(0, BTI_MAX_FRAMES)) {
      if (frameId === 0) continue;
      await ensurePolyScript(polyTab.id, frameId);
      const res = await sendPoly(polyTab.id, { type: 'ENSURE_POLY_PANEL', team: teamHint || '' }, frameId);
      if (res?.ok) {
        lastBcLeg2Frame = { tabId: polyTab.id, frameId };
        return { ...res, frameId };
      }
    }
    return { ok: false, reason: 'BC.Game 슬립 없음 — 배당 클릭' };
  }
  await ensurePolyScript(polyTab.id);
  const res = await sendPoly(polyTab.id, { type: 'ENSURE_POLY_PANEL', team: teamHint || '' });
  return res || { ok: false, reason: '응답 없음' };
}

async function placePolyBet(polyTab, amountUsd, opts = {}) {
  if (!polyTab?.id) return { success: false, reason: '탭 없음' };
  const skipFill = !!opts.skipFill;
  const fastStrike = !!opts.fastStrike;
  const teamHint = opts.teamHint || '';

  if (isBcGameSportsUrl(polyTab.url)) {
    if (!skipFill && !fastStrike) await ensurePolyPanel(polyTab, teamHint);
    const frameIds = await orderBcAmountFrameIds(polyTab.id, polyTab.url);
    for (const frameId of frameIds.slice(0, BTI_MAX_FRAMES)) {
      const res = await placePolyBetOnFrame(polyTab, amountUsd, frameId, { skipFill, fastStrike, teamHint });
      if (res?.success) {
        lastBcLeg2Frame = { tabId: polyTab.id, frameId: res.frameId ?? frameId };
        return res;
      }
    }
    return { success: false, reason: 'BC.Game 배팅 실패 — 슬립·금액·베팅하기 확인' };
  }

  if (!skipFill && !fastStrike) await ensurePolyPanel(polyTab, teamHint);
  await injectPolyMain(polyTab.id);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id },
      world: 'MAIN',
      func: async (amount, fast, skip) => {
        if (typeof window.__polyMainPlaceBet === 'function') {
          return await window.__polyMainPlaceBet(amount, { skipFill: fast || skip, fastStrike: fast });
        }
        return { success: false, reason: 'MAIN 스크립트 없음' };
      },
      args: [amountUsd, fastStrike, skipFill]
    });
    const mainRes = results?.[0]?.result;
    if (mainRes?.success) return mainRes;
    if ((skipFill || fastStrike) && mainRes && !mainRes.success) {
      const retry = await chrome.scripting.executeScript({
        target: { tabId: polyTab.id },
        world: 'MAIN',
        func: async (amount) => window.__polyMainPlaceBet?.(amount, { skipFill: false }),
        args: [amountUsd]
      });
      const retryRes = retry?.[0]?.result;
      if (retryRes?.success) return retryRes;
    }
  } catch (e) {
    /* fallback below */
  }

  await ensurePolyScript(polyTab.id);
  const fallback = await sendPoly(polyTab.id, {
    type: 'PLACE_BET',
    amount: amountUsd,
    skipFill,
    fastStrike,
    teamHint
  });
  if (fallback?.success) return fallback;
  return fallback || { success: false, reason: 'BC.Game 배팅 실패' };
}

async function syncBothAmounts(found, btiBetKrw, polyUsd, hint) {
  const tasks = [];
  if (found?.btiTab?.id && btiBetKrw > 0) {
    tasks.push(setBtiAmount(found.btiTab, btiBetKrw));
  }
  if (found?.polyTab?.id && polyUsd > 0) {
    tasks.push(setPolyAmount(found.polyTab, polyUsd));
  }
  if (found?.btiTab?.id && hint) {
    tasks.push(ensureBtiSlip(found.btiTab, hint).catch(() => null));
  }
  return Promise.all(tasks);
}

async function prewarmTabs(btiTab, polyTab, hint, btiBetKrw, polyUsd) {
  const tasks = [];
  if (btiTab?.id) {
    tasks.push(ensureBtiScript(btiTab.id, btiSlipFrameId(btiTab.id)));
    if (hint) tasks.push(ensureBtiSlip(btiTab, hint));
    if (btiBetKrw > 0) tasks.push(setBtiAmount(btiTab, btiBetKrw));
  }
  if (polyTab?.id) {
    tasks.push(ensurePolyScript(polyTab.id));
    tasks.push(injectPolyMain(polyTab.id));
    if (polyUsd > 0) tasks.push(setPolyAmount(polyTab, polyUsd));
  }
  await Promise.all(tasks);
}

async function readSnapshot(leg2Pref, btiBetKrw, usdRate, opts = {}) {
  const found = await findTabs(leg2Pref);
  if (!found.btiTab && !found.polyTab) {
    return { ok: false, reason: 'x10x10s + BC.Game 탭을 열어주세요', found };
  }
  if (!found.btiTab) {
    return { ok: false, reason: '텐텐뱃: x10x10s.com 스포츠 탭 없음', found };
  }
  if (!found.polyTab) {
    return { ok: false, reason: 'BC.Game: 스포츠/예측 탭 없음', found };
  }

  const arbBtiPre = await readBtiOddsOnce(found.btiTab, null);
  const teamHint = opts.teamHint || arbBtiPre?.teamLabel || arbBtiPre?.outcome || '';
  const readOpts = { ...opts, teamHint, autoClick: opts.autoClick !== false };

  const multi = await readPolySlipAllBcTabs(leg2Pref, readOpts);
  const poly = multi?.slip?.odds > 1.01 ? multi.slip : await readPolyOddsOnce(found.polyTab, readOpts);
  if (multi?.tab) found.polyTab = multi.tab;
  const arbBti = await readBtiOddsOnce(found.btiTab, poly);
  const bti = arbBti;

  const polyO = poly?.odds > 1 && isScanBcSlip(poly) ? normalizeSportsOdds(poly.odds) : null;
  const btiO = arbBti?.odds > 1 ? normalizeSportsOdds(arbBti.odds) : null;
  const profit = (btiO && polyO) ? calcProfit(btiO, polyO) : null;
  const polyUsd = (btiO && polyO) ? calcPolyBetUsd(btiBetKrw, btiO, polyO, usdRate) : 0;

  let reason = '';
  if (!btiO && polyO) reason = '텐텐뱃 배당 없음 — 스포츠 페이지·배당 클릭 확인';
  else if (btiO && !polyO) reason = 'BC.Game 슬립 없음 — 카트에 배당 선택 후 스캔';
  else if (btiO && poly?.odds > 1 && !isScanBcSlip(poly)) reason = 'BC.Game 슬립 없음 — 카트에 배당 선택 후 스캔';

  return {
    ok: true,
    found,
    poly,
    bti,
    arbBti,
    polyO,
    btiO,
    profit,
    polyUsd,
    reason,
    hint: btiHintFromPoly(poly)
  };
}

async function strikeBothSides(ctx) {
  const { found, btiO, polyO, polyUsd, hint, btiBetKrw, polyPreSynced, poly, gate: passedGate } = ctx;
  const t0 = performance.now();
  const polyTeam = poly?.teamLabel || poly?.outcome || hint?.polyTeam || hint?.excludeTeam || '';
  const fast = !!(polyPreSynced || ctx.fastStrike);
  const strikeHint = { ...hint, forArbPick: true };

  const gate = passedGate?.ok
    ? passedGate
    : await verifyStrikeReady(found, hint, poly, { fast });
  if (!gate.ok) {
    return {
      ok: false,
      btiRes: { success: false, reason: gate.reason },
      polyRes: { success: false, reason: gate.reason || 'BC 미준비' },
      elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
      gated: true
    };
  }

  const strikePoly = gate.strikePoly || poly;
  if (!fast) {
    await Promise.all([
      (async () => {
        try {
          const ui = await checkBtiSlipUi(found.btiTab);
          const slipCount = ui?.slipCount || ui?.probe?.slipCount || 0;
          if (!ui.ready) {
            await withTimeout(
              ensureBtiSlip(found.btiTab, { ...strikeHint, clearSlips: slipCount > 1 }),
              5000,
              '텐텐뱃 슬립 준비'
            );
          }
        } catch (_) {}
      })(),
      withTimeout(ensurePolyPanel(found.polyTab, polyTeam), 4000, 'BC.Game 슬립 준비').catch(() => null)
    ]);
  }

  const btiHint = { ...strikeHint, forceBet: true, skipEnsure: fast, fastStrike: fast };
  const polyOpts = { skipFill: fast, fastStrike: fast, teamHint: polyTeam };
  const btiPromise = withTimeout(
    placeBtiBet(found.btiTab, btiBetKrw, btiO || strikePoly?.odds || null, btiHint),
    25000,
    '텐텐뱃 배팅'
  ).catch((e) => ({ success: false, reason: e.message }));
  const polyPromise = withTimeout(
    placePolyBet(found.polyTab, polyUsd, polyOpts),
    25000,
    'BC.Game 배팅'
  ).catch((e) => ({ success: false, reason: e.message }));

  const [btiRes, polyRes] = await Promise.all([btiPromise, polyPromise]);

  return {
    ok: !!(btiRes?.success && polyRes?.success),
    btiRes,
    polyRes,
    elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
    oneSided: !!(btiRes?.success !== polyRes?.success)
  };
}

async function readArbBotBridgeState(btiTab, polyTab) {
  const tabs = [btiTab, polyTab].filter(Boolean);
  for (const tab of tabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => (typeof window.__arbAutoReadState === 'function' ? window.__arbAutoReadState() : null)
      });
      const state = results?.[0]?.result;
      if (state?.profit != null && state.ts && Date.now() - state.ts < 3000) return state;
    } catch (_) {}
  }
  return null;
}
