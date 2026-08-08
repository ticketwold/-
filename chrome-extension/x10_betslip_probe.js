/**
 * X10 BetSlip DOM probe — text-anchor root discovery, frame diagnostics, DOM capture.
 * No guessed betslip selectors; discovers root from live DOM keywords.
 */
(function initX10Probe(global) {
  const KEYWORDS = ["베팅슬립", "베팅 슬립", "싱글", "조합", "베팅하기", "당첨 예상금액", "배당", "배당 수락", "배팅 수락"];
  const ANCHOR_RE = /베팅\s*슬립|베팅슬립|베팅하기|배당\s*수락|배팅\s*수락/;
  const BETSLIP_ANCHOR_CHECKS = [
    { key: "베팅슬립", test: (t) => /베팅\s*슬립|베팅슬립/.test(t) },
    { key: "싱글", test: (t) => /\b싱글\b/.test(t) },
    { key: "selection", test: (t) => /(오버|언더|Over|Under)\s*\(\s*\d+\.\d+\s*\)/i.test(t) },
    { key: "odds", test: (t) => /\b\d{1,2}\.\d{2}\b/.test(t) },
    { key: "bet_accept", test: (t) => /배당\s*수락|배팅\s*수락/i.test(t) },
  ];
  const HASH_CLASS_RE = /^[a-z]{1,3}[A-Z][a-zA-Z0-9_-]{4,}$|^[a-z]{2,4}-[a-f0-9]{5,}$/i;
  const MAX_HTML_BYTES = 30_000;

  function bodyInner() {
    try {
      const root = document.body || document.documentElement;
      if (!root) return "";
      return deepInnerText(root);
    } catch (_err) {
      return "";
    }
  }

  function composedParent(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    const parent = el.parentNode;
    if (parent && parent.nodeType === 11 && parent.host) return parent.host;
    return parent;
  }

  function isWithinRoot(root, el) {
    if (!root || !el) return false;
    let node = el;
    while (node) {
      if (node === root) return true;
      node = composedParent(node);
    }
    return false;
  }

  /** document → element.shadowRoot → nested shadowRoot 재귀 탐색 */
  function walkDeep(start, fn) {
    if (!start) return;
    const stack = [start];
    while (stack.length) {
      const current = stack.pop();
      if (!current) continue;
      if (current.nodeType === 1) {
        fn(current);
        const children = current.children || [];
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
        if (current.shadowRoot) stack.push(current.shadowRoot);
      } else if (current.nodeType === 11) {
        const children = current.children || [];
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
      }
    }
  }

  function deepInnerText(root) {
    const parts = [];
    walkDeep(root, (el) => {
      if (el.nodeType !== 1) return;
      const hasElementChild = [...(el.children || [])].some((ch) => ch.nodeType === 1);
      const hasShadowChild = el.shadowRoot && el.shadowRoot.children?.length > 0;
      if (hasElementChild || hasShadowChild) return;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    });
    return parts.join("\n");
  }

  function walkElements(fn) {
    const root = document.body || document.documentElement;
    if (!root) return;
    walkDeep(root, fn);
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    } catch (_err) {}
    return true;
  }

  function probeFrame() {
    const bodyText = bodyInner();
    const anchors = probeAnchorKeywords();
    return {
      frame_url: location.href,
      readyState: document.readyState || "unknown",
      bodyLength: bodyText.length,
      hasBetSlipKeyword: KEYWORDS.some((k) => bodyText.includes(k)) || anchors.has_any,
      body_has_keywords: anchors.has_any,
      anchor_hits: anchors.hits,
      bodySnippet: bodyText.slice(0, 1200),
    };
  }

  function probeAnchorKeywords() {
    const hits = {};
    const betslipBlock = findBetSlipAnchorTextBlock();

    if (betslipBlock) {
      hits["베팅슬립"] = { selector: "(text-block)", text: betslipBlock.slice(0, 800) };
      const parsed = parseX10SlipText(betslipBlock);
      if (/\b싱글\b/.test(betslipBlock)) hits["싱글"] = { selector: "(text-block)", text: "싱글" };
      if (parsed.selection) hits.selection = { selector: "(text-block)", text: parsed.selection };
      if (parsed.odds != null) hits.odds = { selector: "(text-block)", text: String(parsed.odds) };
      if (/당첨\s*예상|베팅하기/.test(betslipBlock)) {
        hits.bet_accept = {
          selector: "(text-block)",
          text: /베팅하기/.test(betslipBlock) ? "베팅하기" : "당첨 예상금액",
        };
      }
      return { hits, has_any: true };
    }

    walkElements((el) => {
      if (!isVisible(el)) return;
      const inner = (el.innerText || el.textContent || "").trim();
      if (!inner || inner.length > 8000) return;
      for (const check of BETSLIP_ANCHOR_CHECKS) {
        if (hits[check.key]) continue;
        if (!check.test(inner)) continue;
        if (check.key === "베팅슬립" || check.key === "selection" || check.key === "odds") {
          const block = extractBetSlipTextBlock(inner);
          if (!block) continue;
          if (check.key === "베팅슬립") {
            hits[check.key] = { selector: buildStableSelector(el), text: block.slice(0, 800) };
          }
          continue;
        }
        hits[check.key] = {
          selector: buildStableSelector(el),
          text: inner.slice(0, 200),
        };
      }
    });
    return { hits, has_any: Object.keys(hits).length > 0 };
  }

  function findKeywordCandidates() {
    const out = [];
    walkElements((el) => {
      if (!isVisible(el)) return;
      const inner = (el.innerText || "").trim();
      if (!inner || inner.length > 2500) return;
      for (const kw of KEYWORDS) {
        if (!inner.includes(kw)) continue;
        out.push({
          keyword: kw,
          tagName: el.tagName || "",
          id: el.id || "",
          className: String(el.className || ""),
          innerText: inner.slice(0, 500),
          outerHTML: (el.outerHTML || "").slice(0, 8000),
        });
        break;
      }
    });
    return out.slice(0, 50);
  }

  function escapeAttr(v) {
    return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function buildStableSelector(el) {
    if (!el || el === document.body) return "body";
    let node = el;
    const parts = [];
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const dataAttrs = [...(node.attributes || [])].filter(
        (a) => a.name.startsWith("data-") && a.value && a.value.length < 100,
      );
      if (dataAttrs.length) {
        const a = dataAttrs.sort((x, y) => x.name.length - y.name.length)[0];
        parts.unshift(`[${a.name}="${escapeAttr(a.value)}"]`);
        break;
      }
      if (node.id && node.id.length < 80 && !/^\d+$/.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const classes = String(node.className || "")
        .split(/\s+/)
        .filter((c) => c && c.length < 48 && !HASH_CLASS_RE.test(c));
      if (classes.length) {
        parts.unshift(`${node.tagName.toLowerCase()}.${CSS.escape(classes[0])}`);
      } else {
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
          const idx = siblings.indexOf(node) + 1;
          parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${idx})`);
        } else {
          parts.unshift(node.tagName.toLowerCase());
        }
      }
      node = node.parentElement;
      if (parts.length >= 6) break;
    }
    return parts.join(" > ");
  }

  function hasBetButton(root) {
    let found = false;
    walkDeep(root, (el) => {
      if (found || el.nodeType !== 1) return;
      const tag = (el.tagName || "").toLowerCase();
      if (tag !== "button" && el.getAttribute?.("role") !== "button" && tag !== "input") return;
      if (tag === "input" && el.getAttribute?.("type") !== "submit") return;
      if (!isVisible(el)) return;
      const t = (el.innerText || el.textContent || "").toLowerCase();
      if (/베팅하기|배팅하기|배당\s*수락|배팅\s*수락|place\s*bet|베팅|배팅/.test(t)) found = true;
    });
    return found;
  }

  function hasOddsPattern(textBlob) {
    const t = textBlob || "";
    if (/\b\d{1,2}\.\d{2}\b/.test(t)) return true;
    if (/(오버|언더|Over|Under)/i.test(t) && /\(\s*\d+\.\d+\s*\)/.test(t)) return true;
    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.some((l) => /^\d{1,2}\.\d{2}$/.test(l));
  }

  function isSelectionLineText(lineText) {
    const t = String(lineText || "").trim();
    if (!t) return false;
    if (/(오버|언더|Over|Under)/i.test(t) && /\(\s*\d+\.\d+\s*\)/.test(t)) return true;
    if (/(핸디|핸디캡|Handicap)/i.test(t) && /[+-]?\d+\.?\d*/.test(t)) return true;
    if (/^W[12]$/i.test(t)) return true;
    return false;
  }

  function isBetSlipRootCandidate(blob) {
    const t = String(blob || "");
    const hasBetslip = /베팅\s*슬립|베팅슬립/.test(t);
    const hasSingle = /\b싱글\b/.test(t);
    const hasFooter = /당첨\s*예상\s*금액|배당\s*수락|배팅\s*수락/.test(t);
    return hasBetslip && hasSingle && hasFooter;
  }

  function looksLikeMatchListPanel(blob) {
    const t = String(blob || "");
    const oddsHits = (t.match(/\b\d{1,2}\.\d{2}\b/g) || []).length;
    const selectionHits = (t.match(/(오버|언더)\s*\(\s*\d+\.\d+\s*\)/gi) || []).length;
    return oddsHits >= 5 && selectionHits >= 2;
  }

  function parseHeaderSlipCount(root) {
    if (!root) return null;
    const blob = (root.innerText || root.textContent || "").replace(/\r/g, "");
    const m =
      blob.match(/베팅\s*슬립[^\d]*(\d+)[^\n]*\n[^\n]*싱글/i) ||
      blob.match(/베팅슬립[^\d]*(\d+)[^\n]*\n[^\n]*싱글/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  function isStandaloneOddsLine(lineText) {
    const t = String(lineText || "").trim().replace(/,/g, "");
    const m = t.match(/^@?\s*(\d{1,2}\.\d{2})$/);
    if (!m) return false;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) && n >= 1.01 && n <= 100;
  }

  function isMoneyZoneLine(lineText) {
    const t = String(lineText || "").trim();
    if (t === "₩" || t === "원" || /^KRW$/i.test(t)) return true;
    if (/^최대$/.test(t)) return true;
    if (/^\+[\d,]+/.test(t)) return true;
    if (/^[\d,]+\s*₩$/.test(t)) return true;
    if (/당첨\s*예상/.test(t)) return true;
    if (/^베팅하기$/.test(t)) return true;
    return false;
  }

  function isBetSlipTextBlock(rawText) {
    const t = String(rawText || "");
    return (
      /베팅\s*슬립|베팅슬립/.test(t) &&
      /\b싱글\b/.test(t) &&
      (/베팅하기|당첨\s*예상/.test(t))
    );
  }

  function extractLineNumbersFromSelection(selectionText) {
    const nums = new Set();
    const t = String(selectionText || "");
    for (const m of t.matchAll(/\(\s*([+-]?\d+(?:\.\d+)?)\s*\)/g)) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) nums.add(n);
    }
    const hc = t.match(/[+-]\s*(\d+(?:\.\d+)?)/);
    if (hc) nums.add(parseFloat(hc[1]));
    return nums;
  }

  function extractLineFromSelection(selectionText) {
    const nums = extractLineNumbersFromSelection(selectionText);
    if (nums.size) return [...nums][0];
    return null;
  }

  /** 큰 SBCol/사이드바 텍스트에서 베팅슬립~베팅하기 구간만 잘라냄 */
  function extractBetSlipTextBlock(rawText) {
    const t = String(rawText || "").replace(/\r/g, "");
    const start = t.search(/베팅\s*슬립|베팅슬립/);
    if (start < 0) return null;
    const slice = t.slice(start);
    const endMatch = slice.match(/베팅하기|배당\s*수락(?:\s*및\s*배팅)?/);
    if (!endMatch || endMatch.index == null) {
      if (!/당첨\s*예상/.test(slice)) return null;
      return slice.trim();
    }
    const endPos = endMatch.index + endMatch[0].length;
    return slice.slice(0, endPos).trim();
  }

  /** BetSlip anchor text block — 베팅슬립…베팅하기 (경기목록/사이드바 제외) */
  function findBetSlipAnchorTextBlock() {
    let best = null;
    let bestLen = Infinity;

    const consider = (raw) => {
      const block = extractBetSlipTextBlock(raw);
      if (!block || !isBetSlipTextBlock(block)) return;
      if (block.length < bestLen) {
        bestLen = block.length;
        best = block;
      }
    };

    walkElements((el) => {
      if (!isVisible(el)) return;
      const raw = el.innerText || el.textContent || "";
      if (!/베팅\s*슬립|베팅슬립/.test(raw)) return;
      consider(raw);
    });

    if (!best) {
      try {
        consider(bodyInner());
      } catch (_err) {}
    }

    return best;
  }

  /**
   * parseX10SlipText — BetSlip text block 전용 parser (DOM root 없이 사용 가능)
   */
  function parseX10SlipText(rawText) {
    const lines = String(rawText || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let slip_count = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/베팅\s*슬립|베팅슬립/.test(lines[i])) continue;
      const inline = lines[i].match(/베팅\s*슬립\s*(\d+)|베팅슬립\s*(\d+)/i);
      if (inline) {
        slip_count = parseInt(inline[1] || inline[2], 10);
        break;
      }
      if (i + 1 < lines.length && /^\d+$/.test(lines[i + 1])) {
        slip_count = parseInt(lines[i + 1], 10);
        break;
      }
    }

    let selection = "";
    let market = "";
    let line = null;
    let odds = null;
    let event = "";
    let moneyZone = false;

    for (let i = 0; i < lines.length; i += 1) {
      if (isMoneyZoneLine(lines[i])) {
        moneyZone = true;
        continue;
      }
      if (moneyZone) continue;

      if (isSelectionLineText(lines[i])) {
        selection = lines[i];
        line = extractLineFromSelection(selection);
        if (i > 0 && !isSelectionLineText(lines[i - 1]) && !/^(베팅슬립|싱글|Live|\d)/i.test(lines[i - 1])) {
          if (!market) market = lines[i - 1];
        }
        const lineNums = extractLineNumbersFromSelection(selection);
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
          if (isMoneyZoneLine(lines[j])) break;
          if (isSelectionLineText(lines[j])) break;
          if (!isStandaloneOddsLine(lines[j])) continue;
          const val = parseFloat(lines[j]);
          if (lineNums.has(val)) continue;
          odds = val;
          break;
        }
        break;
      }
    }

    if (!event) {
      const skip = /^(베팅슬립|베팅 슬립|싱글|\d+|Live)/i;
      const candidates = lines.filter(
        (l) => l.length > 8 && !skip.test(l) && !isSelectionLineText(l) && !isStandaloneOddsLine(l) && !isMoneyZoneLine(l),
      );
      event = candidates.find((l) => / - /.test(l)) || candidates[0] || "";
    }

    if (!market) {
      const idx = lines.indexOf(selection);
      if (idx > 0) {
        for (let k = idx - 1; k >= 0; k -= 1) {
          if (isMoneyZoneLine(lines[k]) || isSelectionLineText(lines[k])) continue;
          if (/^(Live|베팅|싱글|\d)/i.test(lines[k])) continue;
          market = lines[k];
          break;
        }
      }
    }

    const closed = /betting\s*closed|마감|배팅\s*닫|suspended|일시\s*정지/i.test(String(rawText || ""));
    const effectiveCount = slip_count != null ? slip_count : selection ? 1 : 0;
    const oddsOk = odds != null && odds >= 1.01 && odds <= 100;
    const status = closed ? "closed" : oddsOk && effectiveCount === 1 ? "active" : odds == null ? "odds_missing" : "empty";

    return {
      slip_count: effectiveCount,
      line,
      odds,
      selection,
      market,
      event,
      status,
      ok: effectiveCount === 1 && oddsOk && !closed,
    };
  }

  function slipStatusFromText(rawText, odds) {
    const blob = String(rawText || "");
    if (/betting\s*closed|마감|배팅\s*닫/i.test(blob)) return "closed";
    if (/suspended|일시\s*정지/i.test(blob)) return "suspended";
    if (odds == null) return "odds_missing";
    return "active";
  }

  function cardHasSelectionAndOdds(lines) {
    const selIdx = lines.findIndex((l) => isSelectionLineText(l));
    if (selIdx < 0) return false;
    for (let j = selIdx + 1; j < Math.min(selIdx + 6, lines.length); j += 1) {
      if (isMoneyZoneLine(lines[j])) break;
      if (isSelectionLineText(lines[j])) break;
      if (isStandaloneOddsLine(lines[j])) return true;
    }
    return false;
  }

  /** selection leaf → 가장 작은 slip card container */
  function findCardForSelectionLeaf(leafEl, root) {
    let node = leafEl;
    let best = null;
    for (let depth = 0; depth < 10 && node && isWithinRoot(root, node); depth += 1) {
      const lines = (node.innerText || node.textContent || "")
        .replace(/\r/g, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (cardHasSelectionAndOdds(lines)) {
        if (!best || lines.length <= (best.lines?.length || 9999)) {
          best = { el: node, lines };
        }
      }
      node = composedParent(node);
    }
    return best?.el || leafEl;
  }

  function findSlipCards(root) {
    if (!root) return [];
    const cardSet = new Set();
    const selectionLeaves = [];

    walkDeep(root, (el) => {
      if (el.nodeType !== 1 || !isVisible(el)) return;
      if (!isWithinRoot(root, el)) return;
      const elementChildren = [...(el.children || [])].filter((ch) => ch.nodeType === 1);
      if (elementChildren.length > 0) return;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (isSelectionLineText(t)) selectionLeaves.push(el);
    });

    for (const leaf of selectionLeaves) {
      const card = findCardForSelectionLeaf(leaf, root);
      if (card && isWithinRoot(root, card)) cardSet.add(card);
    }

    const cards = [...cardSet].filter(
      (el, _i, arr) => !arr.some((other) => other !== el && el.contains(other)),
    );
    return cards;
  }

  function findTextAnchorRoot() {
    const candidates = [];
    const betslipAnchors = [];

    walkElements((el) => {
      if (!isVisible(el)) return;
      const blob = el.innerText || el.textContent || "";
      const compact = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (/베팅\s*슬립|베팅슬립/.test(compact) && compact.length <= 120) {
        betslipAnchors.push(el);
      }
      if (!isBetSlipRootCandidate(blob)) return;
      if (looksLikeMatchListPanel(blob)) return;
      candidates.push({ el, len: blob.length });
    });

    for (const anchor of betslipAnchors) {
      let node = anchor;
      for (let depth = 0; depth < 14 && node; depth += 1) {
        const blob = node.innerText || node.textContent || "";
        if (isBetSlipRootCandidate(blob) && !looksLikeMatchListPanel(blob)) {
          candidates.push({ el: node, len: blob.length });
        }
        node = composedParent(node);
      }
    }

    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
      if (seen.has(c.el)) continue;
      seen.add(c.el);
      unique.push(c);
    }
    unique.sort((a, b) => a.len - b.len);

    const pick = unique[0];
    if (!pick) return null;
    return {
      root: pick.el,
      anchor: pick.el,
      selector: buildStableSelector(pick.el),
      method: "tight-betslip-container",
    };
  }

  function countSlipItems(root) {
    if (!root) return { count: 0, items: [], header_count: null, warning: "", effective_count: 0 };
    const cards = findSlipCards(root);
    const headerCount = parseHeaderSlipCount(root);
    let warning = "";
    let effectiveCount = cards.length;

    if (headerCount != null && headerCount !== cards.length) {
      warning = "item-count-mismatch";
      if (headerCount === 1 && cards.length > 1) {
        effectiveCount = 1;
      }
    }

    if (headerCount === 1 && cards.length === 0) {
      effectiveCount = 1;
    }

    return {
      count: effectiveCount,
      effective_count: effectiveCount,
      raw_count: cards.length,
      header_count: headerCount,
      warning,
      items: cards.map((el) => ({
        selector: buildStableSelector(el),
        innerText: (el.innerText || el.textContent || "").slice(0, 400),
        tagName: el.tagName,
      })),
    };
  }

  function outerHtmlChain(el, maxBytes) {
    const chain = [];
    let used = 0;
    let node = el;
    for (let level = 0; level < 5 && node && used < maxBytes; level += 1) {
      const html = (node.outerHTML || "").slice(0, maxBytes - used);
      chain.push({ level, tagName: node.tagName, selector: buildStableSelector(node), outerHTML: html });
      used += html.length;
      node = node.parentElement;
    }
    return chain;
  }

  function captureDomReport() {
    const frame = probeFrame();
    const keywordCandidates = findKeywordCandidates();
    const anchor = findTextAnchorRoot();
    const root = anchor?.root || null;
    const slipItems = countSlipItems(root);
    const chains = keywordCandidates.slice(0, 12).map((c) => ({
      ...c,
      parentChain: [],
    }));
    for (const entry of chains) {
      try {
        const el = document.querySelector(entry.id ? `#${CSS.escape(entry.id)}` : null);
        if (el) entry.parentChain = outerHtmlChain(el, 6000);
      } catch (_err) {}
    }
    if (root) {
      chains.unshift({
        keyword: "ROOT",
        tagName: root.tagName,
        id: root.id || "",
        className: String(root.className || ""),
        innerText: (root.innerText || "").slice(0, 1500),
        selector: buildStableSelector(root),
        parentChain: outerHtmlChain(root, MAX_HTML_BYTES),
      });
    }
    return {
      captured_at: new Date().toISOString(),
      frame,
      anchor,
      slip_count: slipItems.count,
      slip_items: slipItems.items,
      keyword_candidates: keywordCandidates,
      html_chains: chains,
    };
  }

  function buildDebugHtml(report) {
    const esc = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const sections = [];
    sections.push("<!DOCTYPE html><html><head><meta charset='utf-8'><title>x10-betslip-debug</title>");
    sections.push("<style>body{font-family:monospace;background:#111;color:#eee;padding:12px}pre{white-space:pre-wrap;background:#1c1c1c;padding:8px;border:1px solid #333}h2{color:#6cf}</style></head><body>");
    sections.push(`<h1>x10 BetSlip DOM Capture</h1><p>${esc(report.captured_at)}</p>`);
    sections.push(`<h2>Frame</h2><pre>${esc(JSON.stringify(report.frame, null, 2))}</pre>`);
    if (report.anchor) {
      sections.push(`<h2>Text-anchor root</h2><pre>${esc(JSON.stringify(report.anchor, null, 2))}</pre>`);
    }
    sections.push(`<h2>Slip items (count=${report.slip_count})</h2><pre>${esc(JSON.stringify(report.slip_items, null, 2))}</pre>`);
    for (const c of report.keyword_candidates || []) {
      sections.push(`<h2>Keyword: ${esc(c.keyword)} — ${esc(c.tagName)} #${esc(c.id)}</h2>`);
      sections.push(`<pre>${esc(c.innerText)}</pre>`);
      sections.push(`<pre>${esc((c.outerHTML || "").slice(0, 12000))}</pre>`);
    }
    for (const ch of report.html_chains || []) {
      if (!ch.parentChain?.length) continue;
      sections.push(`<h2>Chain: ${esc(ch.keyword)}</h2>`);
      for (const p of ch.parentChain) {
        sections.push(`<h3>level ${p.level} ${esc(p.tagName)} ${esc(p.selector)}</h3>`);
        sections.push(`<pre>${esc(p.outerHTML)}</pre>`);
      }
    }
    sections.push("</body></html>");
    return sections.join("\n");
  }

  function runPipeline(oddsExtractor) {
    const steps = {
      X10_FRAME: "FAIL",
      X10_ROOT: "FAIL",
      X10_TEXT_BLOCK: "FAIL",
      X10_ITEM: "FAIL",
      X10_ODDS: "FAIL",
      X10_STATUS: "FAIL",
      first_failure: "",
    };

    const frame = probeFrame();
    if (!frame.hasBetSlipKeyword) {
      steps.first_failure = "X10_FRAME / no BetSlip keyword in frame";
      return {
        steps,
        frame,
        root: null,
        rootSelector: "",
        fallback_used: false,
        slip_count: 0,
        slip_items: [],
        odds: null,
        odds_candidates: [],
        status: "empty",
        keyword_candidates: findKeywordCandidates(),
      };
    }

    steps.X10_FRAME = "PASS";

    const textBlock = findBetSlipAnchorTextBlock();
    const textParsed = textBlock ? parseX10SlipText(textBlock) : null;
    if (textBlock && textParsed) {
      steps.X10_TEXT_BLOCK = "PASS";
    }

    const anchorResult = findTextAnchorRoot();
    const root = anchorResult?.root || null;
    let fallback_used = false;
    let slipItems = { count: 0, effective_count: 0, items: [], warning: "" };
    let odds = null;
    let odds_candidates = [];
    let odds_source = "";
    let selection_text = "";
    let selection_node = null;
    let odds_text = "";
    let odds_node = null;
    let odds_method = "";
    let line = null;
    let effectiveCount = 0;
    let bodySnippet = textBlock || frame.bodySnippet || "";

    if (root) {
      steps.X10_ROOT = "PASS";
      try {
        console.log("[arb] X10 ROOT FOUND");
      } catch (_logErr) {}
      slipItems = countSlipItems(root);
      effectiveCount = slipItems.effective_count ?? slipItems.count;
      bodySnippet = (root.innerText || "").slice(0, 1500);

      if (typeof oddsExtractor === "function") {
        const extracted = oddsExtractor(root, null);
        odds = extracted?.odds ?? null;
        odds_candidates = extracted?.candidates || [];
        odds_source = extracted?.source || "";
        selection_text = extracted?.selection_text || "";
        selection_node = extracted?.selection_node || null;
        odds_text = extracted?.odds_text || "";
        odds_node = extracted?.odds_node || null;
        odds_method = extracted?.method || odds_source;
        line = extracted?.line ?? null;
      }
    } else {
      steps.X10_ROOT = textBlock ? "ROOT_SELECTOR_FAILED" : "FAIL";
      if (!textBlock) {
        steps.first_failure = "X10_ROOT / no DOM root and no BetSlip text block";
      }
    }

    if (textParsed) {
      if (effectiveCount !== 1 && textParsed.slip_count === 1) {
        effectiveCount = 1;
      } else if (effectiveCount === 0 && textParsed.slip_count === 1) {
        effectiveCount = 1;
      }
      if (odds == null && textParsed.odds != null) {
        odds = textParsed.odds;
        odds_text = String(textParsed.odds);
        odds_source = "text-fallback";
        odds_method = "text-fallback";
        selection_text = textParsed.selection || selection_text;
        line = textParsed.line ?? line;
        fallback_used = !root || steps.X10_ROOT !== "PASS";
      } else if (!root) {
        fallback_used = true;
      }
      if (!selection_text) selection_text = textParsed.selection || "";
      if (line == null) line = textParsed.line;
      bodySnippet = textBlock || bodySnippet;
    }

    if (effectiveCount === 1) {
      steps.X10_ITEM = "PASS";
      try {
        console.log("[arb] X10 ITEM FOUND");
      } catch (_logErr) {}
    } else if (!steps.first_failure) {
      steps.X10_ITEM = "FAIL";
      steps.first_failure = `X10_ITEM / slip_count=${effectiveCount} (expected 1)`;
      if (slipItems.warning) steps.item_warning = slipItems.warning;
    }

    if (odds != null && odds >= 1.01 && odds <= 100) {
      steps.X10_ODDS = "PASS";
      try {
        console.log("[arb] X10 ODDS FOUND");
        console.log(`[arb] ${odds}`);
      } catch (_logErr) {}
    } else if (!steps.first_failure) {
      steps.X10_ODDS = "FAIL";
      steps.first_failure = "X10_ODDS / odds not found in BetSlip";
    }

    const statusBlob = textBlock || bodySnippet;
    const slipStatus = slipStatusFromText(statusBlob, odds);
    let status = slipStatus;
    const canActivate =
      effectiveCount === 1 &&
      odds != null &&
      odds >= 1.01 &&
      odds <= 100 &&
      !["closed", "suspended", "disabled"].includes(slipStatus);

    if (canActivate) {
      steps.X10_ITEM = "PASS";
      steps.X10_ODDS = "PASS";
      steps.X10_STATUS = "ACTIVE";
      status = "active";
      steps.first_failure = slipItems.warning ? `warning:${slipItems.warning}` : steps.X10_ROOT === "ROOT_SELECTOR_FAILED" ? "warning:root-selector-fallback" : "";
    } else if (steps.X10_ODDS === "FAIL") {
      status = "odds_missing";
    }

    return {
      steps,
      frame,
      root,
      root_found: steps.X10_ROOT === "PASS",
      fallback_used,
      rootSelector: anchorResult?.selector || "",
      anchorMethod: anchorResult?.method || (fallback_used ? "text-fallback" : ""),
      text_block: textBlock || "",
      text_parsed: textParsed,
      slip_count: effectiveCount,
      slip_count_raw: slipItems.raw_count ?? effectiveCount,
      header_count: slipItems.header_count ?? textParsed?.slip_count ?? null,
      item_warning: slipItems.warning || "",
      line,
      slip_items: slipItems.items || [],
      odds,
      odds_candidates,
      odds_source,
      selection_text,
      selection_node,
      odds_text,
      odds_node,
      odds_method,
      status,
      keyword_candidates: findKeywordCandidates(),
      bodySnippet,
    };
  }

  global.ArbX10Probe = {
    probeFrame,
    probeAnchorKeywords,
    findKeywordCandidates,
    findTextAnchorRoot,
    findBetSlipAnchorTextBlock,
    extractBetSlipTextBlock,
    findSlipCards,
    parseHeaderSlipCount,
    parseX10SlipText,
    buildStableSelector,
    countSlipItems,
    captureDomReport,
    buildDebugHtml,
    runPipeline,
    walkDeep,
    isSelectionLineText,
    isStandaloneOddsLine,
    isMoneyZoneLine,
    KEYWORDS,
    BETSLIP_ANCHOR_CHECKS,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
