// stake_api_hook.js — Stake.com fetch/XHR 슬립 캡처 (MAIN world)
(function () {
  'use strict';

  function pm(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  function shouldWatch(url) {
    if (!url) return false;
    const u = String(url);
    return /stake\.com|sport|bet|slip|wager|odd|coupon|graphql/i.test(u);
  }

  function extractSlip(obj, depth = 0) {
    if (!obj || depth > 12) return null;
    if (typeof obj !== 'object') return null;

    const odds = pm(obj.odds ?? obj.price ?? obj.coefficient ?? obj.decimalOdds ?? obj.odd);
    const stake = pm(obj.stake ?? obj.amount ?? obj.betAmount ?? obj.wager);
    const payout = pm(obj.payout ?? obj.potentialWin ?? obj.toWin ?? obj.returnAmount);
    const team = obj.selectionName || obj.outcomeName || obj.team || obj.name || '';

    if (odds > 1.01 && odds < 500) {
      const o = Math.round(odds * 1000) / 1000;
      return {
        odds: o,
        stake: stake || null,
        payout: payout || null,
        teamLabel: String(team || '').slice(0, 80),
        fromPayout: stake > 0 && payout > stake,
        source: 'stake',
        sourceKind: 'stake-api',
        capturedAt: Date.now()
      };
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const hit = extractSlip(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }

    for (const key of Object.keys(obj)) {
      const hit = extractSlip(obj[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  function publish(slip) {
    if (!(slip?.odds > 1.01)) return;
    window.__stakeApiSlip = { ...slip, capturedAt: Date.now() };
    try {
      window.dispatchEvent(new CustomEvent('__stakeSlipApiUpdate', { detail: slip }));
    } catch (_) {}
  }

  function parseBody(body) {
    if (!body) return;
    try {
      const data = typeof body === 'string' ? JSON.parse(body) : body;
      const slip = extractSlip(data);
      if (slip) publish(slip);
    } catch (_) {}
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (shouldWatch(url)) {
          res.clone().text().then(parseBody).catch(() => {});
        }
      } catch (_) {}
      return res;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__stakeUrl = url;
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      this.addEventListener('load', () => {
        if (shouldWatch(this.__stakeUrl)) parseBody(this.responseText);
      });
      if (body && shouldWatch(this.__stakeUrl)) parseBody(body);
      return send.apply(this, arguments);
    };
  }
})();
