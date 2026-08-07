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
    const item = result?.items?.[0] || {};
    const status = item.status || result?.parsed_status || result?.reason || "";
    const reason = item.status_reason || result?.status_reason || "";
    const odds = String(item.odds ?? result?.extracted_odds ?? "");
    const prev = String(item.previous_odds ?? "");
    return `${status}|${reason}|${odds}|${prev}|${location.href}|${hash}`;
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

  async function handleBridgeCommand(message) {
    const actions = global.ArbStakeActions;
    if (!actions) return { ok: false, error: "stake-actions-missing", frame_url: location.href };
    const cmd = message.command;

    if (cmd === "scan_bc_stake") {
      const report = actions.scanBcInputReport?.() || actions.scanBcStakeInputs?.({ debug: true, probe: true, frameUrl: location.href });
      const payload = report?.report || report || {};
      const best = payload.best || report?.best;
      return {
        ok: !!best?.selector || !!payload.found,
        frame_url: location.href,
        slip_found: payload.slip_found ?? !!payload.slip?.root,
        slip_selector: payload.slip_selector || "",
        scans: payload.scans || report?.scans || [],
        input_candidates: payload.input_candidates || report?.input_candidates || [],
        scan_lines: payload.scan_lines || report?.scanLines || [],
        found: payload.found || null,
        best,
        selector: best?.selector || payload.selector || "",
        current_value: best?.current_value ?? payload.found?.current_value ?? null,
        score: best?.score || 0,
        deferred: false,
      };
    }

    if (cmd === "set_bc_stake" || cmd === "read_bc_stake") {
      if (cmd === "read_bc_stake") {
        const read = actions.readBcStake();
        if (!read.ok) return { ...read, deferred: true };
        return read;
      }
      if (cmd === "set_bc_stake" && message.test && actions.testBcStakeInput) {
        return actions.testBcStakeInput(Number(message.amount_usdt));
      }
      const scan = actions.scanBcStakeInputs?.({ debug: true, probe: true, frameUrl: location.href });
      if (!scan?.best?.input) {
        return { ok: false, reason: "stake-input-not-found", frame_url: location.href, deferred: true };
      }
      return actions.setBcStake(Number(message.amount_usdt), { debug: true, test: !!message.test });
    }

    if (cmd === "set_x10_stake") {
      const result = actions.setX10Stake(Number(message.amount_krw));
      if (result?.deferred) return { ...result, frame_url: location.href };
      return result;
    }
    if (cmd === "place_bc_bet") {
      return actions.placeBcBet();
    }
    if (cmd === "place_x10_bet") {
      return actions.placeX10Bet();
    }
    return { ok: false, error: "unknown-command", frame_url: location.href };
  }

  function attachObservers(onChange) {
    const observers = [];
    let debounceTimer = null;

    function schedule() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => onChange(false), 30);
    }

    function addObserver(target) {
      if (!target) return;
      const obs = new MutationObserver(() => schedule());
      obs.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "disabled", "aria-disabled", "data-status", "style"],
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

    function runDiagnostics(result) {
      if (site === "x10" && scanner.buildX10DebugSnapshot) {
        const snapshot = scanner.buildX10DebugSnapshot(frameDepth);
        sendDebug("X10 DEBUG", {
          ...meta(),
          ...snapshot,
          reason: result?.status_reason || result?.reason || "",
          slip_root_found: snapshot.slip_root_found || result?.slip_root_found || "NO",
          odds_candidates: result?.odds_candidates || snapshot.odds_candidates || [],
          extracted_odds: result?.extracted_odds ?? snapshot.extracted_odds ?? null,
          status_diagnostics: result?.status_diagnostics || snapshot.status_diagnostics || {},
          parsed_status: result?.parsed_status || snapshot.parsed_status || "",
          status_reason: result?.status_reason || snapshot.status_reason || "",
        });
        sendDebug("SLIP ROOT FOUND", {
          ...meta(),
          found: snapshot.slip_root_found || "NO",
          selector: result?.container_selector || "",
          text: (result?.slip_inner_text || snapshot.slip_inner_text || "").slice(0, 240),
        });
        return;
      }

      const diag =
        site === "bc" ? scanner.diagnoseBcFrame() : scanner.diagnoseX10Frame(frameDepth);

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
      if (!force && key === lastKey) {
        if (site === "x10") {
          runDiagnostics(result);
        }
        return;
      }
      lastKey = key;

      if (force || debugKey !== lastDebugKey) {
        lastDebugKey = debugKey;
        runDiagnostics(result);
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
          status_reason: item.status_reason || "",
          previous_odds: item.previous_odds ?? "",
        });
      }

      sendSlipUpdate(site, result, meta());
    }

    function bootstrap() {
      scan(true);
      if (disconnectObservers) disconnectObservers();
      disconnectObservers = attachObservers(scan);

      if (site === "bc" && global.ArbStakeActions) {
        const registerStake = () => {
          try {
            global.ArbStakeActions.registerBcStakeLocator?.();
          } catch (_err) {}
        };
        registerStake();
        global.ArbStakeActions.watchBcStakeInput?.(() => {
          registerStake();
          chrome.runtime.sendMessage({
            type: "stake_input_changed",
            site: "bc",
            frame_url: location.href,
          });
        });
      }

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
      if (message?.type === "bridge_command" && message.site === site) {
        handleBridgeCommand(message)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
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
