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
    return /슬립이\s*비어|선택한\s*베팅\s*없|empty\s*(bet\s*)?slip|no\s*selection|add\s*selections?/i.test(t);
  }

  const CHIP = new Set([10, 20, 50, 100, 300, 0.2]);

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
      if (!/vs\.?|승자|winner|핸디|handicap/i.test(t)) return;

      const r = el.getBoundingClientRect();
      let score = 0;
      if (r.x > vw * 0.38) score += 180;
      if (/베팅\s*슬립|bet\s*slip/i.test(t)) score += 120;
      if (/\d+\.\d{1,3}\s+0(?:\.\d+)?\s*USDT/i.test(t)) score += 250;
      if (/승자|winner|핸디|handicap/i.test(t)) score += 90;
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

    m = text.match(/(?:승자|winner|맵\s*핸디캡|핸디캡|handicap|map\s*handicap)[^\d]{0,120}(\d+\.\d{1,3})/i);
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
      if (!/승자|winner|핸디|handicap|vs|USDT/i.test(ctx)) return;
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

    if (!teamLabel && eventText) {
      const parts = eventText.split(/\s+vs\.?\s+/i);
      teamLabel = (parts[1] || parts[0] || '').trim();
    }

    if (/핸디|handicap/i.test(text)) marketKind = 'ah';

    return { teamLabel, eventText, marketKind };
  }

  function extractFromSlip(slip) {
    const text = slipText(slip);
    if (!text || isEmptySlip(text)) return null;

    let odds = extractOddsFromText(text);
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
    const slip = findSlipRoot();
    if (!slip) return { ok: false, reason: 'no-slip-root' };
    const r = extractFromSlip(slip);
    if (!r) return { ok: false, reason: 'slip-parse-fail', sample: slipText(slip).slice(0, 240) };
    return r;
  };

  window.__bcProbeDirectSlip = function () {
    const slip = findSlipRoot();
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
