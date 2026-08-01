// engine.js — 탭 탐색, 슬립 읽기, 동시 배팅
'use strict';

let lastBtiFrame = null;
let lastBtiSlipFrame = null;
let lastBtiBoardFrame = null;
let polyScriptReady = new Set();
let btiScriptReady = new Set();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const BTI_PROBE_MS = 5000;
const BTI_MAX_FRAMES = 8;
const POLY_FRAME_MS = 3000;
const POLY_MAX_FRAMES = 6;

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

async function ensureAllBtiScripts(tabId) {
  const frames = await getAllFrames(tabId);
  await Promise.all(frames.map((f) => ensureBtiScript(tabId, f.frameId)));
}

async function findTabs(leg2Pref = 'auto') {
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

async function probeBtiFrameInner(tabId, frameId, hint = {}) {
  let ping = await sendBti(tabId, frameId, { type: 'PING' });
  if (!ping?.ok) {
    await ensureBtiScript(tabId, frameId);
    ping = await sendBti(tabId, frameId, { type: 'PING' });
  }

  const readHint = hint.preferActiveSlip ? hint : { preferActiveSlip: true, ...hint };
  const contentPromise = ping?.ok
    ? sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: readHint }).then((res) => res?.slip || null)
    : Promise.resolve(null);
  const scrapePromise = injectReadBtiFrame(tabId, frameId);

  let [contentSlip, scraped] = await Promise.all([contentPromise, scrapePromise]);
  let slip = (contentSlip?.odds > 1.01) ? contentSlip : scraped;

  if (!(slip?.odds > 1.01) && contentSlip?.odds > 1.01) slip = contentSlip;
  if (!(slip?.odds > 1.01) && scraped?.odds > 1.01) slip = scraped;

  if (!(slip?.odds > 1.01) && ping?.ok) {
    const res2 = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: { preferActiveSlip: true } });
    if (res2?.slip?.odds > 1.01) slip = res2.slip;
    else if (hint.excludeTeam || hint.polyTeam) {
      const res3 = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: { ...hint, forArbPick: true } });
      if (res3?.slip?.odds > 1.01) slip = res3.slip;
    }
    if (!(slip?.odds > 1.01)) {
      const scraped2 = await injectReadBtiFrame(tabId, frameId);
      if (scraped2?.odds > 1.01) slip = scraped2;
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
    return await withTimeout(probeBtiFrameInner(tabId, frameId, hint), BTI_PROBE_MS, `BTI프레임${frameId}`);
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
  const slipPanel = sorted.find((r) => r.slip?.source === 'slip-display' && r.slip?.odds > 1.01);
  const boardHit = sorted.find((r) => r.slip?.odds > 1.01 && (r.slip?.buttonCount > 0 || r.ping?.buttonCount > 0));
  if (slipPanel?.slip && boardHit?.slip && slipPanel.frameId !== boardHit.frameId) {
    return {
      slip: {
        ...slipPanel.slip,
        odds: boardHit.slip.odds,
        source: 'merged',
        buttonCount: boardHit.slip.buttonCount || boardHit.ping?.buttonCount || 0
      },
      frameId: boardHit.frameId
    };
  }
  const pick = sorted.find((r) => r.slip?.odds > 1.01) || sorted[0];
  return { slip: pick?.slip || null, frameId: pick?.frameId ?? 0 };
}

