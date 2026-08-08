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
    const hash = result?.dom_hash || global.ArbFrameScanner?.domHash?.(document) || String(bodyTextLength());
    const item = result?.items?.[0] || {};
    const status = item.status || result?.parsed_status || result?.reason || "";
    const reason = item.status_reason || result?.status_reason || "";
    const odds = String(item.odds ?? result?.extracted_odds ?? "");
    const prev = String(item.previous_odds ?? "");
    const rev = String(result?.revision ?? "");
    const rootId = result?.root_id || "";
    return `${rev}|${status}|${reason}|${odds}|${prev}|${location.href}|${hash}|${rootId}`;
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
      revision: result?.revision ?? null,
      dom_hash: result?.dom_hash ?? null,
      root_id: result?.root_id ?? null,
      timestamp: result?.timestamp ?? Date.now(),
      result,
    });
  }

  async function handleBridgeCommand(message) {
    const actions = global.ArbStakeActions;
    if (!actions) return { ok: false, error: "stake-actions-missing", frame_url: location.href };
    const cmd = message.command;
    const site = message.site === "bc" ? "bc" : "x10";

    if (cmd === "scan_bet_buttons") {
      return actions.scanBetButton?.(site) || { ok: false, reason: "not-found", frame_url: location.href, deferred: true };
    }

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
      if (cmd === "set_bc_stake") {
        try {
          chrome.runtime.sendMessage({
            type: "bridge_debug",
            block: "BC STAKE",
            step: "CONTENT_SCRIPT_RECEIVE",
            site: "bc",
            frame_url: location.href,
            content_script_received: "PASS",
            amount_usdt: message.amount_usdt,
          });
        } catch (_err) {}
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
      return actions.placeBcBet(message.execution_id);
    }
    if (cmd === "place_x10_bet") {
      return actions.placeX10Bet(message.execution_id);
    }
    return { ok: false, error: "unknown-command", frame_url: location.href };
  }

    function attachObservers(onChange) {
    const observers = [];
    let debounceTimer = null;

    function schedule() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        bumpRevision("mutation");
        onChange(false);
      }, 30);
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
    let lastSentRevision = -1;
    let slipRevision = 0;
    let lastSlipRoot = null;
    let disconnectObservers = null;
    const startedAt = Date.now();
    const frameDepth = getFrameDepth();

    function bumpRevision(_tag) {
      slipRevision += 1;
      return slipRevision;
    }

    function emitInvalidated(reason) {
      const rev = bumpRevision(reason || "invalidated");
      const payload = {
        ok: false,
        empty: true,
        items: [],
        reason: reason || "slip-invalidated",
        invalidated: true,
        revision: rev,
        dom_hash: "",
        root_id: "",
        timestamp: Date.now(),
        frame_url: location.href,
        slip_root_found: "NO",
        parsed_status: "EMPTY",
      };
      sendDebug("SLIP INVALIDATED", { ...meta(), reason, revision: rev });
      sendSlipUpdate(site, payload, meta());
      lastKey = resultKey(payload);
      lastSentRevision = rev;
    }

    const meta = () => ({
      site,
      frame_url: location.href,
      frame_depth: frameDepth,
      frame_id: null,
      tab_id: null,
    });

    function emitContentScriptLoaded() {
      try {
        chrome.runtime.sendMessage({
          type: "content_script_loaded",
          site,
          frame_url: location.href,
          readyState: documentReady(),
        });
      } catch (_err) {}
      sendDebug("CONTENT SCRIPT LOADED", {
        ...meta(),
        readyState: documentReady(),
      });
    }

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

      if (site === "bc") {
        for (const scan of diag.selector_scans || []) {
          sendDebug("BC FRAME", {
            ...meta(),
            readyState: documentReady(),
            selector: scan.selector,
            match_count: scan.match_count,
            sample_text: scan.sample_text,
          });
        }
        sendDebug("BC DEBUG", {
          ...meta(),
          slip_root_found: result?.slip_root_found || (result?.empty ? "NO" : "YES"),
          slip_count: result?.slip_count ?? 0,
          selector: result?.container_selector || "",
          match_count: diag.betslip_selection_count ?? 0,
          extracted_odds: result?.extracted_odds ?? result?.items?.[0]?.odds ?? null,
          parsed_status: result?.parsed_status || result?.items?.[0]?.status || result?.reason || "",
          slip_inner_text: (result?.slip_inner_text || "").slice(0, 1000),
          selector_hits: result?.selector_hits || diag.selector_scans || [],
        });
      }

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

    function trackSlipRoot(result) {
      const selector = result?.container_selector || "";
      let root = null;
      if (selector) {
        try {
          root = document.querySelector(selector);
        } catch (_err) {
          root = null;
        }
      }
      if (lastSlipRoot && !lastSlipRoot.isConnected) {
        lastSlipRoot = null;
        emitInvalidated("root-removed");
        return false;
      }
      if (root && lastSlipRoot && root !== lastSlipRoot) {
        bumpRevision("root-replaced");
        sendDebug("SCANNING NEW SLIP", { ...meta(), revision: slipRevision });
      }
      if (root) lastSlipRoot = root;
      else if (result?.empty || result?.reason === "no-slip-root") lastSlipRoot = null;
      return true;
    }

    function scan(force) {
      if (lastSlipRoot && !lastSlipRoot.isConnected) {
        emitInvalidated("root-removed");
      }

      const result = site === "bc" ? scanner.readBcSlip() : scanner.readX10Slip();
      result.frame_url = location.href;
      result.frame_depth = frameDepth;
      if (!result.revision) {
        result.revision = slipRevision;
      } else {
        result.revision = Math.max(Number(result.revision || 0), slipRevision);
      }
      if (!result.timestamp) {
        result.timestamp = Date.now();
      }
      if (!trackSlipRoot(result)) {
        return;
      }

      const key = resultKey(result);
      const debugKey = `${key}|${bodyTextLength()}`;
      const revisionChanged = Number(result.revision || 0) !== lastSentRevision;
      if (!force && key === lastKey && !revisionChanged) {
        if (site === "x10") {
          runDiagnostics(result);
        }
        return;
      }
      lastKey = key;
      lastSentRevision = Number(result.revision || 0);

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
      emitContentScriptLoaded();
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
      if (site === "x10" && message?.type === "x10_probe") {
        const scanner = global.ArbFrameScanner;
        const probe = global.ArbX10Probe;
        const snap = scanner?.buildX10DebugSnapshot?.(frameDepth) || {};
        const frame = probe?.probeFrame?.() || {};
        const rootFound = snap.slip_root_found === "YES" || snap.root_found === "YES";
        const odds = snap.extracted_odds ?? null;
        const status = String(snap.parsed_status || "empty").toUpperCase();
        sendResponse({
          ok: true,
          frame_id: message.frame_id ?? null,
          frame_url: location.href,
          frame_depth: frameDepth,
          root_found: rootFound,
          slip_count: snap.slip_count ?? 0,
          odds,
          status,
          body_has_keywords: !!(frame.body_has_keywords ?? frame.hasBetSlipKeyword),
          ...frame,
          ...snap,
        });
        return true;
      }
      if (site === "x10" && message?.type === "RESCAN_X10") {
        const scanner = global.ArbFrameScanner;
        const probe = global.ArbX10Probe;
        scan(true);
        const slip = scanner?.readX10Slip?.() || {};
        const snap = scanner?.buildX10DebugSnapshot?.(frameDepth) || {};
        const frame = probe?.probeFrame?.() || {};
        const rootFound = slip.slip_root_found === "YES" || snap.slip_root_found === "YES";
        const fallbackUsed = !!(slip.fallback_used ?? snap.fallback_used);
        const slipCount = slip.slip_count ?? snap.slip_count ?? 0;
        const odds = slip.extracted_odds ?? slip.items?.[0]?.odds ?? snap.extracted_odds ?? null;
        const rawStatus = slip.parsed_status || snap.parsed_status || "empty";
        const status =
          rawStatus === "active" && odds != null ? "ACTIVE" : String(rawStatus || "empty").toUpperCase();
        const bodyHasKeywords = !!(frame.body_has_keywords ?? frame.hasBetSlipKeyword);
        const pass = slipCount === 1 && odds != null && status === "ACTIVE";
        sendResponse({
          ok: pass,
          frame_id: message.frame_id ?? null,
          frame_url: location.href,
          frame_depth: frameDepth,
          root_found: rootFound,
          fallback_used: fallbackUsed,
          slip_count: slipCount,
          odds,
          status,
          body_has_keywords: bodyHasKeywords,
          keyword_frame: bodyHasKeywords,
          anchor_hits: frame.anchor_hits || {},
          pipeline_steps: slip.pipeline_steps || snap.pipeline_steps || {},
          first_failure: slip.first_failure || snap.first_failure || "",
          odds_locator_debug: snap.odds_locator_debug || "",
          slip,
          ...snap,
        });
        return true;
      }
      if (site === "x10" && message?.type === "x10_capture_dom") {
        const probe = global.ArbX10Probe;
        if (!probe) {
          sendResponse({ ok: false, reason: "probe-missing" });
          return true;
        }
        const report = probe.captureDomReport();
        const html = probe.buildDebugHtml(report);
        sendResponse({ ok: true, report, html, frame_url: location.href, frame_depth: frameDepth });
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
