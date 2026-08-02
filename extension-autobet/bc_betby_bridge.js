// bc_betby_bridge.js — BC.Game BetBy/BTRenderer 탐지 (MAIN world, bc.game)
(function () {
  if (window.__bcBetbyBridge) return;
  window.__bcBetbyBridge = true;

  function walk(node, visit, depth) {
    if (!node || depth > 50) return;
    visit(node, depth);
    if (node.nodeType === 1) {
      if (node.shadowRoot) walk(node.shadowRoot, visit, depth + 1);
      for (const c of node.childNodes) walk(c, visit, depth + 1);
    } else if (node.nodeType === 11) {
      for (const c of node.childNodes) walk(c, visit, depth + 1);
    }
  }

  window.__bcDiscoverIframes = function () {
    const out = [];
    walk(document.documentElement, (node) => {
      if (node.nodeType !== 1 || node.tagName !== 'IFRAME') return;
      const src = node.src || node.getAttribute('src') || '';
      const r = node.getBoundingClientRect?.();
      out.push({
        src: src.slice(0, 200),
        w: Math.round(r?.width || node.offsetWidth || 0),
        h: Math.round(r?.height || node.offsetHeight || 0)
      });
    }, 0);
    return out.filter((f) => f.w > 40 && f.h > 40);
  };

  window.__bcWaitRenderer = function (maxMs) {
    maxMs = maxMs || 5000;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const ready = !!window.BTRenderer;
        const iframes = window.__bcDiscoverIframes();
        const sports = iframes.filter((f) => /sptsportscdn|cocoesports|betby|sptpub|renderer|sportsbook/i.test(f.src));
        if (ready || sports.length || Date.now() - t0 > maxMs) {
          resolve({ ready, sports, all: iframes, ms: Date.now() - t0 });
        } else {
          requestAnimationFrame(tick);
        }
      };
      tick();
    });
  };

  function hookBtRenderer() {
    if (window.__bcBtRendererHooked) return;
    const Orig = window.BTRenderer;
    if (typeof Orig !== 'function') return;
    window.__bcBtRendererHooked = true;
    window.BTRenderer = function (...args) {
      const inst = new Orig(...args);
      window.__bcBtRenderer = inst;
      try {
        window.dispatchEvent(new CustomEvent('__bcBtRendererReady', { detail: inst }));
      } catch (_) {}
      return inst;
    };
    window.BTRenderer.prototype = Orig.prototype;
    Object.keys(Orig).forEach((k) => { window.BTRenderer[k] = Orig[k]; });
  }

  hookBtRenderer();
  const poll = setInterval(() => {
    hookBtRenderer();
    if (window.__bcBtRendererHooked) clearInterval(poll);
  }, 200);
  setTimeout(() => clearInterval(poll), 15000);

  window.addEventListener('message', (e) => {
    try {
      const d = e?.data;
      if (!d || typeof d !== 'object') return;
      const slip = window.__bcApiSlip;
      if (typeof window.__bcApiHooked === 'undefined') return;
      const odds = parseFloat(d.odds ?? d.price ?? d.coefficient ?? d.decimalOdds);
      if (!(odds > 1.01 && odds < 100)) return;
      window.__bcApiSlip = {
        odds,
        stake: parseFloat(d.stake ?? d.amount) || null,
        payout: parseFloat(d.payout ?? d.potentialWin ?? d.toWin) || null,
        source: 'bcgame',
        sourceKind: 'bc-api',
        fromPayout: false,
        capturedAt: Date.now(),
        via: 'postMessage-bridge'
      };
    } catch (_) {}
  }, true);

  console.log('[BC.Game BetBy bridge] loaded');
})();
