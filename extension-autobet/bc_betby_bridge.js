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

  console.log('[BC.Game BetBy bridge] loaded');
})();
