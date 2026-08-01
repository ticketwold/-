// background.js v5.8 — 텐텐뱃 (x10x10s) + Polymarket / BC.Game
importScripts('sites_config.js', 'teams.js', 'odds.js', 'poly_api.js');

const BTI_MARKET_TYPES = 'ML0%2CHC0%2COU0';
const BTI_SEARCH_API_PATHS = [
  `/api/sportscenter/inplay/markets?language=KO&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`,
  `/api/sportscenter/prematch/markets?language=KO&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`,
  `/api/sportscenter/highlights/markets?language=KO&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`
];
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

async function findLeg2Tab(pref = 'auto') {
  const tabs = await chrome.tabs.query({});
  let best = null;
  let bestScore = -1;
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = activeTabs[0]?.id;

  for (const tab of tabs) {
    if (!tab.url) continue;
    const score = scoreLeg2Tab(tab.url, activeId, tab.id, pref);
    if (score < 0) continue;
    if (score > bestScore) {
      bestScore = score;
      best = tab;
    }
  }
  if (!best) return null;
  return { id: best.id, url: best.url, site: leg2SiteKey(best.url) };
}

async function ensureBtiScript(tabId, frameId = null) {
  try {
    const target = frameId != null
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };
    await chrome.scripting.executeScript({
      target,
      files: ['bti_content.js']
    });
    return true;
  } catch (_) {
    if (frameId == null) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['bti_content.js']
        });
        return true;
      } catch (_2) {}
    }
    return false;
  }
}

async function scrapeBtiBoardMatchups(tab) {
  if (!tab?.id) return { matchups: [], source: '' };
  await ensureBtiScript(tab.id);

  const frames = await getAllTabFrames(tab.id);
  let best = { matchups: [], source: '', buttonCount: 0 };

  for (const frame of frames) {
    if (frame.url && !isInjectableBtiFrame(frame.url) && frame.frameId !== 0) continue;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_BOARD' }, { frameId: frame.frameId });
      if (!res?.events?.length) continue;
      const matchups = boardEventsToBtiMatchups(res.events);
      if (matchups.length > best.matchups.length || (res.buttonCount || 0) > best.buttonCount) {
        best = {
          matchups,
          source: 'BTI 배당판',
          buttonCount: res.buttonCount || 0
        };
      }
    } catch (_) {}
  }

  return best;
}

function boardEventsToBtiMatchups(events) {
  const out = [];
  const seen = new Set();

  for (const ev of events || []) {
    const home = ev.homeTeam || '';
    const away = ev.awayTeam || '';
    if (!home || !away) continue;

    const key = `${home}|${away}`.toLowerCase();
    if (seen.has(key)) continue;

    const ml = (ev.moneyline || ev.selections || []).filter((s) => s.marketKind === 'ml' || s.side === 'home' || s.side === 'away');
    let homeOdds = 0;
    let awayOdds = 0;
    for (const sel of ml) {
      const odds = parseFloat(sel.odds);
      if (!odds || odds <= 1) continue;
      if (sel.side === 'home' || sel.side === 'h') homeOdds = odds;
      if (sel.side === 'away' || sel.side === 'a') awayOdds = odds;
    }
    if (!homeOdds || !awayOdds) continue;

    seen.add(key);
    out.push({
      id: ev.eventId || key,
      home,
      away,
      source: 'board',
      markets: [{
        MarketType: { _id: 'ML0' },
        Selections: [
          { Side: 'H', Name: home, Price: homeOdds },
          { Side: 'A', Name: away, Price: awayOdds }
        ]
      }]
    });
  }

  return out;
}

