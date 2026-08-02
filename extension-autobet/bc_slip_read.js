// bc_slip_read.js — CSP-safe isolated-world BC.Game 슬립 파서
(function () {
  const VER = 8;

  function openShadow(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    if (typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot) {
      try { return chrome.dom.openOrClosedShadowRoot(el); } catch (_) {}
    }
    return null;
  }

  function walkNodes(node, visit, depth) {
    if (!node || depth > 180) return;
    visit(node, depth);
    if (node.nodeType === 1) {
      const sr = openShadow(node);
      if (sr) walkNodes(sr, visit, depth + 1);
      for (const c of node.childNodes) walkNodes(c, visit, depth + 1);
    } else if (node.nodeType === 11) {
      for (const c of node.childNodes) walkNodes(c, visit, depth + 1);
    }
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
    for (const x of [vw - 15, vw - 50, vw - 100, vw - 180, vw - 260]) {
      for (const y of [vh * 0.15, vh * 0.35, vh * 0.55, vh * 0.75]) {
        try {
          for (const el of document.elementsFromPoint(x, y) || []) {
            const t = (el.innerText || el.textContent || '').trim();
            if (t) pointText.push(t);
          }
        } catch (_) {}
      }
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

  /** 슬립 텍스트에서 단일 배당 추출 — 보드의 12.1 같은 오탐 대신 1.31 같은 실제 슬립 배당 우선 */
  function pickBestSlipOdds(text, opts) {
    const stake = opts?.stake || 0;
    const payout = opts?.payout || 0;
    const maxSingle = opts?.maxSingle ?? 5.5;
    const t = String(text || '');

    const labeled = [
      t.match(/(?:total\s*odds?|combined\s*odds?)\s*[:@=]?\s*(\d+\.\d{2,3})/i),
      t.match(/(?:^|[^\d])@\s*(\d+\.\d{2,3})\b/i),
      t.match(/(?:coefficient|decimal\s*odds?)\s*[:@=]?\s*(\d+\.\d{2,3})/i),
      t.match(/(?:odds?)\s*[:@]\s*(\d+\.\d{2,3})/i)
    ].map((m) => (m ? po(m[1]) : null)).filter(Boolean);
    if (labeled.length) return labeled[0];

    const skip = new Set([stake, payout, 10, 20, 50, 100, 300].filter((n) => n > 0));
    const nums = [...t.matchAll(/\b(\d+\.\d{1,3})\b/g)]
      .map((x) => po(x[1]))
      .filter((n) => n && !skip.has(n) && Math.abs(n - stake) > 0.4);
    if (!nums.length) return null;

    const plausible = nums.filter((n) => n >= 1.01 && n <= maxSingle);
    if (plausible.length) return Math.min(...plausible);

    const sportsRange = nums.filter((n) => n >= 1.01 && n < 20);
    if (sportsRange.length) return Math.min(...sportsRange);

    return nums[nums.length - 1];
  }

  function hasSlipMarkers(raw) {
    const t = String(raw || '');
    if (/베팅\s*슬립|bet\s*slip|betslip/i.test(t)) return true;
    if (/place\s*(a\s*)?bet/i.test(t) && /stake|odds|total|win|USDT/i.test(t)) return true;
    if (/total\s*(stake|odds)|potential\s*win|to\s*win/i.test(t) && /\d+\.\d{1,3}/.test(t)) return true;
    if (t.includes('당첨') && (t.includes('USDT') || /\d/.test(t))) return true;
    if (t.includes('베팅하기') && (t.includes('USDT') || /\d/.test(t))) return true;
    if (/예상\s*당첨/.test(t) && /총\s*베팅|USDT/i.test(t)) return true;
    if (/potential\s*win|to\s*win/i.test(t) && /USDT|stake/i.test(t)) return true;
    if (/bet\s*slip|betslip/i.test(t) && /\d+\.\d{2,3}/.test(t)) return true;
    if (/single\s*bet|combo\s*bet|accumulator|parlay/i.test(t) && /\d+\.\d{2,3}/.test(t)) return true;
    if (/coupon|ticket/i.test(t) && /stake|odds|USDT|place/i.test(t) && /\d+\.\d{2,3}/.test(t)) return true;
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
      m = text.match(/(?:potential\s*win|to\s*win|total\s*win)[^\d]{0,30}([\d,]+(?:\.\d+)?)/i);
      if (m) payout = pm(m[1]);
    }

    let odds = stake > 0 && payout > stake ? Math.round((payout / stake) * 1000) / 1000 : null;
    if (!odds) {
      m = text.match(/(?:total\s*odds?|combined\s*odds?|odds?)\s*[:@]?\s*(\d+\.\d{2,3})/i);
      if (m) odds = po(m[1]);
    }
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
    if (!odds) odds = pickBestSlipOdds(text, { stake, payout });

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
      if (t !== '베팅하기' && !/^place\s*(a\s*)?bet$/i.test(t)) return;
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
    let node = el;
    for (let depth = 0; depth < 8 && node; depth++) {
      if (node.getAttribute?.('aria-pressed') === 'true') return true;
      if (node.getAttribute?.('aria-selected') === 'true') return true;
      if (node.getAttribute?.('data-selected') === 'true') return true;
      if (node.getAttribute?.('data-state') === 'on' || node.getAttribute?.('data-state') === 'checked') return true;
      const cls = String(node.className || '');
      if (/selected|active|pressed|highlight|checked|is-active|is-selected|chosen|picked/i.test(cls)) return true;
      try {
        const st = getComputedStyle(node);
        if (parseFloat(st.borderWidth) >= 2) return true;
        const bg = st.backgroundColor || '';
        const m = bg.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m) {
          const g = parseInt(m[2], 10);
          const r = parseInt(m[1], 10);
          if (g > 90 && g > r + 20) return true;
        }
      } catch (_) {}
      node = node.parentElement || node.getRootNode?.()?.host || null;
    }
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
    return m2 ? po(m2[1]) : null;
  }

  function readNearStakeSlip() {
    const fields = collectStakeFields();
    if (!fields.length) return null;
    for (const field of fields) {
      const stake = pm(field.value ?? field.textContent ?? '');
      let el = field;
      for (let i = 0; i < 28 && el; i++) {
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 12 && t.length <= 3000) {
          const hasCtx = /place\s*(a\s*)?bet|total\s*stake|potential|to\s*win|베팅|bet\s*slip|coupon|single|combo|odds|USDT|당첨|stake/i.test(t);
          if (hasCtx || fields.length === 1) {
            const odds = pickBestSlipOdds(t, { stake });
            if (odds > 1.01) {
              return {
                odds,
                stake: stake || null,
                payout: null,
                teamLabel: '',
                method: 'near-stake',
                sourceKind: 'sports-slip',
                fromPayout: false
              };
            }
          }
        }
        el = el.parentElement || el.getRootNode?.()?.host || null;
      }
    }
    return null;
  }

  function readBetbyOutcomeSlip() {
    let best = null;
    walkNodes(document.documentElement, (node) => {
      if (node.nodeType !== 1) return;
      const cls = String(node.className || '');
      const testId = node.getAttribute?.('data-testid') || '';
      if (!/outcome|selection|coupon|bet-item|betslip|bet-slip|ticket|odd-item|coefficient/i.test(`${cls} ${testId}`)) return;
      const t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 5 || t.length > 700) return;
      const odds = pickBestSlipOdds(t);
      if (!(odds > 1.01)) return;
      let score = 0;
      if (/betslip|bet-slip|coupon/i.test(cls)) score += 80;
      if (node.querySelector?.('input, textarea')) score += 60;
      if (/vs|winner|map|맵|승|team/i.test(t)) score += 40;
      if (score > (best?._score ?? -1)) {
        best = { odds, teamLabel: t.slice(0, 70), method: 'betby-outcome', sourceKind: 'sports-slip', fromPayout: false, _score: score };
      }
    }, 0);
    if (!best) return null;
    delete best._score;
    return best;
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
    candidates.sort((a, b) => a.odds - b.odds);
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

  function readBetbyShadowSlip() {
    let bestPanel = null;
    let bestScore = -1;
    walkNodes(document.documentElement, (node) => {
      if (node.nodeType !== 1) return;
      const t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 12 || t.length > 5000) return;
      const cls = String(node.className || '');
      const slipLike = /simplebar|betslip|bet-slip|coupon|ticket|betby/i.test(cls)
        || /place\s*(a\s*)?bet|total\s*stake|bet\s*slip|betslip|베팅\s*슬립/i.test(t);
      if (!slipLike || !/\d+\.\d{2,3}/.test(t)) return;
      let score = 0;
      if (/simplebar/i.test(cls)) score += 90;
      if (/place\s*(a\s*)?bet|베팅하기/i.test(t)) score += 110;
      if (/total\s*stake|총\s*베팅/i.test(t)) score += 100;
      if (node.querySelector?.('input, textarea')) score += 80;
      if (t.length < 800) score += 40;
      if (score > bestScore) { bestScore = score; bestPanel = node; }
    }, 0);
    if (!bestPanel) return null;
    const parsed = parseSlipText((bestPanel.innerText || bestPanel.textContent || '').replace(/\s+/g, ' '));
    if (!parsed) {
      const odds = pickBestSlipOdds(bestPanel.textContent || '');
      if (!(odds > 1.01)) return null;
      return { odds, teamLabel: '', stake: null, payout: null, method: 'shadow-slip', sourceKind: 'bc-native-slip' };
    }
    return { ...parsed, method: 'shadow-slip', sourceKind: 'bc-native-slip' };
  }

  function collectShadowIframes() {
    const out = [];
    walkNodes(document.documentElement, (node) => {
      if (node.nodeType !== 1 || node.tagName !== 'IFRAME') return;
      const src = node.src || node.getAttribute('src') || '';
      if (src && !/hcaptcha|captcha|tracker/i.test(src)) out.push(src.replace(/^https?:\/\//, '').slice(0, 100));
    }, 0);
    return [...new Set(out)];
  }

  function readNativeSlip() {
    const fields = collectStakeFields();
    const strategies = [
      readFromApiCache,
      readBetbyShadowSlip,
      readNearStakeSlip,
      readBetbyOutcomeSlip,
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

  function diagReport() {
    const raw = collectAllText();
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const fields = collectStakeFields();
    const inputs = fields.slice(0, 5).map((node) => ({
      v: String(node.value ?? node.textContent ?? '').trim().slice(0, 40),
      ph: node.placeholder || '',
      cls: String(node.className || '').slice(0, 60)
    }));

    const selectedOdds = [];
    const allOddsBtns = [];
    walkNodes(document.documentElement, (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag !== 'BUTTON' && node.getAttribute?.('role') !== 'button') return;
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^\d+\.\d{1,3}$/.test(t) && !/베팅하기|vs|MOUZ|Spirit/i.test(t)) return;
      const r = node.getBoundingClientRect?.();
      if (!r || r.width <= 5) return;
      const sel = isSelectedEl(node);
      const item = { t: t.slice(0, 50), sel, x: Math.round(r.x), y: Math.round(r.y) };
      if (/^\d+\.\d/.test(t)) {
        allOddsBtns.push(item);
        if (sel) selectedOdds.push(item);
      }
    }, 0);

    const flags = markerFlags(raw);
    let apiSlip = null;
    try { apiSlip = window.__bcApiSlip || null; } catch (_) {}

    return {
      url: location.href,
      slip: flags.slip,
      win: flags.win,
      usdt: flags.usdt,
      betBtn: flags.betBtn,
      textLen: raw.length,
      bodyLen: body.length,
      inputCount: fields.length,
      inputs,
      selectedOdds,
      allOddsBtns: allOddsBtns.slice(0, 8),
      payout: raw.match(/예상\s*당첨\s*금액\s*([\d,.]+)/)?.[1] || null,
      stake: raw.match(/총\s*베팅\s*금액\s*([\d,.]+)/)?.[1] || inputs[0]?.v || null,
      apiSlip,
      shadowIframes: collectShadowIframes(),
      hasDomApi: !!(typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot),
      sample: raw.slice(0, 300)
    };
  }

  window.__bcSlipReadVer = VER;
  window.__bcReadNativeSlip = readNativeSlip;
  window.__bcDiagReport = diagReport;
})();
