// engine.js — 탭 탐색, 슬립 읽기, 동시 배팅
'use strict';

let lastBtiFrame = null;
let lastBtiSlipFrame = null;
let lastBtiBoardFrame = null;
let lastBcLeg2Frame = null;
let polyScriptReady = new Set();
let btiScriptReady = new Set();
const btiAllInjectedFrames = new Map();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const BTI_PROBE_MS = 3000;
const BTI_PROBE_FAST_MS = 1400;
const BTI_READ_INSTANT_MS = 900;
const BTI_READ_FAST_MS = 500;
const BTI_READ_DEEP_MS = 2400;
const BTI_MAX_FRAMES = 16;
const POLY_FRAME_MS = 3000;
const POLY_MAX_FRAMES = 6;

const BTI_API_SLIP_PATHS = [
  '/api/sportscenter/betslip',
  '/api/sportscenter/betslip/get',
  '/api/sportscenter/slip',
  '/api/betslip',
  '/api/betslip/get',
  '/api/sportscenter/betslip/current',
  '/api/sportscenter/coupon',
  '/api/sportscenter/wager/slip'
];
const BTI_API_MAX_AGE_MS = 120000;

function parseBtiApiSlipData(data) {
  if (!data) return null;
  function po(n) {
    const x = parseFloat(n);
    return Number.isFinite(x) && x > 1.01 && x < 500 ? x : null;
  }
  function pickSelOdds(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of ['Price', 'DisplayPrice', 'Odds', 'Decimal', 'DecimalOdds', 'odds', 'price', 'coefficient', 'decimal']) {
      const v = po(obj[k]);
      if (v) return v;
    }
    return null;
  }
  function pickTotalOdds(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of ['totalOdds', 'combinedOdds', 'TotalOdds', 'CombinedOdds']) {
      const v = po(obj[k]);
      if (v) return v;
    }
    return null;
  }
  function walk(obj, depth) {
    if (obj == null || depth > 16) return null;
    if (typeof obj === 'string') {
      try { return walk(JSON.parse(obj), depth + 1); } catch (_) { return null; }
    }
    if (Array.isArray(obj)) {
      let best = null;
      for (const item of obj) {
        const h = walk(item, depth + 1);
        if (h?.odds > 1.01) best = h;
      }
      return best;
    }
    if (typeof obj !== 'object') return null;
    const sels = obj.Selections || obj.selections || obj.Bets || obj.bets || obj.items;
    if (Array.isArray(sels) && sels.length) {
      for (let i = sels.length - 1; i >= 0; i--) {
        const o = pickSelOdds(sels[i]);
        if (o) {
          return {
            odds: Math.round(o * 1000) / 1000,
            selectionText: sels[i].Name || sels[i].TeamName || sels[i].SelectionName || '',
            eventText: obj.EventName || obj.eventName || sels[i].EventName || '',
            source: 'bti-api', fromSlip: true, sourceKind: 'bti-api-fetch'
          };
        }
      }
    }
    const total = pickTotalOdds(obj);
    if (total && Array.isArray(sels) && sels.length > 1) {
      const first = sels[sels.length - 1];
      return {
        odds: Math.round(total * 1000) / 1000,
        selectionText: first?.Name || first?.TeamName || first?.SelectionName || '',
        eventText: obj.EventName || obj.eventName || first?.EventName || '',
        source: 'bti-api', fromSlip: true, sourceKind: 'bti-api-fetch'
      };
    }
    const direct = pickSelOdds(obj);
    if (direct && (obj.Name || obj.TeamName || obj.SelectionName || obj.SelectionId)) {
      return {
        odds: Math.round(direct * 1000) / 1000,
        selectionText: obj.Name || obj.TeamName || obj.SelectionName || '',
        eventText: obj.EventName || obj.eventName || '',
        source: 'bti-api', fromSlip: true, sourceKind: 'bti-api-fetch'
      };
    }
    for (const key of ['betSlip', 'betslip', 'slip', 'coupon', 'data', 'result', 'payload', 'markets', 'Markets']) {
      if (obj[key]) {
        const h = walk(obj[key], depth + 1);
        if (h) return h;
      }
    }
    return null;
  }
  return walk(data, 0);
}

const btiApiFetchCooldown = new Map();
const BTI_API_FETCH_COOLDOWN_MS = 8000;

async function fetchBtiJsonInFrame(tabId, frameId, path) {
  try {
    const via = await sendBti(tabId, frameId, {
      type: 'FETCH_BTI_JSON',
      path: path.startsWith('http') ? null : path,
      url: path.startsWith('http') ? path : null
    });
    if (via?.ok && via.data !== undefined) return via.data;
  } catch (_) {}
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: async (p) => {
      let fetchUrl = p;
      if (!String(p).startsWith('http')) {
        const pathPart = String(p).startsWith('/') ? p : '/' + p;
        const href = location.href || '';
        const m = href.match(/^(https?:\/\/[^?#]+?)(\/in-play\/[^?#]*?)\/api\/sportscenter\/betslip/i);
        if (m && /^\/api\/sportscenter\//i.test(pathPart)) {
          fetchUrl = m[1] + m[2] + pathPart;
        } else if (pathPart.includes('/api/sportscenter/')) {
          fetchUrl = location.origin.replace(/\/$/, '') + pathPart;
        } else {
          fetchUrl = location.origin.replace(/\/$/, '') + pathPart;
        }
      }
      const res = await fetch(fetchUrl, { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return { error: String(res.status) };
      return await res.json();
    },
    args: [path]
  });
  const result = results?.[0]?.result;
  if (!result || result.error) throw new Error(result?.error || 'fetch 실패');
  return result;
}

async function readBtiApiSlipHook(tabId, frameId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: (maxAge) => {
        const s = window.__btiApiSlip;
        if (!(s?.odds > 1.01)) return null;
        if (Date.now() - (s.capturedAt || 0) > maxAge) return null;
        return s;
      },
      args: [BTI_API_MAX_AGE_MS]
    });
    const hit = results?.[0]?.result;
    if (!(hit?.odds > 1.01)) return null;
    return {
      ...hit,
      odds: Math.round(hit.odds * 1000) / 1000,
      source: 'bti-api',
      fromSlip: true,
      sourceKind: hit.sourceKind || 'bti-api-hook'
    };
  } catch (_) {
    return null;
  }
}

async function fetchBtiSlipViaApi(tabId, opts = {}) {
  const now = Date.now();
  const last = btiApiFetchCooldown.get(tabId) || 0;
  if (!opts.force && now - last < BTI_API_FETCH_COOLDOWN_MS) {
    return { slip: null, frameId: 0 };
  }
  btiApiFetchCooldown.set(tabId, now);

  const frameUrlMap = await getFrameUrlMap(tabId);
  const order = await orderBtiFrameIds(tabId);
  const apiFrames = order.filter((fid) => {
    const url = frameUrlMap[fid] || '';
    return (typeof isSportscenterBetslipUrl === 'function' && isSportscenterBetslipUrl(url))
      || (typeof isWidgetsXBetslipUrl === 'function' && isWidgetsXBetslipUrl(url));
  });
  const frames = (apiFrames.length ? apiFrames : order).slice(0, 3);

  for (const frameId of frames) {
    const hooked = await readBtiApiSlipHook(tabId, frameId);
    if (hooked?.odds > 1.01) return { slip: hooked, frameId };
  }

  for (const frameId of frames) {
    const frameUrl = frameUrlMap[frameId] || '';
    const paths = typeof resolveBtiSlipApiPaths === 'function'
      ? resolveBtiSlipApiPaths(frameUrl).slice(0, 3)
      : BTI_API_SLIP_PATHS.slice(0, 2);
    await ensureBtiScript(tabId, frameId);
    for (const path of paths) {
      try {
        const data = await withTimeout(fetchBtiJsonInFrame(tabId, frameId, path), 4000, 'BTI API');
        const slip = parseBtiApiSlipData(data);
        if (slip?.odds > 1.01) return { slip, frameId };
      } catch (_) {}
    }
  }
  return { slip: null, frameId: 0 };
}

async function buildBtiFastFrameIds(tabId) {
  const ids = [];
  const tabUrl = await getTabUrl(tabId);
  const inPlay = typeof isX10InPlayShellUrl === 'function' && isX10InPlayShellUrl(tabUrl);
  try {
    const domFrames = await findBtiSlipFrameIdsByDom(tabId);
    for (const fid of domFrames) {
      if (!ids.includes(fid)) ids.push(fid);
    }
  } catch (_) {}
  try {
    const frames = await getAllFrames(tabId);
    for (const f of frames) {
      if (isJunkBtiFrameUrl(f.url)) continue;
      if (typeof isSportscenterBetslipUrl === 'function' && isSportscenterBetslipUrl(f.url)) {
        if (!ids.includes(f.frameId)) ids.unshift(f.frameId);
      }
    }
    for (const f of frames) {
      if (isJunkBtiFrameUrl(f.url)) continue;
      if (typeof isWidgetsXBetslipUrl === 'function' && isWidgetsXBetslipUrl(f.url)) {
        if (!ids.includes(f.frameId)) ids.push(f.frameId);
      }
    }
  } catch (_) {}
  if (lastBtiSlipFrame?.tabId === tabId && !ids.includes(lastBtiSlipFrame.frameId)) ids.unshift(lastBtiSlipFrame.frameId);
  if (lastBtiFrame?.tabId === tabId && !ids.includes(lastBtiFrame.frameId)) ids.push(lastBtiFrame.frameId);
  if (lastBtiBoardFrame?.tabId === tabId && !ids.includes(lastBtiBoardFrame.frameId)) ids.push(lastBtiBoardFrame.frameId);
  try {
    const order = await orderBtiFrameIds(tabId);
    for (const fid of order.slice(0, 10)) {
      if (!ids.includes(fid)) ids.push(fid);
    }
  } catch (_) {}
  if (!inPlay && !ids.includes(0)) ids.push(0);
  return ids.length ? ids : [0];
}

