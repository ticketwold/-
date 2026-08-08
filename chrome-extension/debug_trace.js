/**
 * Debug-only: per-frame selector scan, body keyword check, DOM snapshot.
 */
(function initDebugTrace(global) {
  const BC_SELECTORS = [
    '[data-editor-id="betslipSelection"]',
    '[data-editor-id*="betslip"]',
    '[id*="betslip" i]',
    '[class*="betslip" i]',
    '[class*="bet-slip" i]',
    '[class*="coupon" i]',
    '[class*="selection" i]',
  ];

  const X10_SELECTORS = [
    '[id*="betslip" i]',
    '[class*="betslip" i]',
    '[class*="bet-slip" i]',
    '[class*="coupon" i]',
    '[class*="ticket" i]',
    '[class*="selection" i]',
    '[class*="betInformation" i]',
  ];

  const BC_KEYWORDS = ["베팅 슬립", "Bet Slip", "배팅", "Bet"];
  const X10_KEYWORDS = ["베팅슬립", "싱글", "조합", "베팅하기", "당첨 예상금액"];

  function scanSelectors(selectors) {
    return selectors.map((sel) => {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch (_err) {
        nodes = [];
      }
      const sample = nodes[0];
      const sampleText = sample
        ? (sample.innerText || sample.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300)
        : "";
      return {
        selector: sel,
        match_count: nodes.length,
        sample_text: sampleText,
        outerHTML: sample ? String(sample.outerHTML || "").slice(0, 320) : "",
      };
    });
  }

  function bodyKeywordCheck(keywords) {
    const body = document.body?.innerText || document.body?.textContent || "";
    const bodyLower = body.toLowerCase();
    const hits = {};
    let any = false;
    for (const kw of keywords) {
      const found = body.includes(kw) || bodyLower.includes(kw.toLowerCase());
      hits[kw] = found;
      if (found) any = true;
    }
    return { keyword_hits: hits, body_has_bet_keywords: any };
  }

  function captureDomSnapshot(site, scans) {
    const best = [...scans].sort((a, b) => b.match_count - a.match_count).find((s) => s.match_count > 0);
    if (!best) return "";
    let root = null;
    try {
      root = document.querySelector(best.selector);
    } catch (_err) {
      return "";
    }
    if (!root) return "";
    const html = root.outerHTML || "";
    if (html.length <= 20480) return html;
    return html.slice(0, 20480);
  }

  function runFrameDiagnostics(site) {
    const selectors = site === "bc" ? BC_SELECTORS : X10_SELECTORS;
    const keywords = site === "bc" ? BC_KEYWORDS : X10_KEYWORDS;
    const scans = scanSelectors(selectors);
    const bodyCheck = bodyKeywordCheck(keywords);
    const betslipSelection = scans.find((s) => s.selector === '[data-editor-id="betslipSelection"]');
    const betslipSelectionCount = betslipSelection?.match_count ?? 0;
    const totalMatches = scans.reduce((sum, row) => sum + row.match_count, 0);
    const domSnapshot = captureDomSnapshot(site, scans);
    const cartBlock = site === "bc" ? "BC CART" : "X10 CART";
    const payload = {
      type: "bridge_debug",
      block: "FRAME SCAN",
      cart_block: cartBlock,
      site,
      frame_url: location.href,
      selector_scans: scans,
      selector_hits: scans,
      body_has_bet_keywords: bodyCheck.body_has_bet_keywords,
      keyword_hits: bodyCheck.keyword_hits,
      betslipSelection_count: betslipSelectionCount,
      total_selector_matches: totalMatches,
      selector_problem: bodyCheck.body_has_bet_keywords && totalMatches === 0,
      dom_snapshot: domSnapshot,
      dom_snapshot_file: site === "bc" ? "debug_bc_slip.html" : "debug_x10_slip.html",
    };
    try {
      console.log(`[${cartBlock}]`, {
        root_found: totalMatches > 0,
        slip_count: totalMatches,
        body_has_bet_keywords: bodyCheck.body_has_bet_keywords,
        selector_problem: payload.selector_problem,
        betslipSelection_count: betslipSelectionCount,
      });
      chrome.runtime.sendMessage(payload);
    } catch (_err) {}
    return payload;
  }

  global.ArbDebugTrace = {
    runFrameDiagnostics,
    scanSelectors,
    bodyKeywordCheck,
    captureDomSnapshot,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
