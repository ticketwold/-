// bc_slip_read.js — CSP-safe isolated-world BC.Game 슬립 파서
(function () {
  const VER = 1;

  function getDeepPageText() {
    const chunks = [];
    const seen = new WeakSet();
    function walk(node, depth) {
      if (!node || depth > 120) return;
      if (node.nodeType === 3) {
        const t = node.textContent?.trim();
        if (t) chunks.push(t);
        return;
      }
      if (node.nodeType !== 1 || seen.has(node)) return;
      seen.add(node);
      let sr = node.shadowRoot;
      if (!sr && typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot) {
        try { sr = chrome.dom.openOrClosedShadowRoot(node); } catch (_) {}
      }
      if (sr) walk(sr, depth + 1);
      for (const c of node.childNodes) walk(c, depth + 1);
    }
    walk(document.documentElement, 0);
    const deep = chunks.join(' ').replace(/\s+/g, ' ').trim();
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return deep.length >= body.length ? deep : body;
  }

  function pm(t) {
    const m = String(t || '').replace(/,/g, '').match(/([\d]+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  function po(t) {
    const n = parseFloat(String(t || '').replace(/,/g, '').trim());
    return Number.isFinite(n) && n > 1.01 && n < 100 ? n : null;
  }

  function readNativeSlip() {
    const raw = getDeepPageText();
    if (!/베팅\s*슬립|bet\s*slip/i.test(raw)) {
      return { ok: false, reason: 'no-slip-text', textLen: raw.length, href: location.href };
    }
    if (!/예상\s*당첨|총\s*베팅|베팅하기/i.test(raw)) {
      return { ok: false, reason: 'no-slip-markers', textLen: raw.length, href: location.href };
    }

    let stake = 0;
    let m = raw.match(/총\s*베팅\s*금액\s*([\d,]+(?:\.\d+)?)/i);
    if (m) stake = pm(m[1]);
    if (!stake) {
      for (const hit of raw.matchAll(/([\d,]+(?:\.\d+)?)\s*USDT/gi)) {
        const v = pm(hit[1]);
        if (v >= 1 && v <= 50000) { stake = v; break; }
      }
    }

    let payout = 0;
    m = raw.match(/예상\s*당첨\s*금액\s*([\d,]+(?:\.\d+)?)/i);
    if (m) payout = pm(m[1]);

    let odds = stake > 0 && payout > stake ? Math.round((payout / stake) * 1000) / 1000 : null;
    if (!odds) {
      const skip = new Set([stake, payout, 10, 20, 50, 100, 300].filter((n) => n > 0));
      const nums = [...raw.matchAll(/\b(\d+\.\d{1,3})\b/g)]
        .map((x) => po(x[1]))
        .filter((n) => n && n < 20 && !skip.has(n));
      if (nums.length) odds = nums[nums.length - 1];
    }

    if (!(odds > 1.01)) {
      return {
        ok: false,
        reason: 'parse-fail',
        stake,
        payout,
        textLen: raw.length,
        sample: raw.slice(0, 160),
        href: location.href
      };
    }

    let teamLabel = '';
    const afterMap = raw.match(/(?:맵\s*[-–]\s*승자|세\s*번째\s*맵|네\s*번째\s*맵|승자|winner)[^\dA-Za-z가-힣]{0,40}([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{2,40})/i);
    if (afterMap) teamLabel = afterMap[1].trim();

    return {
      ok: true,
      source: 'bcgame',
      odds,
      stake: stake || null,
      payout: payout || null,
      teamLabel,
      outcome: teamLabel,
      selectionText: teamLabel,
      displayLabel: `${odds.toFixed(3)}${stake > 0 ? ` · ${stake} USDT` : ''}`,
      sourceKind: 'bc-native-slip',
      fromPayout: !!(stake > 0 && payout > stake),
      hasInput: true,
      textLen: raw.length,
      href: location.href
    };
  }

  window.__bcSlipReadVer = VER;
  window.__bcReadNativeSlip = readNativeSlip;
})();