async function readBtiOddsFromFrame(tabId, frameId, readHint, timeoutMs = BTI_READ_FAST_MS) {
  await Promise.all([ensureBtiScript(tabId, frameId), ensureBtiApiHook(tabId, frameId)]);
  const readers = readHint.forScan
    ? [
        () => withTimeout(
          sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: readHint }),
          timeoutMs,
          'BTI read'
        ).then((res) => res?.slip || null).catch(() => null),
        () => withTimeout(injectReadBtiFrame(tabId, frameId), timeoutMs, 'BTI scrape').catch(() => null)
      ]
    : [
        () => withTimeout(
          sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: readHint }),
          timeoutMs,
          'BTI read'
        ).then((res) => res?.slip || null).catch(() => null),
        () => readBtiApiSlipHook(tabId, frameId).catch(() => null),
        () => withTimeout(injectReadBtiFrame(tabId, frameId), timeoutMs, 'BTI scrape').catch(() => null)
      ];
  for (const fn of readers) {
    const slip = await fn();
    if (slip?.odds > 1.01) {
      if (readHint.forScan && !isBtiSlipOddsSource(slip)) continue;
      lastBtiFrame = { tabId, frameId };
      return { ...slip, _frameId: frameId };
    }
  }
  return null;
}

function scoreBtiReadHit(slip, frameId, tabId) {
  if (!(slip?.odds > 1.01)) return -1;
  let score = 0;
  if (slip.fromSlip) score += 2000;
  const src = slip.source || slip.sourceKind || '';
  if (/slip-card|slip-display/.test(src)) score += 1200;
  if (/slip-latched|in-play-at|widgets-x-slip|widgets-x-at/.test(src)) score += 900;
  if (src.includes('bti-api')) score += 150;
  if (src === 'board-slip-match') score += 150;
  if (lastBtiSlipFrame?.tabId === tabId && lastBtiSlipFrame.frameId === frameId) score += 600;
  if (lastBtiFrame?.tabId === tabId && lastBtiFrame.frameId === frameId) score += 300;
  return score;
}

function pickBestBtiReadHit(hits, tabId) {
  const ranked = hits
    .filter((h) => h?.slip?.odds > 1.01)
    .sort((a, b) => scoreBtiReadHit(b.slip, b.frameId, tabId) - scoreBtiReadHit(a.slip, a.frameId, tabId));
  return ranked[0]?.slip || null;
}

async function rankBtiFramesByPing(tabId, frameIds, limit = 12) {
  await injectAllBtiFramesTab(tabId);
  const frames = await getAllFrames(tabId);
  const allIds = [...new Set([
    ...frameIds,
    ...frames.map((f) => f.frameId)
  ])].slice(0, Math.max(limit, 24));
  const results = await Promise.all(allIds.map(async (frameId) => {
    try {
      await ensureBtiScript(tabId, frameId);
      const ping = await withTimeout(sendBti(tabId, frameId, { type: 'PING' }), 1200, 'ping');
      if (!ping?.ok) return { frameId, score: 0 };
      let score = (ping.buttonCount || 0)
        + (ping.slipOdds > 1.01 ? 320 : 0)
        + (ping.hasInput ? 220 : 0)
        + (ping.hasSlip ? 160 : 0);
      if (/widgets-x/i.test(ping.href || '')) score += 80;
      const topUrl = frames.find((f) => f.frameId === frameId)?.url || ping.href || '';
      if (frameId === 0 && typeof isX10InPlayShellUrl === 'function' && isX10InPlayShellUrl(topUrl)
        && (ping.hasInput || ping.hasSlip || ping.slipOdds > 1.01)) {
        score += 900;
      }
      return { frameId, score };
    } catch (_) {
      return { frameId, score: 0 };
    }
  }));
  return results
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.frameId);
}

async function prioritizeBtiFrameIds(tabId, frameIds, limit = 12) {
  const pingFirst = await rankBtiFramesByPing(tabId, frameIds, limit);
  if (!pingFirst.length) return frameIds;
  const rest = frameIds.filter((id) => !pingFirst.includes(id));
  return [...pingFirst, ...rest];
}

async function readBtiOddsInstant(tabId, hint = {}) {
  if (!tabId) return null;
  const readHint = { preferActiveSlip: true, ...hint };
  let frameIds = [];
  if (lastBtiSlipFrame?.tabId === tabId) frameIds.push(lastBtiSlipFrame.frameId);
  if (lastBtiFrame?.tabId === tabId && !frameIds.includes(lastBtiFrame.frameId)) frameIds.push(lastBtiFrame.frameId);
  if (!frameIds.length) {
    const fast = await buildBtiFastFrameIds(tabId);
    frameIds.push(...fast.slice(0, 6));
  }
  frameIds = await prioritizeBtiFrameIds(tabId, frameIds, 8);
  for (const fid of frameIds.slice(0, 6)) {
    const slip = await readBtiOddsFromFrame(tabId, fid, readHint, BTI_READ_INSTANT_MS);
    if (slip?.odds > 1.01) return slip;
  }
  return null;
}

async function readBtiOddsFast(tabId, hint = {}) {
  if (!tabId) return null;
  const readHint = { preferActiveSlip: true, ...hint };
  const fast = hint.fastScan !== false;
  let frameIds = await buildBtiFastFrameIds(tabId);
  frameIds = await prioritizeBtiFrameIds(tabId, frameIds, fast ? 12 : 16);
  const batchSize = fast ? 10 : 14;
  const timeoutMs = fast ? BTI_READ_FAST_MS : BTI_READ_DEEP_MS;
  const batch = frameIds.slice(0, batchSize);

  if (batch.length) {
    const hits = await Promise.all(batch.map(async (fid) => {
      const slip = await readBtiOddsFromFrame(tabId, fid, readHint, timeoutMs);
      return slip ? { slip, frameId: fid } : null;
    }));
    const found = pickBestBtiReadHit(hits, tabId);
    if (found) return found;
  }

  if (!fast) {
    const rest = frameIds.slice(batchSize, BTI_MAX_FRAMES);
    if (rest.length) {
      const hits = await Promise.all(rest.map(async (fid) => {
        const slip = await readBtiOddsFromFrame(tabId, fid, readHint, timeoutMs);
        return slip ? { slip, frameId: fid } : null;
      }));
      const found = pickBestBtiReadHit(hits, tabId);
      if (found) return found;
    }
  }

  if (!readHint.forScan) {
    try {
      const api = await withTimeout(fetchBtiSlipViaApi(tabId), fast ? 3000 : 5000, 'BTI API');
      if (api.slip?.odds > 1.01) return api.slip;
    } catch (_) {}
  }

  return null;
}

function polyOddsForScan(poly) {
  if (!(poly?.odds > 1.01)) return null;
  if (typeof acceptBcSlipForScan === 'function') {
    const scan = acceptBcSlipForScan(poly);
    if (scan?.odds > 1.01) return normalizeSportsOdds(scan.odds);
  }
  if (typeof isRelaxedBcSlip === 'function' && isRelaxedBcSlip(poly)) {
    return normalizeSportsOdds(poly.odds);
  }
  if (isTrustedBcSlip(poly)) return normalizeSportsOdds(poly.odds);
  if (typeof isRelaxedBcSlip === 'function' && isRelaxedBcSlip(poly)) {
    return normalizeSportsOdds(poly.odds);
  }
  return null;
}

