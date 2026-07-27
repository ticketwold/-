// Polymarket content script — ¢ 가격 / 주문패널 / 당첨금 기반 슬립 읽기

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

function isHighlightedButton(btn) {
  if (!btn || btn.disabled) return false;
  if (btn.getAttribute('aria-pressed') === 'true') return true;
  if (btn.getAttribute('data-state') === 'on' || btn.getAttribute('data-state') === 'checked') return true;
  if (/\bselected\b/i.test(btn.className)) return true;
  try {
    const bg = getComputedStyle(btn).backgroundColor;
    if (bg && !/rgba?\(\s*0\s*,\s*0\s*,\s*0|transparent/i.test(bg)) {
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const r = +m[1], g = +m[2], b = +m[3];
        if (r > 120 || g > 80 || b > 120) return true;
      }
    }
  } catch (_) {}
  return false;
}

function findTradePanel() {
  const selectors = [
    '[class*="TradingWidget"]',
    '[class*="trading-widget"]',
    '[class*="TradeForm"]',
    '[class*="trade-form"]',
    '[class*="OrderPanel"]',
    '[class*="order-panel"]',
    '[data-testid*="trade"]',
    'aside'
  ];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const t = el.textContent || '';
      if (!el.querySelector('input')) continue;
      if (/to win|you.ll receive|buy|shares|amount|avg/i.test(t)) return el;
    }
  }
  return null;
}

function scrapeMoneylineButtons() {
  const out = [];
  const body = document.body?.innerText || '';
  const sections = Array.from(document.querySelectorAll('h2, h3, h4, div, span, p')).filter((el) => {
    const t = (el.textContent || '').trim();
    return /^moneyline$/i.test(t) || /^series lines$/i.test(t);
  });

  let root = document.body;
  if (sections.length) {
    let p = sections[0].parentElement;
    for (let i = 0; i < 4 && p; i++) {
      if (p.querySelectorAll('button').length >= 2) { root = p; break; }
      p = p.parentElement;
    }
  }

  for (const btn of root.querySelectorAll('button')) {
    const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt || txt.includes('--')) continue;
    const price = parseCentsPrice(txt);
    if (price === null) continue;
    const team = txt.replace(/\d+(?:\.\d+)?\s*¢.*$/, '').trim();
    if (!team || team.length > 40) continue;
    out.push({ btn, team, price, priceCents: Math.round(price * 100), text: txt, highlighted: isHighlightedButton(btn) });
  }
  return out;
}

function readStakeFromPanel(panel) {
  const scope = panel || document;
  for (const inp of scope.querySelectorAll('input')) {
    if (inp.offsetParent === null) continue;
    const ph = (inp.placeholder || '').toLowerCase();
    const raw = String(inp.value || '').replace(/,/g, '').trim();
    const v = parseFloat(raw);
    if (v > 0) return v;
    if (ph.includes('amount') || ph.includes('usdc') || inp.type === 'number') {
      if (v > 0) return v;
    }
  }
  return null;
}

