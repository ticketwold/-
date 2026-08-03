// bti_api_hook.js — 텐텐뱃/BTI fetch·XHR·storage 슬립 캐치 (MAIN, document_start)
(function () {
  if (window.__btiApiHooked) return;
  window.__btiApiHooked = true;
  window.__btiApiSlip = null;

  function po(n) {
    const x = parseFloat(n);
    return Number.isFinite(x) && x > 1.01 && x < 500 ? x : null;
  }

  function pickOdds(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of [
      'Price', 'DisplayPrice', 'Odds', 'Decimal', 'DecimalOdds', 'odds', 'price',
      'coefficient', 'Coefficient', 'decimal', 'displayPrice', 'totalOdds', 'combinedOdds'
    ]) {
      const v = po(obj[k]);
      if (v) return v;
    }
    return null;
  }

  function pack(odds, extra) {
    if (!(odds > 1.01)) return null;
    return {
      odds: Math.round(odds * 1000) / 1000,
      selectionText: extra.selectionText || extra.name || extra.Name || extra.TeamName || '',
      eventText: extra.eventText || extra.EventName || extra.eventName || '',
      marketKind: extra.marketKind || 'ml',
      source: 'bti-api',
      fromSlip: true,
      sourceKind: 'bti-api-hook',
      capturedAt: Date.now(),
      ...extra
    };
  }

  function fromSelection(sel, ctx) {
    const odds = pickOdds(sel);
    if (!odds) return null;
    return pack(odds, {
      selectionText: sel.Name || sel.TeamName || sel.SelectionName || sel.label || sel.name || '',
      eventText: ctx?.EventName || ctx?.eventName || '',
      marketKind: /over|under|오버|언더|OU/i.test(JSON.stringify(sel)) ? 'ou' : 'ml'
    });
  }

  function extractSlip(obj, depth, ctx) {
    if (obj == null || depth > 18) return null;
    if (typeof obj === 'string') {
      if (obj.length < 4 || obj.length > 800000) return null;
      try { return extractSlip(JSON.parse(obj), depth + 1, ctx); } catch (_) { return null; }
    }
    if (Array.isArray(obj)) {
      let best = null;
      for (const item of obj) {
        const h = extractSlip(item, depth + 1, ctx);
        if (h?.odds > 1.01) best = h;
      }
      return best;
    }
    if (typeof obj !== 'object') return null;

    const total = po(obj.totalOdds ?? obj.combinedOdds ?? obj.TotalOdds ?? obj.CombinedOdds);
    if (total) {
      const sels = obj.Selections || obj.selections || obj.Bets || obj.bets || obj.items;
      const first = Array.isArray(sels) ? sels[0] : null;
      return pack(total, {
        selectionText: first?.Name || first?.TeamName || first?.SelectionName || '',
        eventText: obj.EventName || obj.eventName || first?.EventName || ''
      });
    }

    const direct = pickOdds(obj);
    if (direct && (obj.Name || obj.TeamName || obj.SelectionName || obj.SelectionId || obj.selectionId)) {
      return fromSelection(obj, ctx || obj);
    }

    if (Array.isArray(obj.Selections) && obj.Selections.length) {
      for (let i = obj.Selections.length - 1; i >= 0; i--) {
        const h = fromSelection(obj.Selections[i], obj);
        if (h) return h;
      }
    }
    if (Array.isArray(obj.selections) && obj.selections.length) {
      for (let i = obj.selections.length - 1; i >= 0; i--) {
        const h = fromSelection(obj.selections[i], obj);
        if (h) return h;
      }
    }

    for (const key of [
      'betSlip', 'betslip', 'BetSlip', 'slip', 'coupon', 'ticket', 'payload', 'data', 'result',
      'Bets', 'bets', 'items', 'Selections', 'selections', 'markets', 'Markets', 'event', 'Event'
    ]) {
      if (obj[key]) {
        const h = extractSlip(obj[key], depth + 1, obj);
        if (h) return h;
      }
    }

    for (const k of Object.keys(obj)) {
      if (/^(code|msg|message|status|success|timestamp|id|language|count)$/i.test(k)) continue;
      const h = extractSlip(obj[k], depth + 1, ctx || obj);
      if (h) return h;
    }
    return null;
  }

  function saveSlip(slip, via) {
    if (!(slip?.odds > 1.01)) return;
    window.__btiApiSlip = {
      ...slip,
      capturedAt: Date.now(),
      apiVia: String(via || '').slice(0, 160)
    };
    try {
      window.dispatchEvent(new CustomEvent('__btiSlipApiUpdate', { detail: window.__btiApiSlip }));
    } catch (_) {}
  }

  function capture(body, via) {
    const slip = extractSlip(body, 0, null);
    if (slip) saveSlip(slip, via);
  }

  function shouldWatch(url) {
    const u = String(url || '');
    return /sportscenter|betslip|bet-slip|wager|selection|coupon|ticket|sport|market|bti|x10x10|live8588|fxf774|odds|slip/i.test(u);
  }

  const _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = async function (...args) {
      const res = await _fetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (shouldWatch(url)) {
          const clone = res.clone();
          const ct = clone.headers?.get?.('content-type') || '';
          if (ct.includes('json') || ct.includes('text') || !ct) {
            const text = await clone.text();
            if (text && text.length < 900000) {
              try { capture(JSON.parse(text), url); } catch (_) {}
            }
          }
        }
      } catch (_) {}
      return res;
    };
  }

  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__btiUrl = url;
    return xOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        const url = this.__btiUrl || '';
        if (!shouldWatch(url)) return;
        const ct = this.getResponseHeader('content-type') || '';
        if (!ct.includes('json') && !ct.includes('text') && this.responseText?.[0] !== '{' && this.responseText?.[0] !== '[') return;
        capture(JSON.parse(this.responseText), url);
      } catch (_) {}
    });
    return xSend.apply(this, arguments);
  };

  function hookStorage(store) {
    if (!store || store.__btiHooked) return;
    store.__btiHooked = true;
    const _set = store.setItem;
    store.setItem = function (key, val) {
      _set.apply(this, arguments);
      if (!/bet|slip|selection|wager|coupon|sport|betslip/i.test(String(key || ''))) return;
      try { capture(JSON.parse(val), 'storage:' + key); } catch (_) {
        try {
          const m = String(val || '').match(/\b\d+\.\d{2,4}\b/g);
          if (m?.length) {
            const odds = po(m[m.length - 1]);
            if (odds) saveSlip({ odds, selectionText: '', source: 'bti-api' }, 'storage-text:' + key);
          }
        } catch (_2) {}
      }
    };
  }
  try { hookStorage(window.localStorage); } catch (_) {}
  try { hookStorage(window.sessionStorage); } catch (_) {}

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    const t = e.data.type || e.data.event || '';
    if (!/bet|slip|selection|sport|wager|odd/i.test(t)) return;
    try { capture(e.data.payload || e.data.data || e.data, 'postMessage:' + t); } catch (_) {}
  }, true);
})();
