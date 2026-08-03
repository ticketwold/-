// BTI API 슬립 읽기 — 세션 쿠키 기반 (토큰 저장 없음, 매 요청 credentials:include)
'use strict';

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

  function pickOdds(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of [
      'Price', 'DisplayPrice', 'Odds', 'Decimal', 'totalOdds', 'combinedOdds',
      'odds', 'price', 'coefficient', 'decimal'
    ]) {
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

    const total = pickOdds(obj);
    const sels = obj.Selections || obj.selections || obj.Bets || obj.bets || obj.items;
    if (total && (Array.isArray(sels) || obj.Name || obj.TeamName)) {
      const first = Array.isArray(sels) ? sels[sels.length - 1] : obj;
      return {
        odds: Math.round(total * 1000) / 1000,
        selectionText: first?.Name || first?.TeamName || first?.SelectionName || '',
        eventText: obj.EventName || obj.eventName || first?.EventName || '',
        source: 'bti-api',
        fromSlip: true,
        sourceKind: 'bti-api-fetch'
      };
    }

    if (Array.isArray(sels)) {
      for (let i = sels.length - 1; i >= 0; i--) {
        const o = pickOdds(sels[i]);
        if (o) {
          return {
            odds: Math.round(o * 1000) / 1000,
            selectionText: sels[i].Name || sels[i].TeamName || sels[i].SelectionName || '',
            eventText: obj.EventName || obj.eventName || sels[i].EventName || '',
            source: 'bti-api',
            fromSlip: true,
            sourceKind: 'bti-api-fetch'
          };
        }
      }
    }

    const direct = pickOdds(obj);
    if (direct && (obj.Name || obj.TeamName || obj.SelectionName || obj.SelectionId)) {
      return {
        odds: Math.round(direct * 1000) / 1000,
        selectionText: obj.Name || obj.TeamName || obj.SelectionName || '',
        eventText: obj.EventName || obj.eventName || '',
        source: 'bti-api',
        fromSlip: true,
        sourceKind: 'bti-api-fetch'
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

async function fetchBtiJsonInFrame(tabId, frameId, path) {
  try {
    const via = await chrome.tabs.sendMessage(tabId, {
      type: 'FETCH_BTI_JSON',
      path: path.startsWith('http') ? null : path,
      url: path.startsWith('http') ? path : null
    }, { frameId });
    if (via?.ok && via.data !== undefined) return via.data;
  } catch (_) {}

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: async (p) => {
        const fetchUrl = p.startsWith('http') ? p : (location.origin.replace(/\/$/, '') + p);
        const res = await fetch(fetchUrl, { credentials: 'include', cache: 'no-store' });
        if (!res.ok) return { error: String(res.status) };
        return await res.json();
      },
      args: [path]
    });
    const result = results?.[0]?.result;
    if (!result || result.error) throw new Error(result?.error || 'fetch 실패');
    return result;
  } catch (e) {
    throw e;
  }
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

async function fetchBtiSlipViaApi(tabId, tabUrl) {
  const order = await orderBtiFrameIds(tabId);
  const frames = order.slice(0, BTI_MAX_FRAMES);

  for (const frameId of frames) {
    const hooked = await readBtiApiSlipHook(tabId, frameId);
    if (hooked?.odds > 1.01) return { slip: hooked, frameId };
  }

  let lastErr = 'BTI API 슬립 없음';
  for (const frameId of frames) {
    await ensureBtiScript(tabId, frameId);
    for (const path of BTI_API_SLIP_PATHS) {
      try {
        const data = await fetchBtiJsonInFrame(tabId, frameId, path);
        const slip = parseBtiApiSlipData(data);
        if (slip?.odds > 1.01) return { slip, frameId };
      } catch (e) {
        lastErr = e.message || lastErr;
      }
    }
  }

  return { slip: null, frameId: 0, error: lastErr };
}