async function orderBtiFrameIds(tabId) {
  const frames = await getAllFrames(tabId);
  const scored = [];

  for (const f of frames) {
    const url = f.url || '';
    if (/doubleclick|googlesyndication|tracker\.html|amazon-ivs|hcaptcha|facebook\.com/i.test(url)) continue;
    let score = scoreBtiFrameUrl(url);
    if (score < -100) continue;
    if (f.frameId === 0 && typeof isX10InPlayShellUrl === 'function' && isX10InPlayShellUrl(url)) {
      score -= 80;
    } else if (f.frameId === 0) {
      score += 5;
    } else if (!isInjectableBtiUrl(url)) {
      score = Math.max(score, 2);
    }
    scored.push({ frameId: f.frameId, score, url });
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

async function getFrameUrlMap(tabId) {
  const frames = await getAllFrames(tabId);
  const map = {};
  for (const f of frames) map[f.frameId] = f.url || '';
  return map;
}

async function scrapeBtiFromAllFrames(tabId) {
  const order = await orderBtiFrameIds(tabId);
  const toProbe = order.slice(0, BTI_MAX_FRAMES);
  const frameUrls = await getFrameUrlMap(tabId);
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
  updateBtiFrameRoles(tabId, results, frameUrls);
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

async function injectBtiInlineBootstrap(tabId, frameId = 0) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        document.documentElement.setAttribute('data-autobet-bti', 'inline');
        if (typeof window.__btiReadOdds === 'function') return;
        window.__btiReadOdds = function readInline(hint) {
          hint = hint || {};
          function po(t) {
            const n = parseFloat(String(t || '').trim());
            return n > 1.01 && n < 100 ? n : null;
          }
          const counter = document.querySelector('#counter, input[class*="Counter"], input[placeholder*="베팅"]');
          const root = counter?.closest('[class*="betslip"], [class*="Betslip"]') || document.body;
          const at = (root.textContent || '').match(/@\s*(\d+\.\d{2,4})/);
          if (at) {
            return {
              odds: po(at[1]),
              source: 'inline-bootstrap',
              fromSlip: true,
              selectionText: root.querySelector('[class*="betInformation__title"]')?.textContent?.trim() || ''
            };
          }
          let best = null;
          let bestScore = -1;
          for (const btn of document.querySelectorAll('button')) {
            const r = btn.getBoundingClientRect?.();
            if (!r || r.width < 2) continue;
            const cls = String(btn.className || '');
            const selected = /selected|active|pressed/i.test(cls) || btn.getAttribute('aria-pressed') === 'true';
            const m = (btn.textContent || '').match(/(\d+\.\d{2,3})/);
            if (!m) continue;
            const o = po(m[1]);
            if (!o) continue;
            const score = (selected ? 1000 : 10) + o;
            if (score > bestScore) {
              bestScore = score;
              best = { odds: o, source: 'inline-board', fromSlip: false, selectionText: '' };
            }
          }
          return best;
        };
      }
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function probeBtiInjectStatus(tabId) {
  const frames = await getAllFrames(tabId);
  const hits = [];
  for (const f of frames.slice(0, 24)) {
    if (/doubleclick|googlesyndication|tracker\.html|amazon-ivs|hcaptcha/i.test(f.url || '')) continue;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        func: () => ({
          has: typeof window.__btiReadOdds === 'function',
          marker: document.documentElement.getAttribute('data-autobet-bti') || '',
          href: location.href.slice(0, 110)
        })
      });
      const hit = res?.[0]?.result;
      hits.push({
        frameId: f.frameId,
        url: (f.url || '').slice(0, 110),
        has: !!hit?.has,
        marker: hit?.marker || ''
      });
    } catch (e) {
      hits.push({
        frameId: f.frameId,
        url: (f.url || '').slice(0, 110),
        has: false,
        error: String(e?.message || e || 'probe-fail').slice(0, 80)
      });
    }
  }
  const withScript = hits.filter((h) => h.has);
  return {
    topHasScript: !!withScript.find((h) => h.frameId === 0),
    framesWithScript: withScript.length,
    hits: hits.slice(0, 14)
  };
}

function isJunkBtiFrameUrl(url) {
  const u = String(url || '');
  if (!u || u === 'about:blank') return true;
  if (/recaptcha|google\.com\/recaptcha|hcaptcha|doubleclick|googlesyndication|player\.twitch|facebook\.com\/tr/i.test(u)) return true;
  if (/streambridge\.feedconstruct\.com\/player/i.test(u)) return true;
  if (/accounts-iframe|amazon-ivs|tracker\.html/i.test(u)) return true;
  if (/livechatinc\.com|livechat\.com|liveplugins\.com|gls\.liveplugins/i.test(u)) return true;
  return false;
}

async function findBtiSlipFrameIdsByDom(tabId) {
  const frames = await getAllFrames(tabId);
  const hits = [];
  for (const f of frames) {
    if (isJunkBtiFrameUrl(f.url)) continue;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        func: () => {
          const input = document.querySelector('#counter, input[class*="Counter"], input[placeholder*="베팅"], input[placeholder*="베팅금"]');
          if (!input) return null;
          const r = input.getBoundingClientRect?.();
          if (!r || r.width < 2 || r.height < 2) return null;
          const root = input.closest('[class*="betslip"], [class*="Betslip"]') || input.parentElement;
          const txt = (root?.textContent || document.body?.textContent || '').replace(/\s+/g, ' ');
          const at = txt.match(/@\s*(\d+\.\d{2,4})/);
          const slipOdds = at ? parseFloat(at[1]) : 0;
          const sel = document.querySelector('[class*="betInformation__title"]')?.textContent?.trim() || '';
          return { slipOdds, sel };
        }
      });
      const hit = res?.[0]?.result;
      if (!hit) continue;
      let score = 2000;
      if (hit.slipOdds > 1.01) score += Math.min(hit.slipOdds, 50);
      if (typeof isSportscenterBetslipUrl === 'function' && isSportscenterBetslipUrl(f.url || '')) score += 500;
      hits.push({ frameId: f.frameId, score, url: f.url || '' });
    } catch (_) {}
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.map((h) => h.frameId);
}

async function injectAllBtiFramesTab(tabId, force = false) {
  const frames = await getAllFrames(tabId);
  const count = frames.length;
  const errors = [];

  const probeBefore = await probeBtiInjectStatus(tabId);
  const prev = btiAllInjectedFrames.get(tabId) || 0;
  if (!force && prev >= count && prev > 0 && probeBefore.framesWithScript > 0) {
    return { ok: true, skipped: true, errors, ...probeBefore };
  }

  const needFrames = frames.filter((f) => {
    if (isJunkBtiFrameUrl(f.url)) return false;
    if (/doubleclick|googlesyndication|tracker\.html|amazon-ivs|hcaptcha/i.test(f.url || '')) return false;
    const hit = probeBefore.hits.find((h) => h.frameId === f.frameId);
    return !hit?.has;
  });

  for (const f of needFrames) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        files: ['bti_content.js']
      });
      btiScriptReady.add(`${tabId}:${f.frameId}`);
    } catch (e) {
      if (f.frameId === 0) errors.push(`f0:${String(e?.message || e).slice(0, 100)}`);
    }
  }

  const hookFrames = frames.filter((f) => !isJunkBtiFrameUrl(f.url));
  for (const f of hookFrames.slice(0, 14)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        files: ['bti_api_hook.js'],
        world: 'MAIN'
      });
    } catch (_) {}
  }

  btiAllInjectedFrames.set(tabId, count);
  btiScriptReady.add(`all:${tabId}`);

  const probe = await probeBtiInjectStatus(tabId);
  if (probe.framesWithScript === 0) {
    await injectBtiInlineBootstrap(tabId, 0);
    for (const f of frames.slice(1, 12)) {
      if (/widgets-x|bti-sports|betslip|sportscenter/i.test(f.url || '')) {
        await injectBtiInlineBootstrap(tabId, f.frameId);
      }
    }
    const reprobe = await probeBtiInjectStatus(tabId);
    return { ok: reprobe.framesWithScript > 0, errors, inlineFallback: true, ...reprobe };
  }
  return { ok: probe.framesWithScript > 0, errors, inlineFallback: false, ...probe };
}

async function ensureBtiScript(tabId, frameId) {
  const key = `${tabId}:${frameId}`;
  if (btiScriptReady.has(key)) return;
  try {
    const probe = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => typeof window.__btiReadOdds === 'function'
    });
    if (probe?.[0]?.result) {
      btiScriptReady.add(key);
      return;
    }
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['bti_content.js'] });
    btiScriptReady.add(key);
  } catch (_) {}
}

async function getTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tabEffectiveUrl(tab);
  } catch (_) {
    return '';
  }
}

async function enumerateAllTabs() {
  const seen = new Map();
  try {
    for (const t of await chrome.tabs.query({})) {
      if (t?.id) seen.set(t.id, t);
    }
  } catch (_) {}
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins) {
      for (const t of w.tabs || []) {
        if (t?.id) seen.set(t.id, t);
      }
    }
  } catch (_) {}
  return [...seen.values()];
}

function noteOpenedWebTab(tabId) {
  if (!tabId) return;
  recentWebTabIds = [tabId, ...recentWebTabIds.filter((id) => id !== tabId)].slice(0, 8);
}

async function openLeg1Tab(useAlt = false) {
  const url = useAlt ? leg1OpenUrlAlt() : leg1OpenUrl();
  const tab = await chrome.tabs.create({ url, active: true });
  noteOpenedWebTab(tab.id);
  await saveTabBindings({ btiTabId: tab.id });
  tabUrlProbeCache.set(tab.id, { url, at: Date.now() });
  return { ok: true, tabId: tab.id, url };
}

async function openLeg2Tab(leg2Pref = 'bcgame') {
  const url = leg2OpenUrl(leg2Pref);
  const tab = await chrome.tabs.create({ url, active: true });
  noteOpenedWebTab(tab.id);
  await saveTabBindings({ leg2TabId: tab.id, leg2Pref });
  tabUrlProbeCache.set(tab.id, { url, at: Date.now() });
  return { ok: true, tabId: tab.id, url };
}

