// background.js v5.7 — 텐텐뱃 (x10x10s) + Polymarket / BC.Game
importScripts('sites_config.js', 'teams.js', 'odds.js', 'poly_api.js');

const BTI_MARKET_TYPES = 'ML0%2CHC0%2COU0';
const BTI_HOST_HINTS = ['bti-sports.io', 'bti-sports.com', 'live8588.com', 'fxf774.com'];
const BTI_EXCLUDED = ['polymarket.com', 'google.com', 'youtube.com'];
const INJECTABLE_SUFFIXES = [
  'bti-sports.com', 'bti-sports.io', 'x10x10s.com', 'live8588.com', 'fxf774.com'
];

let searchRunning = false;
let searchInterval = null;
let panelWindowId = null;

const PANEL_WIDTH = 540;
const PANEL_HEIGHT = 780;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isInjectableUrl(url) {
  if (!url || url === 'about:blank') return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return INJECTABLE_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
  } catch (_) { return false; }
}

function isExcludedHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return BTI_EXCLUDED.some((x) => h.includes(x));
  } catch (_) { return false; }
}

function isDirectBtiTabUrl(url) {
  if (!url || isExcludedHost(url)) return false;
  return BTI_HOST_HINTS.some((h) => url.includes(h));
}

function isBtiHost(url) {
  if (!url || isExcludedHost(url)) return false;
  if (BTI_HOST_HINTS.some((h) => url.includes(h))) return true;
  try {
    const u = new URL(url);
    return isInjectableUrl(url) && /\/sports/i.test(u.pathname);
  } catch (_) { return false; }
}

function isInjectableBtiFrame(url) {
  return isInjectableUrl(url) && (isBtiHost(url) || isWrapperUrl(url));
}

async function getAllTabFrames(tabId) {
  if (!chrome.webNavigation?.getAllFrames) return [{ frameId: 0, url: '' }];
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      resolve(frames?.length ? frames : [{ frameId: 0, url: '' }]);
    });
  });
}

async function probeIframeSrcs(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => Array.from(document.querySelectorAll('iframe'))
        .map((f) => f.src || '').filter((s) => s.startsWith('http'))
    });
    return results?.[0]?.result || [];
  } catch (_) { return []; }
}

async function probeBtiFramesByPing(tabId, frames) {
  const found = [];
  for (const frame of frames) {
    if (frame.frameId === 0) continue;
    if (frame.url && !isInjectableUrl(frame.url)) continue;
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: frame.frameId });
      if (ping && (ping.buttonCount || ping.hasSlip || isBtiHost(ping.href || frame.url))) {
        found.push({ frameId: frame.frameId, url: ping.href || frame.url, score: 14 });
      }
    } catch (_) {}
  }
  return found;
}

async function getBtiFrameCandidates(tabId, tabUrl) {
  const frames = await getAllTabFrames(tabId);
  const candidates = [];
  for (const frame of frames) {
    if (!frame.url || !isInjectableBtiFrame(frame.url)) continue;
    let score = BTI_HOST_HINTS.some((h) => frame.url.includes(h)) ? 20 : 10;
    candidates.push({ frameId: frame.frameId, url: frame.url, score });
  }
  if (!candidates.length) {
    candidates.push(...await probeBtiFramesByPing(tabId, frames));
  }
  if (!candidates.length && tabUrl && isInjectableBtiFrame(tabUrl)) {
    candidates.push({ frameId: 0, url: tabUrl, score: 5 });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

async function getAllFrameIdsForFetch(tabId, tabUrl) {
  const ids = [...new Set((await getBtiFrameCandidates(tabId, tabUrl)).map((c) => c.frameId))];
  if (!ids.length && tabUrl && isInjectableBtiFrame(tabUrl)) return [0];
  return ids;
}

async function fetchJsonInFrame(tabId, frameId, path) {
  try {
    const via = await chrome.tabs.sendMessage(tabId, {
      type: 'FETCH_BTI_JSON',
      path: path.startsWith('http') ? null : path,
      url: path.startsWith('http') ? path : null
    }, { frameId });
    if (via?.ok && via.data !== undefined) return via.data;
  } catch (_) {}

  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: async (p) => {
      const fetchUrl = p.startsWith('http') ? p : (location.origin.replace(/\/$/, '') + p);
      const res = await fetch(fetchUrl, { credentials: 'include' });
      if (!res.ok) return { error: String(res.status) };
      return await res.json();
    },
    args: [path]
  });
  const result = results?.[0]?.result;
  if (!result || result.error) throw new Error(result?.error || 'fetch 실패');
  return result;
}

async function fetchBtiViaTab(tabId, path, tabUrl) {
  let lastErr = 'BTI iframe 없음';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(800);
    for (const frameId of await getAllFrameIdsForFetch(tabId, tabUrl)) {
      try {
        return await fetchJsonInFrame(tabId, frameId, path);
      } catch (e) { lastErr = e.message; }
    }
  }
  throw new Error(lastErr);
}

