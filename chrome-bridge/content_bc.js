/**
 * BC.Game content script — BetSlip 컨테이너만 읽고 변경 시 service worker에 전송.
 */
(function () {
  if (window.top !== window) {
    // iframe 내부에서도 slip이 있을 수 있음 — 계속 진행
  }

  const SITE = "bc";
  let lastPayload = "";
  let observer = null;

  function readSlip() {
    if (!globalThis.ArbFrameScanner?.readBcSlip) {
      return { ok: false, empty: true, items: [], reason: "scanner-missing" };
    }
    return globalThis.ArbFrameScanner.readBcSlip();
  }

  function publish(force) {
    const result = readSlip();
    const payload = JSON.stringify(result);
    if (!force && payload === lastPayload) return;
    lastPayload = payload;
    chrome.runtime.sendMessage({
      type: "slip_update",
      site: SITE,
      frame_url: location.href,
      result,
    });
  }

  function attachObserver() {
    if (observer) observer.disconnect();
    const slip = document.querySelector(
      '[data-editor-id="betslipSelection"], [class*="betslipSelection"], [class*="BetSlipSelection"], [class*="betslip"]'
    );
    if (!slip) return;
    observer = new MutationObserver(() => publish(false));
    observer.observe(slip, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  function bootstrap() {
    publish(true);
    attachObserver();
    setInterval(() => {
      publish(false);
      attachObserver();
    }, 1500);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "scan_slip" && message.site === SITE) {
      publish(true);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