async function queryTabsByUrlPatterns(patterns) {
  const seen = new Map();
  if (!patterns?.length) return [];
  for (let i = 0; i < patterns.length; i += 18) {
    const chunk = patterns.slice(i, i + 18);
    try {
      const found = await chrome.tabs.query({ url: chunk });
      for (const t of found) {
        if (t?.id) seen.set(t.id, t);
      }
    } catch (_) {}
  }
  return [...seen.values()];
}

async function mergeTabs(...groups) {
  const seen = new Map();
  for (const group of groups) {
    for (const tab of group || []) {
      if (tab?.id) seen.set(tab.id, tab);
    }
  }
  return [...seen.values()];
}

async function enrichTabUrls(tabs) {
  return Promise.all(tabs.map(async (tab) => {
    if (tabEffectiveUrl(tab) || !tab?.id) return tab;
    try {
      const fresh = await chrome.tabs.get(tab.id);
      return fresh?.id ? fresh : tab;
    } catch (_) {
      return tab;
    }
  }));
}

const tabUrlProbeCache = new Map();
const TAB_BIND_KEY = 'autoBetTabBind';
let recentWebTabIds = [];

function getRecentWebTabIds() {
  return recentWebTabIds.slice();
}

function installLeg1ScriptWatcher() {
  if (installLeg1ScriptWatcher._done) return;
  installLeg1ScriptWatcher._done = true;

  const scheduleInject = (tabId, url) => {
    if (!tabId || !url || !/^https?:/i.test(url)) return;
    if (typeof isLeg1TabUrl !== 'function' || !isLeg1TabUrl(url)) return;
    injectAllBtiFramesTab(tabId).catch(() => {});
  };

  if (chrome.webNavigation?.onCompleted) {
    chrome.webNavigation.onCompleted.addListener((details) => {
      if (details.frameId !== 0 && !/widgets-x|bti-sports|betslip|sportscenter|feedconstruct/i.test(details.url || '')) return;
      scheduleInject(details.tabId, details.url);
    });
  }
  if (chrome.tabs?.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
      if (info.status !== 'complete') return;
      scheduleInject(tabId, tabEffectiveUrl(tab) || info.url || '');
    });
  }
}

async function injectAllOpenLeg1Tabs() {
  const tabs = await enumerateAllTabs();
  await Promise.all(tabs.map(async (tab) => {
    if (!tab?.id) return;
    const url = await resolveTabUrlEnhanced(tab);
    if (url && typeof isLeg1TabUrl === 'function' && isLeg1TabUrl(url)) {
      await injectAllBtiFramesTab(tab.id).catch(() => {});
    }
  }));
}

function installRecentWebTabTracker() {
  if (installRecentWebTabTracker._done || !chrome.tabs?.onActivated) return;
  installRecentWebTabTracker._done = true;
  const noteWebTab = (tab) => {
    if (!tab?.id) return;
    const url = tabEffectiveUrl(tab);
    if (url && (isExtensionPageUrl(url) || /^chrome:|^edge:|^devtools:/i.test(url))) return;
    recentWebTabIds = [tab.id, ...recentWebTabIds.filter((id) => id !== tab.id)].slice(0, 8);
  };
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then(noteWebTab).catch(() => {});
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.tabs.query({ active: true, windowId }).then((tabs) => {
      if (tabs[0]) noteWebTab(tabs[0]);
    }).catch(() => {});
  });
}

async function probeTabTopUrl(tabId) {
  const cached = tabUrlProbeCache.get(tabId);
  if (cached && Date.now() - cached.at < 20000) return cached.url;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => location.href
    });
    const url = String(results?.[0]?.result || '');
    if (url && /^https?:/i.test(url)) {
      tabUrlProbeCache.set(tabId, { url, at: Date.now() });
      return url;
    }
  } catch (_) {}
  return '';
}

async function resolveTabUrlEnhanced(tab) {
  if (!tab) return '';
  let url = tabEffectiveUrl(tab);
  if (url && !isExtensionPageUrl(url)) return url;
  if (!tab.id) return '';
  url = await getTabUrl(tab.id);
  if (url && !isExtensionPageUrl(url)) return url;
  return probeTabTopUrl(tab.id);
}

async function loadTabBindings() {
  try {
    const data = await chrome.storage.local.get(TAB_BIND_KEY);
    return data[TAB_BIND_KEY] || {};
  } catch (_) {
    return {};
  }
}

async function saveTabBindings(patch) {
  const prev = await loadTabBindings();
  await chrome.storage.local.set({ [TAB_BIND_KEY]: { ...prev, ...patch } });
}

async function tabStillExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (_) {
    return false;
  }
}

async function tryBoundBtiTab(bindings, activeId) {
  if (!bindings?.btiTabId || !(await tabStillExists(bindings.btiTabId))) return null;
  try {
    const tab = await chrome.tabs.get(bindings.btiTabId);
    const score = await scoreBtiTabByPing(tab, activeId);
    if (score >= 80) return tab;
    const url = await resolveTabUrlEnhanced(tab);
    if (isLeg1TabUrl(url) || scoreTabTitleForLeg1(tab) >= 40) return tab;
  } catch (_) {}
  return null;
}

async function tryBoundLeg2Tab(bindings, leg2Pref, activeId) {
  if (!bindings?.leg2TabId || bindings.leg2Pref !== leg2Pref) return null;
  if (!(await tabStillExists(bindings.leg2TabId))) return null;
  try {
    const tab = await chrome.tabs.get(bindings.leg2TabId);
    const score = await scoreLeg2TabByPing(tab, leg2Pref, activeId);
    if (score >= 80) return tab;
    const url = await resolveTabUrlEnhanced(tab);
    if (urlMatchesLeg2Pref(url, leg2Pref) || scoreTabTitleForLeg2(tab, leg2Pref) >= 40) return tab;
  } catch (_) {}
  return null;
}

async function tryRecentTabsForBti(recentIds, activeId) {
  for (const tabId of recentIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isSkippableProbeTab(tab)) continue;
      const url = await resolveTabUrlEnhanced(tab);
      if (url && isLeg2Url(url) && !isLeg1TabUrl(url) && scoreTabTitleForLeg1(tab) < 30) continue;
      const titleScore = scoreTabTitleForLeg1(tab);
      const pingScore = await scoreBtiTabByPing(tab, activeId);
      const urlScore = isLeg1TabUrl(url) ? scoreLeg1Tab(url, activeId, tabId) : 0;
      if (pingScore >= 80 || urlScore + titleScore >= 20 || titleScore >= 50) return tab;
    } catch (_) {}
  }
  return null;
}

async function scoreLeg2TabByPing(tab, leg2Pref, activeId) {
  const tabId = tab.id;
  let score = scoreTabTitleForLeg2(tab, leg2Pref);
  const url = await resolveTabUrlEnhanced(tab);
  if (url && !urlMatchesLeg2Pref(url, leg2Pref)) return 0;
  if (url && isLeg1TabUrl(url) && !urlMatchesLeg2Pref(url, leg2Pref)) return 0;
  if (tabId === activeId) score += 20;
  if (url && isLeg2SportsUrl(url)) score += 35;
  try {
    await ensureLeg2Script(tabId, 0, url);
    const ping = await withTimeout(sendPoly(tabId, { type: 'PING' }, 0), 1200, 'leg2 ping');
    if (ping?.ok) score += 280;
    const probe = await withTimeout(sendPoly(tabId, { type: 'PROBE_POLY' }, 0), 1400, 'leg2 probe');
    if (probe?.probe?.hasPanel || probe?.probe?.slipOdds > 1) score += 120;
    if (probe?.probe?.hasInput) score += 60;
  } catch (_) {}
  return score;
}

async function findLeg2TabByProbe(tabs, leg2Pref, activeId, recentIds = []) {
  const tried = new Set();
  const ordered = [];
  for (const id of recentIds) {
    if (!tried.has(id)) { tried.add(id); ordered.push(id); }
  }
  for (const tab of tabs) {
    if (tab?.id && !tried.has(tab.id)) { tried.add(tab.id); ordered.push(tab.id); }
  }

  let best = null;
  let bestScore = -1;
  for (const tabId of ordered.slice(0, 28)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isSkippableProbeTab(tab)) continue;
      const url = await resolveTabUrlEnhanced(tab);
      if (url && isLeg1TabUrl(url) && !urlMatchesLeg2Pref(url, leg2Pref)) continue;
      let score = scoreTabTitleForLeg2(tab, leg2Pref);
      if (url && urlMatchesLeg2Pref(url, leg2Pref)) score += scoreLeg2Tab(url, activeId, tabId, leg2Pref);
      if (score < 40) {
        score = Math.max(score, await scoreLeg2TabByPing(tab, leg2Pref, activeId));
      } else {
        score = Math.max(score, await scoreLeg2TabByPing(tab, leg2Pref, activeId));
      }
      if (score > bestScore && score >= 50) {
        bestScore = score;
        best = tab;
      }
    } catch (_) {}
  }
  return best;
}

