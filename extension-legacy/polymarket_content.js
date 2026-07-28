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
  let bestScore = -1;
  for (const el of document.querySelectorAll('div, section, aside, form, article')) {
    if (!isVisible(el)) continue;
    const t = el.innerText || '';
    if (!/to\s*win/i.test(t)) continue;
    if (!/\$\s*[\d,]+/.test(t)) continue;
    if (!el.querySelector('input')) continue;
    if (t.length > 3500) continue;

    let score = 0;
    if (/buy\s+[A-Za-z0-9]/i.test(t)) score += 40;
    if (/\bamount\b/i.test(t)) score += 25;
    if (/(?:avg\.?\s*)?price\s*\d+(?:\.\d+)?\s*¢/i.test(t)) score += 30;
    if (/\d+(?:\.\d+)?\s*¢/.test(t)) score += 15;
    // 메인 주문 패널은 작은 위젯보다 텍스트가 더 김 — 최소 패널 선택 버그 방지
    score += Math.min(t.length / 8, 120);
    if (t.length < 40) score -= 50;
    // 퀵버튼 위젯(+$1 @ 1¢) 오인식 패널 제외
    if (/\+\s*\$1\s*@\s*1\s*¢/i.test(t)) score -= 100;
    if (/\+\s*\$\d+\s*@\s*\d+\s*¢/i.test(t) && !/\bamount\b/i.test(t)) score -= 35;

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
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
  if (/^buy\s+.+/i.test(t) && t.length > 6) score += 85;
  if (/buy\s+[A-Za-z0-9가-힣]/i.test(t) && t.length > 8) score += 90;
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

function findSubmitTradeButton(panel) {
  const panelEl = panel || findTradePanel();
  if (!panelEl) return null;

  const candidates = [];
  for (const btn of panelEl.querySelectorAll('button, [role="button"]')) {
    const score = scoreBuySubmitButton(btn, panelEl);
    if (score > 0) candidates.push({ btn, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]?.score >= 40) return candidates[0].btn;

  const input = findAmountInput(panelEl);
  const inputRect = input?.getBoundingClientRect();
  const inputBottom = inputRect ? inputRect.bottom : 0;
  let best = null;
  let bestScore = -1;

  for (const btn of panelEl.querySelectorAll('button, [role="button"]')) {
    if (!isVisible(btn) || isBtnDisabled(btn) || isBuySellTabToggle(btn)) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^buy$/i.test(t) || /^sell$/i.test(t) || t === '매수' || t === '매도') continue;
    const rect = btn.getBoundingClientRect();
    if (rect.height < 26 || rect.width < 50) continue;

    let score = Math.round((rect.width * rect.height) / 40);
    if (inputRect && rect.top >= inputBottom - 24) score += 120;
    if (/\$\s*[\d,]+(?:\.\d+)?/.test(t)) score += 150;
    if (/buy\s+.+/i.test(t) && t.length > 5) score += 80;
    if (/trade|submit|place|confirm|purchase/i.test(t)) score += 50;
    const cls = String(btn.className || '');
    if (/primary|submit|cta|trade|green|blue|brand/i.test(cls)) score += 45;
    if (btn.type === 'submit') score += 100;

    if (score > bestScore) {
      bestScore = score;
      best = btn;
    }
  }
  return best;
}

function findBuyButton(scope) {
  return findSubmitTradeButton(scope || findTradePanel());
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
    const raw = String(inp.value || inp.textContent || '').replace(/[$,\s]/g, '');
    const v = parseFloat(raw);
    if (v > 0) return v;
  }
  const root = scope || document;
  const t = (root.innerText || '').replace(/\s+/g, ' ');
  const amountM = t.match(/\bamount\b[^$]{0,30}\$\s*([\d,]+(?:\.\d+)?)/i);
  if (amountM) return parseFloat(amountM[1].replace(/,/g, ''));
  const m = t.match(/amount[^$\d]{0,20}\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  return null;
}

function isNoiseCentsButton(txt) {
  const t = String(txt || '').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (/^\+\s*\$/.test(t)) return true;
  if (/^\$\d+(\.\d+)?$/.test(t)) return true;
  if (/\+\s*\$?\d+.*@\s*\d+\s*¢/i.test(t)) return true;
  if (/^buy\s*\$/i.test(t)) return true;
  if (/^sell\s+@/i.test(t)) return true;
  return false;
}

function isBuyModeActive(panel) {
  const root = panel || findTradePanel() || document;
  let buyTab = null;
  let sellTab = null;
  for (const btn of root.querySelectorAll('button, [role="tab"], [role="button"]')) {
    if (!isVisible(btn) || !isBuySellTabToggle(btn)) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (t === 'Buy' || t === '매수') buyTab = btn;
    if (t === 'Sell' || t === '매도') sellTab = btn;
  }
  if (!buyTab && !sellTab) return true;
  if (buyTab) {
    const pressed = buyTab.getAttribute('aria-selected') === 'true'
      || buyTab.getAttribute('data-state') === 'active'
      || buyTab.getAttribute('aria-pressed') === 'true';
    const cls = String(buyTab.className || '');
    if (pressed || /active|selected|checked/i.test(cls)) return true;
  }
  if (sellTab) {
    const pressed = sellTab.getAttribute('aria-selected') === 'true'
      || sellTab.getAttribute('data-state') === 'active'
      || sellTab.getAttribute('aria-pressed') === 'true';
    const cls = String(sellTab.className || '');
    if (pressed || /active|selected|checked/i.test(cls)) return false;
  }
  return true;
}

function parseMoneyValue(text) {
  const t = String(text || '').trim();
  const m = t.match(/^\$?\s*([\d,]+(?:\.\d+)?)$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function isLikelyCentPriceContext(contextText, value) {
  const ctx = String(contextText || '');
  if (/¢/.test(ctx)) return true;
  if (/avg\.?\s*price|^\s*price\s*\d/i.test(ctx) && value > 0 && value <= 99) return true;
  if (value > 0 && value <= 99 && /\bprice\b/i.test(ctx)) return true;
  return false;
}

function isValidToWinCandidate(value, stake, contextText) {
  if (!value || value <= 0) return false;
  if (stake && Math.abs(value - stake) < 0.02) return false;
  if (isLikelyCentPriceContext(contextText, value)) return false;
  const hasCents = Math.abs(value - Math.round(value)) > 0.001;
  const wellAboveStake = stake ? value >= stake * 1.35 : value >= 5;
  // 정수 13(Avg Price) 같은 센트값 오인식 차단 — 소수점 달러 또는 stake 대비 충분히 큰 금액만
  if (!hasCents && value <= 99 && (!stake || value < stake * 1.35)) return false;
  return hasCents || wellAboveStake;
}

function readToWinFromDom(scope, stake) {
  if (!scope) return null;
  const values = [];

  for (const el of scope.querySelectorAll('*')) {
    const own = (el.textContent || '').trim();
    if (!/^to\s*win/i.test(own.replace(/[^\w\s]/gi, '').trim()) && !/^to\s*win/i.test(own)) continue;

    let container = el.parentElement;
    for (let up = 0; up < 4 && container; up++) {
      for (const node of container.querySelectorAll('*')) {
        if (!isVisible(node) || node === el) continue;
        const nt = (node.textContent || '').trim();
        if (/to\s*win|avg\.?\s*price|amount/i.test(nt) && nt.length < 24) continue;
        if (/¢/.test(nt)) continue;
        const v = parseMoneyValue(nt);
        if (v && isValidToWinCandidate(v, stake, nt)) values.push(v);
      }
      container = container.parentElement;
    }
  }

  return values.length ? Math.max(...values) : null;
}

function parseOutcomeCentsPrice(txt) {
  if (isNoiseCentsButton(txt)) return null;
  const p = parseCentsPrice(txt);
  if (!p) return null;
  // 1~2¢는 퀵버튼 오인식 — 팀명 없으면 제외
  const team = extractTeamFromCentsLabel(txt);
  if (p <= 0.02 && (!team || team.length < 2)) return null;
  return p;
}

function readToWinAmountFromScope(scope, stake) {
  if (!scope) return null;

  const raw = scope.innerText || '';
  const values = [];

  for (const match of raw.matchAll(/to\s*win/gi)) {
    const after = raw.slice(match.index);
    const section = after.slice(0, 500);

    for (const m of section.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      const ctx = section.slice(Math.max(0, m.index - 6), m.index + m[0].length + 6);
      if (isValidToWinCandidate(v, stake, ctx)) values.push(v);
    }

    for (const m of section.matchAll(/\b([\d,]+\.\d{2})\b/g)) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      const lineStart = section.lastIndexOf('\n', m.index) + 1;
      const lineEnd = section.indexOf('\n', m.index);
      const line = section.slice(lineStart, lineEnd === -1 ? section.length : lineEnd);
      if (/¢/.test(line)) continue;
      if (isValidToWinCandidate(v, stake, line)) values.push(v);
    }
  }

  const domVal = readToWinFromDom(scope, stake);
  if (domVal) values.push(domVal);

  for (const el of scope.querySelectorAll('*')) {
    const own = el.children.length <= 1 ? (el.textContent || '').trim() : '';
    if (!/^to\s*win/i.test(own.replace(/[^\w\s]/gi, '').trim()) && !/^to\s*win$/i.test(own)) continue;
    let node = el.nextElementSibling;
    for (let d = 0; d < 10 && node; d++) {
      const nt = (node.textContent || '').trim();
      if (/¢|avg\.?\s*price/i.test(nt)) {
        node = node.nextElementSibling;
        continue;
      }
      const v = parseMoneyValue(nt);
      if (v && isValidToWinCandidate(v, stake, nt)) values.push(v);
      node = node.nextElementSibling;
    }
  }

  return values.length ? Math.max(...values) : null;
}

function readToWinAmount(panel) {
  const tradePanel = panel || findTradePanel();
  const stake = readStake(tradePanel);
  let value = readToWinAmountFromScope(tradePanel, stake);

  const suspicious = !value || (stake && stake >= 1 && value <= stake * 1.05);
  if (suspicious && document.body && document.body !== tradePanel) {
    const bodyVal = readToWinAmountFromScope(document.body, stake);
    if (bodyVal && (!value || bodyVal > value + 0.01)) value = bodyVal;
  }

  if (!value && document.body) {
    value = readToWinAmountFromScope(document.body, stake);
  }
  return value;
}

function pickTrustedToWin(toWin, stake) {
  if (!toWin) return null;
  if (!isValidToWinCandidate(toWin, stake, '')) return null;
  if (stake && toWin <= stake * 1.05) return null;
  return toWin;
}

function namesMatch(a, b) {
  const na = String(a || '').replace(/\s+/g, '').toLowerCase();
  const nb = String(b || '').replace(/\s+/g, '').toLowerCase();
  if (!na || !nb || na.length < 2 || nb.length < 2) return false;
  if (na === nb) return true;
  const n = Math.min(na.length, nb.length, 5);
  if (na.slice(0, n) === nb.slice(0, n)) return true;
  return na.includes(nb) || nb.includes(na);
}

function extractTeamFromCentsLabel(txt) {
  return String(txt || '')
    .replace(/\s*\d+(?:\.\d+)?\s*¢.*$/i, '')
    .replace(/^(buy|sell|매수|매도)\s+/i, '')
    .trim();
}

function readPanelListedPrice(panel) {
  const t = (panel?.innerText || '').replace(/\s+/g, ' ');
  const m = t.match(/(?:avg\.?\s*)?price\s*(\d+(?:\.\d+)?)\s*¢/i);
  if (m) return parseFloat(m[1]) / 100;
  return null;
}

function findActiveOutcomePrice(panel, teamLabel) {
  const panelEl = panel || findTradePanel();
  if (!panelEl) return null;
  const buyMode = isBuyModeActive(panelEl);
  const roots = [panelEl];

  const candidates = [];
  for (const root of roots) {
    for (const btn of root.querySelectorAll('button, [role="button"], [role="radio"], [role="tab"]')) {
      if (!isVisible(btn) || isBuySellTabToggle(btn)) continue;
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (buyMode && /^sell\s+/i.test(txt)) continue;
      const p = parseOutcomeCentsPrice(txt);
      if (!p) continue;

      const team = extractTeamFromCentsLabel(txt);
      let score = 0;
      if (btn.getAttribute('aria-pressed') === 'true') score += 90;
      if (btn.getAttribute('data-state') === 'on' || btn.getAttribute('data-state') === 'checked') score += 90;
      if (btn.getAttribute('aria-selected') === 'true') score += 80;
      const cls = String(btn.className || '');
      if (/active|selected|checked|pressed/i.test(cls)) score += 50;
      if (teamLabel && team && namesMatch(team, teamLabel)) score += 120;
      if (panel && panel.contains(btn)) score += 40;
      if (team && team.length >= 2) score += 10;
      if (/^buy\s+/i.test(txt)) score += 30;
      if (/^sell\s+/i.test(txt)) score -= 200;

      candidates.push({ price: p, score, team, txt });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].price;
}

function findSelectedOutcomePrice(scope) {
  const root = scope || findTradePanel() || document;
  for (const btn of root.querySelectorAll('button, [role="button"]')) {
    if (!isVisible(btn)) continue;
    const pressed = btn.getAttribute('aria-pressed') === 'true'
      || btn.getAttribute('data-state') === 'on'
      || btn.getAttribute('data-state') === 'checked';
    if (!pressed) continue;
    const p = parseOutcomeCentsPrice(btn.textContent);
    if (p) return p;
  }
  return null;
}

function readToWinAndPrice(scope, opts = {}) {
  const panel = scope || findTradePanel();
  const t = (panel?.innerText || document.body?.innerText || '').replace(/\s+/g, ' ');
  const toWin = readToWinAmount(panel);

  const teamLabel = readTeamLabel(panel);
  let price = findActiveOutcomePrice(panel, teamLabel) || findSelectedOutcomePrice(panel);

  if (!price && panel) {
    for (const btn of panel.querySelectorAll('button, [role="button"]')) {
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt.includes('¢') || txt.includes('--')) continue;
      const p = parseOutcomeCentsPrice(txt);
      if (!p) continue;
      const team = extractTeamFromCentsLabel(txt);
      if (teamLabel && team && namesMatch(team, teamLabel)) {
        price = p;
        break;
      }
    }
  }

  // Avg price는 최후 폴백
  if (!price && !opts.skipAvg) {
    const avg = t.match(/avg(?:\.|erage)?\s*price[^0-9]*(\d+(?:\.\d+)?)\s*¢/i);
    if (avg) price = parseFloat(avg[1]) / 100;
  }
  return { toWin, price };
}

function readTeamLabel(panel) {
  const panelEl = panel || findTradePanel();
  const panelText = panelEl?.innerText || '';

  const buyBtn = findSubmitTradeButton(panelEl);
  if (buyBtn) {
    const btnM = (buyBtn.textContent || '').match(/buy\s+([A-Za-z0-9][^\n$¢@]{0,40})/i);
    if (btnM) return btnM[1].trim().slice(0, 80);
  }

  const buyM = panelText.match(/(?:Buy|매수)\s+([A-Za-z0-9][^\n$¢@]{0,40})/i);
  if (buyM) return buyM[1].trim().slice(0, 80);

  const lines = panelText.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(amount|to win|buy|sell|deposit|cash|portfolio|price|avg)/i.test(line)) continue;
    if (/^sell\b/i.test(line)) continue;
    if (/^\$/.test(line) || /^\+/.test(line)) continue;
    if (/^\d+\s*¢/.test(line) || /¢/.test(line)) continue;
    if (/^@/.test(line)) continue;
    if (line.length >= 2 && line.length <= 60) return line;
  }

  const h1 = document.querySelector('h1');
  if (h1) {
    const title = h1.textContent.trim();
    const vs = title.match(/(.+?)\s+vs\.?\s+(.+)/i);
    if (vs) {
      const buySide = panelText.match(/buy\s+([^\n]+)/i);
      if (buySide) {
        const name = buySide[1].trim();
        if (namesMatch(name, vs[2])) return vs[2].trim();
        if (namesMatch(name, vs[1])) return vs[1].trim();
      }
      return vs[2].trim();
    }
  }
  return '';
}