async function readBtiFromAllFrames(tabId, hint = {}, forceFull = false) {
  const frames = await getAllFrames(tabId);
  const order = [];
  if (lastBtiFrame?.tabId === tabId) order.push(lastBtiFrame.frameId);
  for (const f of frames) if (!order.includes(f.frameId)) order.push(f.frameId);
  const toProbe = order.slice(0, forceFull ? BTI_MAX_FRAMES : Math.min(order.length, 4));

  if (!forceFull && lastBtiFrame?.tabId === tabId) {
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
  const merged = mergeBtiFrameResults(results);
  if (merged.slip?.odds > 1.01) lastBtiFrame = { tabId, frameId: merged.frameId };
  return merged;
}

function btiHintFromPoly(poly) {
  const team = poly?.teamLabel || poly?.outcome || '';
  return team ? { excludeTeam: team, polyTeam: team } : {};
}

async function readPolySlipAllFrames(polyTab) {
  const frames = await getAllFrames(polyTab.id);
  const order = [0, ...frames.map((f) => f.frameId).filter((id) => id !== 0)].slice(0, POLY_MAX_FRAMES);
  const seen = new Set();
  let best = null;
  for (const frameId of order) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    await ensurePolyScript(polyTab.id, frameId);
    let res;
    try {
      res = await withTimeout(sendPoly(polyTab.id, { type: 'READ_SLIP' }, frameId), POLY_FRAME_MS, 'Poly읽기');
    } catch (_) {
      continue;
    }
    const slip = res?.slip;
    if (slip?.fromPayout && slip.odds > 1) return slip;
    if (slip?.odds > 1 || slip?.needsStake) {
      if (!best || slip.fromPayout || (slip.odds > 1 && !best.odds)) best = slip;
    }
  }
  return best;
}

async function readBtiOddsOnce(btiTab, poly) {
  if (!btiTab?.id) return null;
  let merged = await readBtiFromAllFrames(btiTab.id, { preferActiveSlip: true }, false);
  if (merged.slip?.odds > 1.01) return merged.slip;

  const arbHint = { ...btiHintFromPoly(poly), forArbPick: true };
  merged = await readBtiFromAllFrames(btiTab.id, arbHint, false);
  if (!(merged.slip?.odds > 1.01)) {
    merged = await readBtiFromAllFrames(btiTab.id, arbHint, true);
  }
  return merged.slip?.odds > 1.01 ? merged.slip : null;
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
  const { res } = await sendBtiToFrames(btiTab.id, frameIds, { type: 'ENSURE_BTI_SLIP', hint });
  return res || { ok: false, reason: '응답 없음' };
}

