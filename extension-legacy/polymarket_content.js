// Polymarket content script — ¢ 가격 / 주문패널 / To win 당첨금

function parseCentsPrice(text) {
  const t = String(text || '').trim();
  const cent = t.match(/(\d{1,2}(?:\.\d+)?)\s*¢/);
  if (cent) return parseFloat(cent[1]) / 100;
  const n = parseFloat(t);
  if (n > 0 && n < 1) return n;
  if (n >= 1 && n <= 99) return n / 100;
  return null;
}

function priceToDecimal(price) {
  if (!price || price <= 0 || price >= 1) return null;
  return 1 / price;
}

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function robustClick(el) {
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch (_) {
    try { el.scrollIntoView({ block: 'center' }); } catch (_2) {}
  }
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + (window.screenX || 0),
    screenY: y + (window.screenY || 0),
    button: 0,
    buttons: 1
  };
  try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_2) {} }
  try { el.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (_) {}
  try { el.dispatchEvent(new PointerEvent('pointerenter', opts)); } catch (_) {}
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  if (typeof el.click === 'function') el.click();
  return true;
}

function isBtnDisabled(btn) {
  if (!btn) return true;
  if (btn.disabled) return true;
  if (btn.getAttribute('aria-disabled') === 'true') return true;
  const cls = btn.className || '';
  return /disabled|opacity-50|cursor-not-allowed/i.test(cls);
}

function findTradePanel() {
  let best = null;
  let bestLen = Infinity;
  for (const el of document.querySelectorAll('div, section, aside, form, article')) {
    if (!isVisible(el)) continue;
    const t = el.innerText || '';
    if (!/to\s*win/i.test(t)) continue;
    if (!/\$\s*[\d,]+/.test(t)) continue;
    if (!el.querySelector('input')) continue;
    if (t.length > bestLen || t.length > 2500) continue;
    best = el;
    bestLen = t.length;
  }
  return best;
}

