(function () {
  if (window.__bcDirectSlipLoaded) return;
  window.__bcDirectSlipLoaded = true;

  function openShadow(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return chrome?.dom?.openOrClosedShadowRoot?.(el) || null;
    } catch (_) {
      return null;
    }
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

  function slipText(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function parseOdds(s) {
    const n = parseFloat(String(s || '').replace(/,/g, '').trim());
    return Number.isFinite(n) && n > 1.01 && n < 100 ? n : null;
  }

  function isHistoryPanel(t) {
    return /내\s*베팅|베팅\s*내역|bet\s*history|my\s*bets|settled|bethistory/i.test(t);
  }

  function isEmptySlip(t) {
    return /슬립이\s*비어|슬립\s*비어|선택한\s*베팅\s*없|선택된\s*베팅\s*없|베팅을\s*선택|베팅\s*카트가?\s*비|카트가?\s*비어|베팅금액을\s*입력|베팅\s*옵션을\s*클릭|클릭하신\s*후.*베팅|옵션을\s*클릭하신\s*후|empty\s*(bet\s*)?slip|no\s*selection|add\s*selections?|your\s*betslip\s*is\s*empty|betslip\s*is\s*empty/i.test(t);
  }

  function isEmptySlipPrompt(t) {
    return /베팅금액을\s*입력|베팅\s*옵션을\s*클릭|클릭하신\s*후|옵션을\s*클릭하신\s*후|예약\s*코드\s*입력/i.test(t);
  }

  const SPORT_LABEL = /^(basketball|football|soccer|tennis|baseball|hockey|volleyball|esports|e-?sports|농구|축구|야구|테니스|배구|e스포츠)$/i;
  const MARKET_HINT = /vs\.?|승자|winner|핸디|handicap|오버|언더|over|under|total|양팀|득점|O\/U|맵\s*[-–]|map\s*[-–]/i;

  const CHIP = new Set([10, 20, 50, 100, 300, 0.2]);

  function hasSelectionInSlip(text) {
    if (!text || isEmptySlip(text)) return false;
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (isEmptySlipPrompt(t)) return false;

    // 슬립 배당 + 0 USDT (예: 1.14 0 USDT) — 가장 신뢰
    if (/\d+\.\d{1,3}\s+0(?:\.\d+)?\s*USDT/i.test(t)) return true;

    const hasSlipChrome = /베팅\s*슬립|bet\s*slip|betslip|단일|조합|시스템/i.test(t);
    const hasBetCta = /베팅하기|place\s*(a\s*)?bet|총\s*베팅|total\s*stake/i.test(t);
    if (!hasSlipChrome && !hasBetCta) return false;

    const slipPart = t.split(/총\s*베팅|total\s*stake|베팅하기|place\s*(a\s*)?bet/i)[0] || t;
    if (slipPart.length > 900) return false;

    const selBlocks = slipPart.match(/(?:승자|winner|핸디|handicap|맵\s*핸디|오버|언더|over|under|total|O\/U)[^\n]{0,120}\d+\.\d{1,3}/gi) || [];
    for (const block of selBlocks) {
      const m = block.match(/(\d+\.\d{1,3})\s*$/);
      if (m) {
        const o = parseOdds(m[1]);
        if (o && o >= 1.02 && o <= 50) return true;
      }
    }

    return false;
  }

  function findBetSlipShell() {
    let best = null;
    let bestScore = -1;
    const vw = window.innerWidth || 1200;
    walk(document.documentElement, (el) => {
      if (el.nodeType !== 1 || !visible(el)) return;
      const t = slipText(el);
      if (t.length < 12 || t.length > 4000) return;
      if (isHistoryPanel(t)) return;
      const hasSlipUi = /베팅\s*슬립|bet\s*slip|betslip/i.test(t)
        || (/단일|조합|시스템/.test(t) && /USDT|베팅하기|place\s*bet/i.test(t));
      if (!hasSlipUi) return;
      let score = /베팅\s*슬립|bet\s*slip/i.test(t) ? 120 : 60;
      if (isEmptySlip(t)) score += 300;
      const r = el.getBoundingClientRect();
      if (r.x > vw * 0.38) score += 80;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }, 0);
    return best;
  }

  function clearStaleBcCaches() {
    try { window.__bcApiSlip = null; } catch (_) {}
  }

  function isCartEmptyNow() {
    const shell = findBetSlipShell();
    if (shell) {
      const t = slipText(shell);
      if (isEmptySlip(t) || !hasSelectionInSlip(t)) {
        clearStaleBcCaches();
        return true;
      }
    }
    const slip = findSlipRoot() || findBetSlipShell();
    if (slip) {
      const t = slipText(slip);
      if (!hasSelectionInSlip(t)) {
        clearStaleBcCaches();
        return true;
      }
      return false;
    }
    if (shell) {
      const t = slipText(shell);
      if (/베팅\s*슬립|bet\s*slip/i.test(t) && /USDT|0\s*USDT/i.test(t) && !hasSelectionInSlip(t)) {
        clearStaleBcCaches();
        return true;
      }
    }
    return false;
  }

  function findSlipRoot() {
    let best = null;
    let bestScore = -1;
    const vw = window.innerWidth || 1200;

    walk(document.documentElement, (el) => {
      if (el.nodeType !== 1 || !visible(el)) return;
      const t = slipText(el);
      if (t.length < 25 || t.length > 6000) return;
      if (isHistoryPanel(t) || isEmptySlip(t)) return;

      const hasSlipUi = /베팅\s*슬립|bet\s*slip|betslip/i.test(t)
        || (/단일|조합|시스템/.test(t) && /USDT|베팅하기|place\s*bet/i.test(t));
      if (!hasSlipUi) return;
      const hasOddsPick = /\d+\.\d{1,3}\s+0(?:\.\d+)?\s*USDT/i.test(t);
      if (!MARKET_HINT.test(t) && !hasOddsPick) return;

      const r = el.getBoundingClientRect();
      let score = 0;
      if (r.x > vw * 0.38) score += 180;
      if (/베팅\s*슬립|bet\s*slip/i.test(t)) score += 120;
      if (/\d+\.\d{1,3}\s+0(?:\.\d+)?\s*USDT/i.test(t)) score += 250;
      if (MARKET_HINT.test(t)) score += 90;
      if (/베팅하기|place\s*(a\s*)?bet/i.test(t)) score += 70;
      if (el.querySelector?.('input, [role="spinbutton"], [contenteditable="true"]')) score += 50;
      score += Math.min(t.length / 40, 50);

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }, 0);

    return best;
  }

  function extractOddsFromText(text) {
    let m = text.match(/(\d+\.\d{1,3})\s+0(?:\.\d+)?\s*USDT/i);
    if (m) {
      const o = parseOdds(m[1]);
      if (o) return o;
    }

    m = text.match(/(?:승자|winner|맵\s*핸디캡|핸디캡|handicap|map\s*handicap|오버|언더|over|under|total|O\/U)[^\d]{0,120}(\d+\.\d{1,3})/i);
    if (m) {
      const o = parseOdds(m[1]);
      if (o) return o;
    }

    const block = text.split(/총\s*베팅|베팅하기|place\s*(a\s*)?bet|BC\.?\s*GAME/i)[0] || text;
    const nums = [...block.matchAll(/\b(\d+\.\d{1,3})\b/g)]
      .map((x) => parseOdds(x[1]))
      .filter((o) => o && !CHIP.has(o));

    if (nums.length === 1) return nums[0];
    if (nums.length > 1) {
      const nearUsdt = block.match(/(\d+\.\d{1,3})(?:\s+0)?\s*USDT/i);
      if (nearUsdt) {
        const o = parseOdds(nearUsdt[1]);
        if (o) return o;
      }
      const low = nums.filter((n) => n < 30);
      if (low.length) return low[low.length - 1];
      return nums[0];
    }
    return null;
  }

  function extractOddsFromDom(slip) {
    let found = null;
    walk(slip, (el) => {
      if (found || el.nodeType !== 1 || !visible(el)) return;
      const raw = (el.textContent || '').trim();
      if (!/^\d+\.\d{1,3}$/.test(raw)) return;
      const o = parseOdds(raw);
      if (!o || CHIP.has(o)) return;
      const ctx = slipText(el.parentElement).slice(0, 200);
      if (!MARKET_HINT.test(ctx) && !/USDT/i.test(ctx)) return;
      if (el.closest?.('button') && el.tagName !== 'BUTTON') {
        const btn = el.closest('button');
        if (btn && /^(10|20|50|100|300)$/.test((btn.textContent || '').replace(/\s/g, ''))) return;
      }
      found = o;
    }, 0);
    return found;
  }

  function extractMeta(text) {
    let teamLabel = '';
    let eventText = '';
    let marketKind = 'ml';

    const vs = text.match(/([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{1,50}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{1,50})/i);
    if (vs) eventText = `${vs[1].trim()} vs ${vs[2].trim()}`;

    const lines = text.split(/\s+/);
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines.slice(i, i + 4).join(' ');
      if (/vs\.?/i.test(line) && line.length < 80) continue;
      if (/^[A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{2,40}$/.test(lines[i]) && !/^(단일|조합|시스템|승자|winner|USDT|BC)$/i.test(lines[i])) {
        if (!teamLabel || lines[i].length > teamLabel.length) teamLabel = lines[i];
      }
    }

    const winM = text.match(/(?:승자|winner)[^\dA-Za-z가-힣]{0,40}([A-Za-z0-9가-힣][A-Za-z0-9 .'\-]{2,40})/i);
    if (winM) teamLabel = winM[1].trim();

    if (teamLabel && SPORT_LABEL.test(teamLabel)) teamLabel = '';

    if (!teamLabel && eventText) {
      const parts = eventText.split(/\s+vs\.?\s+/i);
      teamLabel = (parts[1] || parts[0] || '').trim();
    }

    if (/핸디|handicap/i.test(text)) marketKind = 'ah';
    else if (/오버|언더|over|under|total|O\/U|양팀|득점/i.test(text)) marketKind = 'ou';

    return { teamLabel, eventText, marketKind };
  }

  function isSlipSuspended(text) {
    return /suspend|suspended|마감|closed|locked|unavailable|정지된|정지됨|베팅\s*마감|betting\s*(is\s*)?closed|일시\s*정지/i.test(text);
  }

  function extractFromSlip(slip) {
    const text = slipText(slip);
    if (!text || isEmptySlip(text)) return null;
    if (!hasSelectionInSlip(text)) return null;
    if (isSlipSuspended(text)) {
      return { ok: false, suspended: true, reason: 'market-suspended', source: 'bcgame' };
    }

    let odds = null;
    const stakeLine = text.match(/(\d+\.\d{1,3})\s+0(?:\.\d+)?\s*USDT/i);
    if (stakeLine) odds = parseOdds(stakeLine[1]);
    if (!odds) odds = extractOddsFromText(text);
    if (!odds) odds = extractOddsFromDom(slip);
    if (!odds) return null;

    const meta = extractMeta(text);
    return {
      ok: true,
      source: 'bcgame',
      odds,
      teamLabel: meta.teamLabel,
      eventText: meta.eventText,
      selectionText: meta.teamLabel,
      outcome: meta.teamLabel,
      fromSlip: true,
      sourceKind: 'bc-direct-slip',
      marketKind: meta.marketKind,
      method: 'direct-slip-panel'
    };
  }

  window.__bcReadDirectSlip = function () {
    if (isCartEmptyNow()) {
      return { ok: false, empty: true, reason: 'empty-slip' };
    }
    const slip = findSlipRoot() || findBetSlipShell();
    if (!slip) {
      if (isCartEmptyNow()) return { ok: false, empty: true, reason: 'empty-slip' };
      return { ok: false, reason: 'no-slip-root' };
    }
    const r = extractFromSlip(slip);
    if (!r) return { ok: false, reason: 'slip-parse-fail', sample: slipText(slip).slice(0, 240) };
    return r;
  };

  window.__bcProbeCartEmpty = function () {
    const empty = isCartEmptyNow();
    if (empty) clearStaleBcCaches();
    const shell = findBetSlipShell();
    const slip = findSlipRoot() || shell;
    const hasSelection = !empty && !!(slip && hasSelectionInSlip(slipText(slip)));
    return { empty, hasSlipShell: !!shell, hasSelection };
  };

  window.__bcClearSlipCaches = clearStaleBcCaches;

  window.__bcProbeDirectSlip = function () {
    if (isCartEmptyNow()) {
      return { hasSlip: false, odds: 0, team: '', eventText: '', score: 0, cartEmpty: true };
    }
    const slip = findSlipRoot() || findBetSlipShell();
    const r = slip ? extractFromSlip(slip) : null;
    const body = document.body?.innerText || '';
    let score = 0;
    if (slip) score += 600;
    if (r?.odds > 1) score += 800 + r.odds * 5;
    if (/베팅\s*슬립|bet\s*slip/i.test(body)) score += 80;
    if (/USDT/i.test(body)) score += 40;
    return {
      hasSlip: !!slip,
      odds: r?.odds || 0,
      team: r?.teamLabel || '',
      eventText: r?.eventText || '',
      score
    };
  };
})();