async function probeWrapperTabForBti(tab) {
  let score = scoreWrapperBtiTab(tab.url);
  const candidates = await getBtiFrameCandidates(tab.id, tab.url);
  if (candidates.length) score = Math.max(score, score + candidates[0].score);
  const pingHits = await probeBtiFramesByPing(tab.id, await getAllTabFrames(tab.id));
  if (pingHits.length) score = Math.max(score, scoreWrapperBtiTab(tab.url) + pingHits[0].score);
  return score > 0 ? score : 0;
}

async function pickBtiTab() {
  const tabs = await chrome.tabs.query({});
  let bestWrapper = null;
  let bestProbe = null;

  for (const tab of tabs) {
    if (!tab.url || !isWrapperUrl(tab.url)) continue;
    const score = scoreWrapperBtiTab(tab.url);
    if (score >= 10 && (!bestWrapper || score > bestWrapper.score)) {
      bestWrapper = { tab, score };
    }
  }
  if (bestWrapper) return { id: bestWrapper.tab.id, url: bestWrapper.tab.url };

  for (const tab of tabs) {
    if (!tab.url || !isWrapperUrl(tab.url)) continue;
    const score = await probeWrapperTabForBti(tab);
    if (score > 0 && (!bestProbe || score > bestProbe.score)) {
      bestProbe = { tab, score };
    }
  }
  if (bestProbe) return { id: bestProbe.tab.id, url: bestProbe.tab.url };

  for (const tab of tabs) {
    if (tab.url && isDirectBtiTabUrl(tab.url)) {
      return { id: tab.id, url: tab.url };
    }
  }
  return null;
}

async function findLeg2Tab() {
  const tabs = await chrome.tabs.query({});
  let best = null;
  let bestScore = -1;
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = activeTabs[0]?.id;

  for (const tab of tabs) {
    if (!tab.url || !isLeg2PredictionUrl(tab.url)) continue;
    let score = 0;
    if (isLeg2EventUrl(tab.url)) score += 20;
    if (isBcGameUrl(tab.url) && /\/predictions/i.test(tab.url)) score += 18;
    else if (/predictions/i.test(tab.url)) score += 5;
    if (tab.id === activeId) score += 15;
    if (score > bestScore) {
      bestScore = score;
      best = tab;
    }
  }
  if (!best) return null;
  return { id: best.id, url: best.url, site: leg2SiteKey(best.url) };
}

function parseBtiSelectionPrice(s) {
  if (!s) return 0;
  for (const f of [s.Price, s.DisplayPrice, s.Odds, s.Decimal, s.price]) {
    const n = parseFloat(f);
    if (n > 1.001 && n < 500) return n;
  }
  return 0;
}

function parseBtiOdds(markets) {
  const result = { ml: [] };
  for (const m of markets || []) {
    const typeId = m.MarketType?._id || m._id || '';
    if (!String(typeId).startsWith('ML')) continue;
    for (const s of (m.Selections || [])) {
      const side = s.Side || '';
      const odds = parseBtiSelectionPrice(s);
      if (odds > 1) result.ml.push({ side, odds, name: s.Name || s.TeamName || '' });
    }
  }
  return result;
}

async function getBtiLiveMatchups(tabId) {
  const tab = tabId ? { id: tabId } : await pickBtiTab();
  if (!tab?.id) return [];
  let tabUrl = tab.url;
  if (!tabUrl) {
    try { tabUrl = (await chrome.tabs.get(tab.id)).url; } catch (_) {}
  }

  const liveUrl = `/api/sportscenter/inplay/markets?language=KO&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`;
  let data = null;
  try {
    data = await fetchBtiViaTab(tab.id, liveUrl, tabUrl);
  } catch (e) {
    console.warn('[BTI] live API:', e.message);
  }

  if (!Array.isArray(data) || !data.length) return [];

  const result = [];
  for (const event of data) {
    if (!event.id || !event.markets?.length) continue;
    let home = '', away = '';
    const m0 = event.markets[0];
    if (m0.Selections) {
      const h = m0.Selections.find((s) => s.Side === 'H' || s.Side === 'Home');
      const a = m0.Selections.find((s) => s.Side === 'A' || s.Side === 'Away');
      if (h) home = h.Name || h.TeamName || '';
      if (a) away = a.Name || a.TeamName || '';
    }
    if (!home && m0.EventName) {
      const parts = m0.EventName.split(' vs ');
      if (parts.length >= 2) { home = parts[0].trim(); away = parts[1].trim(); }
    }
    result.push({ id: event.id, home, away, markets: event.markets, sportId: m0.SportId || 0 });
  }
  return result;
}

