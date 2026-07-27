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

function readStake(scope) {
  const root = scope || document;
  for (const inp of root.querySelectorAll('input')) {
    const v = parseFloat(String(inp.value || '').replace(/,/g, ''));
    if (v > 0) return v;
  }
  const t = (root.innerText || '').replace(/\s+/g, ' ');
  const m = t.match(/amount[^$\d]{0,20}\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  return null;
}

function readToWinAndPrice(scope) {
  const t = (scope?.innerText || document.body?.innerText || '').replace(/\s+/g, ' ');
  let toWin = null;
  const twMatches = [...t.matchAll(/to\s*win[^$]{0,40}\$\s*([\d,]+(?:\.\d+)?)/gi)];
  if (twMatches.length) {
    const values = twMatches
      .map((m) => parseFloat(m[1].replace(/,/g, '')))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (values.length) toWin = Math.max(...values);
  }

  let price = null;
  const avg = t.match(/avg(?:\.|erage)?\s*price[^0-9]*(\d+(?:\.\d+)?)\s*¢/i);
  if (avg) price = parseFloat(avg[1]) / 100;
  if (!price) {
    const cents = t.match(/(\d{1,2}(?:\.\d+)?)\s*¢/g);
    if (cents && cents.length) {
      price = parseCentsPrice(cents[cents.length - 1]);
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
  // ¢ 가격이 있으면 1/price가 가장 정확 (To win 파싱 오류 방지)
  if (price && price > 0 && price < 1) {
    const dec = priceToDecimal(price);
    if (dec) {
      const payout = stake ? stake * dec : null;
      const profit = payout != null && stake ? payout - stake : null;
      return { odds: dec, payout, profit };
    }
  }

  if (stake && toWin) {
    // To win이 stake보다 훨씬 작으면 잘못 파싱된 값일 가능성이 큼
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
    for (const btn of document.querySelectorAll('button')) {
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
      if (!price) price = p;
    }
  }

  const { odds, payout, profit } = calcOddsFromStake(stake, toWin, price);
  const priceCents = price != null ? Math.round(price * 100) : null;
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
    hint: stake && profit != null
      ? `베팅 $${stake} → 수령 $${(payout || stake + profit).toFixed(2)}`
      : (stake ? '' : '금액 입력 필요')
  };
}

async function placePolymarketBet(amountUsd) {
  try {
    const panel = findTradePanel() || document;
    const inputs = Array.from(panel.querySelectorAll('input')).filter(isVisible);
    const amountInput = inputs[0];
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
    sendResponse({ ok: true, href: location.href, site: 'polymarket', version: '1.3' });
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

console.log('[Polymarket봇] content script v1.3');
