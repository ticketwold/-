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
  return candidates[0]?.inp || root.querySelector('input');
}

function setInputValue(input, value) {
  const str = String(value);
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, str);
  else input.value = str;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  try {
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
  } catch (_) {}
}

function isBuyButton(btn) {
  if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
  const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
  const aria = (btn.getAttribute('aria-label') || '').trim();
  if (/sell/i.test(t) && !/buy/i.test(t)) return false;
  if (/^buy\b/i.test(t) || /^buy\s/i.test(t)) return true;
  if (/^buy\b/i.test(aria)) return true;
  if (t === 'Buy' || t.startsWith('Buy ')) return true;
  if (/매수/.test(t)) return true;
  return false;
}

function findBuyButton(scope) {
  const root = scope || findTradePanel() || document;
  const searchRoots = [root];
  if (root !== document) searchRoots.push(document);

  for (const r of searchRoots) {
    for (const btn of r.querySelectorAll('button, [role="button"]')) {
      if (isBuyButton(btn)) return btn;
    }
  }
  return null;
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

    setInputValue(amountInput, amount.toFixed(2));
    await new Promise((r) => setTimeout(r, 500));

    let betBtn = null;
    for (let i = 0; i < 35; i++) {
      betBtn = findBuyButton(panel) || findBuyButton(document);
      if (betBtn && !betBtn.disabled) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!betBtn) {
      const debug = Array.from(document.querySelectorAll('button'))
        .filter(isVisible)
        .slice(0, 10)
        .map((b) => `"${(b.textContent || '').trim().slice(0, 28)}"`)
        .join(' | ');
      return { success: false, reason: `Buy 버튼 없음 | ${debug}` };
    }

    betBtn.click();
    const btnText = (betBtn.textContent || '').trim().slice(0, 40);
    await new Promise((r) => setTimeout(r, 500));

    for (let i = 0; i < 25; i++) {
      const confirmBtn = findConfirmButton();
      if (confirmBtn) {
        confirmBtn.click();
        await new Promise((r) => setTimeout(r, 600));
        return { success: true, btnText, confirmed: true };
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    return { success: true, btnText, confirmed: false };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, href: location.href, site: 'polymarket', version: '1.4' });
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

console.log('[Polymarket봇] content script v1.4');
