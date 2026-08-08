/**
 * BC / x10 stake input write — betslip-scoped, React-compatible, per-frame.
 */
(function initStakeActions(global) {
  const BC_SLIP_SELECTORS = [
    '[data-editor-id="betslipSelection"]',
    '[data-editor-id="betslip"]',
    '[data-editor-id*="betslip"]',
    '[data-testid*="betslip" i]',
    '[class*="betslip" i]',
    '[class*="bet-slip" i]',
    '[class*="BetSlip" i]',
    '[id*="betslip" i]',
    '[class*="coupon" i]',
  ];

  const BC_INPUT_SELECTORS = [
    '[data-editor-id*="stake" i]',
    '[data-testid*="stake" i]',
    '[data-editor-id="betslipStakeInput"]',
    '[data-editor-id*="betslipStake"]',
    '[data-editor-id*="Stake"]',
    'input[inputmode="decimal"]',
    'input[inputmode="numeric"]',
    'input[type="number"]',
    'input[type="text"]',
    'input[class*="stake" i]',
    'input[class*="amount" i]',
  ];

  const VERIFY_DELAYS_MS = [0, 50, 100, 250];
  const MAX_RETRIES = 2;
  const TOLERANCE = 0.01;

  let _lastDebug = null;
  let _stakeObserver = null;
  let _onStakeDomChange = null;
  const _clickLocks = new Map();

  function emitBcStakeStep(step, fields = {}) {
    const payload = { block: "BC STAKE", step, frame_url: location.href, ...fields };
    try {
      console.log(`[BC STAKE] ${step} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    } catch (_err) {}
    emitStakeDebug("BC STAKE", payload);
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    } catch (_err) {}
    return true;
  }

  function text(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function parseStakeValue(raw) {
    const n = parseFloat(String(raw ?? "").replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }

  function getValueSetter() {
    return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set || null;
  }

  function isEditableInput(el) {
    if (!el) return false;
    if (el instanceof HTMLInputElement) return el.type !== "hidden";
    if (el instanceof HTMLTextAreaElement) return true;
    if (el.isContentEditable) return true;
    return el.getAttribute?.("role") === "textbox" || el.getAttribute?.("role") === "spinbutton";
  }

  function readInputValue(el) {
    if (!el) return "";
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || "";
    if (el.isContentEditable) return text(el);
    return el.getAttribute?.("value") || "";
  }

  function dispatchInput(input, data, inputType) {
    try {
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: inputType || "insertText",
          data: data == null ? undefined : String(data),
        })
      );
    } catch (_err) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(input, value) {
    const str = String(value);
    input.focus?.({ preventScroll: true });
    if (input.isContentEditable) {
      input.textContent = str;
      dispatchInput(input, str, "insertText");
      return;
    }
    const setter = getValueSetter();
    if (setter) setter.call(input, str);
    else input.value = str;
    dispatchInput(input, str, "insertText");
  }

  function clearNativeValue(input) {
    input.focus?.();
    if (input.isContentEditable) {
      input.textContent = "";
      dispatchInput(input, "", "deleteContentBackward");
      return;
    }
    const setter = getValueSetter();
    if (setter) setter.call(input, "");
    else input.value = "";
    dispatchInput(input, "", "deleteContentBackward");
    try {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Backspace" }));
    } catch (_err) {}
  }

  function inputMeta(input) {
    return {
      placeholder: input.placeholder || input.getAttribute?.("placeholder") || "",
      type: input.type || input.tagName?.toLowerCase() || "",
      inputmode: input.getAttribute("inputmode") || "",
      class: input.className || "",
      "data-editor-id": input.getAttribute("data-editor-id") || "",
      "data-testid": input.getAttribute("data-testid") || "",
      value: readInputValue(input),
      disabled: !!input.disabled,
      readonly: !!input.readOnly,
      "aria-disabled": input.getAttribute("aria-disabled") || "",
      outerHTML: (input.outerHTML || "").slice(0, 320),
    };
  }

  function probeInput(input) {
    let focusOk = false;
    try {
      input.focus?.({ preventScroll: true });
      focusOk = document.activeElement === input;
    } catch (_err) {}
    return {
      focus_ok: focusOk,
      value: readInputValue(input),
      placeholder: input.placeholder || input.getAttribute?.("placeholder") || "",
      disabled: !!input.disabled,
      readonly: !!input.readOnly,
      "aria-disabled": input.getAttribute("aria-disabled") || "",
    };
  }

  function findBcSelectionElement() {
    for (const sel of ['[data-editor-id="betslipSelection"]', '[data-editor-id*="betslipSelection"]']) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch (_err) {
        continue;
      }
      for (const el of nodes) {
        if (!visible(el)) continue;
        const editorId = el.getAttribute("data-editor-id") || "";
        if (/betslipSelections$/i.test(editorId)) continue;
        return el;
      }
    }
    return null;
  }

  function hasBcStakeInputIn(node) {
    if (!node) return false;
    for (const sel of BC_INPUT_SELECTORS) {
      try {
        for (const el of node.querySelectorAll(sel)) {
          if (isEditableInput(el) && visible(el)) return true;
        }
      } catch (_err) {}
    }
    return false;
  }

  function hasBcBetButtonIn(node) {
    if (!node) return false;
    let nodes = [];
    try {
      nodes = [...node.querySelectorAll("button, [role='button']")];
    } catch (_err) {
      return false;
    }
    return nodes.some((btn) => {
      if (!visible(btn)) return false;
      return /bet|베팅|place/i.test(text(btn));
    });
  }

  function findBcSlipRoot() {
    const selection = findBcSelectionElement();

    if (selection) {
      let node = selection;
      let best = null;
      while (node && node !== document.body) {
        if (hasBcStakeInputIn(node) || hasBcBetButtonIn(node)) {
          best = node;
        }
        node = node.parentElement;
      }
      if (best) {
        return { root: best, selector: "ancestor-of-betslipSelection", selection };
      }

      node = selection.parentElement;
      while (node && node !== document.body) {
        let selectionCount = 0;
        try {
          for (const el of node.querySelectorAll(
            '[data-editor-id="betslipSelection"], [data-editor-id*="betslipSelection"]',
          )) {
            if (!visible(el)) continue;
            const editorId = el.getAttribute("data-editor-id") || "";
            if (/betslipSelections$/i.test(editorId)) continue;
            selectionCount += 1;
          }
        } catch (_err) {}
        if (selectionCount >= 1 && (hasBcStakeInputIn(node) || hasBcBetButtonIn(node))) {
          return { root: node, selector: "ancestor-of-betslipSelection", selection };
        }
        node = node.parentElement;
      }
    }

    for (const sel of BC_SLIP_SELECTORS) {
      if (sel.includes("betslipSelection")) continue;
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch (_err) {
        continue;
      }
      for (const el of nodes) {
        if (!visible(el)) continue;
        return { root: el, selector: sel, selection: findBcSelectionElement() };
      }
    }
    return { root: null, selector: "", selection: selection || null };
  }

  function getBcStakeSearchRoots(slip) {
    const roots = [];
    const seen = new Set();
    const add = (root, scope) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      roots.push({ root, scope });
    };

    if (slip?.root) add(slip.root, "slip-root");

    let node = slip?.selection || null;
    for (let depth = 0; node && depth < 8; depth += 1) {
      add(node, depth === 0 ? "selection-card" : "selection-ancestor");
      if (slip?.root && node === slip.root) break;
      node = node.parentElement;
    }

    if (slip?.selection?.parentElement) {
      let parent = slip.selection.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1) {
        add(parent, "near-selection-parent");
        if (slip?.root && parent === slip.root) break;
        parent = parent.parentElement;
      }
    }

    return roots;
  }

  function scoreBcStakeInput(input, searchRoot, scope = "slip-root") {
    if (!searchRoot?.contains(input)) return -1;
    if (!visible(input)) return -1;
    if (input.disabled || input.readOnly) return -200;
    if (input.getAttribute("aria-disabled") === "true") return -200;
    let score = scope === "slip-root" ? 40 : 20;
    const blob = `${input.id} ${input.placeholder} ${input.className} ${input.getAttribute("data-editor-id") || ""} ${input.getAttribute("data-testid") || ""} ${input.getAttribute("name") || ""}`.toLowerCase();
    if (/stake|amount|usdt|bet/i.test(blob)) score += 100;
    if (input.getAttribute("data-editor-id")?.toLowerCase().includes("stake")) score += 150;
    if (input.getAttribute("data-testid")?.toLowerCase().includes("stake")) score += 120;
    if (input.type === "number" || input.getAttribute("inputmode") === "decimal") score += 40;
    if (input.isContentEditable) score += 20;
    return score;
  }

  function collectInputNodes(slipRoot, selector) {
    const nodes = [];
    try {
      for (const el of slipRoot.querySelectorAll(selector)) {
        if (!isEditableInput(el) || !visible(el)) continue;
        nodes.push(el);
      }
    } catch (_err) {}
    return nodes;
  }

  function scanBcStakeInputs({ debug = false, frameUrl = "", probe = false } = {}) {
    const frame_url = frameUrl || location.href;
    const slip = findBcSlipRoot();
    const scans = [];
    const candidates = [];
    const scanLines = [];

    if (!slip.root) {
      const report = {
        block: "BC INPUT SCAN",
        frame_url,
        slip_found: false,
        slip_selector: "",
        scans: [],
        input_candidates: [],
        scan_lines: scanLines,
        found: null,
        best: null,
        selector: "",
      };
      if (debug) {
        _lastDebug = report;
        emitStakeDebug("BC INPUT SCAN", report);
      }
      return { slip, candidates, scans, scanLines, best: null, selector: "", input_candidates: [], report };
    }

    const seen = new Set();
    const searchRoots = getBcStakeSearchRoots(slip);
    for (const { root: searchRoot, scope } of searchRoots) {
      for (const sel of BC_INPUT_SELECTORS) {
        const nodes = collectInputNodes(searchRoot, sel);
        for (const el of nodes) {
          if (seen.has(el)) continue;
          seen.add(el);
          const meta = inputMeta(el);
          const score = scoreBcStakeInput(el, searchRoot, scope);
          if (score < 0) continue;
          const probeInfo = probe ? probeInput(el) : null;
          const candidate = {
            input: el,
            score,
            selector: sel,
            meta,
            frame_url,
            probe: probeInfo,
            scope,
          };
          candidates.push(candidate);
          if (probeInfo) {
            scanLines.push(
              `[BC INPUT SCAN] probe selector=${sel} scope=${scope} focus=${probeInfo.focus_ok} value=${probeInfo.value} placeholder=${probeInfo.placeholder} disabled=${probeInfo.disabled} readonly=${probeInfo.readonly} aria-disabled=${probeInfo["aria-disabled"]}`
            );
          }
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] || null;
    for (const sel of BC_INPUT_SELECTORS) {
      const matched = candidates.filter((c) => c.selector === sel);
      const sample = matched[0]?.meta || null;
      scans.push({
        frame_url,
        selector: sel,
        count: matched.length,
        placeholder: sample?.placeholder || "",
        type: sample?.type || "",
        inputmode: sample?.inputmode || "",
        class: sample?.class || "",
        value: sample?.value || "",
        disabled: sample?.disabled ?? "",
        readonly: sample?.readonly ?? "",
        "aria-disabled": sample?.["aria-disabled"] || "",
        outerHTML: sample?.outerHTML || "",
      });
      if (debug && matched.length) {
        scanLines.push(
          `[BC INPUT SCAN] frame_url=${frame_url} selector=${sel} count=${matched.length} placeholder=${sample?.placeholder || ""} type=${sample?.type || ""}`
        );
      }
    }

    const input_candidates = candidates.map((c) => ({
      selector: c.selector,
      score: c.score,
      frame_url,
      ...c.meta,
      probe: c.probe,
    }));

    const found = best
      ? {
          selector: best.selector,
          frame_url,
          current_value: readInputValue(best.input),
          score: best.score,
          ...best.meta,
          probe: best.probe,
        }
      : null;

    const report = {
      block: "BC INPUT SCAN",
      frame_url,
      slip_selector: slip.selector,
      slip_found: true,
      scans,
      input_candidates,
      scan_lines: scanLines,
      found,
      best: best
        ? {
            selector: best.selector,
            score: best.score,
            frame_url,
            current_value: readInputValue(best.input),
            meta: best.meta,
            probe: best.probe,
          }
        : null,
      selector: best?.selector || "",
    };

    if (debug) {
      _lastDebug = report;
      for (const line of scanLines) {
        try {
          console.log(line);
        } catch (_err) {}
      }
      emitStakeDebug("BC INPUT SCAN", report);
      if (found) {
        emitBcStakeStep("LOCATE_BC_STAKE_INPUT", {
          input_locator: "PASS",
          frame_url,
          selector: found.selector,
          placeholder: found.placeholder || "",
          before: found.current_value ?? 0,
        });
        emitStakeDebug("BC STAKE INPUT FOUND", found);
      } else {
        emitStakeDebug("BC STAKE INPUT NOT FOUND", report);
      }
    }

    return {
      slip,
      candidates,
      scans,
      scanLines,
      best,
      selector: best?.selector || "",
      input_candidates,
      report,
      found,
    };
  }

  function scanBcInputReport(opts = {}) {
    return scanBcStakeInputs({ debug: true, probe: true, frameUrl: location.href, ...opts }).report;
  }

  function findBcStakeInput(opts) {
    return scanBcStakeInputs(opts).best?.input || null;
  }

  function buildLocator(input, selector) {
    if (!input) return null;
    return {
      selector: selector || "",
      frame_url: location.href,
      current_value: readInputValue(input),
      disabled: !!input.disabled,
      readonly: !!input.readOnly,
      "aria-disabled": input.getAttribute("aria-disabled") || "",
      "data-editor-id": input.getAttribute("data-editor-id") || "",
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function verifyStakeValue(input, want) {
    const checks = { before: parseStakeValue(readInputValue(input)) };
    for (const ms of VERIFY_DELAYS_MS) {
      await sleep(ms);
      checks[`${ms}ms`] = parseStakeValue(readInputValue(input));
    }
    const final = checks["250ms"] ?? checks["100ms"] ?? checks["50ms"] ?? checks.before;
    const ok = final != null && Math.abs(final - want) <= TOLERANCE;
    const reactReset =
      checks.before != null &&
      checks["50ms"] != null &&
      Math.abs(checks.before - want) <= TOLERANCE &&
      final != null &&
      Math.abs(final - want) > TOLERANCE;
    return { ok, actual: final, checks, react_reset: reactReset };
  }

  function inputBlocked(input) {
    if (!input) return "stake-input-not-found";
    if (input.disabled) return "input-disabled";
    if (input.readOnly) return "input-disabled";
    if (input.getAttribute("aria-disabled") === "true") return "input-disabled";
    return null;
  }

  async function applyBcStakeToInput(input, want, selector) {
    const blocked = inputBlocked(input);
    if (blocked) return { ok: false, reason: blocked, actual: null, locator: buildLocator(input, selector) };

    const before = parseStakeValue(readInputValue(input));
    emitBcStakeStep("LOCATE_BC_STAKE_INPUT", {
      input_locator: "PASS",
      frame_id: "",
      selector,
      before: before ?? "",
    });
    input.scrollIntoView?.({ block: "center", inline: "nearest" });
    clearNativeValue(input);
    await sleep(20);
    setNativeValue(input, want);
    emitBcStakeStep("WRITE_VALUE", { write_value: "PASS", after: want });

    let verify = await verifyStakeValue(input, want);
    emitBcStakeStep("VERIFY_VALUE", {
      verify_0ms: verify.checks.before ?? "",
      verify_50ms: verify.checks["50ms"] ?? "",
      verify_100ms: verify.checks["100ms"] ?? "",
      verify_250ms: verify.checks["250ms"] ?? "",
      react_reset: verify.react_reset ? "true" : "false",
    });
    if (verify.react_reset) {
      return {
        ok: false,
        reason: "react-reset-value",
        actual: verify.actual,
        before,
        verify,
        locator: buildLocator(input, selector),
      };
    }
    if (verify.ok) {
      input.blur?.();
      return {
        ok: true,
        reason: "ok",
        actual: verify.actual,
        before,
        verify,
        locator: buildLocator(input, selector),
      };
    }
    return {
      ok: false,
      reason: "value-not-applied",
      actual: verify.actual,
      before,
      verify,
      locator: buildLocator(input, selector),
    };
  }

  async function setBcStake(amountUsdt, { debug = true, test = false } = {}) {
    const want = Math.max(0.1, Math.round(Number(amountUsdt) * 10) / 10);
    const frameUrl = location.href;
    emitBcStakeStep("CONTENT_SCRIPT_RECEIVE", {
      content_script_received: "PASS",
      calculated: want,
    });
    let lastResult = {
      ok: false,
      reason: "stake-input-not-found",
      requested: want,
      actual: null,
      expected: want,
      success: false,
      frame_url: frameUrl,
      debug: null,
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const scan = scanBcStakeInputs({ debug: debug || attempt === 0, probe: true, frameUrl });
      if (debug && scan.report) {
        lastResult.debug = scan.report;
      }
      const best = scan.best;
      if (!best?.input || !best.input.isConnected) {
        lastResult.reason = !best?.input
          ? scan.slip.root
            ? "stake-input-not-found"
            : "frame-not-found"
          : "stale-input-reference";
        emitBcStakeStep("LOCATE_BC_STAKE_INPUT", {
          input_locator: "FAIL",
          selector: scan.slip.selector || best?.selector || "",
          before: "",
          reason: lastResult.reason,
        });
        continue;
      }

      const applied = await applyBcStakeToInput(best.input, want, best.selector);
      lastResult = {
        ok: applied.ok,
        success: applied.ok,
        reason: applied.reason,
        requested: want,
        expected: want,
        actual: applied.actual,
        before: applied.before,
        verify: applied.verify,
        locator: applied.locator,
        selector: best.selector,
        frame_url: frameUrl,
        frame_has_input: true,
        attempt,
        test,
        debug: {
          ...(scan.report || _lastDebug || {}),
          requested: want,
          selected_selector: best.selector,
          frame_url: frameUrl,
          before_value: applied.before,
          after_value: applied.verify?.checks?.["50ms"] ?? applied.actual,
          verify_50ms: applied.verify?.checks?.["50ms"],
          verify_100ms: applied.verify?.checks?.["100ms"],
          verify_250ms: applied.verify?.checks?.["250ms"],
          disabled: best.meta.disabled,
          readonly: best.meta.readonly,
          aria_disabled: best.meta["aria-disabled"],
          react_reset: applied.verify?.react_reset || false,
        },
      };

      if (applied.ok) {
        emitBcStakeStep("ACK_TO_PYTHON", {
          ack: "PASS",
          requested: want,
          actual: applied.actual ?? "",
        });
        if (debug) {
          emitStakeDebug("BC STAKE INPUT FOUND", {
            ...lastResult.debug,
            frame_url: frameUrl,
            selector: best.selector,
            before_value: applied.before,
          });
        }
        emitStakeSyncResult(lastResult);
        return lastResult;
      }

      if (applied.reason === "react-reset-value" || applied.reason === "value-not-applied") {
        await sleep(80);
        continue;
      }
      break;
    }

    emitBcStakeStep("ACK_TO_PYTHON", {
      ack: "FAIL",
      requested: want,
      actual: lastResult.actual ?? "",
      reason: lastResult.reason,
    });
    emitStakeDebug("BC STAKE INPUT FAILED", {
      ...(lastResult.debug || {}),
      reason: lastResult.reason === "stake-input-not-found" ? "not-found" : lastResult.reason,
      frame_url: frameUrl,
    });
    emitStakeSyncResult(lastResult);
    return lastResult;
  }

  async function testBcStakeInput(amountUsdt = 1.0) {
    const result = await setBcStake(amountUsdt, { debug: true, test: true });
    return {
      ok: !!result.ok,
      success: !!result.ok,
      reason: result.reason || (result.ok ? "ok" : "stake-input-not-found"),
      requested: result.requested,
      actual: result.actual,
      frame_url: result.frame_url,
      selector: result.selector,
      debug: result.debug,
    };
  }

  function readBcStake() {
    const scan = scanBcStakeInputs({ debug: false });
    const input = scan.best?.input;
    if (!input) {
      return { ok: false, reason: "stake-input-not-found", actual: null, frame_url: location.href, deferred: true };
    }
    return {
      ok: true,
      actual: parseStakeValue(readInputValue(input)),
      frame_url: location.href,
      selector: scan.selector,
      locator: buildLocator(input, scan.selector),
    };
  }

  function emitStakeDebug(block, payload) {
    try {
      chrome.runtime.sendMessage({
        type: "bridge_debug",
        block,
        site: "bc",
        frame_url: location.href,
        ...(typeof payload === "object" && payload ? payload : { message: payload }),
      });
    } catch (_err) {}
  }

  function emitStakeSyncResult(result) {
    try {
      chrome.runtime.sendMessage({
        type: "stake_sync_result",
        site: "bc",
        requested: result.requested ?? result.expected,
        actual: result.actual,
        success: !!result.ok,
        reason: result.reason || (result.ok ? "ok" : "failed"),
        frame_url: result.frame_url || location.href,
        selector: result.selector || "",
        debug: result.debug || null,
      });
    } catch (_err) {}
  }

  function registerBcStakeLocator() {
    const scan = scanBcStakeInputs({ debug: true, probe: true, frameUrl: location.href });
    if (!scan.best?.input) {
      emitStakeDebug("BC STAKE INPUT NOT FOUND", scan.report || { frame_url: location.href });
      return null;
    }
    const locator = {
      ...buildLocator(scan.best.input, scan.best.selector),
      score: scan.best.score,
      slip_selector: scan.slip.selector,
    };
    try {
      chrome.runtime.sendMessage({
        type: "stake_input_register",
        site: "bc",
        frame_url: location.href,
        locator,
        current_value: readInputValue(scan.best.input),
      });
    } catch (_err) {}
    if (scan.report?.found) {
      emitStakeDebug("BC STAKE INPUT FOUND", scan.report.found);
    }
    return locator;
  }

  function watchBcStakeInput(onChange) {
    _onStakeDomChange = onChange;
    if (_stakeObserver) _stakeObserver.disconnect();
    const slip = findBcSlipRoot();
    const observeRoot = slip.root || slip.selection?.parentElement || document.body;
    if (!observeRoot) return;
    _stakeObserver = new MutationObserver(() => {
      registerBcStakeLocator();
      if (_onStakeDomChange) _onStakeDomChange();
    });
    _stakeObserver.observe(observeRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["value", "disabled", "readonly", "aria-disabled", "class"],
    });
  }

  function buttonMeta(btn) {
    if (!btn) return null;
    return {
      site: "",
      frame_url: location.href,
      selector: btn.id ? `#${btn.id}` : btn.tagName?.toLowerCase() || "button",
      text: text(btn),
      disabled: !!btn.disabled,
      "aria-disabled": btn.getAttribute("aria-disabled") || "",
      class: btn.className || "",
    };
  }

  function clickElement(btn, executionId) {
    if (!btn) return false;
    const lockKey = executionId || "default";
    if (_clickLocks.get(lockKey)) return false;
    _clickLocks.set(lockKey, true);
    try {
      btn.scrollIntoView?.({ block: "center", inline: "nearest" });
      btn.focus?.();
      try {
        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      } catch (_err) {}
      btn.click();
      return true;
    } finally {
      setTimeout(() => _clickLocks.delete(lockKey), 500);
    }
  }

  function findBcBetButton() {
    const slip = findBcSlipRoot();
    const searchRoots = [];
    const seen = new Set();
    const addRoot = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      searchRoots.push(node);
    };
    if (slip.root) addRoot(slip.root);
    if (slip.selection) {
      let node = slip.selection.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1) {
        addRoot(node);
        if (slip.root && node === slip.root) break;
        node = node.parentElement;
      }
    }
    if (!searchRoots.length) return null;

    const patterns = [
      /^베팅하기$/i,
      /^bet$/i,
      /place\s*bet/i,
      /bet\s*now/i,
      /^베팅$/i,
      /submit\s*bet/i,
    ];
    let fallback = null;
    for (const root of searchRoots) {
      let nodes = [];
      try {
        nodes = [...root.querySelectorAll("button, [role='button'], a[role='button']")];
      } catch (_err) {
        continue;
      }
      for (const btn of nodes) {
        if (!visible(btn)) continue;
        const label = text(btn);
        if (!label) continue;
        for (const re of patterns) {
          if (re.test(label)) return btn;
        }
        if (/bet|베팅|place/i.test(label) && !fallback) fallback = btn;
      }
    }
    return fallback;
  }

  function findX10BetButton() {
    const roots = [];
    const slipSelectors = [
      '[class*="betslip" i]',
      '[class*="bet-slip" i]',
      '[class*="Betslip" i]',
      '[class*="coupon" i]',
    ];
    for (const sel of slipSelectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (visible(el)) roots.push(el);
        }
      } catch (_err) {}
    }
    if (!roots.length && document.body) roots.push(document.body);

    const patterns = [/배당\s*수락/i, /베팅하기/i, /place\s*bet/i, /bet\s*now/i, /^베팅$/i];
    for (const root of roots) {
      let nodes = [];
      try {
        nodes = [...root.querySelectorAll("button, [role='button']")];
      } catch (_err) {
        continue;
      }
      for (const btn of nodes) {
        if (!visible(btn)) continue;
        const label = text(btn);
        if (patterns.some((re) => re.test(label))) return btn;
      }
    }
    return null;
  }

  function findX10StakeInput() {
    const selectors = [
      'input#counter',
      'input[class*="CounterSecondary_input"]',
      'input[class*="counter__input"]',
      'input[placeholder*="베팅"]',
    ];
    for (const sel of selectors) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch (_err) {
        continue;
      }
      for (const el of nodes) {
        if (el instanceof HTMLInputElement && visible(el)) return el;
      }
    }
    return null;
  }

  function setX10Stake(amountKrw) {
    const input = findX10StakeInput();
    if (!input) return { ok: false, reason: "x10-stake-input-missing", deferred: true };
    const want = Math.max(1000, Math.round(amountKrw));
    setNativeValue(input, String(want));
    const got = parseStakeValue(input.value);
    return got && got > 0 ? { ok: true, actual: got } : { ok: false, reason: "x10-stake-not-applied" };
  }

  async function placeBcBet(executionId) {
    const slip = findBcSlipRoot();
    if (!slip.root) {
      return { ok: false, reason: "betslip-not-in-frame", deferred: true, frame_url: location.href };
    }
    const btn = findBcBetButton();
    if (!btn) {
      emitStakeDebug("BC BET BUTTON FAILED", { site: "bc", reason: "button-not-found", frame_url: location.href });
      return { ok: false, reason: "bc-bet-button-not-found", deferred: true, frame_url: location.href };
    }
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
      return { ok: false, reason: "bc-bet-button-disabled", frame_url: location.href, ...buttonMeta(btn) };
    }
    const meta = buttonMeta(btn);
    meta.site = "bc";
    emitStakeDebug("BC BET BUTTON FOUND", {
      ...meta,
      text: text(btn),
      disabled: !!btn.disabled,
    });
    const clicked = clickElement(btn, executionId ? `bc:${executionId}` : "bc");
    return {
      ok: clicked,
      reason: clicked ? "ok" : "click-locked",
      frame_url: location.href,
      button_text: text(btn),
      ...meta,
    };
  }

  async function placeX10Bet(executionId) {
    const btn = findX10BetButton();
    if (!btn) {
      emitStakeDebug("BET BUTTON FAILED", { site: "x10", reason: "button-not-found", frame_url: location.href });
      return { ok: false, reason: "x10-bet-button-not-found", deferred: true, frame_url: location.href };
    }
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
      return { ok: false, reason: "x10-bet-button-disabled", frame_url: location.href, ...buttonMeta(btn) };
    }
    const meta = buttonMeta(btn);
    meta.site = "x10";
    emitStakeDebug("BET BUTTON FOUND", meta);
    const clicked = clickElement(btn, executionId ? `x10:${executionId}` : "x10");
    return {
      ok: clicked,
      reason: clicked ? "ok" : "click-locked",
      frame_url: location.href,
      button_text: text(btn),
      ...meta,
    };
  }

  function scanBetButton(site) {
    const siteKey = site === "bc" ? "bc" : "x10";
    const btn = siteKey === "bc" ? findBcBetButton() : findX10BetButton();
    if (!btn) {
      const fail = {
        ok: false,
        found: false,
        site: siteKey,
        reason: "button-not-found",
        frame_url: location.href,
        button_text: "",
      };
      emitStakeDebug("BET BUTTON FAILED", fail);
      return fail;
    }
    const meta = buttonMeta(btn);
    meta.site = siteKey;
    const result = {
      ok: true,
      found: true,
      site: siteKey,
      reason: "ok",
      frame_url: location.href,
      button_text: text(btn),
      disabled: meta.disabled,
      "aria-disabled": meta["aria-disabled"],
      class: meta.class,
      selector: meta.selector,
    };
    emitStakeDebug(siteKey === "bc" ? "BC BET BUTTON FOUND" : "BET BUTTON FOUND", result);
    return result;
  }

  global.ArbStakeActions = {
    setBcStake,
    readBcStake,
    testBcStakeInput,
    setX10Stake,
    placeBcBet,
    placeX10Bet,
    findBcStakeInput,
    scanBcStakeInputs,
    scanBcInputReport,
    registerBcStakeLocator,
    watchBcStakeInput,
    scanBetButton,
    getLastStakeDebug: () => _lastDebug,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
