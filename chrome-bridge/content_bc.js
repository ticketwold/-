/** BC.Game / BetBy iframe content script entry. */
(function () {
  const info = {
    href: location.href,
    top: window.top === window,
    readyState: document.readyState,
  };
  console.log("[CONTENT LOADED][BC]", info);
  try {
    chrome.runtime.sendMessage({
      type: "content_loaded",
      site: "bc",
      href: location.href,
      top_frame: window.top === window,
      ready_state: document.readyState,
    });
  } catch (_err) {}

  if (globalThis.ArbDebugTrace) {
    globalThis.ArbDebugTrace.runFrameDiagnostics("bc");
  }
  if (globalThis.ArbFrameAgent) {
    globalThis.ArbFrameAgent.init("bc");
  }
})();