function findArbOpportunities(btiList, polyList) {
  const opps = [];
  for (const bti of btiList) {
    const btiOdds = parseBtiOdds(bti.markets);
    const mlH = btiOdds.ml.find((m) => m.side === 'H' || m.side === 'Home');
    const mlA = btiOdds.ml.find((m) => m.side === 'A' || m.side === 'Away');
    if (!mlH?.odds || !mlA?.odds) continue;

    for (const poly of polyList) {
      if (!matchupTeamsMatch(bti, poly)) continue;
      for (const pm of poly.ml) {
        if (!pm.decimal) continue;
        const btiHome = teamMatch(pm.team, bti.home);
        const btiAway = teamMatch(pm.team, bti.away);
        let oppOdds = null;
        let btiSide = '';
        if (btiHome) { oppOdds = mlA.odds; btiSide = 'away'; }
        else if (btiAway) { oppOdds = mlH.odds; btiSide = 'home'; }
        else continue;

        const profit = calcArb(pm.decimal, oppOdds);
        if (profit === null || profit < 0) continue;
        opps.push({
          home: bti.home, away: bti.away, league: bti.league || poly.league,
          polyTeam: pm.team, polyOdds: pm.decimal.toFixed(3), polyPrice: pm.price,
          btiSide, btiOdds: oppOdds, profit: profit.toFixed(2)
        });
      }
    }
  }
  return opps.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
}

async function runSearchOnce() {
  const btiTab = await pickBtiTab();
  let btiAll = [];
  if (btiTab) {
    try { btiAll = await getBtiLiveMatchups(btiTab.id); } catch (e) {
      console.warn('[BTI]', e.message);
    }
  }
  let polyAll = [];
  try { polyAll = await getPolymarketMatchups(); } catch (e) {
    console.warn('[Poly API]', e.message);
  }
  const opps = findArbOpportunities(btiAll, polyAll);
  const leg2Tab = await findLeg2Tab();
  return {
    opportunities: opps,
    stats: {
      btiTotal: btiAll.length,
      btiTabFound: !!btiTab,
      polyTotal: polyAll.length,
      polyTabFound: !!leg2Tab,
      leg2Site: leg2Tab ? leg2SiteLabel(leg2Tab.url) : '예측',
      matched: opps.length
    }
  };
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_SEARCH') {
    if (searchRunning) { sendResponse({ ok: true, msg: '이미 실행 중' }); return true; }
    searchRunning = true;
    runSearchOnce().then((result) => {
      sendResponse({ ok: true, result });
      if (searchRunning) {
        searchInterval = setInterval(() => {
          runSearchOnce().then((r) => broadcast({ type: 'SEARCH_RESULT', ...r }));
        }, 500);
      }
    }).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'STOP_SEARCH') {
    searchRunning = false;
    if (searchInterval) { clearInterval(searchInterval); searchInterval = null; }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'RUN_SEARCH_ONCE') {
    runSearchOnce().then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'DIAG_BTI') {
    (async () => {
      const tab = await pickBtiTab();
      if (!tab) return sendResponse({ ok: false, error: 'x10x10s.com 10벳 스포츠 탭을 열어주세요' });
      const frames = await getBtiFrameCandidates(tab.id, tab.url);
      const pings = [];
      for (const f of frames.slice(0, 6)) {
        try {
          const p = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }, { frameId: f.frameId });
          if (p) pings.push({ frameId: f.frameId, ...p });
        } catch (_) {}
      }
      sendResponse({ ok: true, tabUrl: tab.url, frames: frames.length, pings });
    })();
    return true;
  }

  if (msg.type === 'FETCH_BTI_API') {
    (async () => {
      const tab = await pickBtiTab();
      if (!tab) return sendResponse({ ok: false, error: 'BTI 탭 없음' });
      try {
        const data = await fetchBtiViaTab(tab.id, msg.path, tab.url);
        sendResponse({ ok: true, data });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'OPEN_PANEL') {
    openPanelWindow().then((id) => sendResponse({ ok: true, windowId: id }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'ODDS_CHANGED' || msg.type === 'BTI_STAKE_CHANGED') {
    broadcast(msg);
    return false;
  }
});

async function openPanelWindow() {
  if (panelWindowId != null) {
    try {
      const win = await chrome.windows.get(panelWindowId);
      if (win) {
        await chrome.windows.update(panelWindowId, { focused: true, drawAttention: true });
        return panelWindowId;
      }
    } catch (_) {
      panelWindowId = null;
    }
  }

  const url = chrome.runtime.getURL('panel.html');
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    focused: true
  });
  panelWindowId = win.id;
  return panelWindowId;
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === panelWindowId) panelWindowId = null;
});

// 확장 아이콘 클릭 → 큰 패널 창 열기
chrome.action.onClicked.addListener(() => {
  openPanelWindow().catch((e) => console.warn('[panel]', e.message));
});

console.log('[양방봇 v5] background loaded');
