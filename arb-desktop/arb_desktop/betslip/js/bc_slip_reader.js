/**
 * BC.Game BetSlip reader — 배팅카트 컨테이너 내부만 탐색.
 * 페이지 전체 스캔 / 최대 숫자 휴리스틱 금지.
 */
(function () {
  const CHIP = new Set([10, 20, 50, 100, 300, 0.2]);
  const SUSPENDED_RE = /suspend|suspended|마감|closed|locked|unavailable|정지된|정지됨|베팅\s*마감|betting\s*(is\s*)?closed|일시\s*정지/i;
  const EMPTY_RE = /슬립이\s*비어|슬립\s*비어|선택한\s*베팅\s*없|선택된\s*베팅\s*없|베팅을\s*선택|베팅\s*카트가?\s*비|카트가?\s*비어|empty\s*(bet\s*)?slip|no\s*selection|betslip\s*is\s*empty/i;
  const MARKET_HINT = /vs\.?|승자|winner|핸디|handicap|오버|언더|over|under|total|O\/U|맵\s*[-–]|map\s*[-–]/i;

  function openShadow(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    return null;
  }

  function walk(root, fn, depth) {
    if (!root || depth > 72) return;
    fn(root, depth);
    if (root.nodeType === 1) {
      const sr = openShadow(root);
      if (sr) walk(sr, fn, depth + 1);
      for (const ch of root.childNodes) walk(ch, fn, depth + 1);
    } else if (root.nodeType === 11) {
      for (const ch of root.childNodes) walk(ch, fn, depth + 1);
    }
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    } catch (_) {}
    return true;
  }

  function text(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function parseOdds(raw, max = 100) {
    const n = parseFloat(String(raw || '').replace(/,/g, '').trim());
    return Number.isFinite(n) && n > 1.01 && n < max ? n : null;
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
      } catch (_) {}
    }, 0);
    return out;
  }

  function findSlipRoot() {
    const selectors = [
      '[data-editor-id="betslip"]',
      '[data-editor-id*="betslip"]',
      '[data-testid*="betslip"]',
      '[data-testid*="BetSlip"]',
      '[class*="betslip-root"]',
      '[class*="BetslipRoot"]'
    ];
    let best = null;
    let bestScore = -1;
    const vw = window.innerWidth || 1200;

    for (const sel of selectors) {
      for (const el of collectIn(document.documentElement, sel)) {
        if (!visible(el)) continue;
        const t = text(el);
        if (t.length < 8 || t.length > 8000) continue;
        let score = 0;
        if (/베팅\s*슬립|bet\s*slip|betslip/i.test(t)) score += 120;
        if (el.querySelector?.('[data-editor-id*="Selection"], [data-editor-id*="selection"]')) score += 200;
        if (el.querySelector?.('[data-editor-id*="Stake"], input, [role="spinbutton"]')) score += 80;
        const r = el.getBoundingClientRect();
        if (r.x > vw * 0.35) score += 100;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    return bestScore >= 200 ? best : null;
  }

  function isEmptySlip(slip) {
    const t = text(slip);
    return EMPTY_RE.test(t) && !hasSelectionBlocks(slip);
  }

  function hasSelectionBlocks(slip) {
    for (const sel of [
      '[data-editor-id*="betslipSelection"]',
      '[data-editor-id*="betslipOutcome"]',
      '[data-editor-id="betslipSelections"]'
    ]) {
      for (const el of collectIn(slip, sel)) {
        if (!visible(el)) continue;
        const block = text(el);
        if (block.length >= 4 && MARKET_HINT.test(block)) return true;
      }
    }
    return false;
  }

  function findSelectionBlocks(slip) {
    const blocks = [];
    const seen = new Set();
    for (const sel of [
      '[data-editor-id*="betslipSelection"]',
      '[data-editor-id*="betslipOutcome"]',
      '[data-editor-id="betslipSelections"] > *'
    ]) {
      for (const el of collectIn(slip, sel)) {
        if (!visible(el) || seen.has(el)) continue;
        const block = text(el);
        if (block.length < 4 || block.length > 800) continue;
        if (!MARKET_HINT.test(block) && !el.querySelector?.('[data-editor-id*="Odds"], [data-editor-id*="odds"]')) continue;
        seen.add(el);
        blocks.push(el);
      }
    }
    return blocks;
  }

  function isSuspendedBlock(block) {
    return SUSPENDED_RE.test(text(block));
  }

  function isClosedBlock(block) {
    return /closed|마감/i.test(text(block)) && !/live/i.test(text(block));
  }

  function extractEvent(blockText, slipTextFull) {
    const vs = blockText.match(/([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{1,50}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{1,50})/i)
      || slipTextFull.match(/([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{1,50}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{1,50})/i);
    if (vs) return `${vs[1].trim()} vs ${vs[2].trim()}`;
    return '';
  }

  function extractSelection(blockText) {
    const winM = blockText.match(/(?:승자|winner)[^\dA-Za-z가-힣]{0,40}([A-Za-z0-9가-힣][A-Za-z0-9 .'\-]{2,40})/i);
    if (winM) return winM[1].trim();
    const ouM = blockText.match(/((?:오버|언더|over|under)\s*[+-]?\d+(?:\.\d+)?)/i);
    if (ouM) return ouM[1].replace(/\s+/g, ' ').trim();
    const ahM = blockText.match(/([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{1,40})\s*([+-]\d+(?:\.\d+)?)/);
    if (ahM) return `${ahM[1].trim()} ${ahM[2]}`;
    const lines = blockText.split(/\s+/).filter(Boolean);
    for (const line of lines) {
      if (/^(단일|조합|시스템|USDT|BC|승자|winner)$/i.test(line)) continue;
      if (line.length >= 2 && line.length <= 40) return line;
    }
    return '';
  }

  function extractOddsFromBlock(block) {
    const ouLine = (text(block).match(/(?:오버|언더|over|under)\s*([+-]?\d+(?:\.\d+)?)/i) || [])[1];
    const ouLineNum = ouLine ? parseFloat(ouLine) : null;

    const oddsSelectors = [
      '[data-editor-id="betslipSelectionOdds"]',
      '[data-editor-id*="betslipSelectionOdds"]',
      '[data-editor-id*="betslipOdds"]',
      '[data-editor-id*="selectionOdds"]',
      '[data-editor-id*="coefficient"]'
    ];
    for (const sel of oddsSelectors) {
      for (const el of collectIn(block, sel)) {
        if (!visible(el)) continue;
        const raw = (el.textContent || '').trim();
        if (SUSPENDED_RE.test(raw)) continue;
        const o = parseOdds(raw, 100);
        if (o && !CHIP.has(o) && !(ouLineNum != null && Math.abs(o - ouLineNum) < 0.02)) return o;
      }
    }

    for (const el of collectIn(block, 'span, div, b, strong')) {
      if (!visible(el)) continue;
      const raw = (el.textContent || '').trim();
      if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) continue;
      if (SUSPENDED_RE.test(raw)) continue;
      const o = parseOdds(raw, 100);
      if (!o || CHIP.has(o)) continue;
      if (ouLineNum != null && Math.abs(o - ouLineNum) < 0.02) continue;
      const ctx = text(el.parentElement).slice(0, 200);
      if (!MARKET_HINT.test(ctx)) continue;
      return o;
    }
    return null;
  }

  function readStake(slip) {
    const selectors = [
      '[data-editor-id="betslipStakeInput"]',
      '[data-editor-id*="betslipStake"]',
      '[data-editor-id*="StakeInput"]',
      'input[data-editor-id*="stake"]',
      '[role="spinbutton"]'
    ];
    for (const sel of selectors) {
      for (const el of collectIn(slip, sel)) {
        if (!visible(el)) continue;
        const inp = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el : el.querySelector?.('input, textarea');
        const target = inp || el;
        const raw = String(target.value || target.textContent || '').replace(/,/g, '').trim();
        const n = parseFloat(raw);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return 0;
  }

  function parseBlock(block, slip) {
    const blockText = text(block);
    if (isSuspendedBlock(block)) {
      return {
        event: extractEvent(blockText, text(slip)),
        selection: extractSelection(blockText),
        odds: null,
        status: 'suspended',
        stake: readStake(slip) || null
      };
    }
    if (isClosedBlock(block)) {
      return {
        event: extractEvent(blockText, text(slip)),
        selection: extractSelection(blockText),
        odds: null,
        status: 'closed',
        stake: readStake(slip) || null
      };
    }
    const odds = extractOddsFromBlock(block);
    return {
      event: extractEvent(blockText, text(slip)),
      selection: extractSelection(blockText),
      odds: odds,
      status: odds ? 'active' : 'odds_missing',
      stake: readStake(slip) || null
    };
  }

  function readBcBetSlip() {
    const slip = findSlipRoot();
    if (!slip) {
      return { ok: false, empty: true, items: [], reason: 'no-slip-root' };
    }
    if (isEmptySlip(slip)) {
      return { ok: true, empty: true, items: [], reason: 'empty-slip' };
    }

    const blocks = findSelectionBlocks(slip);
    if (!blocks.length) {
      return { ok: false, empty: true, items: [], reason: 'no-selection-block' };
    }

    const items = blocks.slice(0, 1).map((block) => parseBlock(block, slip));
    return {
      ok: true,
      empty: false,
      items,
      source: 'dom',
      reason: ''
    };
  }

  return readBcBetSlip();
})();
