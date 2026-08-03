// stake_api_hook.js — Stake.com GraphQL/fetch 슬립 배당 캡처 (MAIN world)
(function () {
  'use strict';

  function pm(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  function shouldWatch(url) {
    if (!url) return false;
    return /stake\.com|graphql|sport|bet|slip|wager|coupon/i.test(String(url));
  }

  function isSlipContext(keyPath) {
    const p = keyPath.join('.').toLowerCase();
    return /slip|betslip|sportbet|outcome|coupon|selection|wager/i.test(p);
  }

  function extractFromOutcome(obj, keyPath = []) {
    if (!obj || typeof obj !== 'object') return null;
    const path = keyPath.join('.').toLowerCase();

    const odds = pm(obj.odds ?? obj.price ?? obj.coefficient ?? obj.multiplier ?? obj.decimalOdds);
    const name = obj.name || obj.outcomeName || obj.selectionName || obj.team || '';
    const id = obj.id || obj.outcomeId || '';
    const active = obj.active;

    if (odds > 1.01 && odds < 100 && isSlipContext(keyPath)) {
      if (active === false) return null;
      return {
        odds: Math.round(odds * 1000) / 1000,
        teamLabel: String(name).slice(0, 80),
        outcomeId: String(id || ''),
        outcomeName: String(name || ''),
        source: 'stake',
        sourceKind: 'stake-api-slip',
        fromSlip: true,
        capturedAt: Date.now()
      };
    }

    if (Array.isArray(obj)) {
      let best = null;
      for (let i = 0; i < obj.length; i++) {
        const hit = extractFromOutcome(obj[i], [...keyPath, String(i)]);
        if (hit && (!best || hit.outcomeId)) best = hit;
      }
      return best;
    }

    let best = null;
    for (const key of Object.keys(obj)) {
      if (obj[key] == null || typeof obj[key] !== 'object') continue;
      const hit = extractFromOutcome(obj[key], [...keyPath, key]);
      if (!hit) continue;
      const score = (hit.outcomeId ? 10 : 0) + (hit.teamLabel ? 5 : 0);
      const bestScore = (best?.outcomeId ? 10 : 0) + (best?.teamLabel ? 5 : 0);
      if (!best || score > bestScore) best = hit;
    }
    return best;
  }

  function extractSportBetSlip(data) {
    if (!data || typeof data !== 'object') return null;

    const paths = [
      data?.data?.sportBetSlip,
      data?.data?.betSlip,
      data?.data?.activeBetSlip,
      data?.data?.sport?.betSlip
    ];
    for (const root of paths) {
      if (!root) continue;
      const outcomes = root.outcomes || root.selections || root.bets;
      if (Array.isArray(outcomes) && outcomes.length) {
        const o = outcomes[0];
        const odds = pm(o?.odds ?? o?.outcome?.odds ?? o?.price);
        const name = o?.outcome?.name || o?.name || o?.selectionName || '';
        if (odds > 1.01 && odds < 100) {
          return {
            odds: Math.round(odds * 1000) / 1000,
            teamLabel: String(name).slice(0, 80),
            outcomeId: String(o?.outcome?.id || o?.id || ''),
            source: 'stake',
            sourceKind: 'stake-api-slip',
            fromSlip: true,
            capturedAt: Date.now()
          };
        }
      }
    }
    return extractFromOutcome(data, []);
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
      const slip = extractSportBetSlip(data);
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
        const reqBody = args[1]?.body;
        if (reqBody && shouldWatch(url)) parseBody(reqBody);
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

  window.addEventListener('__stakeSlipApiUpdate', () => {});
})();
