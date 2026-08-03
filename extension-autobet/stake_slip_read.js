// stake_slip_read.js — Stake.com 스포츠 슬립 읽기/금액/배팅 (isolated world)
(function () {
  'use strict';

  const VER = 2;
  let oddsLatch = { odds: 0, team: '', at: 0 };

  function pm(t) {
    const n = parseFloat(String(t || '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function parseOdds(t) {
    const s = String(t || '').trim();
    if (!/^\d{1,2}(?:\.\d{1,3})?$/.test(s.replace(',', '.'))) {
      const m = s.match(/^(\d{1,2}\.\d{2,3})$/);
      if (!m) return null;
    }
    const n = pm(s);
    if (n <= 1.01 || n >= 50) return null;
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
    if (!root || depth > 100) return;
    fn(root, depth);
    const sr = openShadow(root);
    if (sr) walkDeep(sr, fn, depth + 1);
    if (root.childNodes) {
      for (const c of root.childNodes) walkDeep(c, fn, depth + 1);
    }
  }

  function scopeTextFromEl(el, maxUp = 12) {
    let p = el;
    for (let i = 0; i < maxUp && p; i++) {
      const t = normText(p.textContent || '');
      if (t.length >= 30 && t.length <= 6000) return t;
      p = p.parentElement;
    }
    return normText(el?.textContent || '');
  }

  function isExcludedInputBlob(blob) {
    return /search|검색|email|password|phone|login|username|coupon\s*code|promo|chat|message|2fa|verify/i.test(blob);
  }

  function isPlaceBetText(t) {
    return /^place\s*bet$/i.test(t) || /^bet\s*now$/i.test(t) || /^confirm(\s*bet)?$/i.test(t);
  }

  function findPlaceBetButtons() {
    const btns = [];
    walkDeep(document.body, (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag !== 'BUTTON' && tag !== 'A' && node.getAttribute?.('role') !== 'button') return;
      const t = normText(node.textContent || node.getAttribute('aria-label') || '');
      if (!isPlaceBetText(t) && !/^place\s*bet/i.test(t)) return;
      if (node.disabled || node.getAttribute?.('aria-disabled') === 'true') return;
      const r = node.getBoundingClientRect?.();
      btns.push({ node, t, r });
    });
    return btns;
  }

  function scoreSlipPanel(node, placeBtn) {
    const text = normText(node.textContent || '');
    if (text.length < 25 || text.length > 8000) return -1;
    if (!/bet\s*slip|betslip|single|multi|place\s*bet|total\s*odds|potential\s*payout|est\.?\s*payout/i.test(text)) return -1;
    if (!/\d+\.\d{2}/.test(text)) return -1;

    let score = 0;
    if (/bet\s*slip|betslip/i.test(text)) score += 120;
    if (/place\s*bet/i.test(text)) score += 80;
    if (/total\s*odds|combined\s*odds/i.test(text)) score += 60;
    if (/potential\s*payout|est\.?\s*payout|total\s*payout/i.test(text)) score += 40;

    const r = node.getBoundingClientRect?.();
    const vw = window.innerWidth || 1200;
    if (r && r.width > 0) {
      if (r.x > vw * 0.45) score += 100;
      if (r.width < vw * 0.55) score += 40;
    }

    if (placeBtn?.r && r) {
      if (placeBtn.node.closest && node.contains(placeBtn.node)) score += 200;
      const dy = Math.abs((placeBtn.r.top || 0) - (r.top || 0));
      if (dy < 400) score += 50;
    }

    if (location.search.includes('modal=bet')) score += 30;
    return score;
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
      if (s > bestScore) {
        bestScore = s;
        best = node;
      }
    });

    if (best && bestScore >= 120) return { root: best, placeBtn: placeBtn?.node || null };

    if (placeBtn?.node) {
      let p = placeBtn.node.parentElement;
      for (let i = 0; i < 15 && p; i++) {
        const t = normText(p.textContent || '');
        if (t.length > 30 && t.length < 8000 && /\d+\.\d{2}/.test(t)) {
          return { root: p, placeBtn: placeBtn.node };
        }
        p = p.parentElement;
      }
    }
    return null;
  }

  function collectInputsIn(root) {
    const inputs = [];
    walkDeep(root, (node) => {
      if (node.nodeType !== 1 || node.tagName !== 'INPUT') return;
      const type = (node.type || '').toLowerCase();
      if (type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'file') return;
      const blob = normText(`${node.placeholder || ''} ${node.getAttribute('aria-label') || ''} ${node.className || ''} ${node.name || ''} ${node.id || ''}`);
      if (isExcludedInputBlob(blob)) return;
      inputs.push(node);
    });
    return inputs;
  }

  function findBestStakeInput(slipRoot, placeBtn) {
    const fields = collectInputsIn(slipRoot);
    if (!fields.length) return null;

    const vw = window.innerWidth || 1200;
    let best = null;
    let bestScore = -1;

    for (const field of fields) {
      let score = 0;
      const blob = normText(`${field.placeholder || ''} ${field.getAttribute('aria-label') || ''} ${field.className || ''} ${field.name || ''}`);
      const scope = scopeTextFromEl(field);

      if (/^stake$/i.test(field.placeholder || '') || /^stake$/i.test(field.getAttribute('aria-label') || '')) score += 300;
      if (/\bstake\b/i.test(blob) && !/payout|odds|search/i.test(blob)) score += 180;
      if (field.getAttribute('inputmode') === 'decimal' || field.inputMode === 'decimal') score += 80;
      if (field.type === 'number' || field.type === 'text') score += 20;

      if (/bet\s*slip|betslip|place\s*bet|total\s*stake|potential\s*payout/i.test(scope)) score += 150;
      if (placeBtn && slipRoot.contains(field) && placeBtn.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_PRECEDING) score += 40;

      const r = field.getBoundingClientRect?.();
      if (r && r.width > 40 && r.height > 10) score += 30;
      if (r && r.x > vw * 0.4) score += 90;
      if (field === document.activeElement) score += 25;

      if (/odds|multiplier|payout|balance|wallet|deposit|withdraw/i.test(blob)) score -= 200;
      if (r && r.y < 80) score -= 150;

      if (score > bestScore) {
        bestScore = score;
        best = field;
      }
    }
    return bestScore >= 80 ? best : null;
  }

  function readOddsFromSlipRoot(slipRoot) {
    const text = normText(slipRoot.textContent || '');

    const totalM = text.match(/(?:total|combined)\s*odds[^\d]{0,12}(\d{1,2}\.\d{2,3})/i);
    if (totalM) {
      const o = parseOdds(totalM[1]);
      if (o) return { odds: o, method: 'total-odds-label' };
    }

    const selectionOdds = [];
    walkDeep(slipRoot, (node) => {
      if (node.nodeType !== 1) return;
      const cls = String(node.className || '');
      if (!/\bodds\b/i.test(cls) && !/coefficient|decimal/i.test(cls)) return;
      const t = normText(node.textContent || '');
      if (t.length > 12) return;
      const o = parseOdds(t);
      if (!o) return;
      let leaf = true;
      for (const c of node.children || []) {
        if (c.nodeType === 1 && normText(c.textContent)) { leaf = false; break; }
      }
      if (!leaf) return;
      let score = 10;
      if (/\bodds\b/i.test(cls)) score += 30;
      const row = scopeTextFromEl(node, 6);
      if (/bet\s*slip|single|multi|selection/i.test(row)) score += 40;
      if (/place\s*bet/i.test(row)) score += 20;
      selectionOdds.push({ odds: o, score });
    });

    if (selectionOdds.length) {
      selectionOdds.sort((a, b) => b.score - a.score);
      const singles = selectionOdds.filter((x) => x.score >= 30);
      const pick = (singles.length ? singles : selectionOdds)[0];
      if (pick) return { odds: pick.odds, method: 'slip-odds-node' };
    }

    const stakeM = text.match(/(?:^|\s)stake[^\d]{0,16}(\d+(?:\.\d+)?)/i);
    const payM = text.match(/(?:potential|est\.?)\s*payout[^\d]{0,16}(\d+(?:\.\d+)?)/i);
    const stake = stakeM ? pm(stakeM[1]) : 0;
    const payout = payM ? pm(payM[1]) : 0;
    if (stake > 0 && payout > stake) {
      const o = Math.round((payout / stake) * 1000) / 1000;
      if (o > 1.01 && o < 50) return { odds: o, method: 'payout-ratio', stake, payout };
    }

    return null;
  }

  function readTeamFromSlip(slipRoot) {
    const lines = normText(slipRoot.textContent || '').split(/\n|·|•/).map(normText).filter(Boolean);
    for (const line of lines) {
      if (line.length < 3 || line.length > 80) continue;
      if (/bet\s*slip|place\s*bet|total\s*odds|stake|payout|single|multi/i.test(line)) continue;
      if (/^\d+\.\d{2,3}$/.test(line)) continue;
      if (/^[+-]?\d+(\.\d+)?$/.test(line)) continue;
      return line.slice(0, 80);
    }
    return '';
  }

  function readApiSlip() {
    try {
      const api = window.__stakeApiSlip;
      if (!(api?.odds > 1.01) || Date.now() - (api.capturedAt || 0) > 120000) return null;
      if (api.sourceKind === 'stake-api-slip') return api;
      if (api.outcomeId || api.outcomeName) return { ...api, sourceKind: 'stake-api-slip' };
      return null;
    } catch (_) {
      return null;
    }
  }

  function latchOdds(slip) {
    if (!(slip?.odds > 1.01)) {
      oddsLatch = { odds: 0, team: '', at: 0 };
      return slip;
    }
    const key = `${slip.teamLabel || ''}_${slip.method || ''}`;
    const now = Date.now();
    if (oddsLatch.odds > 1.01 && now - oddsLatch.at < 3000) {
      if (Math.abs(oddsLatch.odds - slip.odds) < 0.02) {
        slip.odds = oddsLatch.odds;
      } else if (slip.method === 'slip-odds-node' || slip.fromSlip) {
        oddsLatch = { odds: slip.odds, team: key, at: now };
      } else if (Math.abs(oddsLatch.odds - slip.odds) > 0.15) {
        slip.odds = oddsLatch.odds;
      } else {
        oddsLatch = { odds: slip.odds, team: key, at: now };
      }
    } else {
      oddsLatch = { odds: slip.odds, team: key, at: now };
    }
    return slip;
  }

  function readStakeNativeSlip() {
    const api = readApiSlip();
    if (api) {
      return latchOdds({
        ...api,
        source: 'stake',
        sourceKind: 'stake-api-slip',
        method: 'api-slip',
        fromSlip: true
      });
    }

    const panel = findBetSlipPanel();
    if (!panel?.root) return null;

    const { root, placeBtn } = panel;
    const oddsHit = readOddsFromSlipRoot(root);
    if (!(oddsHit?.odds > 1.01)) return null;

    const stakeInput = findBestStakeInput(root, placeBtn);
    const stakeVal = stakeInput ? pm(stakeInput.value) : 0;
    const teamLabel = readTeamFromSlip(root);

    return latchOdds({
      odds: oddsHit.odds,
      stake: stakeVal > 0 ? stakeVal : (oddsHit.stake || null),
      payout: oddsHit.payout || null,
      teamLabel,
      fromPayout: !!(oddsHit.stake > 0 && oddsHit.payout > oddsHit.stake),
      hasInput: !!stakeInput,
      inputCount: collectInputsIn(root).length,
      source: 'stake',
      sourceKind: 'stake-native-slip',
      method: oddsHit.method,
      fromSlip: true
    });
  }

  function setNativeValue(inp, value) {
    const str = String(value);
    inp.focus?.();
    try { inp.click?.(); } catch (_) {}
    const proto = Object.getPrototypeOf(inp);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(inp, str);
    else inp.value = str;
    inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function commitStakeInput(inp) {
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    inp.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  }

  async function setStakeAmount(amount) {
    const rounded = Math.round(amount * 100) / 100;
    const panel = findBetSlipPanel();
    if (!panel?.root) return { ok: false, reason: 'stake-slip-missing' };

    const inp = findBestStakeInput(panel.root, panel.placeBtn);
    if (!inp) return { ok: false, reason: 'stake-input-missing' };

    const methods = [
      () => { setNativeValue(inp, String(rounded)); },
      () => {
        inp.focus();
        try { inp.select?.(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, String(rounded)); } catch (_) {
          setNativeValue(inp, String(rounded));
        }
      }
    ];

    for (const fn of methods) {
      fn();
      await commitStakeInput(inp);
      const accepted = pm(inp.value);
      if (accepted > 0 && Math.abs(accepted - rounded) < 0.5) {
        return { ok: true, stake: accepted, method: 'stake-slip-input', target: rounded, inputId: inp.id || inp.className?.slice?.(0, 30) || '' };
      }
    }
    return { ok: false, reason: 'stake-not-accepted', inputVal: pm(inp.value), target: rounded };
  }

  async function placeStakeBet(amount) {
    const fill = await setStakeAmount(amount);
    if (!fill?.ok) return { success: false, reason: fill?.reason || 'stake-fill-fail' };
    const panel = findBetSlipPanel();
    const btn = panel?.placeBtn || findPlaceBetButtons().sort((a, b) => (b.r?.x || 0) - (a.r?.x || 0))[0]?.node;
    if (!btn) return { success: false, reason: 'bet-button-missing' };
    btn.click();
    await new Promise((r) => setTimeout(r, 200));
    return { success: true, method: 'stake-click', btnText: normText(btn.textContent || '') };
  }

  function diagReport() {
    const panel = findBetSlipPanel();
    const slip = readStakeNativeSlip();
    const inp = panel?.root ? findBestStakeInput(panel.root, panel.placeBtn) : null;
    return {
      ver: VER,
      slip,
      hasPanel: !!panel?.root,
      hasStakeInput: !!inp,
      stakeInput: inp ? { placeholder: inp.placeholder, aria: inp.getAttribute('aria-label'), val: inp.value } : null,
      placeBtn: !!panel?.placeBtn,
      inputCount: panel?.root ? collectInputsIn(panel.root).length : 0,
      textLen: panel?.root ? normText(panel.root.textContent).length : 0,
      url: location.href
    };
  }

  window.__stakeReadNativeSlip = readStakeNativeSlip;
  window.__stakeSetStake = setStakeAmount;
  window.__stakePlaceBet = placeStakeBet;
  window.__stakeDiagReport = diagReport;
  window.__stakeSlipReadVer = VER;
})();
