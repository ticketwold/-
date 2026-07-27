// Polymarket content script — 슬립 읽기 / 베팅 실행

function parseCentsPrice(text) {
  const t = String(text || '').trim();
  const cent = t.match(/(\d{1,2}(?:\.\d)?)\s*¢/);
  if (cent) return parseFloat(cent[1]) / 100;
  const pct = t.match(/(\d{1,2}(?:\.\d)?)\s*%/);
  if (pct) return parseFloat(pct[1]) / 100;
  const n = parseFloat(t);
  if (n > 0 && n < 1) return n;
  if (n > 1 && n <= 99) return n / 100;
  return null;
}

function priceToDecimal(price) {
  if (!price || price <= 0 || price >= 1) return null;
  return 1 / price;
}

function readPolymarketSlip() {
  const bodyText = document.body?.innerText || '';
  let outcome = '';
  let price = null;
  let side = 'yes';

  const selected = document.querySelector(
    '[data-testid*="outcome"][aria-pressed="true"], ' +
    '[class*="selected"][class*="Outcome"], ' +
    'button[aria-selected="true"]'
  );
  if (selected) {
    outcome = (selected.getAttribute('aria-label') || selected.textContent || '').trim().slice(0, 120);
    price = parseCentsPrice(selected.textContent) || parseCentsPrice(selected.getAttribute('aria-label'));
  }

  if (!outcome) {
    const yesBtns = Array.from(document.querySelectorAll('button')).filter((b) => {
      const t = (b.textContent || '').trim();
      return /^yes\b/i.test(t) || t.includes('Yes');
    });
    const active = yesBtns.find((b) =>
      b.getAttribute('aria-pressed') === 'true' ||
      b.className.includes('selected') ||
      b.getAttribute('data-state') === 'on'
    );
    if (active) {
      outcome = active.textContent.trim().slice(0, 120);
      price = parseCentsPrice(active.textContent);
      side = 'yes';
    }
  }

  if (!price) {
    const m = bodyText.match(/(?:Buy|매수|Price|가격)[^\d]*(\d{1,2}(?:\.\d)?)\s*¢/i);
    if (m) price = parseFloat(m[1]) / 100;
  }

  if (!outcome) {
    const h1 = document.querySelector('h1, [class*="question"], [class*="Question"]');
    if (h1) outcome = h1.textContent.trim().slice(0, 120);
  }

  const odds = priceToDecimal(price);
  if (!odds || odds <= 1.01) return null;

  return {
    odds,
    price,
    outcome,
    side,
    marketKind: 'ml',
    period: 'ft',
    selectionText: outcome,
    marketKey: `poly_${side}_${(outcome || 'out').slice(0, 20)}`
  };
}

async function placePolymarketBet(amountUsd) {
  try {
    const inputs = Array.from(document.querySelectorAll('input')).filter((inp) => {
      const ph = (inp.placeholder || '').toLowerCase();
      const name = (inp.name || '').toLowerCase();
      return inp.offsetParent !== null && (
        ph.includes('amount') || ph.includes('usdc') || ph.includes('금액') ||
        name.includes('amount') || inp.type === 'number'
      );
    });
    const amountInput = inputs[0];
    if (!amountInput) return { success: false, reason: '금액 입력 필드 없음' };

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(amountInput, String(amountUsd));
    else amountInput.value = String(amountUsd);
    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    amountInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));

    const btns = Array.from(document.querySelectorAll('button:not([disabled])'));
    let betBtn = btns.find((b) => /^(Buy|매수|Place|Confirm|확인)/i.test(b.textContent.trim()));
    if (!betBtn) {
      betBtn = btns.find((b) => /buy/i.test(b.textContent) && b.textContent.length < 40);
    }
    if (!betBtn) return { success: false, reason: 'Buy/확인 버튼 없음' };
    betBtn.click();
    await new Promise((r) => setTimeout(r, 1500));
    return { success: true };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, href: location.href, site: 'polymarket', version: '1.0' });
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
    const key = `${slip.odds}_${slip.marketKey}`;
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
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  }
})();

console.log('[Polymarket봇] content script 로드됨');
