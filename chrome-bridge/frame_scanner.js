/**
 * BetSlip-only DOM reader — container 내부만 탐색, 전체 페이지 스캔 금지.
 * BC.Game / x10x10s 공용 유틸.
 */
(function initFrameScanner(global) {
  const SUSPENDED_RE =
    /suspend|suspended|마감|closed|locked|unavailable|정지된|정지됨|베팅\s*마감|betting\s*(is\s*)?closed|일시\s*정지/i;
  const EMPTY_RE =
    /슬립이\s*비어|슬립\s*비어|선택한\s*베팅\s*없|선택된\s*베팅\s*없|베팅을\s*선택|베팅\s*카트가?\s*비|카트가?\s*비어|empty\s*(bet\s*)?slip|no\s*selection|betslip\s*is\s*empty/i;
  const ODDS_RE = /(?<!\d)(?:1\.\d+|[2-9]\d*(?:\.\d+)?)(?!\d)/;
  const VS_RE =
    /([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{0,60}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{0,60})/i;
  const SLIP_HINT_RE = /betslip|bet-slip|bet_slip|coupon|ticket|selections|betslipselection/i;

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
    return el.tagName ? el.tagName.toLowerCase() : "";
  }

  function parseOdds(raw) {
    const t = String(raw || "").trim();
    const n = parseFloat(t);
    if (!n || n <= 1.01 || n >= 100) return null;
    if (!/^\d+(\.\d{1,4})?$/.test(t)) return null;
    return n;
  }

  function parseEventTeams(raw) {
    const t = String(raw || "").trim();
    const m = t.match(VS_RE);
    if (!m) return { event: t, home: "", away: "" };
    return { event: `${m[1].trim()} vs ${m[2].trim()}`, home: m[1].trim(), away: m[2].trim() };
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

  function findBcSlipRoot() {
    const selectors = [
      '[data-editor-id="betslipSelection"]',
      '[class*="betslipSelection"]',
      '[class*="BetSlipSelection"]',
      '[class*="bet-slip"]',
      '[class*="betslip"]',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el) || isInsideBetHistory(el)) continue;
        return el;
      }
    }
    return null;
  }

  function findBcSelectionBlocks(slip) {
    const blocks = [];
    const seen = new Set();
    for (const el of slip.querySelectorAll('[class*="selection"], [class*="Selection"], [data-editor-id*="selection"]')) {
      if (seen.has(el) || !visible(el)) continue;
      seen.add(el);
      blocks.push(el);
    }
    if (!blocks.length && text(slip) && !EMPTY_RE.test(text(slip))) {
      blocks.push(slip);
    }
    return blocks;
  }

  function readBcStake(slip) {
    for (const input of slip.querySelectorAll("input")) {
      const val = parseFloat(String(input.value || "").replace(/,/g, ""));
      if (val > 0) return val;
    }
    return null;
  }

  function readBcSlip() {
    const slip = findBcSlipRoot();
    if (!slip) {
      return { ok: false, empty: true, items: [], reason: "no-slip-root", frame_url: location.href };
    }
    if (EMPTY_RE.test(text(slip)) && !findBcSelectionBlocks(slip).length) {
      return {
        ok: true,
        empty: true,
        items: [],
        reason: "empty-slip",
        frame_url: location.href,
        container_selector: selectorHint(slip),
      };
    }
    const blocks = findBcSelectionBlocks(slip);
    if (!blocks.length) {
      return {
        ok: false,
        empty: true,
        items: [],
        reason: "no-selection-block",
        frame_url: location.href,
        container_selector: selectorHint(slip),
      };
    }
    const block = blocks[0];
    const blockText = text(block);
    const stake = readBcStake(slip);
    const oddsMatch = blockText.match(ODDS_RE);
    const odds = oddsMatch ? parseOdds(oddsMatch[0]) : null;
    const teams = parseEventTeams(blockText);
    const suspended = SUSPENDED_RE.test(blockText);
    const item = {
      event: teams.event,
      market: "",
      selection: teams.home || blockText.slice(0, 80),
      odds: suspended ? null : odds,
      status: suspended ? "suspended" : odds ? "active" : "odds_missing",
      stake,
      container_selector: selectorHint(block),
    };
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
    const selectors = [
      '[class*="betslip_fe"]',
      '[class*="Betslip"]',
      '[class*="betslip"]',
      '[class*="bet-slip"]',
      '[class*="coupon"]',
      '[id*="betslip"]',
      '[data-testid*="betslip"]',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el) || !visible(el) || isInsideBetHistory(el)) continue;
        const blob = `${el.className || ""} ${el.id || ""}`.toLowerCase();
        if (!SLIP_HINT_RE.test(blob)) continue;
        seen.add(el);
        roots.push(el);
      }
    }
    return roots;
  }

  function getX10SlipCards(root) {
    const cards = [];
    const seen = new Set();
    for (const el of root.querySelectorAll('[class*="betInformation"], [class*="BetSecondary"]')) {
      if (seen.has(el) || !visible(el)) continue;
      seen.add(el);
      cards.push(el);
    }
    return cards;
  }

  function readX10Stake(root) {
    for (const input of root.querySelectorAll("input")) {
      const val = parseFloat(String(input.value || "").replace(/,/g, ""));
      if (val > 0) return val;
    }
    return null;
  }

  function readX10Slip() {
    const roots = findX10SlipRoots();
    if (!roots.length) {
      return { ok: false, empty: true, items: [], reason: "no-slip-root", frame_url: location.href };
    }
    for (const root of roots) {
      const cards = getX10SlipCards(root);
      if (!cards.length) continue;
      const card = cards[cards.length - 1];
      const cardText = text(card);
      const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
      const selection = titleEls[0] ? titleEls[0].textContent.trim() : "";
      const marketTitle = titleEls[1] ? titleEls[1].textContent.trim() : "";
      const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
      const event = eventEl ? eventEl.textContent.trim() : "";
      const suspended = SUSPENDED_RE.test(cardText);
      const oddsMatch = cardText.match(ODDS_RE);
      const odds = suspended ? null : oddsMatch ? parseOdds(oddsMatch[0]) : null;
      if (!event && !selection) continue;
      return {
        ok: true,
        empty: false,
        items: [
          {
            event,
            market: marketTitle,
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
    };
  }

  global.ArbFrameScanner = {
    readBcSlip,
    readX10Slip,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
