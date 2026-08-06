/**
 * BC.Game BetSlip reader — betslipSelection 컨테이너 내부만 탐색.
 */
(function (options) {
  options = options || {};
  const DEBUG = !!options.debug;
  const CHIP = new Set([10, 20, 50, 100, 300, 0.2]);
  const SUSPENDED_RE = /suspend|suspended|마감|closed|locked|unavailable|정지된|정지됨|베팅\s*마감|betting\s*(is\s*)?closed|일시\s*정지/i;
  const EMPTY_RE = /슬립이\s*비어|슬립\s*비어|선택한\s*베팅\s*없|선택된\s*베팅\s*없|베팅을\s*선택|베팅\s*카트가?\s*비|카트가?\s*비어|empty\s*(bet\s*)?slip|no\s*selection|betslip\s*is\s*empty/i;
  const ODDS_RE = /(?<!\d)(?:1\.\d+|[2-9]\d*(?:\.\d+)?)(?!\d)/;
  const VS_RE = /([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{0,60}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{0,60})/i;

  function openShadow(el) {
    if (!el || el.nodeType !== 1) return null;
    return el.shadowRoot || null;
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

  function normKey(s) {
    return String(s || '').replace(/[^a-z0-9가-힣]/gi, '').toLowerCase();
  }

  function selectorHint(el) {
    if (!el) return '';
    const editor = el.getAttribute?.('data-editor-id');
    if (editor) return `[data-editor-id="${editor}"]`;
    return el.tagName ? el.tagName.toLowerCase() : '';
  }

  function collectIn(scope, selector) {
    const out = [];
    const seen = new Set();
    walk(scope, (node) => {
      if (node.nodeType !== 1 || !node.querySelectorAll) return;
      try {
        for (const el of node.querySelectorAll(selector)) {
          if (!seen.has(el)) { seen.add(el); out.push(el); }
        }
      } catch (_) {}
    }, 0);
    return out;
  }

  function collectDebugTree(block) {
    const nodes = [];
    walk(block, (node) => {
      if (node.nodeType !== 1) return;
      const attrs = {};
      for (const attr of node.attributes || []) {
        if (attr.name.startsWith('data-') || attr.name === 'class' || attr.name === 'id' || attr.name === 'role') {
          attrs[attr.name] = attr.value;
        }
      }
      const entry = {
        tag: node.tagName.toLowerCase(),
        class: node.className || '',
        attrs,
        innerText: text(node).slice(0, 240),
        inputValue: node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' ? String(node.value || '') : ''
      };
      nodes.push(entry);
    }, 0);
    return nodes;
  }

  function findSlipRoot() {
    const selectors = [
      '[data-editor-id="betslip"]',
      '[data-editor-id*="betslip"]',
      '[data-testid*="betslip"]',
      '[class*="betslip-root"]'
    ];
    let best = null, bestScore = -1;
    const vw = window.innerWidth || 1200;
    for (const sel of selectors) {
      for (const el of collectIn(document.documentElement, sel)) {
        if (!visible(el)) continue;
        const t = text(el);
        if (t.length < 8 || t.length > 8000) continue;
        let score = 0;
        if (/베팅\s*슬립|bet\s*slip|betslip/i.test(t)) score += 120;
        if (el.querySelector?.('[data-editor-id*="betslipSelection"]')) score += 250;
        const r = el.getBoundingClientRect();
        if (r.x > vw * 0.35) score += 100;
        if (score > bestScore) { bestScore = score; best = el; }
      }
    }
    return bestScore >= 200 ? best : null;
  }

  function findSelectionBlocks(slip) {
    const blocks = [];
    const seen = new Set();
    for (const el of collectIn(slip, '[data-editor-id="betslipSelection"], [data-editor-id*="betslipSelection"]')) {
      if (!visible(el) || seen.has(el)) continue;
      const editorId = el.getAttribute?.('data-editor-id') || '';
      if (/betslipSelections$/i.test(editorId)) continue;
      const t = text(el);
      if (t.length < 4 || t.length > 900) continue;
      seen.add(el);
      blocks.push(el);
    }
    return blocks;
  }

  function readStake(slip) {
    for (const sel of [
      '[data-editor-id="betslipStakeInput"]',
      '[data-editor-id*="betslipStake"]',
      '[role="spinbutton"]'
    ]) {
      for (const el of collectIn(slip, sel)) {
        if (!visible(el)) continue;
        const inp = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el : el.querySelector?.('input, textarea');
        const target = inp || el;
        const raw = String(target.value || '').replace(/,/g, '').trim();
        const n = parseFloat(raw);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return 0;
  }

  function collectExcludedNumbers(slip, stake) {
    const exclude = new Set();
    if (stake > 0) exclude.add(stake);
    for (const inp of collectIn(slip, 'input, textarea, [role="spinbutton"]')) {
      const raw = String(inp.value || inp.textContent || '').replace(/,/g, '').trim();
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n > 0) exclude.add(n);
    }
    for (const el of collectIn(slip, '[class*="balance"], [class*="Balance"], [class*="payout"], [class*="Payout"], [data-editor-id*="payout"], [data-editor-id*="Payout"]')) {
      const m = text(el).match(ODDS_RE);
      if (m) {
        const n = parseFloat(m[0]);
        if (Number.isFinite(n)) exclude.add(n);
      }
    }
    return exclude;
  }

  function isExcludedOdds(val, exclude) {
    if (!Number.isFinite(val) || val <= 1.01 || val >= 100) return true;
    if (CHIP.has(val)) return true;
    for (const ex of exclude) {
      if (Math.abs(val - ex) < 0.001) return true;
    }
    return false;
  }

  function readDomField(block, patterns) {
    for (const pat of patterns) {
      for (const el of collectIn(block, `[data-editor-id*="${pat}"]`)) {
        const t = text(el);
        if (t) return t;
      }
    }
    return '';
  }

  function extractMarketRaw(textBlob) {
    const patterns = [
      /(승자\s*\([^)]+\))/i,
      /(승자|winner|moneyline|match winner|승패)/i,
      /((?:오버|언더|over|under)\s*[+-]?\d+(?:\.\d+)?)/i,
      /(핸디캡|handicap|spread)/i
    ];
    for (const re of patterns) {
      const m = textBlob.match(re);
      if (m) return m[1].trim();
    }
    return '';
  }

  function normalizeMarket(raw) {
    const blob = String(raw || '').toLowerCase();
    if (/오버|언더|over|under/.test(blob)) return { normalized: 'Over/Under', kind: 'over_under' };
    if (/핸디|handicap|spread/.test(blob)) return { normalized: 'Moneyline', kind: 'handicap' };
    if (/승자|winner|moneyline|승패/.test(blob)) return { normalized: 'Moneyline', kind: 'moneyline' };
    return { normalized: '', kind: 'unknown' };
  }

  function normalizeTeamSpacing(name) {
    return String(name || '').replace(/\s+/g, ' ').trim()
      .replace(/([가-힣])([A-Za-z])/g, '$1 $2')
      .replace(/([A-Za-z])([가-힣])/g, '$1 $2')
      .replace(/\s+/g, ' ').trim();
  }

  function dedupeRepeatedPrefix(text) {
    const words = String(text || '').trim().split(/\s+/);
    if (words.length >= 2 && words.length % 2 === 0) {
      const half = Math.floor(words.length / 2);
      const left = words.slice(0, half).join(' ');
      const right = words.slice(half).join(' ');
      if (normKey(left) === normKey(right)) return left;
    }
    return String(text || '').trim();
  }

  function parseEventTeams(textBlob) {
    const cleaned = String(textBlob || '').replace(/\s+/g, ' ').trim();
    const vsM = cleaned.match(/\s+vs\.?\s+/i);
    if (!vsM) return { event: '', home: '', away: '' };
    const idx = vsM.index || 0;
    const before = dedupeRepeatedPrefix(cleaned.slice(0, idx).trim());
    let after = cleaned.slice(idx + vsM[0].length).trim();
    after = after.replace(/(승자|winner|moneyline|승패|오버|언더|핸디).*/i, '').trim();
    after = after.replace(ODDS_RE, '').trim();
    const home = normalizeTeamSpacing(before);
    const away = normalizeTeamSpacing(after);
    return { event: home && away ? `${home} vs ${away}` : '', home, away };
  }

  function inferSelection(blockText, home) {
    const vsM = blockText.match(/\s+vs\.?\s+/i);
    if (vsM) {
      const before = dedupeRepeatedPrefix(blockText.slice(0, vsM.index).trim());
      if (before) return normalizeTeamSpacing(before);
    }
    return home || '';
  }

  function extractOddsFromBlock(block, exclude) {
    const oddsSelectors = [
      '[data-editor-id="betslipSelectionOdds"]',
      '[data-editor-id*="betslipSelectionOdds"]',
      '[data-editor-id*="betslipOdds"]',
      '[data-editor-id*="selectionOdds"]',
      '[data-editor-id*="coefficient"]',
      '[data-editor-id*="Coefficient"]'
    ];
    for (const sel of oddsSelectors) {
      for (const el of collectIn(block, sel)) {
        if (!visible(el)) continue;
        const raw = (el.textContent || '').trim();
        if (SUSPENDED_RE.test(raw)) continue;
        const m = raw.match(ODDS_RE);
        if (!m) continue;
        const val = parseFloat(m[0]);
        if (!isExcludedOdds(val, exclude)) return val;
      }
    }

    const leaves = [];
    walk(block, (node) => {
      if (node.nodeType !== 1 || !visible(node)) return;
      if (node.children && node.children.length > 0) return;
      if (node.closest?.('input, textarea, [role="spinbutton"]')) return;
      const raw = (node.textContent || '').trim();
      if (!raw || raw.length > 16) return;
      const m = raw.match(ODDS_RE);
      if (!m) return;
      const val = parseFloat(m[0]);
      if (isExcludedOdds(val, exclude)) return;
      leaves.push(val);
    }, 0);
    if (leaves.length) return leaves[leaves.length - 1];
    return null;
  }

  function extractTrailingOdds(textBlob, exclude) {
    const matches = [...textBlob.matchAll(new RegExp(ODDS_RE.source, 'g'))];
    for (let i = matches.length - 1; i >= 0; i--) {
      const val = parseFloat(matches[i][0]);
      if (!isExcludedOdds(val, exclude)) {
        const without = (textBlob.slice(0, matches[i].index) + textBlob.slice(matches[i].index + matches[i][0].length)).trim();
        return { odds: val, text: without };
      }
    }
    return { odds: null, text: textBlob };
  }

  function parseBlock(block, slip) {
    const blockText = text(block);
    const stake = readStake(slip);
    const exclude = collectExcludedNumbers(slip, stake);
    const containerSelector = selectorHint(block);

    let domEvent = readDomField(block, ['eventName', 'EventName', 'event']);
    let domMarket = readDomField(block, ['marketName', 'MarketName', 'market']);
    let domSelection = readDomField(block, ['outcomeName', 'OutcomeName', 'selection', 'Selection']);

    let odds = extractOddsFromBlock(block, exclude);
    let workingText = blockText;
    if (!odds) {
      const trailing = extractTrailingOdds(blockText, exclude);
      odds = trailing.odds;
      workingText = trailing.text;
    }

    const marketRaw = domMarket || extractMarketRaw(workingText);
    let eventPart = workingText;
    if (marketRaw) {
      const idx = eventPart.indexOf(marketRaw);
      if (idx >= 0) eventPart = eventPart.slice(0, idx).trim();
    }

    const teams = parseEventTeams(domEvent || eventPart);
    const marketInfo = normalizeMarket(marketRaw);
    const selection = domSelection || inferSelection(blockText, teams.home);

    const debugNodes = DEBUG ? collectDebugTree(block) : [];

    if (SUSPENDED_RE.test(blockText)) {
      return {
        event: teams.event,
        market: marketRaw,
        market_normalized: marketInfo.normalized,
        selection,
        odds: null,
        status: 'suspended',
        stake: stake || null,
        market_kind: marketInfo.kind,
        container_selector: containerSelector,
        debug_nodes: debugNodes
      };
    }

    return {
      event: teams.event,
      market: marketRaw,
      market_normalized: marketInfo.normalized,
      selection,
      odds,
      status: odds ? 'active' : 'odds_missing',
      stake: stake || null,
      market_kind: marketInfo.kind,
      container_selector: containerSelector,
      debug_nodes: debugNodes
    };
  }

  function readBcBetSlip() {
    const slip = findSlipRoot();
    if (!slip) {
      return { ok: false, empty: true, items: [], reason: 'no-slip-root' };
    }
    if (EMPTY_RE.test(text(slip)) && !findSelectionBlocks(slip).length) {
      return { ok: true, empty: true, items: [], reason: 'empty-slip', container_selector: selectorHint(slip) };
    }

    const blocks = findSelectionBlocks(slip);
    if (!blocks.length) {
      return { ok: false, empty: true, items: [], reason: 'no-selection-block', container_selector: selectorHint(slip) };
    }

    const items = blocks.slice(0, 1).map((block) => parseBlock(block, slip));
    const debug = DEBUG ? blocks.map((b) => ({ selector: selectorHint(b), nodes: collectDebugTree(b) })) : [];

    return {
      ok: true,
      empty: false,
      items,
      source: 'dom',
      container_selector: selectorHint(slip),
      debug
    };
  }

  return readBcBetSlip();
})
