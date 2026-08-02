// bc_slip_read.js — CSP-safe isolated-world BC.Game 슬립 파서
(function () {
  const VER = 2;

  function openShadow(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    if (typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot) {
      try { return chrome.dom.openOrClosedShadowRoot(el); } catch (_) {}
    }
    return null;
  }

  function walkNodes(node, visit, depth) {
    if (!node || depth > 140) return;
    visit(node, depth);
    if (node.nodeType !== 1) return;
    const sr = openShadow(node);
    if (sr) walkNodes(sr, visit, depth + 1);
    for (const c of node.childNodes) walkNodes(c, visit, depth + 1);
  }

  function getDeepPageText() {
    const chunks = [];
    walkNodes(document.documentElement, (node) => {
      if (node.nodeType === 3) {
        const t = node.textContent?.trim();
        if (t) chunks.push(t);
      }
    }, 0);
    const deep = chunks.join(' ').replace(/\s+/g, ' ').trim();
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return (deep.length >= body.length ? deep : body).normalize('NFKC');
  }

  function collectStakeFields() {
    const fields = [];
    walkNodes(document.documentElement, (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !(tag === 'DIV' && node.isContentEditable)) return;
      const val = String(node.value || node.textContent || node.getAttribute?.('value') || '').trim();
      const blob = `${val} ${node.placeholder || ''} ${node.getAttribute?.('aria-label') || ''} ${node.className || ''}`;
      if (/search|검색|email|password/i.test(blob)) return;
      if (/USDT|usdt|stake|amount|베팅|counter|bet/i.test(blob) || /\d/.test(val)) {
        fields.push(node);
      }
    }, 0);
    return fields;
  }

  function scopeTextFromField(field) {
    let parts = [];
    let el = field;
    for (let i = 0; i < 18 && el; i++) {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
      const sr = openShadow(el);
      if (sr) {
        const st = (sr.textContent || '').replace(/\s+/g, ' ').trim();
        if (st) parts.push(st);
      }
      el = el.parentElement || (el.getRootNode?.()?.host || null);
    }
    return parts.join(' ').normalize('NFKC');
  }

  function pm(t) {
    const m = String(t || '').replace(/,/g, '').match(/([\d]+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  function po(t) {
    const n = parseFloat(String(t || '').replace(/,/g, '').trim());
    return Number.isFinite(n) && n > 1.01 && n < 100 ? n : null;
  }

  function hasSlipMarkers(raw) {
    if (/베팅\s*슬립|bet\s*slip|betslip/i.test(raw)) return true;
    if (/예상\s*당첨/.test(raw) && (/총\s*베팅|USDT/i.test(raw))) return true;
    if (/베팅하기|place\s*bet/i.test(raw) && /USDT/i.test(raw)) return true;
    if (/potential\s*win|to\s*win/i.test(raw) && /USDT|stake/i.test(raw)) return true;
    return false;
  }

  function parseSlipText(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!hasSlipMarkers(text)) return null;

    let stake = 0;
    let m = text.match(/총\s*베팅\s*금액\s*([\d,]+(?:\.\d+)?)/i);
    if (m) stake = pm(m[1]);
    if (!stake) {
      for (const hit of text.matchAll(/([\d,]+(?:\.\d+)?)\s*USDT/gi)) {
        const v = pm(hit[1]);
        if (v >= 0.1 && v <= 50000) { stake = v; break; }
      }
    }

    let payout = 0;
    m = text.match(/예상\s*당첨\s*금액\s*([\d,]+(?:\.\d+)?)/i);
    if (m) payout = pm(m[1]);
    if (!payout) {
      m = text.match(/(?:potential\s*win|to\s*win)[^\d]{0,20}([\d,]+(?:\.\d+)?)/i);
      if (m) payout = pm(m[1]);
    }

    let odds = stake > 0 && payout > stake ? Math.round((payout / stake) * 1000) / 1000 : null;
    if (!odds) {
      const skip = new Set([stake, payout, 10, 20, 50, 100, 300].filter((n) => n > 0));
      const nums = [...text.matchAll(/\b(\d+\.\d{1,3})\b/g)]
        .map((x) => po(x[1]))
        .filter((n) => n && n < 20 && !skip.has(n) && Math.abs(n - stake) > 0.4);
      if (nums.length) odds = nums[nums.length - 1];
    }

    if (!(odds > 1.01)) return null;

    let teamLabel = '';
    const afterMap = text.match(/(?:맵\s*[-–]\s*승자|세\s*번째\s*맵|네\s*번째\s*번?\s*맵|승자|winner)[^\dA-Za-z가-힣]{0,40}([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{2,40})/i);
    if (afterMap) teamLabel = afterMap[1].trim();

    return {
      odds,
      stake: stake || null,
      payout: payout || null,
      teamLabel,
      fromPayout: !!(stake > 0 && payout > stake)
    };
  }

  function readViaStakeInputs() {
    const fields = collectStakeFields();
    for (const field of fields) {
      const scope = scopeTextFromField(field);
      if (!hasSlipMarkers(scope) && !/USDT/i.test(scope)) continue;
      const parsed = parseSlipText(scope);
      if (parsed) return { ...parsed, method: 'stake-input' };
    }
    return null;
  }

  function readNativeSlip() {
    const fields = collectStakeFields();
    const viaInput = readViaStakeInputs();
    if (viaInput) {
      return {
        ok: true,
        source: 'bcgame',
        ...viaInput,
        outcome: viaInput.teamLabel,
        selectionText: viaInput.teamLabel,
        displayLabel: `${viaInput.odds.toFixed(3)}${viaInput.stake > 0 ? ` · ${viaInput.stake} USDT` : ''}`,
        sourceKind: 'bc-native-slip',
        hasInput: true,
        inputCount: fields.length,
        href: location.href
      };
    }

    const raw = getDeepPageText();
    const parsed = parseSlipText(raw);
    if (parsed) {
      return {
        ok: true,
        source: 'bcgame',
        ...parsed,
        outcome: parsed.teamLabel,
        selectionText: parsed.teamLabel,
        displayLabel: `${parsed.odds.toFixed(3)}${parsed.stake > 0 ? ` · ${parsed.stake} USDT` : ''}`,
        sourceKind: 'bc-native-slip',
        hasInput: fields.length > 0,
        inputCount: fields.length,
        textLen: raw.length,
        href: location.href
      };
    }

    return {
      ok: false,
      reason: hasSlipMarkers(raw) ? 'parse-fail' : 'no-slip-text',
      inputCount: fields.length,
      textLen: raw.length,
      sample: raw.slice(0, 180),
      href: location.href
    };
  }

  window.__bcSlipReadVer = VER;
  window.__bcReadNativeSlip = readNativeSlip;
})();
