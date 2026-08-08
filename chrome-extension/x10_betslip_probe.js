/**
 * X10 BetSlip DOM probe — text-anchor root discovery, frame diagnostics, DOM capture.
 * No guessed betslip selectors; discovers root from live DOM keywords.
 */
(function initX10Probe(global) {
  const KEYWORDS = ["베팅슬립", "베팅 슬립", "싱글", "조합", "베팅하기", "당첨 예상금액", "배당"];
  const ANCHOR_RE = /베팅\s*슬립|베팅슬립|베팅하기/;
  const HASH_CLASS_RE = /^[a-z]{1,3}[A-Z][a-zA-Z0-9_-]{4,}$|^[a-z]{2,4}-[a-f0-9]{5,}$/i;
  const MAX_HTML_BYTES = 30_000;

  function bodyInner() {
    try {
      return document.body?.innerText || document.body?.textContent || "";
    } catch (_err) {
      return "";
    }
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

  function walkElements(fn) {
    const root = document.body || document.documentElement;
    if (!root) return;
    const stack = [root];
    while (stack.length) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      fn(el);
      for (const ch of el.children || []) stack.push(ch);
    }
  }

  function probeFrame() {
    const bodyText = bodyInner();
    return {
      frame_url: location.href,
      readyState: document.readyState || "unknown",
      bodyLength: bodyText.length,
      hasBetSlipKeyword: KEYWORDS.some((k) => bodyText.includes(k)),
      bodySnippet: bodyText.slice(0, 1200),
    };
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
    let nodes = [];
    try {
      nodes = [...root.querySelectorAll("button, [role='button'], input[type='submit']")];
    } catch (_err) {
      return false;
    }
    for (const b of nodes) {
      if (!isVisible(b)) continue;
      const t = (b.innerText || b.textContent || "").toLowerCase();
      if (/베팅하기|배팅하기|place\s*bet|베팅|배팅/.test(t)) return true;
    }
    return false;
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
    return false;
  }

  function findTextAnchorRoot() {
    const anchors = [];
    walkElements((el) => {
      if (!isVisible(el)) return;
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!ANCHOR_RE.test(t)) return;
      if (t.length > 500) return;
      anchors.push({ el, len: t.length });
    });
    anchors.sort((a, b) => a.len - b.len);

    for (const { el } of anchors) {
      let node = el;
      for (let depth = 0; depth < 14 && node; depth += 1) {
        const blob = node.innerText || "";
        if (hasBetButton(node) && hasOddsPattern(blob)) {
          return {
            root: node,
            anchor: el,
            selector: buildStableSelector(node),
            method: "text-anchor",
          };
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function countSlipItems(root) {
    if (!root) return { count: 0, items: [] };
    const candidates = [];
    walkElements((el) => {
      if (el === root || !root.contains(el)) return;
      if (!isVisible(el)) return;
      const t = (el.innerText || "").trim();
      if (t.length < 4 || t.length > 700) return;
      const hasOdds = hasOddsPattern(t);
      const hasSelection = isSelectionLineText(t);
      if (!hasOdds && !hasSelection) return;
      if (/^(베팅슬립|베팅 슬립|싱글|조합)\s*\d*$/i.test(t.replace(/\s+/g, " "))) return;
      const childWithSignal = [...el.children].filter((c) => {
        const ct = c.innerText || "";
        return hasOddsPattern(ct) || isSelectionLineText(ct);
      }).length;
      if (childWithSignal > 1) return;
      candidates.push(el);
    });
    const minimal = candidates.filter(
      (el, i) => !candidates.some((other, j) => i !== j && el !== other && el.contains(other)),
    );
    return {
      count: minimal.length,
      items: minimal.map((el) => ({
        selector: buildStableSelector(el),
        innerText: (el.innerText || "").slice(0, 400),
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
      X10_ITEM: "FAIL",
      X10_ODDS: "FAIL",
      X10_STATUS: "FAIL",
      first_failure: "",
    };

    const frame = probeFrame();
    if (frame.hasBetSlipKeyword) {
      steps.X10_FRAME = "PASS";
    } else {
      steps.first_failure = "X10_FRAME / no BetSlip keyword in frame";
      return {
        steps,
        frame,
        root: null,
        rootSelector: "",
        slip_count: 0,
        slip_items: [],
        odds: null,
        odds_candidates: [],
        status: "empty",
        keyword_candidates: findKeywordCandidates(),
      };
    }

    const anchorResult = findTextAnchorRoot();
    const bodyHasAnchor = ANCHOR_RE.test(bodyInner());

    if (!anchorResult?.root) {
      steps.X10_ROOT = bodyHasAnchor ? "ROOT_SELECTOR_FAILED" : "FAIL";
      steps.first_failure = bodyHasAnchor
        ? "X10_ROOT / ROOT_SELECTOR_FAILED (body has 베팅슬립/베팅하기)"
        : "X10_ROOT / text-anchor root not found";
      return {
        steps,
        frame,
        root: null,
        rootSelector: "",
        root_reason: steps.first_failure,
        slip_count: 0,
        slip_items: [],
        odds: null,
        odds_candidates: [],
        status: bodyHasAnchor ? "ROOT_SELECTOR_FAILED" : "empty",
        keyword_candidates: findKeywordCandidates(),
        bodySnippet: frame.bodySnippet,
      };
    }

    steps.X10_ROOT = "PASS";
    try {
      console.log("[arb] X10 ROOT FOUND");
    } catch (_logErr) {}
    const root = anchorResult.root;
    const slipItems = countSlipItems(root);
    if (slipItems.count === 1) {
      steps.X10_ITEM = "PASS";
      try {
        console.log("[arb] X10 ITEM FOUND");
      } catch (_logErr) {}
    } else {
      steps.X10_ITEM = "FAIL";
      steps.first_failure = `X10_ITEM / slip_count=${slipItems.count} (expected 1)`;
    }

    let odds = null;
    let odds_candidates = [];
    let odds_source = "";
    let selection_text = "";
    let selection_node = null;
    let odds_text = "";
    let odds_node = null;
    let odds_method = "";
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
    }

    if (odds != null) {
      steps.X10_ODDS = "PASS";
      try {
        console.log("[arb] X10 ODDS FOUND");
        console.log(`[arb] ${odds}`);
      } catch (_logErr) {}
    } else if (!steps.first_failure) {
      steps.X10_ODDS = "FAIL";
      steps.first_failure = "X10_ODDS / odds not found in root";
    }

    let status = "odds_missing";
    if (
      steps.X10_FRAME === "PASS" &&
      steps.X10_ROOT === "PASS" &&
      steps.X10_ITEM === "PASS" &&
      steps.X10_ODDS === "PASS"
    ) {
      steps.X10_STATUS = "ACTIVE";
      status = "active";
    } else if (!steps.first_failure && steps.X10_ODDS === "FAIL") {
      status = "odds_missing";
    }

    return {
      steps,
      frame,
      root,
      rootSelector: anchorResult.selector,
      anchorMethod: anchorResult.method,
      slip_count: slipItems.count,
      slip_items: slipItems.items,
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
      bodySnippet: (root.innerText || "").slice(0, 1500),
    };
  }

  global.ArbX10Probe = {
    probeFrame,
    findKeywordCandidates,
    findTextAnchorRoot,
    buildStableSelector,
    countSlipItems,
    captureDomReport,
    buildDebugHtml,
    runPipeline,
    KEYWORDS,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
