/**
 * BC / x10 stake input write — betslip-scoped, React-compatible, per-frame.
 */
(function initStakeActions(global) {
  const BC_SLIP_SELECTORS = [
    '[data-editor-id="betslipSelection"]',
    '[data-editor-id="betslip"]',
    '[data-editor-id*="betslip"]',
    '[class*="betslip" i]',
    '[class*="bet-slip" i]',
  ];

  const BC_INPUT_SELECTORS = [
    '[data-editor-id="betslipStakeInput"]',
    '[data-editor-id*="betslipStake"]',
    '[data-editor-id*="Stake"]',
    'input[inputmode="decimal"]',
    'input[inputmode="numeric"]',
    'input[type="text"]',
    'input[type="number"]',
    'input[placeholder]',
    'input[data-editor-id]',
    'input[class*="stake" i]',
    'input[class*="amount" i]',
    'input[class*="bet" i]',
    '[role="spinbutton"]',
  ];

  const VERIFY_DELAYS_MS = [50, 100, 250];
  const MAX_RETRIES = 2;
  const TOLERANCE = 0.15;

  let _lastDebug = null;
  let _stakeObserver = null;
  let _onStakeDomChange = null;

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
    const setter = getValueSetter();
    const str = String(value);
    if (setter) setter.call(input, str);
    else input.value = str;
    dispatchInput(input, str, "insertText");
  }

  function clearNativeValue(input) {
    const setter = getValueSetter();
    input.focus?.();
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
      placeholder: input.placeholder || "",
      type: input.type || "",
      inputmode: input.getAttribute("inputmode") || "",
      class: input.className || "",
      "data-editor-id": input.getAttribute("data-editor-id") || "",
      value: input.value,
      disabled: !!input.disabled,
      readonly: !!input.readOnly,
      "aria-disabled": input.getAttribute("aria-disabled") || "",
      outerHTML: (input.outerHTML || "").slice(0, 240),
    };
  }

  function findBcSlipRoot() {
    for (const sel of BC_SLIP_SELECTORS) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch (_err) {
        continue;
      }
      for (const el of nodes) {
        if (visible(el)) return { root: el, selector: sel };
      }
    }
    return { root: null, selector: "" };
  }

  function scoreBcStakeInput(input, slip) {
    let score = 0;
    if (!slip?.root || !slip.root.contains(input)) return -1;
    if (!visible(input)) return -1;
    if (input.disabled || input.readOnly) score -= 200;
    if (input.getAttribute("aria-disabled") === "true") score -= 200;
    const blob = `${input.id} ${input.placeholder} ${input.className} ${input.getAttribute("data-editor-id") || ""}`.toLowerCase();
    if (/stake|amount|usdt|counter|decimal|bet/i.test(blob)) score += 100;
    if (input.getAttribute("data-editor-id")?.includes("Stake")) score += 150;
    if (input.type === "number" || input.getAttribute("inputmode") === "decimal") score += 40;
    return score;
  }

  function scanBcStakeInputs({ debug = false, frameUrl = "" } = {}) {
    const slip = findBcSlipRoot();
    const scans = [];
    const candidates = [];

    if (!slip.root) {
      if (debug) {
        _lastDebug = {
          block: "BC STAKE INPUT SCAN",
          frame_url: frameUrl || location.href,
          slip_found: false,
          scans: [],
          found: null,
        };
      }
      return { slip, candidates, scans, best: null, selector: "" };
    }

    const seen = new Set();
    for (const sel of BC_INPUT_SELECTORS) {
      let nodes = [];
      try {
        nodes = slip.root.querySelectorAll(sel);
      } catch (_err) {
        continue;
      }
      const count = nodes.length;
      let sample = null;
      for (const el of nodes) {
        if (!(el instanceof HTMLInputElement) || el.type === "hidden") continue;
        if (!visible(el)) continue;
        if (seen.has(el)) continue;
        seen.add(el);
        const meta = inputMeta(el);
        const score = scoreBcStakeInput(el, slip);
        if (score < 0) continue;
        candidates.push({ input: el, score, selector: sel, meta });
        if (!sample) sample = meta;
      }
      if (debug) {
        scans.push({
          selector: sel,
          count,
          placeholder: sample?.placeholder || "",
          type: sample?.type || "",
          inputmode: sample?.inputmode || "",
          class: sample?.class || "",
          "data-editor-id": sample?.["data-editor-id"] || "",
          value: sample?.value || "",
          outerHTML: sample?.outerHTML || "",
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] || null;
    if (debug) {
      _lastDebug = {
        block: "BC STAKE INPUT SCAN",
        frame_url: frameUrl || location.href,
        slip_selector: slip.selector,
        slip_found: true,
        scans,
        found: best
          ? {
              selector: best.selector,
              frame_url: frameUrl || location.href,
              current_value: best.input.value,
              ...best.meta,
            }
          : null,
      };
    }
    return {
      slip,
      candidates,
      scans,
      best,
      selector: best?.selector || "",
    };
  }

  function findBcStakeInput(opts) {
    return scanBcStakeInputs(opts).best?.input || null;
  }

  function buildLocator(input, selector) {
    if (!input) return null;
    return {
      selector: selector || "",
      frame_url: location.href,
      current_value: input.value,
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
    const checks = { before: parseStakeValue(input.value) };
    for (const ms of VERIFY_DELAYS_MS) {
      await sleep(ms);
      checks[`${ms}ms`] = parseStakeValue(input.value);
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

    const before = parseStakeValue(input.value);
    input.focus?.({ preventScroll: true });
    clearNativeValue(input);
    await sleep(20);
    setNativeValue(input, want);
    input.blur?.();

    let verify = await verifyStakeValue(input, want);
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
      const scan = scanBcStakeInputs({ debug: debug || attempt === 0, frameUrl });
      if (debug && scan.scans.length) {
        lastResult.debug = _lastDebug;
      }
      const best = scan.best;
      if (!best?.input) {
        lastResult.reason = scan.slip.root ? "stake-input-not-found" : "frame-not-found";
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
        debug: {
          ...(_lastDebug || {}),
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
        if (debug) emitStakeDebug("BC STAKE INPUT FOUND", lastResult.debug);
        emitStakeSyncResult(lastResult);
        return lastResult;
      }

      if (applied.reason === "react-reset-value" || applied.reason === "value-not-applied") {
        await sleep(80);
        continue;
      }
      break;
    }

    emitStakeDebug("BC STAKE SYNC FAILED", lastResult.debug || lastResult);
    emitStakeSyncResult(lastResult);
    return lastResult;
  }

  function readBcStake() {
    const scan = scanBcStakeInputs({ debug: false });
    const input = scan.best?.input;
    if (!input) {
      return { ok: false, reason: "stake-input-not-found", actual: null, frame_url: location.href };
    }
    return {
      ok: true,
      actual: parseStakeValue(input.value),
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
        ...payload,
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
    const scan = scanBcStakeInputs({ debug: true, frameUrl: location.href });
    if (!scan.best?.input) return null;
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
        current_value: scan.best.input.value,
      });
    } catch (_err) {}
    if (_lastDebug?.found) {
      emitStakeDebug("BC STAKE INPUT FOUND", _lastDebug.found);
    }
    return locator;
  }

  function watchBcStakeInput(onChange) {
    _onStakeDomChange = onChange;
    if (_stakeObserver) _stakeObserver.disconnect();
    const slip = findBcSlipRoot().root;
    if (!slip) return;
    _stakeObserver = new MutationObserver(() => {
      registerBcStakeLocator();
      if (_onStakeDomChange) _onStakeDomChange();
    });
    _stakeObserver.observe(slip, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["value", "disabled", "readonly", "aria-disabled", "class"],
    });
  }

  function findBcBetButton() {
    const slip = findBcSlipRoot().root;
    if (!slip) return null;
    let nodes = [];
    try {
      nodes = [...slip.querySelectorAll("button, [role='button'], a[role='button']")];
    } catch (_err) {
      return null;
    }
    const patterns = [
      /^베팅하기$/i,
      /^bet$/i,
      /place\s*bet/i,
      /bet\s*now/i,
      /^베팅$/i,
      /submit\s*bet/i,
    ];
    let fallback = null;
    for (const btn of nodes) {
      if (!visible(btn)) continue;
      const label = text(btn);
      if (!label) continue;
      for (const re of patterns) {
        if (re.test(label)) return btn;
      }
      if (/bet|베팅|place/i.test(label) && !fallback) fallback = btn;
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

  async function placeBcBet() {
    const slip = findBcSlipRoot().root;
    if (!slip) {
      return { ok: false, reason: "betslip-not-in-frame", deferred: true, frame_url: location.href };
    }
    const btn = findBcBetButton();
    if (!btn) {
      return { ok: false, reason: "bc-bet-button-not-found", deferred: true, frame_url: location.href };
    }
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
      return { ok: false, reason: "bc-bet-button-disabled", frame_url: location.href };
    }
    btn.focus?.();
    btn.click();
    return { ok: true, reason: "ok", frame_url: location.href, button_text: text(btn) };
  }

  async function placeX10Bet() {
    const btn = findX10BetButton();
    if (!btn) {
      return { ok: false, reason: "x10-bet-button-not-found", deferred: true, frame_url: location.href };
    }
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
      return { ok: false, reason: "x10-bet-button-disabled", frame_url: location.href };
    }
    btn.focus?.();
    btn.click();
    return { ok: true, reason: "ok", frame_url: location.href, button_text: text(btn) };
  }

  global.ArbStakeActions = {
    setBcStake,
    readBcStake,
    setX10Stake,
    placeBcBet,
    placeX10Bet,
    findBcStakeInput,
    scanBcStakeInputs,
    registerBcStakeLocator,
    watchBcStakeInput,
    getLastStakeDebug: () => _lastDebug,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
