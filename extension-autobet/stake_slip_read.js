// stake_slip_read.js — Stake.com 스포츠 슬립 읽기/금액/배팅 (isolated world)
(function () {
  'use strict';

  const VER = 4;
  const API_FRESH_MS = 2500;
  const ODDS_MAX = 100;

  const SLIP_HINT = /bet\s*slip|betslip|betting\s*slip|single|multi|parlay|place\s*bet|total\s*odds|combined\s*odds|potential\s*payout|est\.?\s*payout|베팅\s*슬립|베팅하기|베팅\s*금액|배팅|총\s*배당|합계\s*배당|예상\s*당첨|당첨\s*금액|배당\s*금|multiplier/i;
  const PLACE_BET = /^(place\s*bet|bet\s*now|confirm(\s*bet)?|베팅하기|배팅하기|베팅|배팅|확인)$/i;

  function pm(t) {
    const n = parseFloat(String(t || '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function parseOdds(t) {
    const s = String(t || '').trim().replace(',', '.');
    const m = s.match(/^(\d{1,3})(?:\.(\d{1,3}))?$/);
    if (m) {
      const n = pm(m[1] + (m[2] != null ? `.${m[2]}` : ''));
      if (n > 1.01 && n < ODDS_MAX) return Math.round(n * 1000) / 1000;
    }
    const n = pm(s);
    if (n > 1.01 && n < ODDS_MAX) return Math.round(n * 1000) / 1000;
    return null;
  }

  function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function openShadow(node) {
    if (!node || node.nodeType !== 1) return null;
    let sr = node.shadowRoot;
    if (!sr && typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot) {
      try { sr = chrome.dom.openOrClosedShadowRoot(node); } catch (_) {}
    }
    return sr || null;
  }

  function walkDeep(root, fn, depth = 0) {
    if (!root || depth > 110) return;
    fn(root, depth);
    const sr = openShadow(root);
    if (sr) walkDeep(sr, fn, depth + 1);
    if (root.childNodes) {
      for (const c of root.childNodes) walkDeep(c, fn, depth + 1);
    }
  }

  function rectOf(node) {
    try { return node.getBoundingClientRect?.() || null; } catch (_) { return null; }
  }

  function scopeTextFromEl(el, maxUp = 14) {
    let p = el;
    for (let i = 0; i < maxUp && p; i++) {
      const t = normText(p.textContent || '');
      if (t.length >= 20 && t.length <= 8000) return t;
      p = p.parentElement;
    }
    return normText(el?.textContent || '');
  }

  function isExcludedInputBlob(blob) {
    return /search|검색|email|password|phone|login|username|coupon\s*code|promo\s*code|chat|message|2fa|verify|nav|menu/i.test(blob);
  }

  function isClickable(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    return tag === 'BUTTON' || tag === 'A' || node.getAttribute?.('role') === 'button';
  }

  function isPlaceBetNode(node) {
    if (!isClickable(node)) return false;
    if (node.disabled || node.getAttribute?.('aria-disabled') === 'true') return false;
    const t = normText(node.textContent || node.getAttribute('aria-label') || '');
    if (!t || t.length > 30) return false;
    return PLACE_BET.test(t) || /^place\s*bet/i.test(t) || /^베팅/i.test(t);
  }

  function findPlaceBetButtons() {
    const btns = [];
    walkDeep(document.body, (node) => {
      if (!isPlaceBetNode(node)) return;
      const r = rectOf(node);
      btns.push({ node, t: normText(node.textContent || ''), r });
    });
    return btns;
  }

  function scoreSlipPanel(node, placeBtn) {
    const text = normText(node.textContent || '');
    if (text.length < 15 || text.length > 12000) return -1;

    const r = rectOf(node);
    const vw = window.innerWidth || 1200;
    const cls = String(node.className || '');

    let score = 0;
    if (SLIP_HINT.test(text)) score += 100;
    if (/bet\s*slip|betslip|베팅\s*슬립/i.test(text)) score += 80;
    if (/place\s*bet|베팅하기|배팅하기/i.test(text)) score += 70;
    if (/total\s*odds|combined\s*odds|총\s*배당|합계\s*배당/i.test(text)) score += 50;
    if (/potential\s*payout|예상\s*당첨|당첨\s*금액/i.test(text)) score += 40;
    if (/bet-slip|betslip|betSlip|coupon|sports-bet|wager/i.test(cls)) score += 60;

    if (r && r.width > 0 && r.height > 80) {
      if (r.x > vw * 0.5) score += 90;
      if (r.x > vw * 0.65) score += 40;
      if (r.width < vw * 0.5) score += 30;
      if (r.height > 120 && r.height < 900) score += 20;
    }

    if (placeBtn?.node && node.contains?.(placeBtn.node)) score += 250;
    if (!/\d+\.\d{2}/.test(text)) return -1;
    score += 15;

    if (location.search.includes('modal=bet')) score += 25;
    return score;
  }

  function findRightColumnPanel() {
    const vw = window.innerWidth || 1200;
    let best = null;
    let bestScore = -1;
    walkDeep(document.body, (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'INPUT' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG') return;
      const r = rectOf(node);
      if (!r || r.width < 160 || r.height < 100) return;
      if (r.x < vw * 0.48) return;
      const text = normText(node.textContent || '');
      if (text.length < 15 || text.length > 6000) return;
      if (!/\d+\.\d{2}/.test(text)) return;
      let score = (r.x / vw) * 80 + Math.min(r.height, 400) / 10;
      if (SLIP_HINT.test(text)) score += 100;
      if (/class.*odds|odds.*svelte/i.test(String(node.className || '') + text)) score += 30;
      if (score > bestScore) { bestScore = score; best = node; }
    });
    return bestScore >= 60 ? best : null;
  }

  function findBottomSlipPanel() {
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth || 1200;
    let best = null;
    let bestScore = -1;
    walkDeep(document.body, (node) => {
      if (node.nodeType !== 1) return;
      const r = rectOf(node);
      if (!r || r.width < vw * 0.35 || r.height < 80) return;
      if (r.top < vh * 0.45) return;
      const text = normText(node.textContent || '');
      if (text.length < 12 || text.length > 8000) return;
      if (!/\d+\.\d{2}/.test(text)) return;
      let score = (r.top / vh) * 60;
      if (SLIP_HINT.test(text)) score += 110;
      if (score > bestScore) { bestScore = score; best = node; }
    });
    return bestScore >= 70 ? best : null;
  }

  function findBetSlipToggle() {
    let hit = null;
    walkDeep(document.body, (node) => {
      if (!isClickable(node) || hit) return;
      const t = normText(node.textContent || node.getAttribute('aria-label') || '');
      if (t.length > 40) return;
      if (/bet\s*slip|betslip|베팅\s*슬립|my\s*bets|내\s*베팅|\d+\s*$/.test(t) && /\d/.test(t)) {
        hit = node;
      }
    });
    return hit;
  }

  async function ensureSlipOpen() {
    const panel = findBetSlipPanel();
    if (panel?.root) return true;
    const toggle = findBetSlipToggle();
    if (toggle) {
      try { toggle.click(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 350));
      return !!findBetSlipPanel();
    }
    return false;
  }

  function findBetSlipPanel() {
    const placeBtns = findPlaceBetButtons();
    const placeBtn = placeBtns.sort((a, b) => (b.r?.x || 0) - (a.r?.x || 0))[0] || null;

    let best = null;
    let bestScore = -1;
    walkDeep(document.body, (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'INPUT' || tag === 'SCRIPT' || tag === 'STYLE') return;
      const s = scoreSlipPanel(node, placeBtn);
      if (s > bestScore) { bestScore = s; best = node; }
    });

    if (best && bestScore >= 80) return { root: best, placeBtn: placeBtn?.node || null };

    if (placeBtn?.node) {
      let p = placeBtn.node.parentElement;
      for (let i = 0; i < 18 && p; i++) {
        const t = normText(p.textContent || '');
        if (t.length > 15 && t.length < 10000 && /\d+\.\d{2}/.test(t)) {
          return { root: p, placeBtn: placeBtn.node };
        }
        p = p.parentElement;
      }
    }

    const rightCol = findRightColumnPanel();
    if (rightCol) return { root: rightCol, placeBtn: placeBtn?.node || null };

    const bottomCol = findBottomSlipPanel();
    if (bottomCol) return { root: bottomCol, placeBtn: placeBtn?.node || null };

    return null;
  }

  function readFieldValue(field) {
    if (!field) return 0;
    const raw = field.value ?? field.textContent ?? field.getAttribute?.('value') ?? '';
    return pm(raw);
  }

  function collectStakeFields(root) {
    const fields = [];
    walkDeep(root, (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      const editable = tag === 'DIV' && (node.isContentEditable || node.getAttribute?.('contenteditable') === 'true');
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !editable) return;

      const type = (node.type || '').toLowerCase();
      if (type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'file') return;

      const blob = normText(`${node.placeholder || ''} ${node.getAttribute('aria-label') || ''} ${node.className || ''} ${node.name || ''} ${node.id || ''}`);
      if (isExcludedInputBlob(blob)) return;
      if (/odds|multiplier|payout|balance|wallet/i.test(blob) && !/stake|베팅|배팅|금액|wager|amount/i.test(blob)) return;
      fields.push(node);
    });
    return fields;
  }

  function findBestStakeInput(slipRoot, placeBtn) {
    const fields = collectStakeFields(slipRoot);
    if (!fields.length) return null;

    const vw = window.innerWidth || 1200;
    let best = null;
    let bestScore = -1;

    for (const field of fields) {
      let score = 0;
      const blob = normText(`${field.placeholder || ''} ${field.getAttribute('aria-label') || ''} ${field.className || ''} ${field.name || ''}`);
      const scope = scopeTextFromEl(field);

      if (/^stake$/i.test(field.placeholder || '') || /^stake$/i.test(field.getAttribute('aria-label') || '')) score += 300;
      if (/베팅\s*금액|배팅\s*금액|금액/i.test(blob)) score += 260;
      if (/\bstake\b|wager|amount/i.test(blob) && !/payout|odds/i.test(blob)) score += 180;
      if (field.getAttribute('inputmode') === 'decimal' || field.inputMode === 'decimal') score += 90;
      if (field.isContentEditable || field.getAttribute?.('contenteditable') === 'true') score += 70;
      if (SLIP_HINT.test(scope)) score += 120;
      if (placeBtn && slipRoot.contains(field)) score += 40;

      const r = rectOf(field);
      if (r && r.width > 30 && r.height > 8) score += 25;
      if (r && r.x > vw * 0.4) score += 80;
      if (field === document.activeElement) score += 30;
      if (r && r.y < 60) score -= 120;

      if (score > bestScore) { bestScore = score; best = field; }
    }
    return bestScore >= 60 ? best : (fields.length === 1 ? fields[0] : null);
  }

  function collectOddsNodes(slipRoot) {
    const hits = [];
    walkDeep(slipRoot, (node) => {
      if (node.nodeType !== 1) return;
      const cls = String(node.className || '');
      const t = normText(node.textContent || '');
      if (t.length > 16) return;

      let o = null;
      if (/\bodds\b/i.test(cls) || /coefficient|decimal|multiplier/i.test(cls)) {
        o = parseOdds(t);
      }
      if (!o && /^\d{1,2}\.\d{2,3}$/.test(t)) o = parseOdds(t);
      if (!o) return;

      let leaf = true;
      for (const c of node.children || []) {
        if (c.nodeType === 1 && normText(c.textContent)) { leaf = false; break; }
      }
      if (!leaf && !/\bodds\b/i.test(cls)) return;

      let score = 20;
      if (/\bodds\b/i.test(cls)) score += 40;
      const row = scopeTextFromEl(node, 8);
      if (SLIP_HINT.test(row)) score += 50;
      if (/total\s*odds|combined\s*odds|총\s*배당|합계\s*배당/i.test(row)) score += 120;
      if (/potential\s*payout|예상\s*당첨|place\s*bet|베팅하기/i.test(row)) score -= 40;
      hits.push({ odds: o, score, cls: cls.slice(0, 40) });
    });
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  function readOddsFromSlipRoot(slipRoot) {
    const text = normText(slipRoot.textContent || '');

    const labelPatterns = [
      /(?:total|combined)\s*odds[^\d]{0,14}(\d{1,2}\.\d{2,3})/i,
      /총\s*배당[^\d]{0,14}(\d{1,2}\.\d{2,3})/i,
      /합계\s*배당[^\d]{0,14}(\d{1,2}\.\d{2,3})/i,
      /배당\s*률[^\d]{0,14}(\d{1,2}\.\d{2,3})/i
    ];
    for (const re of labelPatterns) {
      const m = text.match(re);
      if (m) {
        const o = parseOdds(m[1]);
        if (o) return { odds: o, method: 'total-odds-label' };
      }
    }

    const nodes = collectOddsNodes(slipRoot);
    if (nodes.length) {
      const pick = nodes.find((n) => n.score >= 50) || nodes[0];
      return { odds: pick.odds, method: 'slip-odds-node' };
    }

    const stakeM = text.match(/(?:stake|베팅\s*금액|배팅\s*금액)[^\d]{0,16}(\d+(?:\.\d+)?)/i);
    const payM = text.match(/(?:potential\s*payout|est\.?\s*payout|예상\s*당첨|당첨\s*금액)[^\d]{0,16}(\d+(?:\.\d+)?)/i);
    const stake = stakeM ? pm(stakeM[1]) : 0;
    const payout = payM ? pm(payM[1]) : 0;
    if (stake > 0 && payout > stake) {
      const o = Math.round((payout / stake) * 1000) / 1000;
      if (o > 1.01 && o < 50) return { odds: o, method: 'payout-ratio', stake, payout };
    }

    return null;
  }

  function readTeamFromSlip(slipRoot) {
    const lines = normText(slipRoot.textContent || '').split(/\n|·|•|—/).map(normText).filter(Boolean);
    for (const line of lines) {
      if (line.length < 3 || line.length > 90) continue;
      if (SLIP_HINT.test(line)) continue;
      if (/^\d+\.\d{2,3}$/.test(line)) continue;
      if (/^[+-]?\d+(\.\d+)?$/.test(line)) continue;
      if (/^(dota|csgo|lol|map|game|set|winner)/i.test(line)) continue;
      return line.slice(0, 90);
    }
    return '';
  }

  function readApiSlip(maxAgeMs = API_FRESH_MS) {
    try {
      const api = window.__stakeApiSlip;
      if (!(api?.odds > 1.01) || Date.now() - (api.capturedAt || 0) > maxAgeMs) return null;
      return { ...api, sourceKind: 'stake-api-slip' };
    } catch (_) {
      return null;
    }
  }

  function pickBestSlipOdds(domHit, apiHit) {
    if (domHit?.odds > 1.01 && !(apiHit?.odds > 1.01)) return domHit;
    if (!(domHit?.odds > 1.01) && apiHit?.odds > 1.01) return apiHit;
    if (!(domHit?.odds > 1.01)) return null;
    const domAge = domHit.readAt || 0;
    const apiAge = apiHit?.capturedAt || 0;
    if (apiHit?.odds > 1.01 && apiAge > domAge && Math.abs(apiHit.odds - domHit.odds) >= 0.02) {
      return { ...apiHit, method: 'api-slip-fresh' };
    }
    return domHit;
  }

  function buildSlipFromDom() {
    const panel = findBetSlipPanel();
    if (!panel?.root) return null;

    const { root, placeBtn } = panel;
    const oddsHit = readOddsFromSlipRoot(root);
    if (!(oddsHit?.odds > 1.01)) return null;

    const stakeInput = findBestStakeInput(root, placeBtn);
    const stakeVal = stakeInput ? readFieldValue(stakeInput) : 0;

    return {
      odds: oddsHit.odds,
      stake: stakeVal > 0 ? stakeVal : (oddsHit.stake || null),
      payout: oddsHit.payout || null,
      teamLabel: readTeamFromSlip(root),
      fromPayout: !!(oddsHit.stake > 0 && oddsHit.payout > oddsHit.stake),
      hasInput: !!stakeInput,
      inputCount: collectStakeFields(root).length,
      source: 'stake',
      sourceKind: 'stake-native-slip',
      method: oddsHit.method,
      fromSlip: true,
      readAt: Date.now()
    };
  }

  async function readStakeNativeSlipAsync() {
    await ensureSlipOpen();
    return readStakeNativeSlip();
  }

  function readStakeNativeSlip() {
    const dom = buildSlipFromDom();
    const api = readApiSlip();
    const picked = pickBestSlipOdds(dom, api);
    if (!picked) return null;
    return picked;
  }

  function setNativeValue(el, value) {
    const str = String(value);
    el.focus?.();
    try { el.click?.(); } catch (_) {}
    if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') {
      el.textContent = str;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
      return;
    }
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, str);
    else el.value = str;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function commitStakeInput(inp) {
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    inp.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 160));
  }

  async function setStakeAmount(amount) {
    const rounded = Math.round(amount * 100) / 100;
    const panel = findBetSlipPanel();
    if (!panel?.root) return { ok: false, reason: 'stake-slip-missing' };

    const inp = findBestStakeInput(panel.root, panel.placeBtn);
    if (!inp) return { ok: false, reason: 'stake-input-missing' };

    const tries = [
      () => setNativeValue(inp, String(rounded)),
      () => {
        inp.focus?.();
        try {
          inp.select?.();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, String(rounded));
        } catch (_) {
          setNativeValue(inp, String(rounded));
        }
      }
    ];

    for (const fn of tries) {
      fn();
      await commitStakeInput(inp);
      const accepted = readFieldValue(inp);
      if (accepted > 0 && Math.abs(accepted - rounded) < 0.5) {
        return { ok: true, stake: accepted, method: 'stake-slip-input', target: rounded };
      }
    }
    return { ok: false, reason: 'stake-not-accepted', inputVal: readFieldValue(inp), target: rounded };
  }

  async function placeStakeBet(amount) {
    const fill = await setStakeAmount(amount);
    if (!fill?.ok) return { success: false, reason: fill?.reason || 'stake-fill-fail' };
    const panel = findBetSlipPanel();
    const btn = panel?.placeBtn || findPlaceBetButtons().sort((a, b) => (b.r?.x || 0) - (a.r?.x || 0))[0]?.node;
    if (!btn) return { success: false, reason: 'bet-button-missing' };
    btn.click();
    await new Promise((r) => setTimeout(r, 220));
    return { success: true, method: 'stake-click', btnText: normText(btn.textContent || '') };
  }

  function diagReport() {
    const panel = findBetSlipPanel();
    const placeBtns = findPlaceBetButtons();
    const slip = readStakeNativeSlip();
    const inp = panel?.root ? findBestStakeInput(panel.root, panel.placeBtn) : null;
    const oddsNodes = panel?.root ? collectOddsNodes(panel.root).slice(0, 5) : [];
    return {
      ver: VER,
      slip,
      hasPanel: !!panel?.root,
      panelScore: panel ? normText(panel.root?.textContent).slice(0, 120) : '',
      placeBtnCount: placeBtns.length,
      placeBtnText: placeBtns[0]?.t || '',
      hasStakeInput: !!inp,
      stakeInput: inp ? {
        tag: inp.tagName,
        placeholder: inp.placeholder,
        aria: inp.getAttribute('aria-label'),
        editable: inp.isContentEditable,
        val: readFieldValue(inp)
      } : null,
      oddsNodes,
      inputCount: panel?.root ? collectStakeFields(panel.root).length : 0,
      textLen: panel?.root ? normText(panel.root.textContent).length : 0,
      url: location.href
    };
  }

  window.__stakeReadNativeSlip = readStakeNativeSlip;
  window.__stakeReadNativeSlipAsync = readStakeNativeSlipAsync;
  window.__stakeEnsureSlipOpen = ensureSlipOpen;
  window.__stakeSetStake = setStakeAmount;
  window.__stakePlaceBet = placeStakeBet;
  window.__stakeDiagReport = diagReport;
  window.__stakeSlipReadVer = VER;

  try {
    window.addEventListener('__stakeSlipApiUpdate', () => {
      try { window.dispatchEvent(new CustomEvent('__stakeSlipDomTick')); } catch (_) {}
    });
  } catch (_) {}
})();
