/** x10x10s / BTI iframe content script entry. */
(function () {
  const info = {
    href: location.href,
    top: window.top === window,
    readyState: document.readyState,
  };
  console.log("[CONTENT LOADED][X10]", info);
  try {
    chrome.runtime.sendMessage({
      type: "content_loaded",
      site: "x10",
      href: location.href,
      top_frame: window.top === window,
      ready_state: document.readyState,
    });
  } catch (_err) {}

  if (globalThis.ArbDebugTrace) {
    globalThis.ArbDebugTrace.runFrameDiagnostics("x10");
  }
  if (globalThis.ArbFrameAgent) {
    globalThis.ArbFrameAgent.init("x10");
  }
})();
