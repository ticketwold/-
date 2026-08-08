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

  const X10_DIAG_SELECTORS = [
    '[id*="betslip" i]',
    '[class*="betslip" i]',
    '[class*="bet-slip" i]',
    '[class*="coupon" i]',
    '[class*="ticket" i]',
    '[class*="selection" i]',
  ];

  const X10_ODDS_SELECTORS = [
    '[class*="odds" i]',
    '[class*="coef" i]',
    '[class*="coefficient" i]',
    '[class*="price" i]',
    '[data-testid*="odds" i]',
    '[data-odds]',
    '[data-coef]',
    '[data-coefficient]',
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

  const x10RootTracker = { key: "", revision: 0 };

  function resetX10SlipState() {
    x10SlipState.lastActiveOdds = null;
    x10SlipState.lastStatus = "empty";
    x10SlipState.oddsMissingSince = 0;
    x10RootTracker.key = "";
  }

  function trackX10Root(root) {
    if (!root) {
      resetX10SlipState();
      return x10RootTracker.revision;
    }
    const key = `${slipRootId(root)}:${domHash(root)}`;
    if (x10RootTracker.key && x10RootTracker.key !== key) {
      x10SlipState.lastActiveOdds = null;
      x10SlipState.lastStatus = "empty";
      x10SlipState.oddsMissingSince = 0;
      x10RootTracker.revision += 1;
    }
    x10RootTracker.key = key;
    return x10RootTracker.revision;
  }

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
    if (!root) return { disabled: false, ariaDisabled: false, found: false };
    let nodes = [];
    try {
      nodes = [...root.querySelectorAll("button, [role='button'], input[type='submit']")];
    } catch (_err) {
      return { disabled: false, ariaDisabled: false, found: false };
    }
    for (const btn of nodes) {
      if (!visible(btn)) continue;
      const label = text(btn).toLowerCase();
      if (!/(bet|place|베팅|배팅|제출|확인)/i.test(label)) continue;
      return {
        found: true,
        disabled: btn.disabled || elementDisabled(btn),
        ariaDisabled: btn.getAttribute("aria-disabled") === "true",
      };
    }
    return { disabled: false, ariaDisabled: false, found: false };
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

    if (extractedOdds == null) {
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
      if (message?.type === "x10_probe") {
        const scanner = global.ArbFrameScanner;
        const probe = global.ArbX10Probe;
        const snap = scanner?.buildX10DebugSnapshot?.(frameDepth) || {};
        const frame = probe?.probeFrame?.() || {};
        sendResponse({
          ok: true,
          frame_url: location.href,
          frame_depth: frameDepth,
          ...frame,
          ...snap,
        });
        return true;
      }
      if (message?.type === "x10_capture_dom") {
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

  function domHash(elOrDoc) {
    const root =
      elOrDoc?.nodeType === 1 ? elOrDoc : elOrDoc?.body || elOrDoc?.documentElement;
    if (!root) return "0";
    const t = (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim();
    let h = 0;
    for (let i = 0; i < t.length; i += 1) {
      h = (Math.imul(31, h) + t.charCodeAt(i)) >>> 0;
    }
    return `${t.length}:${h.toString(16)}`;
  }

  function slipRootId(root) {
    if (!root) return "";
    return (
      root.getAttribute?.("data-editor-id") ||
      root.id ||
      selectorHint(root) ||
      ""
    );
  }

  function enrichSlipResult(result, root) {
    if (root) {
      const hash = domHash(root);
      result.dom_hash = hash;
      result.root_id = slipRootId(root);
      if (result.items?.length) {
        for (const item of result.items) {
          if (!item.dom_hash) item.dom_hash = hash;
        }
      }
    }
    result.timestamp = Date.now();
    return result;
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

  function countBcSelections() {
    let count = 0;
    for (const sel of [
      '[data-editor-id="betslipSelection"]',
      '[data-editor-id*="betslipSelection"]',
    ]) {
      for (const el of collectIn(document.documentElement, sel)) {
        if (!visible(el) || isInsideBetHistory(el)) continue;
        const editorId = el.getAttribute?.("data-editor-id") || "";
        if (/betslipSelections$/i.test(editorId)) continue;
        count += 1;
      }
    }
    return count;
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
    const selectorHits = scanSelectors(BC_SELECTOR_CANDIDATES);
    const selectionEl = findBcSelectionElement();
    const slipCount = countBcSelections();

    if (!selectionEl && slipCount < 1) {
      return {
        ok: false,
        empty: true,
        items: [],
        reason: "no-slip-root",
        frame_url: location.href,
        slip_root_found: "NO",
        slip_count: 0,
        selector_hits: selectorHits,
      };
    }

    const selection = selectionEl || collectIn(document.documentElement, '[data-editor-id="betslipSelection"]').find(
      (el) => visible(el) && !isInsideBetHistory(el),
    );
    if (!selection) {
      return {
        ok: false,
        empty: true,
        items: [],
        reason: "no-slip-root",
        frame_url: location.href,
        slip_root_found: "NO",
        slip_count: slipCount,
        selector_hits: selectorHits,
      };
    }

    const slip = findBcSlipRoot(selection);
    const blockText = text(selection);
    const slipInnerText = text(slip).slice(0, 1000);
    if (EMPTY_RE.test(text(slip)) && blockText.length < 4 && slipCount < 1) {
      return {
        ok: true,
        empty: true,
        items: [],
        reason: "empty-slip",
        frame_url: location.href,
        container_selector: selectorHint(slip),
        slip_root_found: "YES",
        slip_count: slipCount,
        selector_hits: selectorHits,
        slip_inner_text: slipInnerText,
      };
    }

    const event = readDomField(selection, ["eventName", "EventName", "event"]);
    const market = readDomField(selection, ["marketName", "MarketName", "market"]);
    const selectionName = readDomField(selection, ["outcomeName", "OutcomeName", "selection", "Selection"]);
    const stake = readBcStake(slip);
    const odds = extractBcOdds(selection, slip);
    const status = classifySlipStatus(blockText || slipInnerText, odds, slip);

    const item = enrichItem(
      {
        event,
        market,
        selection: selectionName,
        odds: status === "active" ? odds : null,
        status: odds != null ? status : slipCount >= 1 || blockText.length >= 4 ? (status === "empty" ? "odds_missing" : status) : status,
        stake,
        container_selector: selectorHint(selection),
        dom_hash: domHash(slip),
      },
      event,
    );

    if (!event && !selectionName && odds == null) {
      if (slipCount >= 1 || blockText.length >= 4 || slipInnerText.length >= 8) {
        return {
          ok: true,
          empty: false,
          items: [
            enrichItem(
              {
                event,
                market,
                selection: selectionName || blockText.slice(0, 120),
                odds: null,
                status: "odds_missing",
                stake,
                container_selector: selectorHint(selection),
                dom_hash: domHash(slip),
              },
              event,
            ),
          ],
          source: "dom",
          frame_url: location.href,
          container_selector: selectorHint(slip),
          slip_root_found: "YES",
          slip_count: slipCount,
          selector_hits: selectorHits,
          slip_inner_text: slipInnerText,
          parsed_status: "odds_missing",
          status_reason: "root-found-no-odds",
        };
      }
      return {
        ok: true,
        empty: true,
        items: [],
        reason: "empty-slip",
        frame_url: location.href,
        container_selector: selectorHint(slip),
        slip_root_found: "YES",
        slip_count: slipCount,
        selector_hits: selectorHits,
        slip_inner_text: slipInnerText,
      };
    }

    return {
      ok: true,
      empty: false,
      items: [item],
      source: "dom",
      frame_url: location.href,
      container_selector: selectorHint(slip),
      slip_root_found: "YES",
      slip_count: Math.max(slipCount, 1),
      selector_hits: selectorHits,
      slip_inner_text: slipInnerText,
      parsed_status: item.status,
      extracted_odds: odds,
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

  function scanX10DiagnosticSelectors() {
    const scans = [];
    for (const selector of X10_DIAG_SELECTORS) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(selector)];
      } catch (_err) {
        scans.push({ selector, match_count: 0, sample_text: "(invalid selector)" });
        continue;
      }
      const visibleNodes = nodes.filter((el) => visible(el));
      const sample = visibleNodes[0] ? text(visibleNodes[0]).slice(0, 500) : "";
      scans.push({ selector, match_count: visibleNodes.length, sample_text: sample });
    }
    return scans;
  }

  function scanX10DebugSelectors() {
    return scanX10DiagnosticSelectors();
  }

  function buildX10DebugSnapshot(frameDepth) {
    const probeApi = global.ArbX10Probe;
    const frameInfo = probeApi?.probeFrame?.() || {
      frame_url: location.href,
      readyState: document.readyState,
      bodyLength: 0,
      hasBetSlipKeyword: false,
    };
    const pipeline = probeApi?.runPipeline?.((root, stake) => extractX10OddsFromRoot(root, stake)) || {
      steps: {},
      root: null,
      odds: null,
      slip_count: 0,
      status: "empty",
    };
    const root = pipeline.root || null;
    const debugCandidates = (pipeline.odds_candidates || []).map((c) => ({
      ...c,
      label: c.selected
        ? `${c.value} SELECTED odds`
        : `${c.value} EXCLUDED ${c.exclude_reason || "rejected"}`,
    }));
    const rootStatus = pipeline.steps?.X10_ROOT === "PASS" ? "FOUND" : "MISSING";
    const selectionText = pipeline.selection_text || "";
    const oddsText = pipeline.odds_text || "";
    const extracted = pipeline.odds;
    const oddsLocatorDebug = [
      `Root ${rootStatus}`,
      selectionText ? `Selection:\n${selectionText}` : "Selection:",
      oddsText ? `Odds:\n${oddsText}` : "Odds:",
      extracted != null ? `Extracted:\n${extracted}` : "Extracted:",
    ].join("\n\n");
    return {
      site: "x10",
      frame_url: location.href,
      frame_depth: frameDepth,
      document_ready: frameInfo.readyState,
      body_text_length: frameInfo.bodyLength,
      has_betslip_keyword: frameInfo.hasBetSlipKeyword,
      injected_frame: true,
      target_frame: frameInfo.hasBetSlipKeyword ? location.href : "",
      root_found: pipeline.steps?.X10_ROOT === "PASS" ? "YES" : pipeline.steps?.X10_ROOT === "ROOT_SELECTOR_FAILED" ? "ROOT_SELECTOR_FAILED" : "NO",
      slip_root_found: pipeline.steps?.X10_ROOT === "PASS" ? "YES" : "NO",
      root_selector: pipeline.rootSelector || "",
      container_selector: pipeline.rootSelector || "",
      slip_count: pipeline.slip_count ?? 0,
      slip_items: pipeline.slip_items || [],
      root_inner_text: pipeline.bodySnippet || frameInfo.bodySnippet || "",
      slip_inner_text: pipeline.bodySnippet || "",
      pipeline_steps: pipeline.steps || {},
      first_failure: pipeline.steps?.first_failure || "",
      odds_candidates: debugCandidates,
      odds_source: pipeline.odds_source || "",
      extracted_odds: pipeline.odds,
      selection_text: selectionText,
      selection_node: pipeline.selection_node || null,
      odds_text: oddsText,
      odds_node: pipeline.odds_node || null,
      odds_locator: {
        root: rootStatus,
        selection_text: selectionText,
        selection_node: pipeline.selection_node || null,
        odds_text: oddsText,
        odds_node: pipeline.odds_node || null,
        extracted_odds: extracted,
        method: pipeline.odds_method || pipeline.odds_source || "",
      },
      odds_locator_debug: oddsLocatorDebug,
      parsed_status: pipeline.status || "empty",
      status_reason: pipeline.steps?.first_failure || pipeline.status || "",
      keyword_candidates: pipeline.keyword_candidates || [],
      revision: x10RootTracker.revision,
    };
  }

  function hasX10SlipContent(rootText, odds) {
    if (odds != null) return true;
    const blob = String(rootText || "");
    return (
      /베팅\s*슬립\s*\d+|베팅슬립\s*\d+/i.test(blob) ||
      /\b싱글\b/i.test(blob) ||
      /베팅하기|배당\s*수락/i.test(blob)
    );
  }

  function scoreX10Root(root) {
    const blob = text(root);
    let score = 0;
    if (/베팅\s*슬립|베팅슬립|bet\s*slip/i.test(blob)) score += 60;
    if (/베팅하기|배팅하기|place\s*bet/i.test(blob)) score += 40;
    if (/\b싱글\b|\bsingle\b/i.test(blob)) score += 15;
    if (inspectX10BetButton(root).found) score += 25;
    const stake = readX10Stake(root);
    const probe = extractX10OddsFromRoot(root, stake);
    if (probe.odds != null) score += 120;
    score += Math.min(blob.length / 120, 25);
    if (blob.length > 6000) score -= 40;
    return score;
  }

  function pickBestX10Root(roots) {
    if (!roots?.length) return null;
    let best = roots[0];
    let bestScore = scoreX10Root(best);
    for (let i = 1; i < roots.length; i += 1) {
      const s = scoreX10Root(roots[i]);
      if (s > bestScore) {
        bestScore = s;
        best = roots[i];
      }
    }
    return best;
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
    roots.sort((a, b) => scoreX10Root(b) - scoreX10Root(a));
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

  const X10_ODDS_MIN = 1.01;
  const X10_ODDS_MAX = 100;

  const X10_CHIP_AMOUNTS = new Set([10, 20, 50, 100, 300, 1000, 10000, 100000, 500000, 0.2]);

  function isX10LineValue(val, leafText, parentText, contextBlob) {
    const blob = `${contextBlob} ${parentText} ${leafText}`.toLowerCase();
    const valStr = String(val);
    if (isX10ParenLineValue(leafText, valStr) || isX10ParenLineValue(parentText, valStr)) return true;
    if (/[+-]\s*\d/.test(leafText) || /[+-]\d/.test(leafText)) {
      const m = leafText.match(/[+-]\s*(\d+(?:\.\d+)?)/);
      if (m && Math.abs(parseFloat(m[1]) - val) < 0.001) return true;
    }
    if (/(over|under|오버|언더|total|토탈|핸디|handicap|spread|기준)/i.test(blob)) {
      if (/^\d+\.5$/.test(valStr) && val >= 1.5) return true;
      if (new RegExp(`(?:over|under|오버|언더)\\s*${valStr.replace(".", "\\.")}`, "i").test(blob)) return true;
      if (val >= 10 && val < 100 && /^\d+\.\d+$/.test(valStr)) return true;
    }
    if (/^\d+\.\d+$/.test(valStr) && val >= 20 && /^\d+\.5$/.test(valStr)) return true;
    return false;
  }

  function x10ExcludeReason(val, leafText, parentText, contextBlob, stake) {
    if (!Number.isFinite(val)) return "not-a-number";
    if (val < X10_ODDS_MIN || val > X10_ODDS_MAX) return "out-of-range";
    if (stake != null && Math.abs(val - stake) < 0.001) return "stake";
    if (X10_CHIP_AMOUNTS.has(val)) return "stake";
    if (Number.isInteger(val) && val >= 1000) return "stake";
    const blob = `${leafText} ${parentText} ${contextBlob}`;
    if (/당첨\s*예상|예상\s*금액|expected\s*payout|payout/i.test(blob)) return "payout";
    if (/잔액|balance/i.test(blob)) return "balance";
    if (/\+\s*[\d,]+/.test(leafText)) return "stake";
    if (/^\d{1,2}$/.test(leafText.trim())) return "score";
    if (isX10LineValue(val, leafText, parentText, contextBlob)) return "line";
    if (!/\./.test(leafText) && val < 10 && Number.isInteger(val)) return "inning";
    return "";
  }

  function collectX10LeafTexts(root) {
    const leaves = [];
    walk(root, (node) => {
      if (node.nodeType !== 1 || !visible(node)) return;
      const elementChildren = [...node.children].filter((ch) => ch.nodeType === 1);
      if (elementChildren.length > 0) return;
      const raw = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 48) return;
      const parent = node.parentElement || root;
      const grandparent = parent?.parentElement || root;
      leaves.push({
        node,
        text: raw,
        tag: node.tagName?.toLowerCase() || "",
        className: String(node.className || ""),
        parentText: text(parent).slice(0, 120),
        grandparentText: text(grandparent).slice(0, 120),
      });
    }, 0);
    return leaves;
  }

  function x10NodeDescriptor(node) {
    if (!node) return null;
    return {
      tag: node.tagName?.toLowerCase() || "",
      className: String(node.className || "").slice(0, 80),
      text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
      selector: selectorHint(node),
    };
  }

  /** selection 행: 오버 (6.5) — 괄호 안 6.5는 기준점 */
  function isX10SelectionLineText(rawText) {
    const t = String(rawText || "").trim();
    if (!t || t.length > 120) return false;
    if (/^(베팅슬립|베팅 슬립|싱글|조합|멀티|더블)$/i.test(t)) return false;
    if (/배팅\s*수락|베팅하기|배팅하기|당첨/i.test(t)) return false;
    if (/\d+\.\d+\s*@\s*\d/.test(t)) return false;
    if (/(오버|언더|Over|Under)/i.test(t) && /\(\s*\d+\.\d+\s*\)/.test(t)) return true;
    if (/(핸디|핸디캡|Handicap)/i.test(t) && /[+-]?\d+\.?\d*/.test(t)) return true;
    return false;
  }

  function isX10ParenLineValue(lineText, token) {
    const escaped = String(token).replace(".", "\\.");
    return new RegExp(`\\(\\s*${escaped}\\s*\\)`).test(lineText || "");
  }

  function isX10StandaloneOddsLine(rawText) {
    const t = String(rawText || "").trim();
    const m = t.match(/^@?\s*(\d{1,3}(?:\.\d{1,3})?)$/);
    if (!m) return false;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) && n >= X10_ODDS_MIN && n <= X10_ODDS_MAX;
  }

  function buildX10OddsPick(pick, candidates, extra) {
    return {
      odds: pick.value,
      candidates,
      source: pick.source,
      selection_text: extra.selection_text || "",
      selection_node: extra.selection_node || null,
      odds_text: extra.odds_text || pick.text || String(pick.value),
      odds_node: extra.odds_node || null,
      method: extra.method || pick.source,
    };
  }

  /** 우선순위 1: root 내부 selection → 다음 줄/오른쪽 배당 */
  function extractX10OddsFromSelection(root, stake, contextBlob) {
    if (!root) return { odds: null, candidates: [], source: "" };

    const candidates = [];
    const leaves = collectX10LeafTexts(root);

    for (let li = 0; li < leaves.length; li += 1) {
      const leaf = leaves[li];
      if (!isX10SelectionLineText(leaf.text)) continue;

      const selectionText = leaf.text.trim();
      const selectionNode = x10NodeDescriptor(leaf.node);

      const inlineAt = leaf.text.match(/@\s*(\d{1,3}(?:\.\d{1,3})?)\s*$/);
      if (inlineAt) {
        const val = parseFloat(inlineAt[1]);
        const reason = x10ExcludeReason(val, inlineAt[1], leaf.parentText, contextBlob, stake);
        const entry = {
          value: val,
          text: inlineAt[1],
          tag: leaf.tag,
          className: leaf.className,
          parentText: leaf.parentText,
          source: "selection",
          excluded: Boolean(reason),
          exclude_reason: reason || "",
          selected: false,
        };
        candidates.push(entry);
        if (!reason) {
          entry.selected = true;
          return buildX10OddsPick(entry, candidates, {
            selection_text: selectionText,
            selection_node: selectionNode,
            odds_text: inlineAt[1],
            odds_node: x10NodeDescriptor(leaf.node),
            method: "selection_inline_at",
          });
        }
      }

      const tokens = leaf.text.match(/\b(\d{1,3}(?:\.\d{1,3})?)\b/g) || [];
      for (let ti = tokens.length - 1; ti >= 0; ti -= 1) {
        const token = tokens[ti];
        if (isX10ParenLineValue(leaf.text, token)) continue;
        const val = parseFloat(token);
        const reason = x10ExcludeReason(val, token, leaf.parentText, contextBlob, stake);
        const entry = {
          value: val,
          text: token,
          tag: leaf.tag,
          className: leaf.className,
          parentText: leaf.parentText,
          source: "selection",
          excluded: Boolean(reason),
          exclude_reason: reason || "",
          selected: false,
        };
        candidates.push(entry);
        if (!reason) {
          entry.selected = true;
          return buildX10OddsPick(entry, candidates, {
            selection_text: selectionText,
            selection_node: selectionNode,
            odds_text: token,
            odds_node: x10NodeDescriptor(leaf.node),
            method: "selection_rightmost",
          });
        }
      }

      for (let fi = li + 1; fi < Math.min(li + 8, leaves.length); fi += 1) {
        const follow = leaves[fi];
        const lt = follow.text.trim();
        if (/배팅|수락|원|KRW|₩|합계|당첨/i.test(lt)) break;
        if (isX10SelectionLineText(lt)) break;
        if (!isX10StandaloneOddsLine(lt)) continue;
        const val = parseFloat(lt.replace(/^@/, ""));
        const reason = x10ExcludeReason(
          val,
          lt,
          follow.parentText,
          `${follow.grandparentText} ${contextBlob}`,
          stake,
        );
        const entry = {
          value: val,
          text: lt,
          tag: follow.tag,
          className: follow.className,
          parentText: follow.parentText,
          source: "selection",
          excluded: Boolean(reason),
          exclude_reason: reason || "",
          selected: false,
        };
        candidates.push(entry);
        if (!reason) {
          entry.selected = true;
          return buildX10OddsPick(entry, candidates, {
            selection_text: selectionText,
            selection_node: selectionNode,
            odds_text: lt,
            odds_node: x10NodeDescriptor(follow.node),
            method: "selection_following_line",
          });
        }
      }
    }

    const lines = (root.innerText || "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (!isX10SelectionLineText(lines[i])) continue;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
        if (/배팅|수락|당첨/i.test(lines[j])) break;
        if (isX10SelectionLineText(lines[j])) break;
        if (!isX10StandaloneOddsLine(lines[j])) continue;
        const val = parseFloat(lines[j].replace(/^@/, ""));
        const reason = x10ExcludeReason(val, lines[j], lines[i], contextBlob, stake);
        const entry = {
          value: val,
          text: lines[j],
          tag: "",
          className: "",
          parentText: lines[i],
          source: "selection",
          excluded: Boolean(reason),
          exclude_reason: reason || "",
          selected: false,
        };
        candidates.push(entry);
        if (!reason) {
          entry.selected = true;
          return buildX10OddsPick(entry, candidates, {
            selection_text: lines[i],
            selection_node: null,
            odds_text: lines[j],
            odds_node: null,
            method: "selection_text_lines",
          });
        }
      }
    }

    return { odds: null, candidates, source: "" };
  }

  function extractX10OddsFromDedicated(root, stake, contextBlob) {
    const candidates = [];
    for (const sel of X10_ODDS_SELECTORS) {
      let nodes = [];
      try {
        nodes = [...root.querySelectorAll(sel)];
      } catch (_err) {
        continue;
      }
      for (const node of nodes) {
        if (!visible(node)) continue;
        const raw = text(node).replace(/,/g, "").trim();
        const m = raw.match(/^@?\s*([+-]?\d+(?:\.\d+)?)$/);
        if (!m) continue;
        const val = parseFloat(m[1]);
        const parentText = text(node.parentElement || root);
        const reason = x10ExcludeReason(val, raw, parentText, contextBlob, stake);
        const entry = {
          value: val,
          text: raw,
          tag: node.tagName?.toLowerCase() || "",
          className: String(node.className || ""),
          parentText: parentText.slice(0, 120),
          source: "selector",
          selector: sel,
          excluded: Boolean(reason),
          exclude_reason: reason || "",
          selected: false,
        };
        candidates.push(entry);
        if (!reason) {
          entry.selected = true;
          return { odds: val, candidates, source: "selector" };
        }
      }
    }
    return { odds: null, candidates, source: "" };
  }

  function extractX10OddsFromRoot(root, stake) {
    const contextBlob = text(root);
    const fromSelection = extractX10OddsFromSelection(root, stake, contextBlob);
    if (fromSelection.odds != null) return fromSelection;

    const dedicated = extractX10OddsFromDedicated(root, stake, contextBlob);
    if (dedicated.odds != null) {
      return {
        ...dedicated,
        selection_text: "",
        selection_node: null,
        odds_text: dedicated.candidates?.find((c) => c.selected)?.text || String(dedicated.odds),
        odds_node: null,
        method: dedicated.source,
      };
    }

    const candidates = [...fromSelection.candidates, ...dedicated.candidates];
    for (const leaf of collectX10LeafTexts(root)) {
      const normalized = leaf.text.replace(/,/g, "");
      const m = normalized.match(/^@?\s*([+-]?\d+(?:\.\d{1,4})?)$/);
      if (!m) continue;
      const val = parseFloat(m[1]);
      const reason = x10ExcludeReason(
        val,
        leaf.text,
        leaf.parentText,
        `${leaf.grandparentText} ${contextBlob}`,
        stake,
      );
      candidates.push({
        value: val,
        text: leaf.text,
        tag: leaf.tag,
        className: leaf.className,
        parentText: leaf.parentText,
        node: leaf.node,
        source: "leaf",
        excluded: Boolean(reason),
        exclude_reason: reason || "",
        selected: false,
      });
    }

    let odds = null;
    const valid = candidates.filter((c) => !c.excluded && c.value >= X10_ODDS_MIN && c.value <= X10_ODDS_MAX);
    const pick = valid.length ? valid[valid.length - 1] : null;
    if (pick) {
      odds = pick.value;
      pick.selected = true;
    }

    return {
      odds,
      candidates,
      source: pick?.source || "leaf",
      selection_text: "",
      selection_node: null,
      odds_text: pick?.text || (odds != null ? String(odds) : ""),
      odds_node: pick ? x10NodeDescriptor(pick.node) : null,
      method: pick?.source || "leaf",
    };
  }

  function readX10Slip() {
    const probeApi = global.ArbX10Probe;
    if (!probeApi?.runPipeline) {
      return {
        ok: false,
        empty: true,
        items: [],
        reason: "x10-probe-missing",
        frame_url: location.href,
      };
    }

    const pipeline = probeApi.runPipeline((root, stake) => extractX10OddsFromRoot(root, readX10Stake(root) ?? stake));
    const steps = pipeline.steps || {};
    const root = pipeline.root || null;

    if (!root) {
      resetX10SlipState();
      return {
        ok: steps.X10_FRAME === "PASS",
        empty: true,
        items: [],
        reason: steps.X10_ROOT === "ROOT_SELECTOR_FAILED" ? "ROOT_SELECTOR_FAILED" : "no-slip-root",
        frame_url: location.href,
        slip_root_found: "NO",
        root_found: steps.X10_ROOT === "ROOT_SELECTOR_FAILED" ? "ROOT_SELECTOR_FAILED" : "NO",
        slip_inner_text: pipeline.bodySnippet || pipeline.frame?.bodySnippet || "",
        pipeline_steps: steps,
        first_failure: steps.first_failure || "",
        keyword_candidates: pipeline.keyword_candidates || [],
        extracted_odds: null,
        revision: x10RootTracker.revision,
        parsed_status: pipeline.status || "empty",
        status_reason: steps.first_failure || pipeline.status || "",
      };
    }

    const revision = trackX10Root(root);
    const rootText = text(root);
    const stake = readX10Stake(root);
    const odds = pipeline.odds;
    const candidates = pipeline.odds_candidates || [];
    const slipCount = pipeline.slip_count ?? 0;

    const statusResult = resolveX10SlipStatus(root, rootText, odds);
    let slipStatus = pipeline.status === "active" ? "active" : statusResult.status;
    if (odds != null && steps.X10_ODDS === "PASS" && steps.X10_ITEM === "PASS" && slipStatus !== "closed" && slipStatus !== "suspended" && slipStatus !== "disabled") {
      slipStatus = "active";
    }

    const parsed = parseX10SlipText(rootText);
    const base = {
      source: "dom",
      frame_url: location.href,
      container_selector: pipeline.rootSelector || selectorHint(root),
      slip_root_found: "YES",
      root_found: "YES",
      slip_count: slipCount,
      slip_inner_text: pipeline.bodySnippet || rootText.slice(0, 1500),
      pipeline_steps: steps,
      first_failure: steps.first_failure || "",
      odds_candidates: candidates,
      odds_source: pipeline.odds_source || "",
      extracted_odds: odds,
      parsed_status: slipStatus,
      status_reason: steps.first_failure || statusResult.reason || slipStatus,
      status_diagnostics: statusResult.diagnostics,
      slip_items: pipeline.slip_items || [],
      revision,
      anchor_method: pipeline.anchorMethod || "text-anchor",
    };

    if (slipStatus === "active" && odds != null && slipCount === 1) {
      const item = enrichItem(
        {
          event: parsed.event || "",
          market: parsed.market || "",
          selection: parsed.selection || "",
          odds,
          status: "active",
          status_reason: "active",
          stake,
          container_selector: pipeline.rootSelector || selectorHint(root),
          dom_hash: domHash(root),
          status_diagnostics: statusResult.diagnostics,
        },
        parsed.event,
      );
      return enrichSlipResult({ ok: true, empty: false, items: [item], ...base }, root);
    }

    const closedLike = ["closed", "suspended", "disabled", "closed_pending"].includes(slipStatus);
    if (closedLike || odds == null || slipCount !== 1) {
      return enrichSlipResult(
        {
          ok: true,
          empty: slipCount === 0 && odds == null,
          items:
            slipCount > 0 || odds != null
              ? [
                  enrichItem(
                    {
                      event: parsed.event || "",
                      market: parsed.market || "",
                      selection: parsed.selection || "",
                      odds: slipStatus === "active" ? odds : null,
                      previous_odds: null,
                      status: slipCount !== 1 ? "odds_missing" : slipStatus,
                      status_reason: steps.first_failure || statusResult.reason,
                      stake,
                      container_selector: pipeline.rootSelector || selectorHint(root),
                      status_diagnostics: statusResult.diagnostics,
                    },
                    parsed.event,
                  ),
                ]
              : [],
          reason: steps.first_failure || (slipCount !== 1 ? `slip_count=${slipCount}` : "odds-missing"),
          ...base,
        },
        root,
      );
    }

    return enrichSlipResult({ ok: true, empty: true, items: [], reason: "empty-slip", ...base }, root);
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
