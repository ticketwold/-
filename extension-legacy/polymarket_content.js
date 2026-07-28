// Polymarket content script v5 — To win 기반 배당 (텐텐뱃 양방 전용)

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function isBuySellTab(btn) {
  const t = (btn?.textContent || '').replace(/\s+/g, ' ').trim();
  return t === 'Buy' || t === 'Sell' || t === '매수' || t === '매도';
}

function findTradePanel() {
  let best = null;
  let bestScore = -1;
  for (const el of document.querySelectorAll('div, section, aside, form')) {
    if (!visible(el)) continue;
    const t = el.innerText || '';
    if (!/to\s*win/i.test(t) || !el.querySelector('input')) continue;
    if (t.length > 4000) continue;

    let score = 0;
    if (/\bamount\b/i.test(t)) score += 30;
    if (/buy\s+[A-Za-z0-9]/i.test(t)) score += 35;
    if (/(?:avg\.?\s*)?price\s*\d/i.test(t)) score += 20;
    score += Math.min(t.length / 10, 100);
    if (/\+\s*\$1\s*@\s*1\s*¢/i.test(t)) score -= 120;
    if (t.length < 50) score -= 40;

    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function findAmountInput(panel) {
  const root = panel || findTradePanel() || document;
  for (const inp of root.querySelectorAll('input')) {
    if (!visible(inp)) continue;
    const ph = (inp.placeholder || '').toLowerCase();
    const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
    if (ph.includes('amount') || ph.includes('$') || aria.includes('amount')) return inp;
  }
  return root.querySelector('input');
}

function readStake(panel) {
  const inp = findAmountInput(panel);
  if (inp) {
    const v = parseFloat(String(inp.value || '').replace(/[$,\s]/g, ''));
    if (v > 0) return v;
  }
  return null;
}

function parseMoneyOnly(text) {
  const t = String(text || '').trim();
  const m = t.match(/^\$?\s*([\d,]+(?:\.\d+)?)$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function isCentPriceContext(ctx, value) {
  if (/¢/.test(ctx)) return true;
  if (/\b(?:avg\.?\s*)?price\b/i.test(ctx) && value > 0 && value <= 99) return true;
  return false;
}

function isValidPayout(value, stake, ctx) {
  if (!value || value <= 0) return false;
  if (stake && Math.abs(value - stake) < 0.02) return false;
  if (isCentPriceContext(ctx, value)) return false;
  const hasDecimals = Math.abs(value - Math.round(value)) > 0.001;
  if (hasDecimals) return true;
  if (stake && value >= stake * 1.35) return true;
  return false;
}

function readPayoutAmount(panel, stake) {
  const scopes = [panel, document.body].filter(Boolean);
  const values = [];

  for (const scope of scopes) {
    const raw = scope.innerText || '';
    for (const match of raw.matchAll(/to\s*win/gi)) {
      const section = raw.slice(match.index, match.index + 600);
      for (const m of section.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        const ctx = section.slice(Math.max(0, m.index - 8), m.index + m[0].length + 8);
        if (isValidPayout(v, stake, ctx)) values.push(v);
      }
      for (const m of section.matchAll(/\b([\d,]+\.\d{2})\b/g)) {
        const lineStart = section.lastIndexOf('\n', m.index) + 1;
        const lineEnd = section.indexOf('\n', m.index);
        const line = section.slice(lineStart, lineEnd === -1 ? section.length : lineEnd);
        if (/¢/.test(line)) continue;
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (isValidPayout(v, stake, line)) values.push(v);
      }
    }

    for (const el of scope.querySelectorAll('*')) {
      const own = (el.textContent || '').trim();
      if (!/^to\s*win/i.test(own.replace(/[^\w\s]/gi, ''))) continue;
      let node = el.nextElementSibling;
      for (let i = 0; i < 8 && node; i++) {
        const nt = (node.textContent || '').trim();
        if (/¢|avg\.?\s*price/i.test(nt)) { node = node.nextElementSibling; continue; }
        const v = parseMoneyOnly(nt);
        if (v && isValidPayout(v, stake, nt)) values.push(v);
        node = node.nextElementSibling;
      }
    }
  }

  return values.length ? Math.max(...values) : null;
}

function readListedPriceCents(panel) {
  const t = (panel?.innerText || '').replace(/\s+/g, ' ');
  const m = t.match(/(?:avg\.?\s*)?price\s*(\d+(?:\.\d+)?)\s*¢/i);
  return m ? parseFloat(m[1]) : null;
}

function readTeamLabel(panel) {
  const panelEl = panel || findTradePanel();
  const text = panelEl?.innerText || '';

  for (const btn of (panelEl || document).querySelectorAll('button, [role="button"]')) {
    if (!visible(btn)) continue;
    const m = (btn.textContent || '').match(/^buy\s+([A-Za-z0-9][^\n$¢@]{0,40})/i);
    if (m) return m[1].trim();
  }

  const buyM = text.match(/(?:Buy|매수)\s+([A-Za-z0-9][^\n$¢@]{0,40})/i);
  if (buyM) return buyM[1].trim();

  const h1 = document.querySelector('h1')?.textContent || '';
  const vs = h1.match(/(.+?)\s+vs\.?\s+(.+)/i);
  if (vs) return vs[2].trim();
  return '';
}

function readPolymarketSlip() {
  const panel = findTradePanel();
  const stake = readStake(panel);
  const payout = readPayoutAmount(panel, stake);
  const team = readTeamLabel(panel);
  const listedCents = readListedPriceCents(panel);

  let odds = null;
  let fromPayout = false;

  if (stake && payout) {
    odds = calcOddsFromStakeAndPayout(stake, payout);
    fromPayout = !!(odds && odds > 1.001);
  }

  if (!fromPayout && listedCents) {
    const price = listedCents / 100;
    if (price > 0 && price < 1) odds = 1 / price;
  }

  if (!odds || odds <= 1.001) return null;

  const priceCents = listedCents || decimalToCents(odds);
  const profit = fromPayout && payout >= stake ? payout - stake : null;

  return {
    source: 'polymarket',
    odds,
    priceCents,
    price: priceCents / 100,
    teamLabel: team,
    outcome: team,
    selectionText: team ? `${team} @ ${priceCents}¢` : `${priceCents}¢`,
    displayLabel: `${priceCents}¢ (${odds.toFixed(3)})`,
    stake: stake || null,
    payout: fromPayout ? payout : (stake ? stake * odds : null),
    toWin: profit,
    hint: stake && payout ? `베팅 $${stake} → 수령 $${payout.toFixed(2)}` : (stake ? '' : '금액 입력 필요'),
    marketKind: 'ml',
    period: 'ft',
    marketKey: `poly_ml_${(team || 'out').slice(0, 20)}`,
    fromPayout
  };
}

function calcOddsFromStakeAndPayout(stake, payout) {
  if (!stake || !payout) return null;
  if (payout >= stake) return payout / stake;
  return (stake + payout) / stake;
}

function decimalToCents(decimal) {
  if (!decimal || decimal <= 1) return null;
  return Math.round(1000 / decimal) / 10;
}

function robustClick(el) {
  if (!el) return false;
  try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  if (typeof el.click === 'function') el.click();
  return true;
}

function findBuyButton(panel) {
  const root = panel || findTradePanel();
  if (!root) return null;
  for (const btn of root.querySelectorAll('button, [role="button"]')) {
    if (!visible(btn) || btn.disabled || isBuySellTab(btn)) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^buy\s+.+/i.test(t) && t.length > 6) return btn;
  }
  return null;
}

function setInputValue(input, value) {
  if (!input) return false;
  const str = String(value);
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, str);
  else input.value = str;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

async function placePolymarketBet(amountUsd) {
  const panel = findTradePanel();
  if (!panel) return { success: false, reason: '주문 패널 없음' };
  const input = findAmountInput(panel);
  if (!input) return { success: false, reason: '금액 입력 없음' };

  const amount = Math.max(0.01, Math.round(amountUsd * 100) / 100);
  setInputValue(input, amount.toFixed(2));
  await new Promise((r) => setTimeout(r, 400));

  const btn = findBuyButton(panel);
  if (!btn) return { success: false, reason: 'Buy 버튼 없음' };
  robustClick(btn);
  await new Promise((r) => setTimeout(r, 500));
  return { success: true, btnText: (btn.textContent || '').trim().slice(0, 40) };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, site: 'polymarket', version: '5.0' });
    return false;
  }
  if (msg.type === 'READ_SLIP') {
    sendResponse({ slip: readPolymarketSlip() });
    return false;
  }
  if (msg.type === 'PLACE_BET') {
    placePolymarketBet(msg.amount).then(sendResponse);
    return true;
  }
});

(function observe() {
  let last = '';
  let timer = null;
  function tick() {
    const slip = readPolymarketSlip();
    if (!slip) return;
    const key = `${slip.odds}_${slip.stake}_${slip.payout}`;
    if (key === last) return;
    last = key;
    try { chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: 'polymarket', slip }); } catch (_) {}
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, 50);
  }
  if (document.body) {
    new MutationObserver(schedule).observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true
    });
    document.addEventListener('input', schedule, true);
    schedule();
  }
})();

console.log('[Poly v5] content script loaded');
