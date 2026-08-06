/**
 * BetSlip-only DOM reader + per-frame selector diagnostics.
 */
(function initFrameScanner(global) {
  const SUSPENDED_RE =
    /suspend|suspended|마감|closed|locked|unavailable|정지된|정지됨|베팅\s*마감|betting\s*(is\s*)?closed|일시\s*정지/i;
  const EMPTY_RE =
    /슬립이\s*비어|슬립\s*비어|선택한\s*베팅\s*없|선택된\s*베팅\s*없|베팅을\s*선택|베팅\s*카트가?\s*비|카트가?\s*비어|empty\s*(bet\s*)?slip|no\s*selection|betslip\s*is\s*empty/i;
  const ODDS_RE = /(?<!\d)(?:1\.\d+|[2-9]\d*(?:\.\d+)?)(?!\d)/;
  const CHIP = new Set([10, 20, 50, 100, 300, 0.2]);

  const BC_SELECTOR_CANDIDATES = [
    '[data-editor-id="betslipSelection"]',
    '[data-editor-id*="betslip"]',
    '[id*="betslip" i]',
    '[class*="betslip" i]',
    '[class*="bet-slip" i]',
    '[class*="coupon" i]',
    '[class*="ticket" i]',
    '[class*="selection" i]',
  ];

  const X10_SELECTOR_CANDIDATES = [
    '[id*="betslip" i]',
    '[class*="betslip" i]',
    '[class*="bet-slip" i]',
    '[class*="coupon" i]',
    '[class*="ticket" i]',
    '[class*="selection" i]',
    '[class*="betcart" i]',
    '[class*="bet-cart" i]',
    '[class*="betslip_fe"]',
    '[class*="betInformation"]',
  ];

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

  function selectorHint(el) {
    if (!el) return "";
    const editor = el.getAttribute?.("data-editor-id");
    if (editor) return `[data-editor-id="${editor}"]`;
    if (el.id) return `#${el.id}`;
    const cls = String(el.className || "")
      .split(/\s+/)
      .filter(Boolean)[0];
    if (cls) return `.${cls}`;
    return el.tagName ? el.tagName.toLowerCase() : "";
  }

  function domHash(doc) {
    const root = doc?.body || doc?.documentElement;
    if (!root) return "0";
    const t = (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim();
    return `${t.length}:${t.slice(0, 64)}`;
  }

  function scanSelectors(candidates) {
    const scans = [];
    for (const selector of candidates) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(selector)];
      } catch (_err) {
        scans.push({ selector, match_count: 0, sample_text: "(invalid selector)" });
        continue;
      }
      const visibleNodes = nodes.filter((el) => visible(el));
      const sample = visibleNodes[0] ? text(visibleNodes[0]).slice(0, 160) : "";
      scans.push({
        selector,
        match_count: visibleNodes.length,
        sample_text: sample,
      });
    }
    return scans;
  }

  function isInsideBetHistory(el) {
    let node = el;
    for (let i = 0; i < 18 && node; i++) {
      const blob = `${node.className || ""} ${node.id || ""} ${node.getAttribute?.("data-testid") || ""}`.toLowerCase();
      if (/mybets|bet-history|bethistory|openbets|settledbets|historybets/i.test(blob)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function walk(root, fn, depth) {
    if (!root || depth > 72) return;
    fn(root, depth);
    if (root.nodeType === 1) {
      if (root.shadowRoot) walk(root.shadowRoot, fn, depth + 1);
      for (const ch of root.childNodes) walk(ch, fn, depth + 1);
    } else if (root.nodeType === 11) {
      for (const ch of root.childNodes) walk(ch, fn, depth + 1);
    }
  }

  function collectIn(scope, selector) {
    const out = [];
    const seen = new Set();
    walk(scope, (node) => {
      if (node.nodeType !== 1 || !node.querySelectorAll) return;
      try {
        for (const el of node.querySelectorAll(selector)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch (_err) {}
    }, 0);
    return out;
  }

  function readDomField(block, patterns) {
    for (const pat of patterns) {
      for (const el of collectIn(block, `[data-editor-id*="${pat}"]`)) {
        const t = text(el);
        if (t) return t;
      }
    }
    return "";
  }

  function parseOdds(raw) {
    const t = String(raw || "").trim();
    const n = parseFloat(t);
    if (!n || n <= 1.01 || n >= 100) return null;
    return n;
  }

  function isExcludedOdds(val, exclude) {
    if (!Number.isFinite(val) || val <= 1.01 || val >= 100) return true;
    if (CHIP.has(val)) return true;
    for (const ex of exclude) {
      if (Math.abs(val - ex) < 0.001) return true;
    }
    return false;
  }

  function findBcSelectionElement() {
    for (const sel of [
      '[data-editor-id="betslipSelection"]',
      '[data-editor-id*="betslipSelection"]',
    ]) {
      for (const el of collectIn(document.documentElement, sel)) {
        if (!visible(el) || isInsideBetHistory(el)) continue;
        const editorId = el.getAttribute?.("data-editor-id") || "";
        if (/betslipSelections$/i.test(editorId)) continue;
        return el;
      }
    }
    return null;
  }

  function findBcSlipRoot(fromSelection) {
    if (!fromSelection) return null;
    const ancestors = [
      fromSelection.closest('[data-editor-id="betslip"]'),
      fromSelection.closest('[data-editor-id*="betslip"]'),
      fromSelection.closest('[class*="betslip" i]'),
      fromSelection.closest('[class*="bet-slip" i]'),
      fromSelection.parentElement,
    ].filter(Boolean);
    for (const el of ancestors) {
      if (visible(el)) return el;
    }
    return fromSelection;
  }

  function readBcStake(slip) {
    for (const sel of [
      '[data-editor-id="betslipStakeInput"]',
      '[data-editor-id*="betslipStake"]',
      '[role="spinbutton"]',
      "input",
    ]) {
      for (const el of collectIn(slip, sel)) {
        if (!visible(el)) continue;
        const inp = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el : el.querySelector?.("input, textarea");
        const target = inp || el;
        const raw = String(target.value || "").replace(/,/g, "").trim();
        const n = parseFloat(raw);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  }

  function extractBcOdds(block, slip) {
    const exclude = new Set();
    const stake = readBcStake(slip);
    if (stake) exclude.add(stake);

    for (const sel of [
      '[data-editor-id="betslipSelectionOdds"]',
      '[data-editor-id*="betslipSelectionOdds"]',
      '[data-editor-id*="selectionOdds"]',
      '[data-editor-id*="coefficient"]',
    ]) {
      for (const el of collectIn(block, sel)) {
        if (!visible(el)) continue;
        const m = text(el).match(ODDS_RE);
        if (!m) continue;
        const val = parseFloat(m[0]);
        if (!isExcludedOdds(val, exclude)) return val;
      }
    }

    const leaves = [];
    walk(block, (node) => {
      if (node.nodeType !== 1 || !visible(node)) return;
      if (node.children?.length) return;
      const raw = (node.textContent || "").trim();
      if (!raw || raw.length > 16) return;
      const m = raw.match(ODDS_RE);
      if (!m) return;
      const val = parseFloat(m[0]);
      if (!isExcludedOdds(val, exclude)) leaves.push(val);
    }, 0);
    return leaves.length ? leaves[leaves.length - 1] : null;
  }

  function readBcSlip() {
    const selectionEl = findBcSelectionElement();
    if (!selectionEl) {
      return {
        ok: false,
        empty: true,
        items: [],
        reason: "no-slip-root",
        frame_url: location.href,
        selector_hits: scanSelectors(BC_SELECTOR_CANDIDATES),
      };
    }

    const slip = findBcSlipRoot(selectionEl);
    const blockText = text(selectionEl);
    if (EMPTY_RE.test(text(slip)) && blockText.length < 4) {
      return {
        ok: true,
        empty: true,
        items: [],
        reason: "empty-slip",
        frame_url: location.href,
        container_selector: selectorHint(slip),
      };
    }

    const event = readDomField(selectionEl, ["eventName", "EventName", "event"]);
    const market = readDomField(selectionEl, ["marketName", "MarketName", "market"]);
    const selection = readDomField(selectionEl, ["outcomeName", "OutcomeName", "selection", "Selection"]);
    const stake = readBcStake(slip);
    const suspended = SUSPENDED_RE.test(blockText);
    const odds = suspended ? null : extractBcOdds(selectionEl, slip);

    const item = {
      event,
      market,
      selection,
      odds,
      status: suspended ? "suspended" : odds ? "active" : "odds_missing",
      stake,
      container_selector: selectorHint(selectionEl),
    };

    if (!event && !selection && !odds) {
      return {
        ok: true,
        empty: true,
        items: [],
        reason: "empty-slip",
        frame_url: location.href,
        container_selector: selectorHint(slip),
      };
    }

    return {
      ok: true,
      empty: false,
      items: [item],
      source: "dom",
      frame_url: location.href,
      container_selector: selectorHint(slip),
    };
  }

  function findX10SlipRoots() {
    const roots = [];
    const seen = new Set();
    for (const sel of X10_SELECTOR_CANDIDATES) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch (_err) {
        continue;
      }
      for (const el of nodes) {
        if (seen.has(el) || !visible(el) || isInsideBetHistory(el)) continue;
        seen.add(el);
        roots.push(el);
      }
    }
    roots.sort((a, b) => text(b).length - text(a).length);
    return roots;
  }

  function getX10SlipCards(root) {
    const cards = [];
    const seen = new Set();
    for (const sel of [
      '[class*="betslip_fe_BetSecondary_bet"]',
      '[class*="BetSecondary_bet"]',
      '[class*="betInformation"]',
    ]) {
      for (const el of root.querySelectorAll(sel)) {
        if (seen.has(el) || !visible(el)) continue;
        const cn = String(el.className || "");
        if (/wrapper|counter|badge|PlaceBet|Tab/i.test(cn)) continue;
        const txt = text(el);
        if (txt.length < 8 || txt.length > 900) continue;
        seen.add(el);
        cards.push(el);
      }
    }
    return cards;
  }

  function readX10Stake(root) {
    const input = root.querySelector(
      'input#counter, input[class*="CounterSecondary_input"], input[class*="counter__input"], input[placeholder*="베팅"], input'
    );
    if (!input) return null;
    const raw = String(input.value || "").replace(/,/g, "").trim();
    const v = parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  function readX10Odds(card) {
    if (SUSPENDED_RE.test(text(card))) return null;
    for (const sp of card.querySelectorAll('[class*="odds"], [class*="Odds"], [class*="price"], [class*="Price"]')) {
      const n = parseOdds(sp.textContent);
      if (n) return n;
    }
    const m = text(card).match(/@\s*(\d+(?:\.\d{1,4})?)/);
    if (m) return parseOdds(m[1]);
    for (const sp of card.querySelectorAll("span, div, b, strong")) {
      const t = (sp.textContent || "").trim();
      if (/^\d+\.\d{2,3}$/.test(t)) {
        const n = parseOdds(t);
        if (n) return n;
      }
    }
    return null;
  }

  function readX10Slip() {
    const roots = findX10SlipRoots();
    if (!roots.length) {
      return {
        ok: false,
        empty: true,
        items: [],
        reason: "no-slip-root",
        frame_url: location.href,
        selector_hits: scanSelectors(X10_SELECTOR_CANDIDATES),
      };
    }

    for (const root of roots) {
      const cards = getX10SlipCards(root);
      if (!cards.length) continue;
      const card = cards[cards.length - 1];
      const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
      const selection = titleEls[0] ? titleEls[0].textContent.trim() : "";
      const market = titleEls[1] ? titleEls[1].textContent.trim() : "";
      const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
      const event = eventEl ? eventEl.textContent.trim() : "";
      const suspended = SUSPENDED_RE.test(text(card));
      const odds = suspended ? null : readX10Odds(card);
      if (!event && !selection) continue;

      return {
        ok: true,
        empty: false,
        items: [
          {
            event,
            market,
            selection,
            odds,
            status: suspended ? "suspended" : odds ? "active" : "odds_missing",
            stake: readX10Stake(root),
            container_selector: selectorHint(card),
          },
        ],
        source: "dom",
        frame_url: location.href,
        container_selector: selectorHint(root),
      };
    }

    return {
      ok: true,
      empty: true,
      items: [],
      reason: "empty-slip",
      frame_url: location.href,
      container_selector: selectorHint(roots[0]),
      selector_hits: scanSelectors(X10_SELECTOR_CANDIDATES),
    };
  }

  function diagnoseBcFrame() {
    return {
      site: "bc",
      frame_url: location.href,
      selector_scans: scanSelectors(BC_SELECTOR_CANDIDATES),
      betslip_selection_count: collectIn(
        document.documentElement,
        '[data-editor-id="betslipSelection"], [data-editor-id*="betslipSelection"]'
      ).filter(visible).length,
    };
  }

  function diagnoseX10Frame() {
    return {
      site: "x10",
      frame_url: location.href,
      selector_scans: scanSelectors(X10_SELECTOR_CANDIDATES),
      slip_root_count: findX10SlipRoots().length,
    };
  }

  global.ArbFrameScanner = {
    domHash,
    scanSelectors,
    diagnoseBcFrame,
    diagnoseX10Frame,
    readBcSlip,
    readX10Slip,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