function mergeBtiMatchupLists(primary, secondary) {
  if (!secondary?.length) return primary || [];
  if (!primary?.length) return secondary;
  const out = [...primary];
  const seen = new Set(primary.map((m) => `${m.home}|${m.away}`.toLowerCase()));
  for (const row of secondary) {
    const key = `${row.home}|${row.away}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function ensurePredictionScript(tabId, frameId = null) {
  try {
    const target = frameId != null
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };
    await chrome.scripting.executeScript({
      target,
      files: ['polymarket_content.js']
    });
    return true;
  } catch (_) {
    if (frameId == null) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['polymarket_content.js']
        });
        return true;
      } catch (_2) {}
    }
    return false;
  }
}

async function scanLeg2TabBoard(tab) {
  if (!tab?.id) return { matchups: [], cartFound: false };
  await ensurePredictionScript(tab.id);

  const frames = await getAllTabFrames(tab.id);
  let best = { matchups: [], cartFound: false, cartSlip: null, source: '' };

  for (const frame of frames) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_BOARD' }, { frameId: frame.frameId });
      if (!res) continue;
      const count = res.matchups?.length || 0;
      const hasCart = !!res.hasCart || !!res.cartSlip?.odds;
      if (count > best.matchups.length || (hasCart && !best.cartFound)) {
        best = {
          matchups: res.matchups || best.matchups,
          cartFound: hasCart || best.cartFound,
          cartSlip: res.cartSlip?.odds ? res.cartSlip : best.cartSlip,
          source: res.site || best.source
        };
      }
      if (hasCart && res.cartSlip?.odds) {
        best.cartFound = true;
        best.cartSlip = res.cartSlip;
      }
    } catch (_) {}
  }

  return best;
}

function mergeMatchupLists(primary, secondary) {
  if (!secondary?.length) return primary || [];
  if (!primary?.length) return secondary;
  const out = [...primary];
  const seen = new Set(primary.map((m) => `${m.home}|${m.away}`.toLowerCase()));
  for (const row of secondary) {
    const key = `${row.home}|${row.away}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function getPredictionMatchups(leg2Pref, leg2Tab) {
  let list = [];
  let apiError = '';
  let source = 'Gamma API';

  try {
    list = await getPolymarketMatchups();
    if (leg2Pref === 'polymarket') source = 'Polymarket API';
    else if (leg2Pref === 'bcgame') source = 'BC.Game (Gamma API)';
    else source = 'Gamma API';
  } catch (e) {
    apiError = e.message || 'API 실패';
    console.warn('[Prediction API]', apiError);
  }

  let board = null;
  let cartFound = false;

  if (leg2Tab?.id) {
    board = await scanLeg2TabBoard(leg2Tab);
    cartFound = board.cartFound || !!board.cartSlip?.odds;
    if (board.matchups?.length) {
      list = mergeMatchupLists(list, board.matchups);
      if (leg2Pref === 'bcgame' || isBcGameUrl(leg2Tab.url)) {
        source = apiError ? 'BC.Game 페이지' : `${source} + 페이지`;
      }
    }
  }

  return { list, source, board, cartFound, apiError };
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

function btiEventsToMatchups(data, source = 'api') {
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
    if (!home || !away) continue;
    result.push({
      id: event.id,
      home,
      away,
      markets: event.markets,
      sportId: m0.SportId || 0,
      source
    });
  }
  return result;
}

async function getBtiMatchups(tabId) {
  const tab = tabId ? { id: tabId } : await pickBtiTab();
  if (!tab?.id) return { list: [], source: '' };

  let tabUrl = tab.url;
  if (!tabUrl) {
    try { tabUrl = (await chrome.tabs.get(tab.id)).url; } catch (_) {}
  }

  let list = [];
  const sources = [];

  for (const path of BTI_SEARCH_API_PATHS) {
    try {
      const data = await fetchBtiViaTab(tab.id, path, tabUrl);
      const parsed = btiEventsToMatchups(data, 'api');
      if (parsed.length) {
        list = mergeBtiMatchupLists(list, parsed);
        sources.push(path.includes('inplay') ? '라이브' : path.includes('prematch') ? '프리매치' : '하이라이트');
      }
    } catch (e) {
      console.warn('[BTI] API:', path.split('?')[0], e.message);
    }
  }

  if (list.length < 5) {
    try {
      const board = await scrapeBtiBoardMatchups(tab);
      if (board.matchups?.length) {
        list = mergeBtiMatchupLists(list, board.matchups);
        if (board.source) sources.push(board.source);
      }
    } catch (e) {
      console.warn('[BTI] board:', e.message);
    }
  }

  return { list, source: sources.length ? sources.join(' + ') : '없음' };
}

async function getBtiLiveMatchups(tabId) {
  const { list } = await getBtiMatchups(tabId);
  return list;
}

function findArbOpportunities(btiList, polyList) {
  const opps = [];
  let pairsMatched = 0;

  for (const bti of btiList) {
    const btiOdds = parseBtiOdds(bti.markets);
    const mlH = btiOdds.ml.find((m) => m.side === 'H' || m.side === 'Home');
    const mlA = btiOdds.ml.find((m) => m.side === 'A' || m.side === 'Away');
    if (!mlH?.odds || !mlA?.odds) continue;

    for (const poly of polyList) {
      if (!matchupTeamsMatch(bti, poly)) continue;
      pairsMatched++;

      let best = null;
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
        const profitVal = profit == null ? -999 : profit;
        const row = {
          home: bti.home, away: bti.away, league: bti.league || poly.league,
          polyTeam: pm.team, polyOdds: pm.decimal.toFixed(3), polyPrice: pm.price,
          btiSide, btiOdds: oppOdds, profit: profitVal.toFixed(2)
        };
        if (!best || profitVal > parseFloat(best.profit)) best = row;
      }
      if (best) opps.push(best);
    }
  }

  return {
    opportunities: opps.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit)),
    pairsMatched,
    profitable: opps.filter((o) => parseFloat(o.profit) >= 0).length
  };
}

