/**
 * Shared frame agent — per-frame scan, debug, dedup, observers.
 * Each iframe runs independently; never uses parent.contentDocument.
 */
(function initFrameAgent(global) {
  const WATCH_MS = 30_000;
  const POLL_MS = 1500;

  function getFrameDepth() {
    let depth = 0;
    let w = global;
    try {
      while (w !== w.parent) {
        depth += 1;
        w = w.parent;
      }
    } catch (_err) {
      return -1;
    }
    return depth;
  }

  function bodyTextLength() {
    try {
      return (document.body?.innerText || document.body?.textContent || "").length;
    } catch (_err) {
      return 0;
    }
  }

  function documentReady() {
    return document.readyState || "unknown";
  }

  function resultKey(result) {
    const hash = global.ArbFrameScanner?.domHash?.(document) || String(bodyTextLength());
    return `${result?.reason || ""}|${location.href}|${hash}`;
  }

  function sendDebug(block, payload) {
    chrome.runtime.sendMessage({
      type: "bridge_debug",
      block,
      site: payload.site,
      tab_id: payload.tab_id,
      frame_id: payload.frame_id,
      frame_url: payload.frame_url || location.href,
      frame_depth: payload.frame_depth,
      ...payload,
    });
  }

  function sendSlipUpdate(site, result, meta) {
    chrome.runtime.sendMessage({
      type: "slip_update",
      site,
      frame_url: location.href,
      frame_depth: meta.frame_depth,
      frame_id: meta.frame_id,
      result,
    });
  }

  function attachObservers(onChange) {
    const observers = [];

    function addObserver(target) {
      if (!target) return;
      const obs = new MutationObserver(() => onChange(false));
      obs.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      observers.push(obs);
    }

    addObserver(document.body || document.documentElement);

    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        addObserver(iframe.parentElement || iframe);
      } catch (_err) {}
    }

    return () => observers.forEach((o) => o.disconnect());
  }

  function init(site) {
    const scanner = global.ArbFrameScanner;
    if (!scanner) return;

    let lastKey = "";
    let lastDebugKey = "";
    let disconnectObservers = null;
    const startedAt = Date.now();
    const frameDepth = getFrameDepth();

    const meta = () => ({
      site,
      frame_url: location.href,
      frame_depth: frameDepth,
      frame_id: frameDepth,
      tab_id: null,
    });

    function runDiagnostics() {
      const diag =
        site === "bc" ? scanner.diagnoseBcFrame() : scanner.diagnoseX10Frame();

      sendDebug("FRAME DEBUG", {
        ...meta(),
        document_ready: documentReady(),
        body_text_length: bodyTextLength(),
        diagnostics: diag,
      });

      for (const scan of diag.selector_scans || []) {
        sendDebug("FRAME SCAN", {
          ...meta(),
          selector: scan.selector,
          match_count: scan.match_count,
          sample_text: scan.sample_text,
        });
      }
    }

    function scan(force) {
      const result = site === "bc" ? scanner.readBcSlip() : scanner.readX10Slip();
      result.frame_url = location.href;
      result.frame_depth = frameDepth;

      const key = resultKey(result);
      const debugKey = `${key}|${bodyTextLength()}`;
      if (!force && key === lastKey) return;
      lastKey = key;

      if (force || debugKey !== lastDebugKey) {
        lastDebugKey = debugKey;
        runDiagnostics();
      }

      if (!result.empty && result.items?.length) {
        const item = result.items[0];
        sendDebug("SLIP ROOT FOUND", {
          ...meta(),
          selector: result.container_selector || item.container_selector || "",
          text: [item.event, item.market, item.selection].filter(Boolean).join(" | ").slice(0, 240),
        });
        sendDebug("SLIP ITEM", {
          ...meta(),
          event: item.event || "",
          market: item.market || "",
          selection: item.selection || "",
          odds: item.odds ?? "",
          stake: item.stake ?? "",
          status: item.status || "",
        });
      }

      sendSlipUpdate(site, result, meta());
    }

    function bootstrap() {
      scan(true);
      if (disconnectObservers) disconnectObservers();
      disconnectObservers = attachObservers(scan);

      const timer = setInterval(() => {
        scan(false);
        if (Date.now() - startedAt > WATCH_MS) {
          clearInterval(timer);
        }
      }, POLL_MS);
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "scan_slip" && message.site === site) {
        scan(true);
        sendResponse({ ok: true, frame_url: location.href, frame_depth: frameDepth });
        return true;
      }
      return false;
    });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
    } else {
      bootstrap();
    }
  }

  global.ArbFrameAgent = { init };
})(typeof globalThis !== "undefined" ? globalThis : window);
