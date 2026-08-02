// bc_slip_read.js — CSP-safe isolated-world BC.Game 슬립 파서
(function () {
  const VER = 4;

  function openShadow(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    if (typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot) {
      try { return chrome.dom.openOrClosedShadowRoot(el); } catch (_) {}
    }
    return null;
  }

  function walkNodes(node, visit, depth) {
    if (!node || depth > 160) return;
    visit(node, depth);
    if (node.nodeType !== 1) return;
    const sr = openShadow(node);
    if (sr) walkNodes(sr, visit, depth + 1);
    for (const c of node.childNodes) walkNodes(c, visit, depth + 1);
  }

  function stripHtml(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function collectAllText() {
    const parts = [];
    walkNodes(document.documentElement, (node) => {
      if (node.nodeType === 3) {
        const t = node.textContent?.trim();
        if (t) parts.push(t);
      }
    }, 0);

    const deep = parts.join(' ');
    const body = document.body?.innerText || '';
    let html = '';
    try { html = stripHtml(document.documentElement.innerHTML); } catch (_) {}

    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const pointText = [];
    for (const [x, y] of [[vw - 40, vh * 0.25], [vw - 80, vh * 0.5], [vw - 60, vh * 0.75], [vw - 120, 120], [vw - 100, vh - 80]]) {
      try {
        for (const el of document.elementsFromPoint(x, y) || []) {
          const t = (el.innerText || el.textContent || '').trim();
          if (t) pointText.push(t);
        }
      } catch (_) {}
    }

    const merged = [deep, body, html, pointText.join(' ')].join(' ');
    return merged.replace(/\s+/g, ' ').normalize('NFKC').trim();
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
    const t = String(raw || '');
    if (/베팅\s*슬립|bet\s*slip|betslip/i.test(t)) return true;
    if (t.includes('당첨') && t.includes('USDT')) return true;
    if (t.includes('베팅하기') && t.includes('USDT')) return true;
    if (/예상\s*당첨/.test(t) && /총\s*베팅|USDT/i.test(t)) return true;
    if (/potential\s*win|to\s*win/i.test(t) && /USDT|stake/i.test(t)) return true;
    return false;
  }

  function collectStakeFields() {
    const fields = [];
    walkNodes(document.documentElement, (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !(tag === 'DIV' && node.isContentEditable)) return;
      const val = String(node.value ?? node.textContent ?? node.getAttribute?.('value') ?? '').trim();
      const blob = `${val} ${node.placeholder || ''} ${node.getAttribute?.('aria-label') || ''} ${node.className || ''}`;
      if (/search|검색|email|password/i.test(blob)) return;
      if (/USDT|usdt|stake|amount|베팅|counter|bet/i.test(blob) || /\d/.test(val)) fields.push(node);
    }, 0);
    return fields;
  }

  function scopeTextFromEl(start) {
    const parts = [];
    let el = start;
    for (let i = 0; i < 20 && el; i++) {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
      const sr = openShadow(el);
      if (sr) {
        const st = (sr.textContent || '').replace(/\s+/g, ' ').trim();
        if (st) parts.push(st);
      }
      el = el.parentElement || el.getRootNode?.()?.host || null;
    }
    return parts.join(' ').normalize('NFKC');
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
      m = text.match(/(?:potential\s*win|to\s*win)[^\d]{0,30}([\d,]+(?:\.\d+)?)/i);
      if (m) payout = pm(m[1]);
    }

    let odds = stake > 0 && payout > stake ? Math.round((payout / stake) * 1000) / 1000 : null;
    if (!odds) {
      const usdtAmounts = [...text.matchAll(/([\d,]+(?:\.\d+)?)\s*USDT/gi)].map((x) => pm(x[1])).filter((n) => n >= 1);
      for (const s of usdtAmounts) {
        for (const p of usdtAmounts) {
          if (p > s && p / s < 20) {
            odds = Math.round((p / s) * 1000) / 1000;
            if (!stake) stake = s;
            if (!payout) payout = p;
            break;
          }
        }
        if (odds) break;
      }
    }
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

    return { odds, stake: stake || null, payout: payout || null, teamLabel, fromPayout: !!(stake > 0 && payout > stake) };
  }

  function readViaBetButton() {
    let hit = null;
    walkNodes(document.documentElement, (node) => {
      if (hit || node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag !== 'BUTTON' && tag !== 'A' && node.getAttribute?.('role') !== 'button') return;
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t !== '베팅하기' && !/^place\s*bet$/i.test(t)) return;
      const parsed = parseSlipText(scopeTextFromEl(node));
      if (parsed) hit = { ...parsed, method: 'bet-btn' };
    }, 0);
    return hit;
  }

  function readViaStakeInputs() {
    for (const field of collectStakeFields()) {
      const parsed = parseSlipText(scopeTextFromEl(field));
      if (parsed) return { ...parsed, method: 'stake-input' };
    }
    return null;
  }

  function readFromStorage() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const v = store.getItem(store.key(i)) || '';
          if (!/bet|slip|stake|odds|selection|betslip|USDT/i.test(v)) continue;
          let stake = 0;
          let payout = 0;
          let odds = null;
          const sm = v.match(/"(?:stake|betAmount|amount)"\s*:\s*([\d.]+)/i);
          if (sm) stake = parseFloat(sm[1]);
          const pm2 = v.match(/"(?:payout|win|toWin|potentialWin)"\s*:\s*([\d.]+)/i);
          if (pm2) payout = parseFloat(pm2[1]);
          const om = v.match(/"(?:odds|price|coefficient)"\s*:\s*([\d.]+)/i);
          if (om) odds = po(om[1]);
          if (!odds && stake > 0 && payout > stake) odds = Math.round((payout / stake) * 1000) / 1000;
          if (odds > 1.01) return { odds, stake: stake || null, payout: payout || null, method: 'storage' };
        }
      } catch (_) {}
    }
    return null;
  }

  function scanWindowGlobals() {
    try {
      for (const key of Object.keys(window)) {
        if (!/bet|slip|sport|stake|odd|wager/i.test(key)) continue;
        let val = window[key];
        if (val == null) continue;
        let s = '';
        try { s = typeof val === 'string' ? val : JSON.stringify(val); } catch (_) { continue; }
        if (s.length > 20000) s = s.slice(0, 20000);
        const parsed = parseSlipText(s) || (() => {
          const om = s.match(/"odds"\s*:\s*([\d.]+)/);
          const sm = s.match(/"stake"\s*:\s*([\d.]+)/);
          const pm2 = s.match(/"payout"\s*:\s*([\d.]+)/);
          if (!om) return null;
          const odds = po(om[1]);
          if (!odds) return null;
          const stake = sm ? parseFloat(sm[1]) : 0;
          const payout = pm2 ? parseFloat(pm2[1]) : 0;
          return { odds, stake: stake || null, payout: payout || null, fromPayout: !!(stake && payout > stake) };
        })();
        if (parsed?.odds > 1.01) return { ...parsed, method: 'window-' + key };
      }
    } catch (_) {}
    return null;
  }

  function walkSameOriginIframes() {
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const doc = iframe.contentDocument;
        if (!doc?.documentElement) continue;
        const t = (doc.body?.innerText || doc.documentElement.innerText || '').replace(/\s+/g, ' ');
        const parsed = parseSlipText(t);
        if (parsed) return { ...parsed, method: 'same-origin-iframe' };
      } catch (_) {}
    }
    return null;
  }

  function markerFlags(raw) {
    const t = String(raw || '');
    return {
      slip: /베팅\s*슬립|betslip/i.test(t),
      win: t.includes('당첨'),
      usdt: t.includes('USDT'),
      betBtn: t.includes('베팅하기')
    };
  }

  function readFromApiCache() {
    try {
      const api = window.__bcApiSlip;
      if (api?.odds > 1.01 && Date.now() - (api.capturedAt || 0) < 180000) {
        return { ...api, method: 'api-cache' };
      }
    } catch (_) {}
    return null;
  }

  function isSelectedEl(el) {
    if (!el) return false;
    if (el.getAttribute('aria-pressed') === 'true') return true;
    if (el.getAttribute('aria-selected') === 'true') return true;
    if (el.getAttribute('data-selected') === 'true') return true;
    if (el.getAttribute('data-state') === 'on' || el.getAttribute('data-state') === 'checked') return true;
    const cls = String(el.className || '');
    if (/selected|active|pressed|highlight|checked|is-active/i.test(cls)) return true;
    try {
      const st = getComputedStyle(el);
      if (parseFloat(st.borderWidth) >= 2) return true;
      const bg = st.backgroundColor || '';
      const m = bg.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) {
        const g = parseInt(m[2], 10);
        const r = parseInt(m[1], 10);
        if (g > 90 && g > r + 20) return true;
      }
    } catch (_) {}
    return false;
  }

  function parseOddsFromButton(node) {
    const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 200) return null;
    for (const el of [node, ...Array.from(node.querySelectorAll?.('[class*="odd"], [class*="Odds"], span, b') || [])]) {
      const t = (el.textContent || '').trim();
      if (/^\d+\.\d{1,3}$/.test(t)) {
        const o = po(t);
        if (o) return o;
      }
    }
    const m = txt.match(/(\d+\.\d{1,3})\s*$/);
    if (m) return po(m[1]);
    const m2 = txt.match(/(\d+\.\d{1,3})/);
    return m2 ? po(m[2] || m2[1]) : null;
  }

  function readSelectedBoardOdds() {
    const candidates = [];
    walkNodes(document.documentElement, (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      const role = node.getAttribute?.('role') || '';
      if (tag !== 'BUTTON' && role !== 'button') return;
      const r = node.getBoundingClientRect?.();
      if (!r || r.width < 8 || r.height < 8) return;
      const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || /login|deposit|menu|베팅하기|예약|cookie|sign/i.test(txt)) return;
      const odds = parseOddsFromButton(node);
      if (!odds) return;
      const selected = isSelectedEl(node);
      if (!selected) return;
      candidates.push({ odds, txt: txt.slice(0, 80), selected: true });
    }, 0);
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.odds - a.odds);
    const sel = candidates[0];
    return {
      odds: sel.odds,
      teamLabel: sel.txt,
      method: 'board-selected',
      sourceKind: 'sports-board-selected'
    };
  }

  function readScriptJsonState() {
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (t.length < 20 || t.length > 2000000) continue;
      if (!/bet|slip|betslip|selection|stake|coefficient|decimal/i.test(t)) continue;
      const parsed = parseSlipText(t) || (() => {
        try {
          const j = JSON.parse(t);
          return extractFromJson(j, 0);
        } catch (_) { return null; }
      })();
      if (parsed?.odds > 1.01) return { ...parsed, method: 'script-json' };
    }
    return null;
  }

  function extractFromJson(obj, depth) {
    if (!obj || depth > 14) return null;
    if (typeof obj === 'string') {
      try { return extractFromJson(JSON.parse(obj), depth + 1); } catch (_) { return null; }
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const h = extractFromJson(item, depth + 1);
        if (h) return h;
      }
      return null;
    }
    if (typeof obj === 'object') {
      const odds = po(obj.odds ?? obj.price ?? obj.coefficient ?? obj.decimalOdds);
      const stake = pm(obj.stake ?? obj.amount ?? obj.betAmount);
      const payout = pm(obj.payout ?? obj.potentialWin ?? obj.toWin);
      if (odds && (stake > 0 || payout > 0)) {
        const o = stake > 0 && payout > stake ? Math.round((payout / stake) * 1000) / 1000 : odds;
        return { odds: o, stake: stake || null, payout: payout || null, fromPayout: payout > stake };
      }
      for (const k of Object.keys(obj)) {
        const h = extractFromJson(obj[k], depth + 1);
        if (h) return h;
      }
    }
    return null;
  }

  function readNativeSlip() {
    const fields = collectStakeFields();
    const strategies = [
      readFromApiCache,
      readViaBetButton,
      readViaStakeInputs,
      readSelectedBoardOdds,
      () => {
        const p = parseSlipText(collectAllText());
        return p ? { ...p, method: 'all-text' } : null;
      },
      readScriptJsonState,
      walkSameOriginIframes,
      readFromStorage,
      scanWindowGlobals
    ];

    for (const fn of strategies) {
      const hit = fn();
      if (hit?.odds > 1.01) {
        const isBoard = hit.sourceKind === 'sports-board-selected' || hit.method === 'board-selected';
        return {
          ok: true,
          source: 'bcgame',
          ...hit,
          outcome: hit.teamLabel || '',
          selectionText: hit.teamLabel || '',
          displayLabel: `${hit.odds.toFixed(3)}${hit.stake > 0 ? ` · ${hit.stake} USDT` : ''}`,
          sourceKind: isBoard ? 'sports-board-selected' : 'bc-native-slip',
          hasInput: fields.length > 0,
          inputCount: fields.length,
          href: location.href
        };
      }
    }

    const raw = collectAllText();
    const flags = markerFlags(raw);
    return {
      ok: false,
      reason: hasSlipMarkers(raw) ? 'parse-fail' : 'no-slip-text',
      inputCount: fields.length,
      textLen: raw.length,
      flags,
      sample: raw.slice(0, 200),
      href: location.href
    };
  }

  window.__bcSlipReadVer = VER;
  window.__bcReadNativeSlip = readNativeSlip;
})();