function leg2ScriptFile(url) {
  return leg2SiteKey(url) === 'stake' ? 'stake_content.js' : 'polymarket_content.js';
}

async function ensureLeg2Script(tabId, frameId, tabUrl) {
  const url = tabUrl || await getTabUrl(tabId);
  const file = leg2ScriptFile(url);
  const allFrames = frameId === undefined || frameId === null;
  const key = `${file}:${allFrames ? String(tabId) : `${tabId}:${frameId}`}`;
  if (polyScriptReady.has(key)) return;
  try {
    const target = allFrames ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
    await chrome.scripting.executeScript({ target, files: [file] });
    if (leg2SiteKey(url) === 'stake') {
      await chrome.scripting.executeScript({
        target: allFrames ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] },
        files: ['stake_slip_read.js']
      });
    }
    polyScriptReady.add(key);
    if (allFrames) polyScriptReady.add(`${file}:${tabId}`);
  } catch (_) {}
}

async function ensurePolyScript(tabId, frameId) {
  return ensureLeg2Script(tabId, frameId);
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

async function scoreBtiTabByFrames(tabId, activeId) {
  try {
    const frames = await getAllFrames(tabId);
    let score = 0;
    for (const f of frames) {
      const u = f.url || '';
      if (!u || u === 'about:blank') continue;
      score += scoreBtiFrameUrl(u);
      if (isInjectableBtiUrl(u)) score += 120;
      if (typeof isWidgetsXBetslipUrl === 'function' && isWidgetsXBetslipUrl(u)) score += 200;
    }
    if (tabId === activeId) score += 40;
    return score;
  } catch (_) {
    return 0;
  }
}

async function scoreBtiTabByPing(tab, activeId) {
  const tabId = tab.id;
  let score = scoreTabTitleForLeg1(tab);
  const url = await resolveTabUrlEnhanced(tab);
  if (isLeg1TabUrl(url)) score += 220;
  if (url && isLeg2Url(url) && !isLeg1TabUrl(url) && scoreTabTitleForLeg1(tab) < 40) return 0;
  if (tabId === activeId) score += 35;

  const frames = await getAllFrames(tabId);
  const ordered = [...frames].sort((a, b) => scoreBtiFrameUrl(b.url || '') - scoreBtiFrameUrl(a.url || ''));
  const frameIds = ordered.length ? ordered.map((f) => f.frameId) : [0];
  for (const frameId of frameIds.slice(0, 10)) {
    try {
      await ensureBtiScript(tabId, frameId);
      const ping = await withTimeout(sendBti(tabId, frameId, { type: 'PING' }), 1100, 'ping');
      if (ping?.ok) {
        score += 280 + Math.min(ping.buttonCount || 0, 80) + (ping.hasInput ? 120 : 0) + (ping.hasSlip ? 80 : 0);
        if (score >= 120) return score;
      }
    } catch (_) {}
  }
  if (!frames.length || (frames.length === 1 && !frames[0]?.url)) {
    try {
      await ensureBtiScript(tabId, 0);
      const ping = await withTimeout(sendBti(tabId, 0, { type: 'PING' }), 1100, 'ping');
      if (ping?.ok) score += 260;
    } catch (_) {}
  }
  return score;
}

async function findBtiTabByFrameProbe(tabs, activeId, recentIds = []) {
  const seen = new Set();
  const candidates = [];
  for (const id of recentIds) {
    if (!seen.has(id)) {
      seen.add(id);
      try {
        const tab = await chrome.tabs.get(id);
        if (tab?.id) candidates.push(tab);
      } catch (_) {}
    }
  }
  for (const tab of tabs) {
    if (tab?.id && !seen.has(tab.id)) {
      seen.add(tab.id);
      candidates.push(tab);
    }
  }

  const scored = await Promise.all(candidates.filter((tab) => {
    if (!tab?.id || isSkippableProbeTab(tab)) return false;
    return true;
  }).slice(0, 30).map(async (tab) => {
    const url = await resolveTabUrlEnhanced(tab);
    if (url && isLeg2Url(url) && !isLeg1TabUrl(url) && scoreTabTitleForLeg1(tab) < 30) {
      return { tab, score: 0 };
    }
    const frameScore = await scoreBtiTabByFrames(tab.id, activeId);
    let score = frameScore + scoreTabTitleForLeg1(tab);
    if (isLeg1TabUrl(url)) score += 100;
    if (tab.id === activeId) score += 15;
    if (score < 120) {
      const pingScore = await scoreBtiTabByPing(tab, activeId);
      score = Math.max(score, pingScore);
    }
    return { tab, score };
  }));

  const best = scored
    .filter((row) => row.score >= 80)
    .sort((a, b) => b.score - a.score)[0];
  return best?.tab || null;
}

async function findTabs(leg2Pref = 'bcgame') {
  const [allTabs, leg1PatternTabs, leg2PatternTabs, bindings] = await Promise.all([
    enumerateAllTabs(),
    queryTabsByUrlPatterns(leg1TabUrlPatterns()),
    queryTabsByUrlPatterns(leg2TabUrlPatterns(leg2Pref)),
    loadTabBindings()
  ]);
  const tabs = await enrichTabUrls(await mergeTabs(allTabs, leg1PatternTabs, leg2PatternTabs));
  const recentIds = getRecentWebTabIds();
  let btiTab = null;
  let btiBestScore = -1;
  const leg2Tabs = [];
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = activeTabs[0]?.id;

  btiTab = await tryBoundBtiTab(bindings, activeId);
  if (!btiTab) btiTab = await tryRecentTabsForBti(recentIds, activeId);

  if (!btiTab) {
    for (const tab of tabs) {
      const url = await resolveTabUrlEnhanced(tab);
      const leg1Score = (url ? scoreLeg1Tab(url, activeId, tab.id) : -1) + scoreTabTitleForLeg1(tab);
      if (leg1Score > btiBestScore) {
        btiBestScore = leg1Score;
        btiTab = tab;
      }
    }
    if (!btiTab && leg1PatternTabs.length) {
      for (const tab of leg1PatternTabs) {
        const url = await resolveTabUrlEnhanced(tab);
        const leg1Score = scoreLeg1Tab(url, activeId, tab.id) + scoreTabTitleForLeg1(tab);
        if (leg1Score > btiBestScore) {
          btiBestScore = leg1Score;
          btiTab = tab;
        }
      }
    }
    if (!btiTab) {
      btiTab = await findBtiTabByFrameProbe(tabs, activeId, recentIds);
    }
  }

  for (const tab of tabs) {
    const url = await resolveTabUrlEnhanced(tab);
    if (url && urlMatchesLeg2Pref(url, leg2Pref)) leg2Tabs.push({ tab, url });
  }

  let polyTab = await tryBoundLeg2Tab(bindings, leg2Pref, activeId);
  if (!polyTab) {
    let bestScore = -1;
    for (const { tab, url } of leg2Tabs) {
      const score = scoreLeg2Tab(url, activeId, tab.id, leg2Pref) + scoreTabTitleForLeg2(tab, leg2Pref);
      if (score > bestScore) { bestScore = score; polyTab = tab; }
    }
    if (!polyTab && leg2PatternTabs.length) {
      for (const tab of leg2PatternTabs) {
        const url = await resolveTabUrlEnhanced(tab);
        const score = scoreLeg2Tab(url, activeId, tab.id, leg2Pref) + scoreTabTitleForLeg2(tab, leg2Pref);
        if (score > bestScore) { bestScore = score; polyTab = tab; }
      }
    }
    if (!polyTab) {
      polyTab = await findLeg2TabByProbe(tabs, leg2Pref, activeId, recentIds);
    }
  }

  if (btiTab?.id) saveTabBindings({ btiTabId: btiTab.id }).catch(() => {});
  if (polyTab?.id) saveTabBindings({ leg2TabId: polyTab.id, leg2Pref }).catch(() => {});

  return {
    btiTab: btiTab ? { id: btiTab.id, url: (await resolveTabUrlEnhanced(btiTab)) || '' } : null,
    polyTab: polyTab ? { id: polyTab.id, url: (await resolveTabUrlEnhanced(polyTab)) || '' } : null
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
  if (/^(slip-display|slip-card|slip-latched|in-play-at|widgets-x-slip|widgets-x-at|board-slip-match)$/i.test(src)) return true;
  if (src.includes('bti-api')) return true;
  if (src === 'board-live' && slip.selectionText) return true;
  return false;
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
  let slip = (contentSlip?.odds > 1.01) ? contentSlip : null;
  if (!slip && scraped?.odds > 1.01) slip = scraped;

  if (!slip && ping?.ok) {
    const res2 = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: { preferActiveSlip: true, ...hint } });
    if (res2?.slip?.odds > 1.01) slip = res2.slip;
    else if (hint.excludeTeam || hint.polyTeam) {
      const res3 = await sendBti(tabId, frameId, { type: 'READ_BTI_ODDS', hint: { ...hint, forArbPick: true } });
      if (res3?.slip?.odds > 1.01) slip = res3.slip;
    }
    if (!slip) {
      const scraped2 = await injectReadBtiFrame(tabId, frameId);
      if (scraped2?.odds > 1.01) slip = scraped2;
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

async function probeBtiFrame(tabId, frameId, hint = {}, fast = true) {
  const ms = fast ? BTI_PROBE_FAST_MS : BTI_PROBE_MS;
  try {
    return await withTimeout(probeBtiFrameInner(tabId, frameId, hint), ms, `텐텐뱃 iframe ${frameId}`);
  } catch (_) {
    return { frameId, ping: null, slip: null, score: 0, hasInput: false, hasBoard: false };
  }
}

function updateBtiFrameRoles(tabId, results, frameUrls = {}) {
  let slipFrame = null;
  let slipScore = -1;
  let boardFrame = null;
  let boardScore = -1;
  for (const r of results) {
    const url = frameUrls[r.frameId] || '';
    const slipUrlBoost = /widgets-x/i.test(url) ? 800
      : (typeof isSportscenterBetslipUrl === 'function' && isSportscenterBetslipUrl(url) ? 900 : 0);
    if (r.hasInput || slipUrlBoost) {
      const s = slipUrlBoost + (r.slip?.odds > 1.01 ? 1000 : 0) + (r.ping?.hasInput ? 500 : 0);
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
  const slipHit = sorted.find((r) => r.slip?.odds > 1.01);
  return slipHit ? { slip: slipHit.slip, frameId: slipHit.frameId } : { slip: null, frameId: 0 };
}

async function readBtiFromAllFrames(tabId, hint = {}, forceFull = false) {
  const order = await orderBtiFrameIds(tabId);
  const limit = forceFull ? BTI_MAX_FRAMES : Math.min(order.length, 10);
  const toProbe = order.slice(0, limit);
  const probeFast = !forceFull;

  if (!forceFull && lastBtiFrame?.tabId === tabId && order.includes(lastBtiFrame.frameId)) {
    const fast = await probeBtiFrame(tabId, lastBtiFrame.frameId, hint, true);
    if (fast.slip?.odds > 1.01) {
      lastBtiFrame = { tabId, frameId: fast.frameId };
      return { slip: fast.slip, frameId: fast.frameId };
    }
  }

  await Promise.all(toProbe.map((fid) => ensureBtiScript(tabId, fid)));
  const frameUrls = await getFrameUrlMap(tabId);
  const results = await Promise.all(toProbe.map((fid) => probeBtiFrame(tabId, fid, hint, probeFast)));
  updateBtiFrameRoles(tabId, results, frameUrls);
  let merged = mergeBtiFrameResults(results);

  if (!(merged.slip?.odds > 1.01) && forceFull && toProbe.length < order.length) {
    const rest = order.slice(toProbe.length, BTI_MAX_FRAMES);
    const more = await Promise.all(rest.map((fid) => probeBtiFrame(tabId, fid, hint, false)));
    updateBtiFrameRoles(tabId, more, frameUrls);
    merged = mergeBtiFrameResults([...results, ...more]);
  }

  if (!(merged.slip?.odds > 1.01) && forceFull) {
    const scraped = await scrapeBtiFromAllFrames(tabId);
    if (scraped.slip?.odds > 1.01) return scraped;
  }

  if (!(merged.slip?.odds > 1.01) && forceFull) {
    try {
      const api = await withTimeout(fetchBtiSlipViaApi(tabId), 5000, 'BTI API');
      if (api.slip?.odds > 1.01) {
        lastBtiFrame = { tabId, frameId: api.frameId };
        return { slip: api.slip, frameId: api.frameId };
      }
    } catch (_) {}
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
    .map((t) => ({ tab: t, url: tabEffectiveUrl(t) }))
    .filter(({ url }) => url && urlMatchesLeg2Pref(url, leg2Pref))
    .map(({ tab, url }) => ({ tab, score: scoreLeg2Tab(url, null, tab.id, leg2Pref) }))
    .sort((a, b) => b.score - a.score);

  const fast = opts.fastScan !== false;
  const toScan = fast ? leg2Tabs.slice(0, 1) : leg2Tabs;

  let best = null;
  for (const { tab } of toScan) {
    const slip = await readPolyOddsOnce({ id: tab.id, url: tab.url }, opts);
    if (!(slip?.odds > 1.01) || (!polyOddsForScan(slip) && !isTrustedBcSlip(slip))) continue;
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
  const frames = await getAllFrames(btiTab.id);
  const msg = query ? { type: 'SEARCH_ODDS', query } : { type: 'SCRAPE_BOARD' };
  const results = await Promise.all(frames.map(async (f) => {
    if (/doubleclick|googlesyndication|tracker\.html|amazon-ivs|hcaptcha/i.test(f.url || '')) return null;
    try {
      await ensureBtiScript(btiTab.id, f.frameId);
      const board = await withTimeout(sendBti(btiTab.id, f.frameId, msg), 2200, 'BTI board');
      if (!board) return null;
      const score = (board.eventCount || 0) * 25 + (board.buttonCount || 0) + (board.hitCount || 0) * 10;
      return { ...board, frameId: f.frameId, score };
    } catch (_) {
      return null;
    }
  }));
  const scored = results.filter(Boolean).sort((a, b) => b.score - a.score);
  return scored[0] || { ok: false, events: [], hits: [], hitCount: 0, buttonCount: 0, eventCount: 0 };
}

async function diagnoseBtiExtension(leg2Pref = 'bcgame') {
  const manifest = chrome.runtime.getManifest();
  const tabs = await enumerateAllTabs();
  const webTabs = tabs.filter((t) => /^https?:/i.test(tabEffectiveUrl(t)));
  const found = await findTabs(leg2Pref);
  let inject = null;
  let scriptingOk = false;
  let scriptingErr = '';

  if (found.btiTab?.id) {
    try {
      const ping = await chrome.scripting.executeScript({
        target: { tabId: found.btiTab.id, frameIds: [0] },
        func: () => ({ href: location.href, host: location.hostname })
      });
      scriptingOk = !!ping?.[0]?.result?.href;
    } catch (e) {
      scriptingErr = String(e?.message || e).slice(0, 120);
    }
    inject = await injectAllBtiFramesTab(found.btiTab.id, true);
  }

  let summary = '';
  if (!found.btiTab) {
    summary = '텐텐뱃 탭 없음 — [텐텐뱃 열기] 클릭';
  } else if (!scriptingOk) {
    summary = `탭 접근 실패: ${scriptingErr || '권한 없음'} — 같은 Chrome인지 확인`;
  } else if (!(inject?.framesWithScript > 0)) {
    summary = `스크립트 주입 실패 — chrome://extensions 에서 확장 활성화 확인 (ID ${chrome.runtime.id})`;
  } else {
    summary = `정상 — 스크립트 ${inject.framesWithScript}개 프레임`;
  }

  return {
    ok: !!(found.btiTab && scriptingOk && inject?.framesWithScript > 0),
    extensionId: chrome.runtime.id,
    version: manifest.version,
    webTabCount: webTabs.length,
    btiTab: found.btiTab,
    scriptingOk,
    scriptingErr,
    inject,
    summary
  };
}

async function verifyBtiConnection(leg2Pref = 'bcgame') {
  const found = await findTabs(leg2Pref);
  if (!found.btiTab) {
    const tabs = await enumerateAllTabs();
    return {
      ok: false,
      reason: formatTabDiscoveryHint(tabs)
    };
  }
  const inject = await injectAllBtiFramesTab(found.btiTab.id, true);
  const board = await searchBtiBoardFromFrames(found.btiTab);
  const probes = await probeBtiFramesDiagnostic(found.btiTab);
  const scriptOk = inject.framesWithScript > 0;
  const bestProbe = probes.find((p) => p.slipOdds > 1.01) || null;
  return {
    ok: true,
    btiTab: found.btiTab,
    extensionVersion: chrome.runtime.getManifest().version,
    inject,
    scriptOk,
    bestSlipOdds: bestProbe?.slipOdds || 0,
    bestFrameId: bestProbe?.frameId ?? null,
    scriptWarning: scriptOk
      ? ''
      : `스크립트 주입 실패 (${inject.errors?.join(' · ') || '원인 불명'}) — chrome://extensions 에서 확장 v2.5.8 활성화 후 [텐텐뱃 열기]로 탭을 여세요`,
    board: {
      buttonCount: board.buttonCount || 0,
      eventCount: board.eventCount || 0,
      hitCount: board.hitCount || 0
    },
    probes: probes.slice(0, 8)
  };
}

async function probeBtiFramesDiagnostic(btiTab) {
  if (!btiTab?.id) return [];
  await injectAllBtiFramesTab(btiTab.id);
  const frames = await getAllFrames(btiTab.id);
  return Promise.all(frames.slice(0, 24).map(async (f) => {
    if (isJunkBtiFrameUrl(f.url)) return null;
    if (/doubleclick|googlesyndication|tracker\.html|amazon-ivs|hcaptcha/i.test(f.url || '')) return null;
    let ping = null;
    let slipOdds = 0;
    let buttons = 0;
    let marker = '';
    let hook = '';
    let liveSlip = null;
    try {
      await ensureBtiScript(btiTab.id, f.frameId);
      const markRes = await chrome.scripting.executeScript({
        target: { tabId: btiTab.id, frameIds: [f.frameId] },
        func: () => ({
          marker: document.documentElement.getAttribute('data-autobet-bti') || '',
          href: location.href
        })
      });
      marker = markRes?.[0]?.result?.marker || '';
      const hookRes = await chrome.scripting.executeScript({
        target: { tabId: btiTab.id, frameIds: [f.frameId] },
        world: 'MAIN',
        func: () => document.documentElement.getAttribute('data-autobet-hook') || ''
      });
      hook = hookRes?.[0]?.result || '';
      ping = await withTimeout(sendBti(btiTab.id, f.frameId, { type: 'PING' }), 1500, 'ping');
      const res = await withTimeout(
        sendBti(btiTab.id, f.frameId, { type: 'READ_BTI_ODDS', hint: { preferActiveSlip: true, forScan: true } }),
        1800,
        'read'
      );
      slipOdds = res?.slip?.odds > 1.01 ? res.slip.odds : 0;
      buttons = ping?.buttonCount || 0;
      if (slipOdds > 1.01) liveSlip = res.slip;
      if (!slipOdds) {
        const diag = await withTimeout(sendBti(btiTab.id, f.frameId, { type: 'BTI_DIAG' }), 1200, 'diag').catch(() => null);
        if (diag?.liveSlip?.odds > 1.01) {
          slipOdds = diag.liveSlip.odds;
          liveSlip = diag.liveSlip;
        }
      }
    } catch (_) {}
    return {
      frameId: f.frameId,
      url: f.url || '',
      widgetsX: /widgets-x/i.test(f.url || ''),
      sportscenterBetslip: typeof isSportscenterBetslipUrl === 'function' && isSportscenterBetslipUrl(f.url || ''),
      buttons,
      slipOdds,
      hasInput: !!ping?.hasInput,
      hasSlip: !!ping?.hasSlip,
      pingOk: !!ping?.ok,
      marker,
      hook,
      liveSlip
    };
  })).then((rows) => rows.filter(Boolean).sort((a, b) => {
    const sa = (a.slipOdds > 1 ? 3000 : 0) + (a.sportscenterBetslip ? 1500 : 0) + (a.hasInput ? 1000 : 0) + (a.hasSlip ? 500 : 0) + (a.pingOk ? 100 : 0);
    const sb = (b.slipOdds > 1 ? 3000 : 0) + (b.sportscenterBetslip ? 1500 : 0) + (b.hasInput ? 1000 : 0) + (b.hasSlip ? 500 : 0) + (b.pingOk ? 100 : 0);
    return sb - sa;
  }));
}

async function bruteReadBtiOdds(tabId) {
  await injectAllBtiFramesTab(tabId);
  const frames = await getAllFrames(tabId);
  const sorted = [...frames].sort((a, b) => {
    const sa = (typeof isWidgetsXBetslipUrl === 'function' && isWidgetsXBetslipUrl(a.url) ? 1000 : 0) + scoreBtiFrameUrl(a.url || '');
    const sb = (typeof isWidgetsXBetslipUrl === 'function' && isWidgetsXBetslipUrl(b.url) ? 1000 : 0) + scoreBtiFrameUrl(b.url || '');
    return sb - sa;
  });
  const hits = await Promise.all(sorted.map(async (f) => {
    if (/doubleclick|googlesyndication|tracker\.html|amazon-ivs|hcaptcha/i.test(f.url || '')) return null;
    try {
      const injected = await withTimeout(injectReadBtiFrame(tabId, f.frameId), 1400, 'brute-inject');
      if (injected?.odds > 1.01) return { ...injected, source: injected.source || 'brute-inject', _frameId: f.frameId };
    } catch (_) {}
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        func: () => {
          function po(t) {
            const n = parseFloat(String(t || '').trim());
            return n > 1.01 && n < 100 ? n : null;
          }
          let best = null;
          let bestScore = -1;
          const slipSel = document.querySelector('[class*="betInformation__title"]')?.textContent?.trim() || '';
          const selClean = slipSel.replace(/\s+/g, '').toLowerCase();
          for (const btn of document.querySelectorAll('button')) {
            const r = btn.getBoundingClientRect();
            if (!r || r.width < 2 || r.height < 2) continue;
            const cls = String(btn.className || '');
            const selected = /selected|active|pressed|highlight/i.test(cls)
              || btn.getAttribute('aria-pressed') === 'true'
              || btn.getAttribute('data-selected') === 'true';
            const oddsEl = btn.querySelector('[class*="odds"], [class*="Odds"]');
            let o = po(oddsEl?.textContent);
            if (!o) {
              const m = (btn.textContent || '').match(/(\d+\.\d{2,3})(?:\s*$)/);
              if (m) o = po(m[1]);
            }
            if (!o) continue;
            let score = selected ? 2000 : 20;
            if (/Selections_selection|master_fe_Selections/i.test(cls)) score += 200;
            const btnClean = (btn.textContent || '').replace(/\s+/g, '').toLowerCase();
            if (selClean.length > 2 && btnClean.includes(selClean.slice(0, Math.min(selClean.length, 6)))) score += 500;
            if (score > bestScore) {
              bestScore = score;
              best = { odds: o, selectionText: slipSel, selected };
            }
          }
          if (!best) {
            const counter = document.querySelector('#counter, input[class*="Counter"], input[placeholder*="베팅"]');
            const root = counter?.closest('[class*="betslip"], [class*="Betslip"]') || document.body;
            const at = (root.textContent || '').match(/@\s*(\d+\.\d{2,4})/);
            if (at) best = { odds: po(at[1]), selectionText: slipSel, selected: false };
          }
          return best;
        }
      });
      const hit = results?.[0]?.result;
      if (hit?.odds > 1.01) {
        return {
          odds: hit.odds,
          selectionText: hit.selectionText || '',
          source: 'brute-dom',
          fromSlip: false,
          _frameId: f.frameId
        };
      }
    } catch (_) {}
    return null;
  }));
  const found = hits.filter(Boolean).sort((a, b) => {
    const sa = (a.fromSlip ? 3000 : 0) + (a.selected ? 1200 : 0) + (isBtiSlipOddsSource(a) ? 800 : 0);
    const sb = (b.fromSlip ? 3000 : 0) + (b.selected ? 1200 : 0) + (isBtiSlipOddsSource(b) ? 800 : 0);
    return sb - sa;
  });
  if (found.length) {
    lastBtiFrame = { tabId, frameId: found[0]._frameId };
    return found[0];
  }
  return null;
}

function buildBtiReadHint(poly, opts = {}) {
  const forScan = opts.forScan === true || (opts.focusTab === true && opts.forStrike !== true);
  if (forScan) {
    return {
      preferActiveSlip: true,
      forScan: true,
      fastScan: opts.fastScan,
      focusTab: opts.focusTab,
      deepScan: opts.deepScan
    };
  }
  return { preferActiveSlip: true, ...(poly ? btiHintFromPoly(poly) : {}), ...opts };
}

function attachBtiFrameMeta(slip, frameId) {
  if (!slip || frameId == null) return slip;
  return { ...slip, _frameId: frameId };
}

async function readBtiOddsOnce(btiTab, poly, opts = {}) {
  if (!btiTab?.id) return null;
  await injectAllBtiFramesTab(btiTab.id);
  const hint = buildBtiReadHint(poly, opts);
  const deep = opts.deepScan === true || opts.focusTab === true || opts.fastScan === false;

  if (opts.instant) {
    let hit = await readBtiOddsInstant(btiTab.id, hint);
    if (hit?.odds > 1.01) return attachBtiFrameMeta(hit, hit._frameId);
    hit = await readBtiOddsFast(btiTab.id, { ...hint, fastScan: true });
    if (hit?.odds > 1.01) return attachBtiFrameMeta(hit, hit._frameId);
  } else {
    let hit = await readBtiOddsFast(btiTab.id, { ...hint, fastScan: true });
    if (hit?.odds > 1.01) return attachBtiFrameMeta(hit, hit._frameId);
  }

  if (hint.forScan) {
    try {
      const merged = await readBtiFromAllFrames(btiTab.id, hint, true);
      if (merged.slip?.odds > 1.01) return attachBtiFrameMeta(merged.slip, merged.frameId);
    } catch (_) {}
  }

  if (deep) {
    try {
      const merged = await readBtiFromAllFrames(btiTab.id, hint, true);
      if (merged.slip?.odds > 1.01) return attachBtiFrameMeta(merged.slip, merged.frameId);
    } catch (_) {}

    let hit = await readBtiOddsFast(btiTab.id, { ...hint, fastScan: false });
    if (hit?.odds > 1.01) return attachBtiFrameMeta(hit, hit._frameId);
  }

  if (opts.forScan || opts.instant || opts.focusTab) {
    const brute = await bruteReadBtiOdds(btiTab.id);
    if (brute?.odds > 1.01 && isBtiSlipOddsSource(brute)) return attachBtiFrameMeta(brute, brute._frameId);
  }

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
      files: [isStakeSportsUrl(polyTab.url) ? 'stake_slip_read.js' : 'bc_slip_read.js']
    });
    const slipBet = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [frameId] },
      func: async (amount) => {
        if (typeof window.__stakePlaceBet === 'function') return window.__stakePlaceBet(amount);
        if (typeof window.__bcPlaceBet === 'function') return window.__bcPlaceBet(amount);
        return null;
      },
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
    score: (typeof scoreLeg2FrameUrl === 'function' ? scoreLeg2FrameUrl(f.url || '', tabUrl) : scoreBcLeg2FrameUrl(f.url || '', tabUrl)) + (f.frameId === 0 ? 2 : 0),
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
  if (isStakeSportsUrl(polyTab.url)) {
    await ensureLeg2Script(polyTab.id, 0, polyTab.url);
    const res = await sendPoly(polyTab.id, { type: 'PROBE_POLY' }, 0);
    if (res?.probe) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: 0 };
      return res.probe;
    }
  }
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

  const leg2Name = leg2PrefLabel(leg2SiteKey(found?.polyTab?.url) || 'bcgame');
  const strikePoly = isStrikeBcSlip(freshPoly) ? freshPoly : (isStrikeBcSlip(poly) ? poly : null);
  if (!strikePoly) {
    return {
      ok: false,
      btiClosed: false,
      reason: `${leg2Name} 슬립 없음 — 카트에 배당 선택 후 스캔`,
      btiUi,
      polyProbe
    };
  }

  if (!polyProbe?.hasInput || !polyProbe?.hasBtn || polyProbe?.btnDisabled) {
    return {
      ok: false,
      btiClosed: false,
      reason: `${leg2Name} 배팅 준비 안됨 — 슬립 열기·금액 입력 확인`,
      btiUi,
      polyProbe
    };
  }

  if (polyProbe?.slipOdds > 1.01 && Math.abs(polyProbe.slipOdds - strikePoly.odds) > 0.2) {
    return {
      ok: false,
      btiClosed: false,
      reason: `${leg2Name} 배당 불일치 — 슬립 다시 확인`,
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

async function setPolyAmountViaStakeSlipRead(polyTab, amountUsd) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [0] },
      files: ['stake_slip_read.js']
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [0] },
      func: async (amount) => (typeof window.__stakeSetStake === 'function' ? window.__stakeSetStake(amount) : { ok: false, reason: 'no-set-stake' }),
      args: [amountUsd]
    });
    return results?.[0]?.result || { ok: false, reason: 'stake-slip-set-fail' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function setPolyAmount(polyTab, amountUsd) {
  if (!polyTab?.id) return { ok: false, reason: '탭 없음' };
  if (isStakeSportsUrl(polyTab.url)) {
    await ensureLeg2Script(polyTab.id, 0, polyTab.url);
    const slipHit = await setPolyAmountViaStakeSlipRead(polyTab, amountUsd);
    if (slipHit?.ok) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: 0 };
      return slipHit;
    }
    const res = await sendPoly(polyTab.id, { type: 'SET_POLY_AMOUNT', amount: amountUsd, force: true }, 0);
    if (res?.ok) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: 0 };
      return res;
    }
    return { ok: false, reason: `${leg2PrefLabel('stake')} 금액 입력 실패 — 슬립 금액란 확인` };
  }
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
  if (isStakeSportsUrl(polyTab.url)) {
    await ensureLeg2Script(polyTab.id, 0, polyTab.url);
    const res = await sendPoly(polyTab.id, { type: 'ENSURE_POLY_PANEL', team: teamHint || '' }, 0);
    if (res?.ok) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: 0 };
      return { ...res, frameId: 0 };
    }
    return { ok: false, reason: `${leg2PrefLabel('stake')} 슬립 없음 — 배당 클릭` };
  }
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

  if (isStakeSportsUrl(polyTab.url)) {
    if (!skipFill && !fastStrike) await ensurePolyPanel(polyTab, teamHint);
    const frameIds = [0];
    if (lastBcLeg2Frame?.tabId === polyTab.id) frameIds.unshift(lastBcLeg2Frame.frameId);
    for (const frameId of [...new Set(frameIds)]) {
      const res = await placePolyBetOnFrame(polyTab, amountUsd, frameId, { skipFill, fastStrike, teamHint });
      if (res?.success) {
        lastBcLeg2Frame = { tabId: polyTab.id, frameId: res.frameId ?? frameId };
        return res;
      }
    }
    return { success: false, reason: `${leg2PrefLabel('stake')} 배팅 실패 — 슬립·금액 확인` };
  }

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
  const leg2Name = leg2PrefLabel(leg2Pref || 'bcgame');
  if (opts.leg2Synced === false) {
    return { ok: false, reason: `${leg2Name} 미연결 — 사이트 선택 후 [연결] 버튼을 눌러주세요` };
  }

  const found = await findTabs(leg2Pref);
  if (opts.found?.btiTab?.id) {
    found.btiTab = opts.found.btiTab;
  }
  if (opts.found?.polyTab?.id) {
    found.polyTab = opts.found.polyTab;
  }
  if (!found.btiTab && !found.polyTab) {
    return { ok: false, reason: `x10x10s + ${leg2Name} 탭을 열어주세요`, found };
  }
  if (!found.btiTab) {
    return { ok: false, reason: '텐텐뱃: x10x10s.com 스포츠 탭 없음', found };
  }
  if (!found.polyTab) {
    return { ok: false, reason: `${leg2Name}: 스포츠 탭 없음`, found };
  }

  if (opts.connectLight) {
    return {
      ok: true,
      found,
      poly: null,
      bti: null,
      arbBti: null,
      polyO: null,
      btiO: null,
      profit: null,
      polyUsd: 0,
      reason: '연결됨 — 배당 선택 후 [스캔]',
      hint: {}
    };
  }

  const readOpts = {
    ...opts,
    leg2Pref,
    autoClick: opts.autoClick !== false,
    focusTab: opts.focusTab === true,
    fastScan: opts.fastScan !== false
  };
  const btiReadOpts = {
    fastScan: readOpts.fastScan,
    deepScan: readOpts.focusTab,
    focusTab: readOpts.focusTab,
    forScan: true,
    instant: readOpts.instant === true
  };
  const scanAttempts = readOpts.instant ? 1 : (readOpts.focusTab ? 2 : (readOpts.fastScan ? 1 : 2));
  const scanDelay = readOpts.instant ? 0 : (readOpts.focusTab ? 400 : 250);

  let poly = null;
  let arbBti = null;
  const polyReadOpts = {
    ...readOpts,
    fastScan: readOpts.instant ? true : readOpts.fastScan,
    waitMs: readOpts.instant ? 0 : readOpts.waitMs,
    instant: readOpts.instant === true
  };
  for (let attempt = 0; attempt < scanAttempts; attempt++) {
    try {
      const [btiTry, polyTry] = await Promise.all([
        readBtiOddsOnce(found.btiTab, null, btiReadOpts),
        (async () => {
          const multi = await readPolySlipAllBcTabs(leg2Pref, polyReadOpts);
          if (multi?.tab) found.polyTab = multi.tab;
          if (multi?.slip?.odds > 1.01) return multi.slip;
          return readPolyOddsOnce(found.polyTab, polyReadOpts);
        })()
      ]);
      if (btiTry?.odds > 1.01) arbBti = btiTry;
      if (polyTry && polyOddsForScan(polyTry)) poly = polyTry;
    } catch (_) {}

    if ((arbBti?.odds > 1.01) && polyOddsForScan(poly)) break;
    if (attempt < scanAttempts - 1) await sleep(scanDelay);
  }

  if (!(arbBti?.odds > 1.01)) {
    try {
      arbBti = await bruteReadBtiOdds(found.btiTab.id);
      if (arbBti && !isBtiSlipOddsSource(arbBti)) arbBti = null;
    } catch (_) {}
  }
  const bti = arbBti;

  const polyOVal = polyOddsForScan(poly);
  const btiO = arbBti?.odds > 1.01 ? normalizeSportsOdds(arbBti.odds) : 0;
  const polyO = polyOVal > 1.01 ? polyOVal : 0;
  const profit = (btiO > 1.01 && polyO > 1.01) ? calcProfit(btiO, polyO) : null;
  const polyUsd = (btiO > 1.01 && polyO > 1.01) ? calcPolyBetUsd(btiBetKrw, btiO, polyO, usdRate) : 0;

  let reason = '';
  if (btiO <= 1.01 && polyO > 1.01) reason = '텐텐뱃 라이브 슬립 배당 없음 — 배당 클릭 후 베팅카트 확인';
  else if (btiO > 1.01 && polyO <= 1.01) reason = poly?.odds > 1.01
    ? `${leg2Name} 배당 검증 실패 — 슬립/선택 배당 확인`
    : `${leg2Name} 배당 없음 — 카트에 배당 선택 후 스캔`;

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
    hint: btiHintFromPoly(poly),
    btiDebug: bti ? {
      source: bti.source || bti.sourceKind || '',
      frameId: bti._frameId ?? null,
      fromSlip: !!bti.fromSlip,
      selectionText: bti.selectionText || bti.teamLabel || ''
    } : null
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
