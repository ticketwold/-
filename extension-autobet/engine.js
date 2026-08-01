// engine.js — 탭 탐색, 슬립 읽기, 동시 배팅
'use strict';

const BTI_HOST_HINTS = ['bti-sports.io', 'bti-sports.com', 'live8588.com', 'fxf774.com'];
const INJECTABLE_SUFFIXES = ['bti-sports.com', 'bti-sports.io', 'x10x10s.com', 'live8588.com', 'fxf774.com'];

let lastBtiFrame = null;
let lastBtiSlipFrame = null;
let lastBtiBoardFrame = null;
let polyScriptReady = new Set();
let btiScriptReady = new Set();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

async function ensurePolyScript(tabId, frameId = 0) {
  const key = frameId ? `${tabId}:${frameId}` : String(tabId);
  if (polyScriptReady.has(key)) return;
  try {
    const target = frameId ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['polymarket_content.js'] });
    polyScriptReady.add(key);
    if (!frameId) polyScriptReady.add(String(tabId));
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

async function findTabs(leg2Pref = 'auto') {
  const tabs = await chrome.tabs.query({});
  let btiTab = null;
  const leg2Tabs = [];
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = activeTabs[0]?.id;

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (urlMatchesLeg2Pref(tab.url, leg2Pref)) leg2Tabs.push(tab);
    if (isWrapperUrl(tab.url) && !btiTab) btiTab = tab;
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

function btiHintFromPoly(poly) {
  const team = poly?.teamLabel || poly?.outcome || '';
  return team ? { excludeTeam: team, polyTeam: team } : {};
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

async function probeBtiFrame(tabId, frameId, hint = {}) {
  await ensureBtiScript(tabId, frameId);
  const ping = await sendBti(tabId, frameId, { type: 'PING' });
  if (!ping?.ok) return { frameId, slip: null, score: 0 };
  const res = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint });
  const slip = res?.slip;
  let score = 0;
  if (slip?.odds > 1.01) score += 1000;
  if (ping?.hasInput) score += 500;
  if (ping?.buttonCount) score += Math.min(ping.buttonCount, 100);
  return { frameId, slip, score, hasInput: !!ping?.hasInput, hasBoard: (ping?.buttonCount || 0) > 0 };
}

async function readBtiFromAllFrames(tabId, hint = {}) {
  const frames = await getAllFrames(tabId);
  const order = [];
  if (lastBtiFrame?.tabId === tabId) order.push(lastBtiFrame.frameId);
  for (const f of frames) if (!order.includes(f.frameId)) order.push(f.frameId);

  const results = await Promise.all(order.map((fid) => probeBtiFrame(tabId, fid, hint)));
  let slipFrame = null;
  let boardFrame = null;
  for (const r of results) {
    if (r.hasInput) slipFrame = r.frameId;
    if (r.hasBoard) boardFrame = r.frameId;
  }
  if (slipFrame != null) lastBtiSlipFrame = { tabId, frameId: slipFrame };
  if (boardFrame != null) lastBtiBoardFrame = { tabId, frameId: boardFrame };

  const sorted = [...results].sort((a, b) => b.score - a.score);
  const best = sorted.find((r) => r.slip?.odds > 1.01) || sorted[0];
  if (best?.slip?.odds > 1.01) lastBtiFrame = { tabId, frameId: best.frameId };
  return { slip: best?.slip || null, frameId: best?.frameId ?? 0 };
}

async function readBtiArbOdds(btiTab, poly) {
  if (!btiTab?.id) return null;
  const merged = await readBtiFromAllFrames(btiTab.id, btiHintFromPoly(poly));
  return merged.slip?.odds > 1.01 ? merged.slip : null;
}

async function readBtiSlip(btiTab) {
  if (!btiTab?.id) return null;
  const merged = await readBtiFromAllFrames(btiTab.id, {});
  return merged.slip?.odds > 1 ? merged.slip : null;
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
  const frameIds = [btiBoardFrameId(btiTab.id), btiSlipFrameId(btiTab.id), 0];
  const { res } = await sendBtiToFrames(btiTab.id, frameIds, { type: 'ENSURE_BTI_SLIP', hint });
  return res || { ok: false, reason: '응답 없음' };
}

async function placeBtiBet(btiTab, amount, targetOdds, hint = {}) {
  const frameIds = [btiSlipFrameId(btiTab.id), lastBtiFrame?.tabId === btiTab.id ? lastBtiFrame.frameId : 0, btiBoardFrameId(btiTab.id)];
  const { res } = await sendBtiToFrames(btiTab.id, frameIds, {
    type: 'PLACE_BET', amount, targetOdds, hint
  });
  return res || { success: false, reason: '응답 없음' };
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

async function setPolyAmount(polyTab, amountUsd) {
  if (!polyTab?.id) return { ok: false, reason: '탭 없음' };
  await ensurePolyScript(polyTab.id);
  const res = await sendPoly(polyTab.id, { type: 'SET_POLY_AMOUNT', amount: amountUsd, force: true });
  return res || { ok: false, reason: '응답 없음' };
}

async function placePolyBet(polyTab, amountUsd) {
  if (!polyTab?.id) return { success: false, reason: '탭 없음' };
  await injectPolyMain(polyTab.id);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id },
      world: 'MAIN',
      func: async (amount) => {
        if (typeof window.__polyMainPlaceBet === 'function') {
          return await window.__polyMainPlaceBet(amount);
        }
        return { success: false, reason: 'MAIN 스크립트 없음' };
      },
      args: [amountUsd]
    });
    return results?.[0]?.result || { success: false, reason: 'MAIN 응답 없음' };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

async function prewarmTabs(btiTab, polyTab, hint) {
  const tasks = [];
  if (btiTab?.id) {
    tasks.push(ensureBtiSlip(btiTab, hint));
    tasks.push(ensureBtiScript(btiTab.id, btiSlipFrameId(btiTab.id)));
  }
  if (polyTab?.id) {
    tasks.push(ensurePolyScript(polyTab.id));
    tasks.push(injectPolyMain(polyTab.id));
  }
  await Promise.all(tasks);
}

async function readSnapshot(leg2Pref, btiBetKrw, usdRate) {
  const found = await findTabs(leg2Pref);
  if (!found.btiTab || !found.polyTab) {
    return { ok: false, reason: '탭 없음', found };
  }

  const [poly, bti, arbBti] = await Promise.all([
    readPolySlipAllFrames(found.polyTab),
    readBtiSlip(found.btiTab),
    readPolySlipAllFrames(found.polyTab).then((p) => readBtiArbOdds(found.btiTab, p))
  ]);

  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = arbBti?.odds > 1 ? arbBti.odds : (bti?.odds > 1 ? bti.odds : null);
  const profit = (btiO && polyO) ? calcProfit(btiO, polyO) : null;
  const polyUsd = (btiO && polyO) ? calcPolyBetUsd(btiBetKrw, btiO, polyO, usdRate) : 0;

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
    hint: btiHintFromPoly(poly)
  };
}

async function strikeBothSides(ctx) {
  const { found, btiO, polyO, polyUsd, hint, btiBetKrw } = ctx;
  const t0 = performance.now();

  const [btiRes, polyRes] = await Promise.all([
    placeBtiBet(found.btiTab, btiBetKrw, btiO, hint),
    placePolyBet(found.polyTab, polyUsd)
  ]);

  return {
    ok: !!(btiRes?.success && polyRes?.success),
    btiRes,
    polyRes,
    elapsedMs: Math.round((performance.now() - t0) * 100) / 100
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
