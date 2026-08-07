/**
 * BC / x10 stake input write + bet button actions (betslip-scoped).
 */
(function initStakeActions(global) {
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

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }

  function findBcSlipRoot() {
    const selectors = [
      '[data-editor-id="betslip"]',
      '[data-editor-id*="betslip"]',
      '[class*="betslip" i]',
      '[class*="bet-slip" i]',
    ];
    for (const sel of selectors) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch (_err) {
        continue;
      }
      for (const el of nodes) {
        if (visible(el)) return el;
      }
    }
    return null;
  }

  function scoreBcStakeInput(input, slip) {
    let score = 0;
    if (!slip || slip.contains(input)) score += 300;
    const blob = `${input.id} ${input.placeholder} ${input.className} ${input.getAttribute?.("data-editor-id") || ""}`.toLowerCase();
    if (/stake|betslip|usdt|counter|decimal/i.test(blob)) score += 80;
    if (input.getAttribute?.("data-editor-id")?.includes("Stake")) score += 120;
    return score;
  }

  function findBcStakeInput() {
    const slip = findBcSlipRoot();
    if (!slip) return null;
    const candidates = [];
    for (const sel of [
      '[data-editor-id="betslipStakeInput"]',
      '[data-editor-id*="betslipStake"]',
      '[role="spinbutton"]',
      'input[type="text"]',
      'input[type="number"]',
      "input",
    ]) {
      let nodes = [];
      try {
        nodes = slip.querySelectorAll(sel);
      } catch (_err) {
        continue;
      }
      for (const el of nodes) {
        if (!(el instanceof HTMLInputElement) || el.type === "hidden" || !visible(el)) continue;
        candidates.push(el);
      }
    }
    if (!candidates.length) return null;
    return candidates.sort((a, b) => scoreBcStakeInput(b, slip) - scoreBcStakeInput(a, slip))[0];
  }

  function findBcBetButton(slip) {
    const root = slip || findBcSlipRoot() || document.body;
    let nodes = [];
    try {
      nodes = [...root.querySelectorAll("button, [role='button']")];
    } catch (_err) {
      return null;
    }
    for (const btn of nodes) {
      if (!visible(btn)) continue;
      const label = text(btn).toLowerCase();
      if (/(^베팅하기$|place bet|bet now)/i.test(label)) return btn;
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

  function findX10BetButton() {
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll("button, [role='button']")];
    } catch (_err) {
      return null;
    }
    for (const btn of nodes) {
      if (!visible(btn)) continue;
      const label = text(btn);
      if (/배당\s*수락|베팅하기|Place Bet|Bet Now/i.test(label)) return btn;
    }
    return null;
  }

  function parseStakeValue(raw) {
    const n = parseFloat(String(raw || "").replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }

  function applyBcStake(input, want) {
    const str = String(want);
    input.focus?.();
    try {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, str);
    } catch (_err) {}
    setNativeValue(input, str);
    input.blur?.();
    const got = parseStakeValue(input.value);
    return got;
  }

  async function setBcStake(amountUsdt) {
    const input = findBcStakeInput();
    if (!input) return { ok: false, reason: "stake-input-not-found", expected: amountUsdt, actual: null };
    const want = Math.max(0.01, Math.round(amountUsdt * 10) / 10);
    let got = applyBcStake(input, want);
    if (got == null || Math.abs(got - want) > 0.15) {
      await new Promise((r) => setTimeout(r, 80));
      got = applyBcStake(input, want);
    }
    if (got == null || Math.abs(got - want) > 0.15) {
      return { ok: false, reason: "stake-sync-failed", expected: want, actual: got };
    }
    return { ok: true, expected: want, actual: got };
  }

  function readBcStake() {
    const input = findBcStakeInput();
    if (!input) return { ok: false, reason: "stake-input-not-found", actual: null };
    return { ok: true, actual: parseStakeValue(input.value) };
  }

  function setX10Stake(amountKrw) {
    const input = findX10StakeInput();
    if (!input) return { ok: false, reason: "x10-stake-input-missing" };
    const want = Math.max(1000, Math.round(amountKrw));
    setNativeValue(input, String(want));
    const got = parseStakeValue(input.value);
    return got && got > 0 ? { ok: true, actual: got } : { ok: false, reason: "x10-stake-not-applied" };
  }

  async function placeBcBet() {
    const btn = findBcBetButton();
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") {
      return { ok: false, reason: "bc-bet-button-disabled" };
    }
    btn.click();
    return { ok: true };
  }

  async function placeX10Bet() {
    const btn = findX10BetButton();
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") {
      return { ok: false, reason: "x10-bet-button-disabled" };
    }
    btn.click();
    return { ok: true };
  }

  global.ArbStakeActions = {
    setBcStake,
    readBcStake,
    setX10Stake,
    placeBcBet,
    placeX10Bet,
    findBcStakeInput,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
