// bc_api_hook.js — BC.Game fetch/XHR 슬립 캐치 (document_start MAIN)
(function () {
  if (window.__bcApiHooked) return;
  window.__bcApiHooked = true;
  window.__bcApiSlip = null;

  function po(n) {
    const x = parseFloat(n);
    return Number.isFinite(x) && x > 1.01 && x < 100 ? x : null;
  }

  function pm(n) {
    const x = parseFloat(String(n || '').replace(/,/g, ''));
    return Number.isFinite(x) && x > 0 ? x : null;
  }

  function pack(odds, stake, payout, extra) {
    if (!(odds > 1.01)) return null;
    const o = {
      odds,
      stake: stake || null,
      payout: payout || null,
      source: 'bcgame',
      sourceKind: 'bc-api',
      fromPayout: !!(stake > 0 && payout > stake),
      hasInput: true,
      ...extra
    };
    o.displayLabel = `${odds.toFixed(3)}${stake > 0 ? ` · ${stake} USDT` : ''}`;
    return o;
  }

  function extractSlip(obj, depth) {
    if (obj == null || depth > 16) return null;
    if (typeof obj === 'string') {
      if (obj.length < 4 || obj.length > 500000) return null;
      try { return extractSlip(JSON.parse(obj), depth + 1); } catch (_) { return null; }
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const h = extractSlip(item, depth + 1);
        if (h) return h;
      }
      return null;
    }
    if (typeof obj !== 'object') return null;

    const odds = po(obj.odds ?? obj.price ?? obj.coefficient ?? obj.decimalOdds ?? obj.oddsValue ?? obj.odd);
    const stake = pm(obj.stake ?? obj.amount ?? obj.betAmount ?? obj.bet_stake ?? obj.betAmountUsd);
    let payout = pm(obj.payout ?? obj.potentialWin ?? obj.toWin ?? obj.winAmount ?? obj.possibleWin);

    if (odds && (stake > 0 || payout > 0)) {
      const o = stake > 0 && payout > stake ? Math.round((payout / stake) * 1000) / 1000 : odds;
      return pack(o, stake, payout, { teamLabel: obj.teamName || obj.outcomeName || obj.selectionName || '' });
    }

    for (const key of ['bets', 'selections', 'betSlip', 'betslip', 'items', 'data', 'result', 'payload']) {
      if (obj[key]) {
        const h = extractSlip(obj[key], depth + 1);
        if (h) return h;
      }
    }

    for (const k of Object.keys(obj)) {
      if (/^(code|msg|message|status|success|timestamp|id)$/i.test(k)) continue;
      const h = extractSlip(obj[k], depth + 1);
      if (h) return h;
    }
    return null;
  }

  function saveSlip(slip, url) {
    if (!(slip?.odds > 1.01)) return;
    window.__bcApiSlip = { ...slip, capturedAt: Date.now(), apiUrl: String(url || '').slice(0, 160) };
    try {
      window.dispatchEvent(new CustomEvent('__bcSlipApiUpdate', { detail: window.__bcApiSlip }));
    } catch (_) {}
  }

  function capture(body, url) {
    const slip = extractSlip(body, 0);
    if (slip) saveSlip(slip, url);
  }

  function shouldWatch(url) {
    const u = String(url || '');
    return /betby|slip|sport|wager|stake|odd|coupon|ticket|sptsportscdn|selection|bc\.game/i.test(u);
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
          if (ct.includes('json') || ct.includes('text')) {
            const text = await clone.text();
            try { capture(JSON.parse(text), url); } catch (_) {}
          }
        }
      } catch (_) {}
      return res;
    };
  }

  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__bcUrl = url;
    return xOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        const url = this.__bcUrl || '';
        if (!shouldWatch(url)) return;
        const ct = this.getResponseHeader('content-type') || '';
        if (this.responseText && (ct.includes('json') || this.responseText.startsWith('{'))) {
          capture(JSON.parse(this.responseText), url);
        }
      } catch (_) {}
    });
    return xSend.apply(this, arguments);
  };

  window.addEventListener('storage', (e) => {
    if (!e.key || !/bet|slip|sport|wager/i.test(e.key)) return;
    try { capture(JSON.parse(e.newValue), 'storage:' + e.key); } catch (_) {}
  });
})();