function readPayoutFromPanel(panel) {
  const text = (panel?.innerText || document.body?.innerText || '').replace(/\s+/g, ' ');
  let stake = null;
  let toWin = null;
  let payout = null;

  const toWinM = text.match(/(?:to win|you(?:'|')?ll receive|potential profit|profit)\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (toWinM) toWin = parseFloat(toWinM[1].replace(/,/g, ''));

  const payoutM = text.match(/(?:payout|total return|receive)\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (payoutM) payout = parseFloat(payoutM[1].replace(/,/g, ''));

  const sharesM = text.match(/([\d,]+(?:\.\d+)?)\s*shares?\s*@\s*(\d+(?:\.\d+)?)\s*¢/i);
  if (sharesM) {
    const shares = parseFloat(sharesM[1].replace(/,/g, ''));
    const p = parseFloat(sharesM[2]) / 100;
    if (shares > 0 && p > 0) {
      stake = shares * p;
      payout = shares * 1;
      toWin = payout - stake;
    }
  }

  return { stake, toWin, payout };
}

function readPolymarketSlip() {
  const panel = findTradePanel();
  const stakeFromInput = readStakeFromPanel(panel);
  const { stake: stakeFromText, toWin, payout: payoutFromText } = readPayoutFromPanel(panel);
  const stake = stakeFromInput || stakeFromText;

  const mlButtons = scrapeMoneylineButtons();
  let pick = mlButtons.find((b) => b.highlighted);
  if (!pick && mlButtons.length === 2) {
    const panelText = (panel?.textContent || '').toLowerCase();
    pick = mlButtons.find((b) => panelText.includes(b.team.toLowerCase().slice(0, 4)));
  }

  let price = pick?.price ?? null;
  let teamLabel = pick?.team || '';
  let priceCents = pick?.priceCents ?? null;

  if (!price && panel) {
    const avgM = (panel.textContent || '').match(/avg(?:\.|erage)?\s*price[:\s]*(\d+(?:\.\d+)?)\s*¢/i);
    if (avgM) {
      price = parseFloat(avgM[1]) / 100;
      priceCents = Math.round(price * 100);
    }
  }

  const panelText = panel?.textContent || '';
  const buyM = panelText.match(/(?:Buy|매수)\s+(?:Yes|No)?\s*[·•\-]?\s*([^\n]+)/i);
  if (buyM && !teamLabel) teamLabel = buyM[1].trim().slice(0, 80);

  let payout = payoutFromText;
  if (!payout && stake && toWin) payout = stake + toWin;
  if (!payout && stake && price) payout = stake / price;

  let odds = null;
  if (stake && payout && payout > stake) {
    odds = payout / stake;
  } else if (price) {
    odds = priceToDecimal(price);
  }

  const eventTitle = document.querySelector('h1')?.textContent?.trim() || '';

  if (!price && !odds) return null;

  const base = {
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
      ? `${teamLabel} @ ${priceCents != null ? priceCents + '¢' : ''}`
      : (priceCents != null ? `${priceCents}¢` : ''),
    stake: stake || null,
    toWin: toWin || (payout && stake ? payout - stake : null),
    payout: payout || null
  };

  if (!odds || odds <= 1.001) {
    return {
      ...base,
      odds: price ? priceToDecimal(price) : null,
      needsStake: !stake,
      hint: stake ? '당첨금 계산 중…' : '금액 입력 후 당첨금이 표시됩니다'
    };
  }

  return {
    ...base,
    odds,
    displayLabel: priceCents != null
      ? `${priceCents}¢ (${odds.toFixed(3)})`
      : odds.toFixed(3),
    hint: stake && toWin != null ? `당첨 $${toWin.toFixed(2)}` : null
  };
}

async function placePolymarketBet(amountUsd) {
  try {
    const panel = findTradePanel() || document;
    const inputs = Array.from(panel.querySelectorAll('input')).filter((inp) => inp.offsetParent !== null);
    const amountInput = inputs.find((inp) => {
      const ph = (inp.placeholder || '').toLowerCase();
      return ph.includes('amount') || ph.includes('usdc') || inp.type === 'number';
    }) || inputs[0];

    if (!amountInput) return { success: false, reason: '금액 입력 필드 없음' };

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(amountInput, String(amountUsd));
    else amountInput.value = String(amountUsd);
    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    amountInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));

    const btns = Array.from(document.querySelectorAll('button:not([disabled])'));
    const betBtn = btns.find((b) => /^(Buy|매수|Place|Confirm)/i.test(b.textContent.trim()))
      || btns.find((b) => /\bbuy\b/i.test(b.textContent) && b.textContent.length < 50);
    if (!betBtn) return { success: false, reason: 'Buy 버튼 없음' };
    betBtn.click();
    await new Promise((r) => setTimeout(r, 1500));
    return { success: true };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, href: location.href, site: 'polymarket', version: '1.1' });
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
    timer = setTimeout(check, 50);
  }
  if (document.body) {
    const obs = new MutationObserver(schedule);
    obs.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'value', 'aria-pressed', 'data-state']
    });
    document.addEventListener('input', schedule, true);
    check();
  }
})();

console.log('[Polymarket봇] content script v1.1 (¢/슬립/당첨금)');
