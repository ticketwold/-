// stake_slip_read.js — Stake.com 스포츠 슬립 읽기/금액/배팅 (isolated world)
(function () {
  'use strict';

  const VER = 1;

  function pm(t) {
    const n = parseFloat(String(t || '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function parseOdds(t) {
    const n = pm(t);
    if (n <= 1.01 || n >= 500) return null;
    return Math.round(n * 1000) / 1000;
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
    if (!root || depth > 120) return;
    fn(root, depth);
    const sr = openShadow(root);
    if (sr) walkDeep(sr, fn, depth + 1);
    if (root.childNodes) {
      for (const c of root.childNodes) walkDeep(c, fn, depth + 1);
    }
  }

  function collectTexts(root) {
    const out = [];
    walkDeep(root, (node) => {
      if (node.nodeType === 3) {
        const t = normText(node.textContent);
        if (t) out.push(t);
      }
    });
    return out.join(' ');
  }

  function isSlipText(t) {
    return /bet\s*slip|betslip|single\s*bet|multi\s*bet|my\s*bets|place\s*bet|total\s*odds|total\s*stake|potential\s*payout|베팅\s*슬립/i.test(t);
  }

  function findSlipRoots() {
    const roots = [];
    const seen = new Set();
    walkDeep(document.body, (node) => {
      if (node.nodeType !== 1 || seen.has(node)) return;
      const t = normText(node.textContent || '');
      if (t.length < 20 || t.length > 12000) return;
      if (!isSlipText(t)) return;
      if (!/\d+\.\d{2,3}/.test(t)) return;
      seen.add(node);
      roots.push({ node, text: t, score: (t.match(/place\s*bet|total\s*stake|potential\s*payout/gi) || []).length * 40 + t.length });
    });
    roots.sort((a, b) => b.score - a.score);
    return roots.map((r) => r.node);
  }

  function findStakeInputs(scope) {
    const inputs = [];
    walkDeep(scope || document.body, (node) => {
      if (node.nodeType !== 1 || node.tagName !== 'INPUT') return;
      const type = (node.type || '').toLowerCase();
      if (type === 'hidden' || type === 'checkbox' || type === 'radio') return;
      const blob = normText(`${node.placeholder || ''} ${node.getAttribute('aria-label') || ''} ${node.className || ''} ${node.name || ''}`);
      if (/search|email|password|phone/i.test(blob)) return;
      inputs.push(node);
    });
    return inputs;
  }

  function readStakeFromInput(scope) {
    for (const inp of findStakeInputs(scope)) {
      const v = pm(inp.value);
      if (v >= 0.01 && v <= 500000) return v;
    }
    return 0;
  }

  function pickSlipOdds(text, opts = {}) {
    const stake = opts.stake || 0;
    const payout = opts.payout || 0;
    const skip = new Set([stake, payout, 0, 1, 2, 5, 10, 20, 50, 100].filter((n) => n > 0));
    const nums = (text.match(/\b\d{1,3}(?:[.,]\d{2,3})\b/g) || [])
      .map((s) => parseOdds(s.replace(',', '.')))
      .filter((n) => n && !skip.has(n));
    if (!nums.length) return null;
    if (payout > stake && stake > 0) {
      const fromPay = Math.round((payout / stake) * 1000) / 1000;
      if (fromPay > 1.01) return fromPay;
    }
    const sorted = [...nums].sort((a, b) => b - a);
    return sorted.find((n) => n >= 1.01 && n <= 50) || sorted[0];
  }

  function parseSlipText(text) {
    const stakeM = text.match(/(?:total\s*)?stake[^\d]{0,20}([\d,]+(?:\.\d+)?)/i);
    const payM = text.match(/(?:potential\s*)?(?:payout|win|return)[^\d]{0,20}([\d,]+(?:\.\d+)?)/i);
    const stake = stakeM ? pm(stakeM[1]) : 0;
    const payout = payM ? pm(payM[1]) : 0;
    let odds = null;
    const oddsM = text.match(/(?:total\s*)?odds[^\d]{0,16}([\d,]+(?:\.\d+)?)/i);
    if (oddsM) odds = parseOdds(oddsM[1]);
    if (!odds) odds = pickSlipOdds(text, { stake, payout });
    let teamLabel = '';
    const teamM = text.match(/(?:^|\n)([A-Za-z0-9가-힣][^\n]{2,60}?)\s+[\d.]+\s*(?:\n|$)/);
    if (teamM) teamLabel = normText(teamM[1]).slice(0, 80);
    return { odds, stake, payout, teamLabel, fromPayout: stake > 0 && payout > stake };
  }

  function readBoardSelectedOdds() {
    const hits = [];
    walkDeep(document.body, (node) => {
      if (node.nodeType !== 1) return;
      const cls = String(node.className || '');
      if (!/odds|coefficient|price/i.test(cls)) return;
      const t = normText(node.textContent);
      const odds = parseOdds(t);
      if (!odds) return;
      let selected = false;
      let p = node;
      for (let i = 0; i < 8 && p; i++) {
        const c = String(p.className || '');
        const aria = p.getAttribute?.('aria-pressed') || p.getAttribute?.('aria-selected') || '';
        if (/selected|active|pressed|is-active|isSelected/i.test(c + aria)) { selected = true; break; }
        p = p.parentElement;
      }
      if (selected) hits.push({ odds, node });
    });
    hits.sort((a, b) => b.odds - a.odds);
    return hits[0] || null;
  }

  function readStakeNativeSlip() {
    try {
      const api = window.__stakeApiSlip;
      if (api?.odds > 1.01 && Date.now() - (api.capturedAt || 0) < 180000) {
        return {
          ...api,
          source: 'stake',
          sourceKind: 'stake-api',
          method: 'api-cache'
        };
      }
    } catch (_) {}

    const roots = findSlipRoots();
    for (const root of roots.slice(0, 4)) {
      const text = collectTexts(root);
      const parsed = parseSlipText(text);
      if (parsed.odds > 1.01) {
        const stake = readStakeFromInput(root) || parsed.stake;
        return {
          odds: parsed.odds,
          stake: stake || null,
          payout: parsed.payout || null,
          teamLabel: parsed.teamLabel || '',
          fromPayout: parsed.fromPayout,
          hasInput: stake > 0,
          inputCount: findStakeInputs(root).length,
          source: 'stake',
          sourceKind: 'stake-native-slip',
          method: 'slip-root',
          fromSlip: true
        };
      }
    }

    const board = readBoardSelectedOdds();
    if (board?.odds > 1.01) {
      return {
        odds: board.odds,
        source: 'stake',
        sourceKind: 'stake-board-selected',
        method: 'board-selected',
        selected: true
      };
    }

    const bodyText = normText(document.body?.innerText || '').slice(0, 8000);
    if (isSlipText(bodyText)) {
      const parsed = parseSlipText(bodyText);
      if (parsed.odds > 1.01) {
        return {
          ...parsed,
          source: 'stake',
          sourceKind: 'stake-native-slip',
          method: 'body-text'
        };
      }
    }
    return null;
  }

  function findBetButton(scope) {
    const btns = [];
    walkDeep(scope || document.body, (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag !== 'BUTTON' && tag !== 'A' && node.getAttribute?.('role') !== 'button') return;
      const t = normText(node.textContent || node.getAttribute('aria-label') || '');
      if (!/place\s*bet|bet\s*now|confirm\s*bet|베팅|배팅/i.test(t)) return;
      if (node.disabled || node.getAttribute?.('aria-disabled') === 'true') return;
      btns.push({ node, t, score: t.length });
    });
    btns.sort((a, b) => b.score - a.score);
    return btns[0]?.node || null;
  }

  function setNativeValue(inp, value) {
    const proto = Object.getPrototypeOf(inp);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(inp, value);
    else inp.value = value;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function setStakeAmount(amount) {
    const rounded = Math.round(amount * 100) / 100;
    const roots = findSlipRoots();
    const scopes = roots.length ? roots : [document.body];
    for (const scope of scopes) {
      for (const inp of findStakeInputs(scope)) {
        inp.focus();
        setNativeValue(inp, String(rounded));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
        const accepted = pm(inp.value);
        if (accepted > 0 && Math.abs(accepted - rounded) < 0.5) {
          return { ok: true, stake: accepted, method: 'stake-input', target: rounded };
        }
      }
    }
    return { ok: false, reason: 'stake-input-missing' };
  }

  async function placeStakeBet(amount) {
    const fill = await setStakeAmount(amount);
    if (!fill?.ok && !fill?.partial) return { success: false, reason: fill?.reason || 'stake-fill-fail' };
    const btn = findBetButton();
    if (!btn) return { success: false, reason: 'bet-button-missing' };
    btn.click();
    await new Promise((r) => setTimeout(r, 200));
    return { success: true, method: 'stake-click', btnText: normText(btn.textContent || '') };
  }

  function diagReport() {
    const slip = readStakeNativeSlip();
    const roots = findSlipRoots();
    return {
      ver: VER,
      slip,
      rootCount: roots.length,
      inputCount: findStakeInputs(document.body).length,
      hasBetBtn: !!findBetButton(),
      textLen: (document.body?.innerText || '').length,
      url: location.href
    };
  }

  window.__stakeReadNativeSlip = readStakeNativeSlip;
  window.__stakeSetStake = setStakeAmount;
  window.__stakePlaceBet = placeStakeBet;
  window.__stakeDiagReport = diagReport;
  window.__stakeSlipReadVer = VER;
})();
