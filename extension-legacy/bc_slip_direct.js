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

  function parseOdds(s, max = 100) {
    const n = parseFloat(String(s || '').replace(/,/g, '').trim());
    return Number.isFinite(n) && n > 1.01 && n < max ? n : null;
  }

  function isOuMarket(text) {
    return /오버|언더|over|under|total|O\/U|합계|득점/i.test(text || '');
  }

  function isLikelyTotalLine(num, beforeText) {
    if (num == null) return false;
    const ctx = String(beforeText || '').slice(-48);
    if (!/오버|언더|over|under|total|O\/U|합계/i.test(ctx)) return false;
    // 오버 37.5 / under 2.5 — 라인 숫자 (배당 아님)
    if (num >= 4.5) return true;
    if (num >= 2 && num <= 4.5 && /\.\d$/.test(String(num))) return true;
    return false;
  }

  function extractOuLine(text) {
    const m = String(text || '').match(/(?:오버|언더|over|under)\s*([+-]?\d+(?:\.\d+)?)/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  function isSameAsOuLine(num, ouLine) {
    return ouLine != null && num != null && Math.abs(num - ouLine) < 0.02;
  }

  function parseOddsLoose(raw, ouLine) {
    const s = String(raw || '').trim();
    let o = parseOdds(s);
    if (!o && /^(?:[2-9]|1[0-5])$/.test(s)) o = parseFloat(s);
    if (!o) return null;
    if (isSameAsOuLine(o, ouLine)) return null;
    if (ouLine != null && o > 15) return null;
    return o;
  }

  function pickBestOddsCandidate(matches, block, isOu) {
    const ouLine = isOu ? extractOuLine(block) : null;
    const candidates = [];
    for (const x of matches) {
      const val = parseOddsLoose(x[1], ouLine) || parseOdds(x[1], isOu ? 15 : 100);
      if (!val || CHIP.has(val)) continue;
      const idx = x.index ?? block.indexOf(x[0]);
      const before = block.slice(Math.max(0, idx - 40), idx);
      if (isLikelyTotalLine(val, before)) continue;
      if (isSameAsOuLine(val, ouLine)) continue;
      if (isOu && val > 15) continue;
      candidates.push({ val, idx });
    }
    if (!candidates.length && isOu) {
      const intMatches = [...block.matchAll(/\b([2-9]|1[0-5])\b/g)];
      for (const x of intMatches) {
        const val = parseFloat(x[1]);
        if (isSameAsOuLine(val, ouLine)) continue;
        candidates.push({ val, idx: x.index ?? 0 });
      }
    }
    if (!candidates.length) return null;
    if (isOu) {
      const typical = candidates.filter((c) => c.val >= 1.01 && c.val <= 15);
      if (typical.length) return typical[typical.length - 1].val;
    }
    const low = candidates.filter((c) => c.val < 30);
    if (low.length) return low[low.length - 1].val;
    return candidates[0].val;
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

    const ou = isOuMarket(text);

    // 승자/핸디만 — 숫자가 배당인 경우가 많음 (OU는 라인과 혼동)
    if (!ou) {
      m = text.match(/(?:승자|winner|맵\s*핸디캡|핸디캡|handicap|map\s*handicap)[^\d]{0,120}(\d+\.\d{1,3})/i);
      if (m) {
        const o = parseOdds(m[1]);
        if (o) return o;
      }
    }

    const block = text.split(/총\s*베팅|베팅하기|place\s*(a\s*)?bet|BC\.?\s*GAME/i)[0] || text;
    const allMatches = [...block.matchAll(/\b(\d+\.\d{1,3})\b/g)];
    const picked = pickBestOddsCandidate(allMatches, block, ou);
    if (picked) return picked;
    return null;
  }

  function extractOddsFromDom(slip) {
    const slipFull = slipText(slip);
    const ou = isOuMarket(slipFull);
    const ouLine = extractOuLine(slipFull);
    const candidates = [];

    const oddsSelectors = [
      '[data-editor-id*="odds"]',
      '[data-editor-id*="Odds"]',
      '[data-editor-id*="coefficient"]',
      '[data-editor-id*="Coefficient"]',
      '[class*="odds"]',
      '[class*="Odds"]',
      '[class*="coeff"]',
      '[class*="Coeff"]'
    ];
    for (const sel of oddsSelectors) {
      for (const el of collectAll(sel, slip)) {
        if (!visible(el)) continue;
        const raw = (el.textContent || '').trim();
        const o = parseOddsLoose(raw, ouLine) || parseOdds(raw, ou ? 15 : 100);
        if (!o || CHIP.has(o)) continue;
        if (isSameAsOuLine(o, ouLine)) continue;
        candidates.push({ o, score: 200 });
      }
    }

    walk(slip, (el) => {
      if (el.nodeType !== 1 || !visible(el)) return;
      const raw = (el.textContent || '').trim();
      if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) return;
      const o = parseOddsLoose(raw, ouLine) || parseOdds(raw, ou ? 15 : 100);
      if (!o || CHIP.has(o)) return;
      const ctx = slipText(el.parentElement).slice(0, 200);
      if (!MARKET_HINT.test(ctx) && !/USDT/i.test(ctx)) return;
      if (el.closest?.('button') && el.tagName !== 'BUTTON') {
        const btn = el.closest('button');
        if (btn && /^(10|20|50|100|300)$/.test((btn.textContent || '').replace(/\s/g, ''))) return;
      }
      const before = ctx.slice(0, Math.max(0, ctx.indexOf(raw)));
      if (isLikelyTotalLine(o, before)) return;
      if (isSameAsOuLine(o, ouLine)) return;
      if (ou && o > 15) return;
      let score = 50;
      const cls = `${el.className || ''} ${el.parentElement?.className || ''}`;
      if (/odds|coeff|price|decimal/i.test(cls)) score += 80;
      if (el.getAttribute?.('data-editor-id')) score += 100;
      candidates.push({ o, score });
    }, 0);

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    if (ou) {
      const typical = candidates.filter((c) => c.o >= 1.01 && c.o <= 15);
      if (typical.length) return typical[0].o;
    }
    return candidates[0].o;
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

    const ouM = text.match(/((?:오버|언더|over|under)\s*[+-]?\d+(?:\.\d+)?)/i);
    if (ouM) teamLabel = ouM[1].replace(/\s+/g, ' ').trim();

    if (teamLabel && SPORT_LABEL.test(teamLabel)) teamLabel = '';

    if (!teamLabel && eventText && !ouM) {
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

    const meta = extractMeta(text);
    const ou = meta.marketKind === 'ou' || isOuMarket(text);
    const ouLine = extractOuLine(text);

    let odds = null;
    const stakeLine = text.match(/(\d+\.\d{1,3})\s+0(?:\.\d+)?\s*USDT/i);
    if (stakeLine) {
      const o = parseOdds(stakeLine[1]);
      if (o && !isSameAsOuLine(o, ouLine)) odds = o;
    }
    if (ou) {
      if (!odds) odds = extractOddsFromDom(slip);
      if (!odds) odds = extractOddsFromText(text);
    } else {
      if (!odds) odds = extractOddsFromText(text);
      if (!odds) odds = extractOddsFromDom(slip);
    }
    if (isSameAsOuLine(odds, ouLine) || (ou && odds > 15)) odds = null;
    if (!odds) return null;

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
      ouLine: ouLine || undefined,
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
