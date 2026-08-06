/**
 * BetSlip DOM monitor — hash + MutationObserver (polling 최소화).
 */
(function () {
  if (window.__arbSlipMonitor) return window.__arbSlipMonitor;

  const state = {
    observers: [],
    lastHash: '',
    mutationCount: 0,
    canScan: false
  };

  function slipRoots() {
    const roots = [];
    const selectors = [
      '[data-editor-id*="betslip"]',
      '[class*="betslip_fe"]',
      '[class*="Betslip"]',
      '[class*="betslip"]',
      '[class*="bet-slip"]',
      '[id*="betslip"]'
    ];
    const seen = new Set();
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        roots.push(el);
      }
    }
    return roots;
  }

  function collectSlipText() {
    return slipRoots().map((el) => (el.innerText || el.textContent || '').trim()).join('\n');
  }

  function fnv1a(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function computeHash() {
    const blob = collectSlipText();
    return fnv1a(blob);
  }

  function onMutate() {
    state.mutationCount += 1;
    const h = computeHash();
    if (h !== state.lastHash) {
      state.lastHash = h;
      state.canScan = slipRoots().some((r) => (r.innerText || '').trim().length > 8);
      window.dispatchEvent(new CustomEvent('arb-slip-mutate', { detail: { hash: h } }));
    }
  }

  function setupObserver() {
    for (const obs of state.observers) {
      try { obs.disconnect(); } catch (_) {}
    }
    state.observers = [];
    for (const root of slipRoots()) {
      const obs = new MutationObserver(onMutate);
      obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      state.observers.push(obs);
    }
    state.lastHash = computeHash();
    state.canScan = slipRoots().length > 0;
  }

  window.__arbSlipMonitor = {
    computeHash,
    setupObserver,
    getState() {
      return {
        hash: computeHash(),
        mutationCount: state.mutationCount,
        canScan: state.canScan,
        rootCount: slipRoots().length
      };
    },
    waitForChange(prevHash, timeoutMs) {
      return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          const h = computeHash();
          if (h !== prevHash) return resolve({ changed: true, hash: h });
          if (Date.now() - start >= timeoutMs) return resolve({ changed: false, hash: h });
          requestAnimationFrame(check);
        };
        check();
      });
    }
  };

  setupObserver();
  return window.__arbSlipMonitor;
})();