function calcOddsFromStake(stake, toWin, price) {
  if (stake && toWin && toWin > 0) {
    let payout, profit, dec;
    if (toWin >= stake) {
      // To win >= 베팅액 → 총 수령액 ($10 → $11.06 = 1.106배, $10 → $191.83 = 19.183배)
      payout = toWin;
      profit = toWin - stake;
      dec = payout / stake;
    } else {
      // To win < 베팅액 → 순이익 ($10 → $1.06 이익 = 1.106배)
      profit = toWin;
      payout = stake + toWin;
      dec = payout / stake;
    }
    if (dec > 1.001) {
      return { odds: dec, payout, profit, fromToWin: true };
    }
  }

  const priceDec = (price && price > 0 && price < 1) ? priceToDecimal(price) : null;
  if (priceDec) {
    const payout = stake ? stake * priceDec : null;
    const profit = payout != null && stake ? payout - stake : null;
    return { odds: priceDec, payout, profit, usedPrice: true };
  }

  return { odds: null, payout: null, profit: null };
}

function readPolymarketSlip() {
  const panel = findTradePanel();
  const scope = panel || document.body;
  const stake = readStake(scope);
  const toWin = readToWinAmount(panel);
  let teamLabel = readTeamLabel(panel);

  // stake와 거의 같은 To win(오인식)이면 가격 폴백 전에 무시
  const trustedToWin = pickTrustedToWin(toWin, stake);
  const { odds, payout, profit, fromToWin } = calcOddsFromStake(stake, trustedToWin, null);
  if (odds && fromToWin) {
    const listedCents = readPanelListedPrice(panel);
    const priceCents = listedCents != null
      ? Math.round(listedCents * 1000) / 10
      : Math.round(1000 / odds) / 10;
    const eventTitle = document.querySelector('h1')?.textContent?.trim() || '';
    const totalPayout = payout;
    return {
      odds,
      price: priceCents / 100,
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
        ? `${teamLabel} @ ${priceCents}¢`
        : `${priceCents}¢`,
      stake: stake || null,
      toWin: profit,
      payout: totalPayout,
      displayLabel: `${priceCents}¢ (${odds.toFixed(3)})`,
      hint: stake && totalPayout
        ? `베팅 $${stake} → 수령 $${totalPayout.toFixed(2)}`
        : (stake ? '' : '금액 입력 필요'),
      fromToWin: true
    };
  }

  let price = findActiveOutcomePrice(panel, teamLabel);
  const { price: panelPrice } = readToWinAndPrice(scope, { skipAvg: true });
  if (!price) price = panelPrice;

  if (!price && panel) {
    for (const btn of panel.querySelectorAll('button, [role="button"]')) {
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt.includes('¢') || txt.includes('--')) continue;
      if (/^sell\s+/i.test(txt)) continue;
      const p = parseOutcomeCentsPrice(txt);
      if (!p) continue;
      const team = extractTeamFromCentsLabel(txt);
      if (team && teamLabel && namesMatch(team, teamLabel)) {
        price = p;
        break;
      }
      if (!teamLabel && team.length >= 2) teamLabel = team;
    }
  }

  // 금액 입력됐는데 To win 미확인 → Avg Price 폴백 (Sell 쪽 17¢ 오인식 방지)
  if (stake && stake >= 1 && !trustedToWin) {
    if (!price || price <= 0.02) {
      const listed = readPanelListedPrice(panel);
      if (listed) price = listed;
    }
    if (price && price <= 0.02) price = null;
  }

  // stake 있으면 Avg Price보다 To win 기반 배당 우선
  let calc = calcOddsFromStake(stake, trustedToWin, price);
  if (stake && trustedToWin && !calc.fromToWin) {
    calc = calcOddsFromStake(stake, trustedToWin, null);
  }
  if (stake && trustedToWin && calc.fromToWin && price) {
    const priceOdds = priceToDecimal(price);
    if (priceOdds && Math.abs(calc.odds - priceOdds) / calc.odds > 0.03) {
      calc = calcOddsFromStake(stake, trustedToWin, null);
    }
  }
  const finalOdds = calc.odds;
  if (!finalOdds || finalOdds <= 1.001) return null;

  const totalPayout = calc.payout || (stake && calc.profit != null ? stake + calc.profit : null);
  const fromToWin2 = calc.fromToWin;
  const priceCents = fromToWin2
    ? Math.round(1000 / finalOdds) / 10
    : (price != null ? Math.round(price * 1000) / 10 : (finalOdds ? Math.round(1000 / finalOdds) / 10 : null));
  const impliedPrice = priceCents != null ? priceCents / 100 : price;

  const eventTitle = document.querySelector('h1')?.textContent?.trim() || '';

  return {
    odds: finalOdds,
    price: impliedPrice,
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
    toWin: calc.profit,
    payout: totalPayout,
    displayLabel: priceCents != null
      ? `${priceCents}¢ (${finalOdds.toFixed(3)})`
      : finalOdds.toFixed(3),
    hint: stake && totalPayout
      ? `베팅 $${stake} → 수령 $${totalPayout.toFixed(2)}`
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

    try {
      amountInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      amountInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));

    let betBtn = null;
    for (let i = 0; i < 20; i++) {
      betBtn = findSubmitTradeButton(panel);
      if (betBtn && !isBtnDisabled(betBtn) && !isBuySellTabToggle(betBtn)) break;
      betBtn = null;
      await new Promise((r) => setTimeout(r, 80));
    }

    if (!betBtn) {
      const debug = Array.from((panel || document).querySelectorAll('button'))
        .filter(isVisible)
        .slice(0, 12)
        .map((b) => `"${(b.textContent || '').trim().slice(0, 32)}"`)
        .join(' | ');
      return { success: false, reason: `제출 버튼 없음 | ${debug}` };
    }

    const btnText = (betBtn.textContent || '').trim().slice(0, 60);
    const btnScore = scoreBuySubmitButton(betBtn, panel);
    const hasDollar = /\$\s*[\d,]+/.test(btnText);
    const beforeStake = readStake(panel) || amount;
    const beforePanelText = panel.innerText || '';
    for (let attempt = 0; attempt < 3; attempt++) {
      robustClick(betBtn);
      await new Promise((r) => setTimeout(r, 450));
      const err = findPolyErrorMessage();
      if (err) return { success: false, reason: `Poly 오류: ${err}`, btnText };
      let submitted = detectPolyBetSubmitted(beforeStake, beforePanelText);
      if (submitted.submitted) {
        const confirmBtn = findConfirmButton();
        if (confirmBtn) {
          robustClick(confirmBtn);
          await new Promise((r) => setTimeout(r, 500));
        }
        return { success: true, btnText, confirmed: !!confirmBtn, kind: submitted.kind, attempts: attempt + 1 };
      }
      await new Promise((r) => setTimeout(r, 500));
      submitted = detectPolyBetSubmitted(beforeStake, beforePanelText);
      if (submitted.submitted) {
        return { success: true, btnText, confirmed: false, kind: submitted.kind, attempts: attempt + 1 };
      }
      if (!findPolyErrorMessage() && (hasDollar || btnScore >= 30)) {
        return { success: true, btnText, confirmed: false, kind: 'direct_submit', attempts: attempt + 1 };
      }
      betBtn = findSubmitTradeButton(panel);
      if (!betBtn || isBtnDisabled(betBtn) || isBuySellTabToggle(betBtn)) break;
    }

    return { success: false, reason: `제출 미체결 (${btnText})`, btnText, attempts: 3 };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, href: location.href, site: 'polymarket', version: '2.0' });
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

console.log('[Polymarket봇] content script v2.4');