function findAmountInput(panel) {
  const root = panel || findTradePanel() || document;
  const candidates = [];
  for (const inp of root.querySelectorAll('input')) {
    if (!isVisible(inp)) continue;
    const ph = (inp.placeholder || '').toLowerCase();
    const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
    let score = 0;
    if (ph.includes('amount') || ph.includes('$') || ph === '0') score += 15;
    if (aria.includes('amount')) score += 15;
    if (inp.type === 'number' || inp.inputMode === 'decimal' || inp.inputMode === 'numeric') score += 8;
    if (inp.type === 'text') score += 3;
    candidates.push({ inp, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return candidates[0].inp;
  for (const el of root.querySelectorAll('[contenteditable="true"]')) {
    if (isVisible(el)) return el;
  }
  return root.querySelector('input');
}

function setInputValue(input, value) {
  const str = String(value);
  if (!input) return false;
  if (input.getAttribute('contenteditable') === 'true') {
    input.focus();
    input.textContent = str;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  input.focus();
  input.select?.();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, str);
  else input.value = str;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  try {
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
  } catch (_) {}
  const readBack = parseFloat(String(input.value || '').replace(/,/g, ''));
  return Number.isFinite(readBack) && Math.abs(readBack - parseFloat(str)) < 0.02;
}

function isBuySellTabToggle(btn) {
  if (!btn) return false;
  const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
  if (t !== 'Buy' && t !== 'Sell' && t !== '매수' && t !== '매도') return false;
  if (btn.getAttribute('role') === 'tab') return true;
  const parent = btn.parentElement;
  if (parent) {
    const kids = parent.querySelectorAll('button, [role="button"], [role="tab"]');
    let buySellCount = 0;
    for (const k of kids) {
      const kt = (k.textContent || '').trim();
      if (kt === 'Buy' || kt === 'Sell' || kt === '매수' || kt === '매도') buySellCount++;
    }
    if (buySellCount >= 2) return true;
  }
  return t === 'Buy' || t === 'Sell';
}

function scoreBuySubmitButton(btn, panel) {
  if (!btn || !isVisible(btn) || isBtnDisabled(btn)) return -1;
  if (isBuySellTabToggle(btn)) return -1;
  const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
  const aria = (btn.getAttribute('aria-label') || '').trim();
  const testId = btn.getAttribute('data-testid') || '';
  if (/sell/i.test(t) && !/buy/i.test(t) && !/매수/.test(t)) return -1;
  if (t === 'Buy' || t === 'Sell' || t === '매수' || t === '매도') return -1;

  let score = 0;
  if (/submit|place-order|trade-submit|order-submit|trade-button/i.test(testId)) score += 90;
  if (/\$\s*[\d,]+(?:\.\d+)?/.test(t) || /\$\s*[\d,]+(?:\.\d+)?/.test(aria)) score += 70;
  if (/\d+(?:\.\d+)?\s*¢/.test(t)) score += 45;
  if (/^buy\s+.+/i.test(t) && t.length > 6) score += 55;
  if (/매수\s*.+/.test(t) && t.length > 3) score += 55;
  if (/place\s*order|submit|confirm/i.test(t)) score += 35;
  if (/buy|매수/i.test(t)) score += 20;
  if (panel && panel.contains(btn)) score += 25;
  const rect = btn.getBoundingClientRect();
  score += Math.round(rect.top / 8);
  if (rect.height >= 36) score += 10;
  return score;
}

function isBuyButton(btn) {
  return scoreBuySubmitButton(btn, findTradePanel()) > 0;
}

function findBuyButton(scope) {
  const panel = scope || findTradePanel();
  const roots = panel ? [panel] : [document];
  const candidates = [];
  for (const root of roots) {
    for (const btn of root.querySelectorAll('button, [role="button"]')) {
      const score = scoreBuySubmitButton(btn, panel);
      if (score > 0) candidates.push({ btn, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.btn || null;
}

function findConfirmButton() {
  for (const btn of document.querySelectorAll('button, [role="button"]')) {
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^confirm$/i.test(t) || t === '확인' || /submit\s*order/i.test(t)) return btn;
    if (/^place\s*order$/i.test(t)) return btn;
  }
  return null;
}

function findBetModal() {
  for (const el of document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="Modal"], [data-state="open"]')) {
    if (!isVisible(el)) continue;
    const t = (el.innerText || '').replace(/\s+/g, ' ');
    if (/confirm|place\s*order|review\s*order|submit/i.test(t)) return el;
  }
  return null;
}

function findPolyErrorMessage() {
  for (const el of document.querySelectorAll('[role="alert"], [class*="toast" i], [class*="error" i], [class*="Error"]')) {
    if (!isVisible(el)) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (/insufficient|not enough|failed|error|rejected|minimum|invalid/i.test(t)) return t.slice(0, 80);
  }
  return null;
}

function detectPolyBetSubmitted(beforeStake, beforePanelText) {
  const confirmBtn = findConfirmButton();
  if (confirmBtn) return { submitted: true, kind: 'confirm' };
  const modal = findBetModal();
  if (modal) return { submitted: true, kind: 'modal' };
  const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
  if (/order\s*placed|trade\s*successful|successfully\s*(bought|placed)|bet\s*placed|purchase\s*complete/i.test(body)) {
    return { submitted: true, kind: 'toast' };
  }
  const stake = readStake();
  if (beforeStake > 0 && (!stake || stake < beforeStake * 0.5)) {
    return { submitted: true, kind: 'stake_cleared' };
  }
  const panel = findTradePanel();
  if (panel && beforePanelText && panel.innerText !== beforePanelText) {
    const afterText = panel.innerText.replace(/\s+/g, ' ');
    if (/placed|success|complete|submitted/i.test(afterText)) {
      return { submitted: true, kind: 'panel_change' };
    }
  }
  return { submitted: false };
}

function readStake(scope) {
  const inp = findAmountInput(scope);
  if (inp) {
    const v = parseFloat(String(inp.value || '').replace(/,/g, ''));
    if (v > 0) return v;
  }
  const root = scope || document;
  const t = (root.innerText || '').replace(/\s+/g, ' ');
  const m = t.match(/amount[^$\d]{0,20}\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  return null;
}

function findSelectedOutcomePrice(scope) {
  const root = scope || findTradePanel() || document;
  for (const btn of root.querySelectorAll('button, [role="button"]')) {
    if (!isVisible(btn)) continue;
    const pressed = btn.getAttribute('aria-pressed') === 'true'
      || btn.getAttribute('data-state') === 'on'
      || btn.getAttribute('data-state') === 'checked';
    if (!pressed) continue;
    const p = parseCentsPrice(btn.textContent);
    if (p) return p;
  }
  return null;
}

function readToWinAndPrice(scope) {
  const panel = scope || findTradePanel();
  const t = (panel?.innerText || document.body?.innerText || '').replace(/\s+/g, ' ');
  let toWin = null;
  const twMatches = [...t.matchAll(/to\s*win[^$]{0,40}\$\s*([\d,]+(?:\.\d+)?)/gi)];
  if (twMatches.length) {
    const values = twMatches
      .map((m) => parseFloat(m[1].replace(/,/g, '')))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (values.length) toWin = Math.max(...values);
  }

  let price = findSelectedOutcomePrice(panel);
  const avg = t.match(/avg(?:\.|erage)?\s*price[^0-9]*(\d+(?:\.\d+)?)\s*¢/i);
  if (!price && avg) price = parseFloat(avg[1]) / 100;
  if (!price && panel) {
    const centsInPanel = (panel.innerText || '').match(/(\d{1,2}(?:\.\d+)?)\s*¢/g);
    if (centsInPanel && centsInPanel.length) {
      price = parseCentsPrice(centsInPanel[centsInPanel.length - 1]);
    }
  }
  return { toWin, price };
}

function readTeamLabel(panel) {
  const panelText = panel?.innerText || '';
  const buyM = panelText.match(/(?:Buy|매수)\s+([^\n]+)/i);
  if (buyM) return buyM[1].replace(/\$[\d,.]+.*$/, '').trim().slice(0, 80);

  const lines = panelText.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(amount|to win|buy|deposit|cash|portfolio)/i.test(line)) continue;
    if (/^\$/.test(line)) continue;
    if (/^\d+\s*¢/.test(line)) continue;
    if (line.length >= 3 && line.length <= 60) return line;
  }

  const h1 = document.querySelector('h1');
  if (h1) {
    const title = h1.textContent.trim();
    const vs = title.match(/(.+?)\s+vs\.?\s+(.+)/i);
    if (vs) return vs[1].trim();
  }
  return '';
}

function calcOddsFromStake(stake, toWin, price) {
  if (price && price > 0 && price < 1) {
    const dec = priceToDecimal(price);
    if (dec) {
      const payout = stake ? stake * dec : null;
      const profit = payout != null && stake ? payout - stake : null;
      return { odds: dec, payout, profit };
    }
  }

  if (stake && toWin) {
    if (toWin < stake * 0.5) {
      return { odds: null, payout: null, profit: null };
    }
    if (toWin >= stake * 0.85) {
      return { odds: toWin / stake, payout: toWin, profit: toWin - stake };
    }
    return { odds: (stake + toWin) / stake, payout: stake + toWin, profit: toWin };
  }

  return { odds: null, payout: null, profit: null };
}

function readPolymarketSlip() {
  const panel = findTradePanel();
  const scope = panel || document.body;
  const stake = readStake(scope);
  const { toWin, price: panelPrice } = readToWinAndPrice(scope);
  let teamLabel = readTeamLabel(panel);

  let price = panelPrice;
  if (!price && panel) {
    for (const btn of panel.querySelectorAll('button, [role="button"]')) {
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt.includes('¢') || txt.includes('--')) continue;
      const p = parseCentsPrice(txt);
      if (!p) continue;
      const team = txt.replace(/\s*\d+(?:\.\d+)?\s*¢.*$/, '').trim();
      if (team && teamLabel && team.toLowerCase().includes(teamLabel.toLowerCase().slice(0, 5))) {
        price = p;
        break;
      }
      if (!teamLabel && team.length >= 2) teamLabel = team;
    }
  }

  const { odds, payout, profit } = calcOddsFromStake(stake, toWin, price);
  const priceCents = price != null ? Math.round(price * 1000) / 10 : null;
  const eventTitle = document.querySelector('h1')?.textContent?.trim() || '';

  const priceOdds = price ? priceToDecimal(price) : null;
  const finalOdds = priceOdds || odds;
  if (!finalOdds || finalOdds <= 1.001) return null;

  return {
    odds: finalOdds,
    price,
    priceCents,
    outcome: teamLabel,
    teamLabel,
    eventTitle: eventTitle.slice(0, 120),
    side: 'yes',
    marketKind: 'ml',
    period: 'ft',
    marketKey: `poly_ml_${(teamLabel || 'out').slice(0, 20)}`,
    source: 'polymarket',
    selectionText: teamLabel
      ? `${teamLabel}${priceCents != null ? ' @ ' + priceCents + '¢' : ''}`
      : (priceCents != null ? `${priceCents}¢` : ''),
    stake: stake || null,
    toWin: profit,
    payout: payout || (stake && profit != null ? stake + profit : null),
    displayLabel: priceCents != null
      ? `${priceCents}¢ (${finalOdds.toFixed(3)})`
      : finalOdds.toFixed(3),
    hint: stake && (payout || profit != null)
      ? `베팅 $${stake} → 수령 $${(payout || stake + (profit || 0)).toFixed(2)}`
      : (stake ? '' : '금액 입력 필요')
  };
}

function probePolyBetFrame() {
  const panel = findTradePanel();
  const input = findAmountInput(panel);
  const buyBtn = findBuyButton(panel);
  const slip = readPolymarketSlip();
  return {
    hasPanel: !!panel,
    hasInput: !!input,
    hasBuyBtn: !!buyBtn,
    hasSlip: !!slip,
    stake: slip?.stake || 0,
    href: location.href
  };
}

async function placePolymarketBet(amountUsd) {
  try {
    const amount = Math.max(0.01, Math.round(amountUsd * 100) / 100);
    const panel = findTradePanel();
    if (!panel) {
      return { success: false, reason: '주문 패널 없음 — Polymarket에서 Buy 탭+금액 입력 후 시도' };
    }

    const amountInput = findAmountInput(panel);
    if (!amountInput) return { success: false, reason: '금액 입력 필드 없음' };

    const amountStr = amount.toFixed(2);
    let amountOk = false;
    for (let fillTry = 0; fillTry < 4; fillTry++) {
      amountInput.focus();
      amountInput.click();
      try { amountInput.select?.(); } catch (_) {}
      try { document.execCommand('insertText', false, amountStr); } catch (_) {}
      setInputValue(amountInput, amountStr);
      await new Promise((r) => setTimeout(r, 400));
      const stake = readStake(panel);
      if (stake && Math.abs(stake - amount) < 0.05) {
        amountOk = true;
        break;
      }
    }
    if (!amountOk) {
      return { success: false, reason: `금액 입력 실패 ($${amountStr}) — Polymarket 탭에서 수동 입력` };
    }

    let betBtn = null;
    for (let i = 0; i < 50; i++) {
      betBtn = findBuyButton(panel);
      if (betBtn && !isBtnDisabled(betBtn) && !isBuySellTabToggle(betBtn)) break;
      betBtn = null;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!betBtn) {
      const debug = Array.from((panel || document).querySelectorAll('button'))
        .filter(isVisible)
        .slice(0, 12)
        .map((b) => `"${(b.textContent || '').trim().slice(0, 32)}"`)
        .join(' | ');
      return { success: false, reason: `제출 Buy 버튼 없음 | ${debug}` };
    }

    const btnText = (betBtn.textContent || '').trim().slice(0, 60);
    const btnScore = scoreBuySubmitButton(betBtn, panel);
    const beforeStake = readStake(panel) || amount;
    const beforePanelText = panel.innerText || '';
    for (let attempt = 0; attempt < 4; attempt++) {
      robustClick(betBtn);
      await new Promise((r) => setTimeout(r, 600));
      const err = findPolyErrorMessage();
      if (err) return { success: false, reason: `Poly 오류: ${err}`, btnText };
      let submitted = detectPolyBetSubmitted(beforeStake, beforePanelText);
      if (submitted.submitted) {
        const confirmBtn = findConfirmButton();
        if (confirmBtn) {
          robustClick(confirmBtn);
          await new Promise((r) => setTimeout(r, 800));
        }
        return { success: true, btnText, confirmed: !!confirmBtn, kind: submitted.kind, attempts: attempt + 1 };
      }
      await new Promise((r) => setTimeout(r, 800));
      submitted = detectPolyBetSubmitted(beforeStake, beforePanelText);
      if (submitted.submitted) {
        return { success: true, btnText, confirmed: false, kind: submitted.kind, attempts: attempt + 1 };
      }
      betBtn = findBuyButton(panel);
      if (!betBtn || isBtnDisabled(betBtn) || isBuySellTabToggle(betBtn)) break;
    }

    if (btnScore >= 40 && !findPolyErrorMessage()) {
      return { success: true, btnText, confirmed: false, kind: 'direct_click', uncertain: true, attempts: 4 };
    }
    return { success: false, reason: `Buy 미체결 (${btnText}) — 제출 버튼 확인 필요`, btnText, attempts: 4 };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, href: location.href, site: 'polymarket', version: '1.7' });
    return false;
  }
  if (msg.type === 'PROBE_POLY') {
    sendResponse(probePolyBetFrame());
    return false;
  }
  if (msg.type === 'READ_SLIP') {
    sendResponse({ slip: readPolymarketSlip() });
    return false;
  }
  if (msg.type === 'PLACE_BET') {
    placePolymarketBet(msg.amount).then((result) => sendResponse(result));
    return true;
  }
});

(function startPolyObserver() {
  let lastKey = '';
  let timer = null;
  function check() {
    const slip = readPolymarketSlip();
    if (!slip) return;
    const key = `${slip.odds}_${slip.priceCents}_${slip.stake}_${slip.marketKey}`;
    if (key === lastKey) return;
    lastKey = key;
    try {
      chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: 'polymarket', slip });
    } catch (_) {}
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, 40);
  }
  if (document.body) {
    const obs = new MutationObserver(schedule);
    obs.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'value', 'aria-pressed', 'data-state']
    });
    document.addEventListener('input', schedule, true);
    schedule();
  }
})();

console.log('[Polymarket봇] content script v1.7');