async function runSearchOnce(leg1Site = 'bti', leg2Pref = 'auto') {
  const btiTab = await pickBtiTab();
  let btiAll = [];
  let btiSource = '';
  if (btiTab) {
    try {
      const btiRes = await getBtiMatchups(btiTab.id);
      btiAll = btiRes.list;
      btiSource = btiRes.source;
    } catch (e) {
      console.warn('[BTI]', e.message);
    }
  }

  const leg2Tab = await findLeg2Tab(leg2Pref);
  let pred = { list: [], source: '없음', board: null, cartFound: false };
  try {
    pred = await getPredictionMatchups(leg2Pref, leg2Tab);
  } catch (e) {
    console.warn('[Prediction]', e.message);
  }

  const arb = findArbOpportunities(btiAll, pred.list);
  return {
    opportunities: arb.opportunities,
    stats: {
      btiTotal: btiAll.length,
      btiTabFound: !!btiTab,
      btiSource,
      polyTotal: pred.list.length,
      polyTabFound: !!leg2Tab,
      leg2Pref,
      leg2Site: leg2Tab ? leg2SiteLabel(leg2Tab.url) : leg2PrefLabel(leg2Pref),
      leg2Source: pred.source,
      leg2ApiError: pred.apiError || '',
      bcBoardCount: pred.board?.matchups?.length || 0,
      bcCartFound: pred.cartFound || !!pred.board?.cartSlip?.odds,
      pairsMatched: arb.pairsMatched,
      matched: arb.profitable,
      allMatched: arb.opportunities.length
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
    const leg2Pref = msg.leg2Site || 'auto';
    runSearchOnce(msg.leg1Site || 'bti', leg2Pref).then((result) => {
      sendResponse({ ok: true, result });
      if (searchRunning) {
        searchInterval = setInterval(() => {
          runSearchOnce(msg.leg1Site || 'bti', leg2Pref).then((r) => broadcast({ type: 'SEARCH_RESULT', ...r }));
        }, 300);
      }
    }).catch((e) => {
      searchRunning = false;
      if (searchInterval) { clearInterval(searchInterval); searchInterval = null; }
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }

  if (msg.type === 'STOP_SEARCH') {
    searchRunning = false;
    if (searchInterval) { clearInterval(searchInterval); searchInterval = null; }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'RUN_SEARCH_ONCE') {
    runSearchOnce(msg.leg1Site || 'bti', msg.leg2Site || 'auto').then((r) => sendResponse({ ok: true, result: r }))
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

  if (msg.type === 'GET_TABS') {
    (async () => {
      try {
        const leg2Pref = msg.leg2Pref || 'auto';
        const bti = await pickBtiTab();
        const poly = await findLeg2Tab(leg2Pref);
        sendResponse({
          btiTab: bti ? { id: bti.id, url: bti.url } : null,
          polyTab: poly ? { id: poly.id, url: poly.url } : null,
          leg2Pref
        });
      } catch (e) {
        sendResponse({ btiTab: null, polyTab: null, error: e.message });
      }
    })();
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

// 확장 아이콘 클릭 → 패널 창 열기 (default_popup 없음 — onClicked 동작)
chrome.action.onClicked.addListener(() => {
  openPanelWindow().catch((e) => console.warn('[panel]', e.message));
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    openPanelWindow().catch(() => {});
  }
});

console.log('[양방봇 v5] background loaded');
