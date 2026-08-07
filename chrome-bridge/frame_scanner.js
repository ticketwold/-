/**
 * BetSlip-only DOM reader + per-frame selector diagnostics.
 */
(function initFrameScanner(global) {
  const SUSPENDED_RE =
    /suspend|suspended|마감|closed|locked|unavailable|정지된|정지됨|베팅\s*마감|betting\s*(is\s*)?closed|일시\s*정지/i;
  const CLOSED_RE =
    /betting\s*closed|market\s*closed|배팅\s*닫|닫힘|locked|inactive|disabled|unavailable|odds\s*unavailable|정지됨|마감/i;
  const PAUSED_RE = /일시\s*정지|paused/i;
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

  const X10_DEBUG_SELECTORS = [
    ".bet-slip-item",
    ".bet-slip",
    ".bet-slip-container",
    '[data-editor-id]',
    '[class*="slip" i]',
    '[class*="coupon" i]',
    '[class*="betslip" i]',
    '[class*="bet-slip" i]',
    '[class*="betcart" i]',
    '[class*="bet-cart" i]',
    '[class*="ticket" i]',
    '[class*="selection" i]',
    '[class*="betInformation"]',
    '[class*="betslip_fe"]',
  ];

  const CLOSED_KEYWORD_RE =
    /betting\s*closed|market\s*closed|odds\s*unavailable|배팅\s*닫|베팅\s*닫|닫힘|배팅불가|베팅불가|\bclosed\b|\blocked\b|\binactive\b|\bunavailable\b|마감/i;
  const SUSPENDED_KEYWORD_RE = /\bsuspended\b|일시\s*정지|일시정지|\bpaused\b/i;
  const DISABLED_KEYWORD_RE = /\bdisabled\b|배팅\s*불가|베팅\s*불가|정지(?!된)/i;
  const STATUS_CLASS_RE = /\b(disabled|suspended|closed|locked|inactive|unavailable)\b/i;
  const X10_CLOSED_PENDING_MS = 200;

  const x10SlipState = {
    lastActiveOdds: null,
    lastStatus: "empty",
    oddsMissingSince: 0,
  };

  function elementDisabled(el) {
    if (!el) return false;
    if (el.disabled) return true;
    if (el.getAttribute?.("aria-disabled") === "true") return true;
    if (el.hasAttribute?.("data-disabled")) return true;
    const dataStatus = String(el.getAttribute?.("data-status") || "").toLowerCase();
    if (/(closed|disabled|suspended|locked|inactive|unavailable)/.test(dataStatus)) return true;
    if (STATUS_CLASS_RE.test(String(el.className || ""))) return true;
    try {
      const st = getComputedStyle(el);
      if (st.pointerEvents === "none" || st.cursor === "not-allowed") return true;
      if (Number(st.opacity) > 0 && Number(st.opacity) < 0.35) return true;
    } catch (_err) {}
    return false;
  }

  function inspectX10BetButton(root) {
    if (!root) return { disabled: false, ariaDisabled: false };
    let nodes = [];
    try {
      nodes = [...root.querySelectorAll("button, [role='button'], input[type='submit']")];
    } catch (_err) {
      return { disabled: false, ariaDisabled: false };
    }
    for (const btn of nodes) {
      if (!visible(btn)) continue;
      const label = text(btn).toLowerCase();
      if (!/(bet|place|베팅|배팅|제출|확인)/i.test(label)) continue;
      return {
        disabled: btn.disabled || elementDisabled(btn),
        ariaDisabled: btn.getAttribute("aria-disabled") === "true",
      };
    }
    return { disabled: false, ariaDisabled: false };
  }

  function inspectX10OddsElements(root) {
    const selectors = [
      '[class*="odds" i]',
      '[class*="coefficient" i]',
      '[class*="coef" i]',
      '[data-testid*="odds" i]',
    ];
    let present = false;
    let disabled = false;
    for (const sel of selectors) {
      let nodes = [];
      try {
        nodes = [...root.querySelectorAll(sel)];
      } catch (_err) {
        continue;
      }
      for (const el of nodes) {
        if (!visible(el)) continue;
        present = true;
        if (elementDisabled(el)) disabled = true;
      }
    }
    return { present, disabled };
  }

  function inspectX10Container(root) {
    let node = root;
    let ariaDisabled = false;
    let containerDisabled = false;
    for (let i = 0; i < 12 && node; i += 1) {
      if (elementDisabled(node)) {
        containerDisabled = true;
        if (node.getAttribute?.("aria-disabled") === "true") ariaDisabled = true;
        break;
      }
      if (node.getAttribute?.("aria-disabled") === "true") {
        ariaDisabled = true;
        containerDisabled = true;
        break;
      }
      node = node.parentElement;
    }
    return { containerDisabled, ariaDisabled };
  }

  function matchX10Keywords(blockText) {
    for (const [re, status, reason] of [
      [CLOSED_KEYWORD_RE, "closed", "closed-keyword"],
      [SUSPENDED_KEYWORD_RE, "suspended", "suspended-keyword"],
      [DISABLED_KEYWORD_RE, "disabled", "disabled-keyword"],
    ]) {
      const m = re.exec(blockText || "");
      if (m) return { status, reason, keyword: m[0] };
    }
    return { status: "", reason: "", keyword: "" };
  }

  function resolveX10SlipStatus(root, blockText, extractedOdds) {
    const betBtn = inspectX10BetButton(root);
    const oddsEl = inspectX10OddsElements(root);
    const container = inspectX10Container(root);
    const kw = matchX10Keywords(blockText);
    const slipRootClass = String(root?.className || "");

    const diagnostics = {
      raw_status_text: (blockText || "").slice(0, 240),
      odds_element_present: extractedOdds != null || oddsEl.present,
      odds_element_disabled: oddsEl.disabled,
      slip_root_class: slipRootClass,
      bet_button_disabled: betBtn.disabled,
      aria_disabled: betBtn.ariaDisabled || container.ariaDisabled,
      matched_keyword: kw.keyword || "",
      parsed_status: "active",
      reason: "active",
    };

    function finalize(status, reason, prevOdds) {
      diagnostics.parsed_status = status;
      diagnostics.reason = reason;
      if (status === "active") {
        x10SlipState.lastStatus = "active";
        x10SlipState.oddsMissingSince = 0;
        if (extractedOdds != null) x10SlipState.lastActiveOdds = extractedOdds;
        return { status, reason, previous_odds: null, diagnostics };
      }
      const keepPrev = prevOdds ?? (extractedOdds != null ? extractedOdds : x10SlipState.lastActiveOdds);
      x10SlipState.lastStatus = status;
      if (status !== "closed_pending") x10SlipState.oddsMissingSince = 0;
      return { status, reason, previous_odds: keepPrev, diagnostics };
    }

    if (betBtn.disabled) return finalize("closed", "bet-button-disabled", extractedOdds);
    if (container.ariaDisabled) return finalize("disabled", "aria-disabled", extractedOdds);
    if (container.containerDisabled) return finalize("closed", "disabled-container", extractedOdds);
    if (oddsEl.disabled) return finalize("closed", "odds-element-disabled", extractedOdds);
    if (kw.status === "closed") return finalize("closed", kw.reason, extractedOdds);
    if (kw.status === "suspended") return finalize("suspended", kw.reason, extractedOdds);
    if (kw.status === "disabled") return finalize("disabled", kw.reason, extractedOdds);
    if (STATUS_CLASS_RE.test(slipRootClass)) {
      const token = (slipRootClass.match(STATUS_CLASS_RE) || [])[1] || "";
      if (/suspended/i.test(token)) return finalize("suspended", "suspended-class", extractedOdds);
      return finalize("closed", "closed-class", extractedOdds);
    }

    if extracted_odds == null) {
      const wasActive =
        x10SlipState.lastActiveOdds != null &&
        (x10SlipState.lastStatus === "active" || x10SlipState.lastStatus === "closed_pending");
      if (wasActive) {
        const now = Date.now();
        if (!x10SlipState.oddsMissingSince) x10SlipState.oddsMissingSince = now;
        if (now - x10SlipState.oddsMissingSince < X10_CLOSED_PENDING_MS) {
          return finalize("closed_pending", "odds-missing", x10SlipState.lastActiveOdds);
        }
        return finalize("closed", "betting-closed", x10SlipState.lastActiveOdds);
      }
      return finalize("odds_missing", "odds-missing", null);
    }

    x10SlipState.oddsMissingSince = 0;
    x10SlipState.lastActiveOdds = extractedOdds;
    return finalize("active", "active", null);
  }

  function isBetButtonDisabled(root) {
    if (!root) return false;
    let nodes = [];
    try {
      nodes = [...root.querySelectorAll("button, [role='button'], input[type='submit']")];
    } catch (_err) {
      return false;
    }
    for (const btn of nodes) {
      if (!visible(btn)) continue;
      const label = text(btn).toLowerCase();
      if (!/(bet|place|베팅|배팅|제출|확인)/i.test(label)) continue;
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return true;
      try {
        const st = getComputedStyle(btn);
        if (st.pointerEvents === "none" || st.cursor === "not-allowed") return true;
      } catch (_err) {}
    }
    return false;
  }

  function classifySlipStatus(blockText, odds, root) {
    if (EMPTY_RE.test(blockText)) return "empty";
    if (isBetButtonDisabled(root)) return "closed";
    if (CLOSED_RE.test(blockText)) return "closed";
    if (PAUSED_RE.test(blockText) || SUSPENDED_RE.test(blockText)) return "suspended";
    if (odds == null) return "odds_missing";
    return "active";
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

  function enrichItem(item, event) {
    if (global.ArbBetTypeParser?.enrichSlipItem) {
      return global.ArbBetTypeParser.enrichSlipItem(item, event);
    }
    return item;
  }

  function parseX10SlipText(rootText) {
    const lines = String(rootText || "")
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 1 && l.length < 120);
    const skip = /^(베팅|bet|slip|카트|총|total|stake|금액|배당|odds|@|\d+\.\d+$)/i;
    const useful = lines.filter((l) => !skip.test(l) && !/^\d{1,3}(,\d{3})*$/.test(l));
    let event = "";
    let market = "";
    let selection = "";
    const vs = useful.find((l) => /\bvs\.?\b/i.test(l));
    if (vs) event = vs;
    const totalMarketRe =
      /토탈\s*골|토탈골|총\s*골|총\s*득점|합계\s*득점|총점|득점\s*합계|total\s*goals?|total\s*goal|goals?\s*total|total\s*points?|game\s*total|match\s*total|\btotals?\b|\bo\s*\/\s*u\b|over\s*\/\s*under|언더\s*\/\s*오버|오버\s*\/\s*언더/i;
    const ou = useful.find(
      (l) =>
        /\b(over|under|오버|언더|이상|이하)\b/i.test(l) ||
        /\b[ou]\s*[+-]?\d/i.test(l) ||
        /\b[ou]\s*\(\s*\d/i.test(l),
    );
    const hc = useful.find((l) => /[+-]\d+(?:\.\d+)?/.test(l));
    const win = useful.find((l) => /\b(승|win|winner|w[12])\b/i.test(l) && !/\b(over|under|오버|언더)\b/i.test(l));
    if (ou) {
      selection = ou;
      market =
        useful.find((l) => totalMarketRe.test(l) && l !== ou) ||
        useful.find((l) => /\b(total|합계|득점|언더\/오버|over\/under)\b/i.test(l) && l !== ou) ||
        "언더/오버";
    } else if (hc) {
      selection = hc;
      market = useful.find((l) => /handicap|핸디|spread/i.test(l)) || "핸디캡";
    } else if (win) {
      selection = win;
      market = useful.find((l) => /승패|moneyline|winner|세트|맵|set|map/i.test(l) && l !== win) || "승패";
    } else if (useful.length >= 2) {
      selection = useful[useful.length - 1];
      market = useful[useful.length - 2];
    } else if (useful.length === 1) {
      selection = useful[0];
    }
    return { event, market, selection };
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
    const odds = extractBcOdds(selectionEl, slip);
    const status = classifySlipStatus(blockText, odds, slip);

    const item = enrichItem(
      {
        event,
        market,
        selection,
        odds: status === "active" ? odds : null,
        status,
        stake,
        container_selector: selectorHint(selectionEl),
        dom_hash: domHash(slip),
      },
      event,
    );

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

  function getX10SlipInnerText(roots) {
    const root = roots?.[0];
    if (!root) {
      try {
        return (document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1000);
      } catch (_err) {
        return "";
      }
    }
    return text(root).slice(0, 1000);
  }

  function scanX10DebugSelectors() {
    return scanSelectors(X10_DEBUG_SELECTORS);
  }

  function buildX10DebugSnapshot(frameDepth) {
    const roots = findX10SlipRoots();
    const selectorHits = scanX10DebugSelectors();
    const bestRoot = roots[0] || null;
    const stake = bestRoot ? readX10Stake(bestRoot) : null;
    const oddsProbe = bestRoot ? extractX10OddsFromRoot(bestRoot, stake) : { odds: null, candidates: [] };
    const statusProbe = bestRoot
      ? resolveX10SlipStatus(bestRoot, text(bestRoot), oddsProbe.odds)
      : { status: "empty", reason: "no-slip-root", diagnostics: {} };
    return {
      site: "x10",
      frame_url: location.href,
      document_location: location.href,
      frame_depth: frameDepth,
      document_ready: document.readyState || "unknown",
      body_text_length: (() => {
        try {
          return (document.body?.innerText || document.body?.textContent || "").length;
        } catch (_err) {
          return 0;
        }
      })(),
      slip_root_found: roots.length ? "YES" : "NO",
      slip_root_count: roots.length,
      slip_inner_text: getX10SlipInnerText(roots),
      selector_hits: selectorHits,
      selector_scans: selectorHits,
      odds_candidates: oddsProbe.candidates,
      extracted_odds: oddsProbe.odds,
      status_diagnostics: statusProbe.diagnostics || {},
      parsed_status: statusProbe.status || "empty",
      status_reason: statusProbe.reason || "",
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

  function readX10Stake(root) {
    const input = root.querySelector(
      'input#counter, input[class*="CounterSecondary_input"], input[class*="counter__input"], input[placeholder*="베팅"], input'
    );
    if (!input) return null;
    const raw = String(input.value || "").replace(/,/g, "").trim();
    const v = parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  const X10_CHIP_AMOUNTS = new Set([10, 20, 50, 100, 300, 1000, 10000, 100000, 500000, 0.2]);

  function x10ExcludeReason(val, leafText, context, stake) {
    if (!Number.isFinite(val)) return "not-a-number";
    if (val <= 1.01 || val >= 100) return "out-of-range";
    if (stake != null && Math.abs(val - stake) < 0.001) return "stake-input";
    if (X10_CHIP_AMOUNTS.has(val)) return "chip-button";
    if (Number.isInteger(val) && val >= 1000) return "large-integer";
    const blob = `${leafText} ${context}`;
    if (/당첨\s*예상금액|예상\s*금액|expected\s*payout/i.test(blob)) return "payout-context";
    if (/잔액|balance/i.test(blob)) return "balance-context";
    if (/\+\s*[\d,]+/.test(leafText)) return "chip-button";
    if (/^\d{1,2}$/.test(leafText)) return "score-or-inning";
    if (!/\./.test(leafText) && val < 10) return "small-integer";
    return "";
  }

  function collectX10LeafTexts(root) {
    const leaves = [];
    walk(root, (node) => {
      if (node.nodeType !== 1 || !visible(node)) return;
      const elementChildren = [...node.children].filter((ch) => ch.nodeType === 1);
      if (elementChildren.length > 0) return;
      const raw = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 32) return;
      leaves.push({ node, text: raw });
    }, 0);
    return leaves;
  }

  function extractX10OddsFromRoot(root, stake) {
    const candidates = [];
    const context = text(root);

    for (const leaf of collectX10LeafTexts(root)) {
      const normalized = leaf.text.replace(/,/g, "");
      const m = normalized.match(/^@?\s*(\d+(?:\.\d{1,4})?)$/);
      if (!m) continue;
      const val = parseFloat(m[1]);
      const parentText = text(leaf.node.parentElement || root);
      const reason = x10ExcludeReason(val, leaf.text, `${parentText} ${context}`, stake);
      candidates.push({
        value: val,
        text: leaf.text,
        excluded: Boolean(reason),
        exclude_reason: reason || "",
        selected: false,
      });
    }

    let odds = null;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (!candidates[i].excluded) {
        odds = candidates[i].value;
        candidates[i].selected = true;
        break;
      }
    }

    return { odds, candidates };
  }

  function readX10Slip() {
    const roots = findX10SlipRoots();
    const selectorHits = scanX10DebugSelectors();
    const slipInnerText = getX10SlipInnerText(roots);
    if (!roots.length) {
      return {
        ok: false,
        empty: true,
        items: [],
        reason: "no-slip-root",
        frame_url: location.href,
        slip_root_found: "NO",
        slip_inner_text: slipInnerText,
        selector_hits: selectorHits,
      };
    }

    for (const root of roots) {
      const rootText = text(root);
      const stake = readX10Stake(root);
      const { odds, candidates } = extractX10OddsFromRoot(root, stake);
      const statusResult = resolveX10SlipStatus(root, rootText, odds);
      const slipStatus = statusResult.status;
      const usableOdds = slipStatus === "active" ? odds : null;

      if (slipStatus !== "active") {
        const parsed = parseX10SlipText(rootText);
        return {
          ok: true,
          empty: false,
          items: [
            enrichItem(
              {
                event: parsed.event,
                market: parsed.market,
                selection: parsed.selection,
                odds: usableOdds,
                previous_odds: statusResult.previous_odds ?? odds,
                status: slipStatus,
                status_reason: statusResult.reason,
                stake,
                container_selector: selectorHint(root),
                status_diagnostics: statusResult.diagnostics,
              },
              parsed.event,
            ),
          ],
          source: "dom",
          frame_url: location.href,
          container_selector: selectorHint(root),
          slip_root_found: "YES",
          slip_inner_text: slipInnerText,
          selector_hits: selectorHits,
          odds_candidates: candidates,
          extracted_odds: odds,
          parsed_status: slipStatus,
          status_reason: statusResult.reason,
          status_diagnostics: statusResult.diagnostics,
        };
      }

      if (odds != null) {
        const parsed = parseX10SlipText(rootText);
        const item = enrichItem(
          {
            event: parsed.event,
            market: parsed.market,
            selection: parsed.selection,
            odds,
            status: "active",
            status_reason: "active",
            stake,
            container_selector: selectorHint(root),
            dom_hash: domHash(root),
            status_diagnostics: statusResult.diagnostics,
          },
          parsed.event,
        );
        return {
          ok: true,
          empty: false,
          items: [item],
          source: "dom",
          frame_url: location.href,
          container_selector: selectorHint(root),
          slip_root_found: "YES",
          slip_inner_text: slipInnerText,
          selector_hits: selectorHits,
          odds_candidates: candidates,
          extracted_odds: odds,
          parsed_status: "active",
          status_reason: "active",
          status_diagnostics: statusResult.diagnostics,
        };
      }
    }

    const lastRoot = roots[0];
    const lastStake = lastRoot ? readX10Stake(lastRoot) : null;
    const lastProbe = lastRoot ? extractX10OddsFromRoot(lastRoot, lastStake) : { odds: null, candidates: [] };
    const lastStatus = lastRoot
      ? resolveX10SlipStatus(lastRoot, text(lastRoot), lastProbe.odds)
      : { status: "odds_missing", reason: "odds-missing", diagnostics: {} };

    if (lastStatus.status && lastStatus.status !== "active") {
      return {
        ok: true,
        empty: false,
        items: [
          {
            event: "",
            market: "",
            selection: "",
            odds: null,
            previous_odds: lastStatus.previous_odds ?? lastProbe.odds,
            status: lastStatus.status,
            status_reason: lastStatus.reason,
            stake: lastStake,
            container_selector: lastRoot ? selectorHint(lastRoot) : "",
            status_diagnostics: lastStatus.diagnostics,
          },
        ],
        source: "dom",
        frame_url: location.href,
        container_selector: lastRoot ? selectorHint(lastRoot) : "",
        slip_root_found: "YES",
        slip_inner_text: slipInnerText,
        selector_hits: selectorHits,
        odds_candidates: lastProbe.candidates,
        extracted_odds: lastProbe.odds,
        parsed_status: lastStatus.status,
        status_reason: lastStatus.reason,
        status_diagnostics: lastStatus.diagnostics,
      };
    }

    return {
      ok: true,
      empty: true,
      items: [],
      reason: "empty-slip",
      frame_url: location.href,
      container_selector: lastRoot ? selectorHint(lastRoot) : "",
      slip_root_found: "YES",
      slip_inner_text: slipInnerText,
      selector_hits: selectorHits,
      odds_candidates: lastProbe.candidates,
      extracted_odds: null,
      parsed_status: lastStatus.status || "odds_missing",
      status_reason: lastStatus.reason || "odds-missing",
      status_diagnostics: lastStatus.diagnostics || {},
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

  function diagnoseX10Frame(frameDepth) {
    const depth = Number.isFinite(frameDepth) ? frameDepth : 0;
    return buildX10DebugSnapshot(depth);
  }

  global.ArbFrameScanner = {
    domHash,
    scanSelectors,
    diagnoseBcFrame,
    diagnoseX10Frame,
    buildX10DebugSnapshot,
    readBcSlip,
    readX10Slip,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