async function resolveBtiBetFrameIds(tabId) {
  const frames = await getAllFrames(tabId);
  const order = [];
  if (lastBtiSlipFrame?.tabId === tabId) order.push(lastBtiSlipFrame.frameId);
  if (lastBtiFrame?.tabId === tabId && !order.includes(lastBtiFrame.frameId)) order.push(lastBtiFrame.frameId);
  if (lastBtiBoardFrame?.tabId === tabId && !order.includes(lastBtiBoardFrame.frameId)) order.push(lastBtiBoardFrame.frameId);
  for (const f of frames) if (!order.includes(f.frameId)) order.push(f.frameId);

  const scored = [];
  for (const frameId of order.slice(0, BTI_MAX_FRAMES)) {
    await ensureBtiScript(tabId, frameId);
    let probe = null;
    try {
      probe = await withTimeout(sendBti(tabId, frameId, { type: 'PROBE_BET_FRAME' }), 2500, 'BTI탐색');
    } catch (_) {}
    if (!probe) continue;
    let score = 0;
    if (probe.hasInput) score += 500;
    if (probe.hasBtn) score += 400;
    if (probe.hasSlip) score += 200;
    if (probe.slipOdds > 1) score += Math.min(probe.slipOdds, 50);
    if (probe.hasInput && probe.hasBtn) score += 300;
    scored.push({ frameId, score, probe });
  }
  scored.sort((a, b) => b.score - a.score);
  const ids = scored.filter((s) => s.score >= 400).map((s) => s.frameId);
  return ids.length ? ids : (scored[0] ? [scored[0].frameId] : [btiSlipFrameId(tabId), 0]);
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

async function placeBtiBet(btiTab, amount, targetOdds, hint = {}) {
  const frameIds = await resolveBtiBetFrameIds(btiTab.id);
  const msg = { type: 'PLACE_BET', amount, targetOdds, hint };
  let lastRes = null;
  for (const frameId of frameIds) {
    const res = await sendBti(btiTab.id, frameId, msg);
    if (!res) continue;
    lastRes = res;
    if (res.success) return { ...res, frameId };
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

async function setPolyAmount(polyTab, amountUsd) {
  if (!polyTab?.id) return { ok: false, reason: '탭 없음' };
  await ensurePolyScript(polyTab.id);
  const res = await sendPoly(polyTab.id, { type: 'SET_POLY_AMOUNT', amount: amountUsd, force: true });
  return res || { ok: false, reason: '응답 없음' };
}

async function placePolyBet(polyTab, amountUsd, opts = {}) {
  if (!polyTab?.id) return { success: false, reason: '탭 없음' };
  const skipFill = !!opts.skipFill;
  await injectPolyMain(polyTab.id);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id },
      world: 'MAIN',
      func: async (amount, fast) => {
        if (typeof window.__polyMainPlaceBet === 'function') {
          return await window.__polyMainPlaceBet(amount, { skipFill: fast });
        }
        return { success: false, reason: 'MAIN 스크립트 없음' };
      },
      args: [amountUsd, skipFill]
    });
    const mainRes = results?.[0]?.result;
    if (mainRes?.success) return mainRes;
    if (skipFill && mainRes && !mainRes.success) {
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
  const fallback = await sendPoly(polyTab.id, { type: 'PLACE_BET', amount: amountUsd, skipFill });
  if (fallback?.success) return fallback;
  return fallback || { success: false, reason: 'Poly 배팅 실패' };
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

async function readSnapshot(leg2Pref, btiBetKrw, usdRate) {
  const found = await findTabs(leg2Pref);
  if (!found.btiTab && !found.polyTab) {
    return { ok: false, reason: 'x10x10s + 예측 탭을 열어주세요', found };
  }
  if (!found.btiTab) {
    return { ok: false, reason: '텐텐뱃: x10x10s.com 스포츠 탭 없음', found };
  }
  if (!found.polyTab) {
    return { ok: false, reason: '예측: Polymarket/BC.Game 탭 없음', found };
  }

  const poly = await readPolySlipAllFrames(found.polyTab);
  const arbBti = await readBtiOddsOnce(found.btiTab, poly);
  const bti = arbBti;

  const polyO = poly?.odds > 1 ? poly.odds : null;
  const btiO = arbBti?.odds > 1 ? arbBti.odds : null;
  const profit = (btiO && polyO) ? calcProfit(btiO, polyO) : null;
  const polyUsd = (btiO && polyO) ? calcPolyBetUsd(btiBetKrw, btiO, polyO, usdRate) : 0;

  let reason = '';
  if (!btiO && polyO) reason = '텐텐뱃 배당 없음 — 스포츠 배당판/슬립 확인';
  else if (btiO && !polyO) reason = '예측 배당 없음 — 금액(USDT) 입력';

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
  const { found, btiO, polyO, polyUsd, hint, btiBetKrw, polyPreSynced } = ctx;
  const t0 = performance.now();

  if (!polyPreSynced) {
    try {
      await withTimeout(ensureBtiSlip(found.btiTab, hint), 8000, 'BTI 슬립 준비');
    } catch (e) {
      console.warn('[strike] ensureBtiSlip:', e.message);
    }
  }

  const btiHint = { ...hint, skipEnsure: true, forceBet: true };
  const btiP = withTimeout(placeBtiBet(found.btiTab, btiBetKrw, btiO || null, btiHint), 25000, '텐텐뱃 배팅')
    .catch((e) => ({ success: false, reason: e.message }));
  const polyP = withTimeout(
    placePolyBet(found.polyTab, polyUsd, { skipFill: !!polyPreSynced }),
    25000,
    'Polymarket 배팅'
  ).catch((e) => ({ success: false, reason: e.message }));
  const [btiRes, polyRes] = await Promise.all([btiP, polyP]);

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
