// Polymarket mobile helpers — MAIN world bet via message bridge
(function () {
  if (window.__polyMobileBridge) return;
  window.__polyMobileBridge = true;

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'PLACE_BET_MAIN') {
      (async () => {
        if (typeof window.__polyMainPlaceBet !== 'function') {
          sendResponse({ success: false, reason: 'MAIN 베팅 스크립트 없음' });
          return;
        }
        const res = await window.__polyMainPlaceBet(msg.amount);
        sendResponse(res);
      })();
      return true;
    }
    if (msg.type === 'PROBE_POLY_MAIN') {
      sendResponse({
        ok: true,
        probe: typeof window.__polyMainProbe === 'function' ? window.__polyMainProbe() : null
      });
      return false;
    }
  });
})();
