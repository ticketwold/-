/**
 * x10x10s / BTI BetSlip reader — 배팅카트 컨테이너 내부만 탐색.
 * 배당판(board) 스캔 금지. 슬립 카드 DOM만 사용.
 */
(function () {
  const SUSPENDED_RE = /정지된|정지됨|마감|closed|suspended|locked|unavailable/i;

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    } catch (_) {}
    return true;
  }

  function text(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function parseOdds(raw) {
    const t = String(raw || '').trim();
    const n = parseFloat(t);
    if (!n || n <= 1.01 || n >= 100) return null;
    if (!/^\d+(\.\d{1,4})?$/.test(t)) return null;
    return n;
  }

  function isStruckThrough(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const cs = window.getComputedStyle(el);
      if ((cs.textDecorationLine || '').includes('line-through')) return true;
      if ((cs.textDecoration || '').includes('line-through')) return true;
    } catch (_) {}
    const cn = String(el.className || '');
    if (/old|previous|strike|strikethrough|deprecated|crossed/i.test(cn)) return true;
    const parent = el.parentElement;
    if (parent && parent !== el) return isStruckThrough(parent);
    return false;
  }

  function isInsideBetHistory(el) {
    let node = el;
    for (let i = 0; i < 18 && node; i++) {
      const blob = `${node.className || ''} ${node.id || ''} ${node.getAttribute?.('data-testid') || ''}`.toLowerCase();
      if (/mybets|my-bets|bet-history|bethistory|openbets|settledbets|historybets|pastbets/i.test(blob)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function findSlipRoot() {
    const roots = [];
    for (const el of document.querySelectorAll('[class*="betslip_fe"], [class*="Betslip"], [class*="betslip"]')) {
      if (!visible(el) || isInsideBetHistory(el)) continue;
      roots.push(el);
    }
    if (!roots.length) return null;
    roots.sort((a, b) => text(b).length - text(a).length);
    return roots[0];
  }

  function getSlipCards(slipRoot) {
    const selectors = [
      '[class*="betslip_fe_BetSecondary_bet"]',
      '[class*="BetSecondary_bet"]'
    ];
    const seen = new Set();
    const cards = [];
    for (const sel of selectors) {
      for (const el of slipRoot.querySelectorAll(sel)) {
        if (seen.has(el) || isInsideBetHistory(el)) continue;
        const cn = String(el.className || '');
        if (cn.includes('wrapper') || cn.includes('counter') || cn.includes('badge') || cn.includes('PlaceBet') || cn.includes('Tab')) continue;
        const hasTitle = el.querySelector('[class*="betInformation__title"]');
        if (!hasTitle) continue;
        seen.add(el);
        cards.push(el);
      }
    }
    return cards;
  }

  function readOddsFromCard(card) {
    if (SUSPENDED_RE.test(text(card))) return null;

    for (const sp of card.querySelectorAll('[class*="UpdateNotification"]')) {
      if (isStruckThrough(sp)) continue;
      const n = parseOdds(sp.textContent);
      if (n) return n;
    }

    for (const sp of card.querySelectorAll('[class*="odds"], [class*="Odds"], [class*="price"], [class*="Price"]')) {
      if (isStruckThrough(sp)) continue;
      const n = parseOdds(sp.textContent);
      if (n) return n;
    }

    const atM = text(card).match(/@\s*(\d+(?:\.\d{1,4})?)/);
    if (atM) {
      const n = parseOdds(atM[1]);
      if (n) return n;
    }

    for (const sp of card.querySelectorAll('span, div, b, strong, p')) {
      if (isStruckThrough(sp)) continue;
      const t = (sp.textContent || '').trim();
      if (!/^\d+\.\d{2,3}$/.test(t)) continue;
      const n = parseOdds(t);
      if (n) return n;
    }
    return null;
  }

  function readStake(slipRoot) {
    const input = slipRoot.querySelector('input#counter, input[class*="CounterSecondary_input"], input[class*="counter__input"], input[placeholder*="베팅"]');
    if (!input) return 0;
    const raw = String(input.value || '').replace(/,/g, '').trim();
    const v = parseInt(raw, 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function cardStatus(card) {
    const t = text(card);
    if (SUSPENDED_RE.test(t)) return 'suspended';
    if (/^정지된$|^정지$|^마감$|^Suspended$|^Closed$/i.test(t)) return 'suspended';
    for (const sp of card.querySelectorAll('span, div, label')) {
      const label = (sp.textContent || '').trim();
      if (/^정지된$|^정지$|^마감$|^Suspended$|^Closed$/i.test(label)) return 'suspended';
    }
    const odds = readOddsFromCard(card);
    return odds ? 'active' : 'odds_missing';
  }

  function parseCard(card, slipRoot) {
    const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
    const selection = titleEls[0] ? titleEls[0].textContent.trim() : '';
    const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
    const event = eventEl ? eventEl.textContent.trim() : '';
    const status = cardStatus(card);
    const odds = status === 'suspended' ? null : readOddsFromCard(card);
    return {
      event,
      selection,
      odds,
      status,
      stake: readStake(slipRoot) || null
    };
  }

  function readBtiBetSlip() {
    const slipRoot = findSlipRoot();
    if (!slipRoot) {
      return { ok: false, empty: true, items: [], reason: 'no-slip-root' };
    }

    const cards = getSlipCards(slipRoot);
    if (!cards.length) {
      return { ok: true, empty: true, items: [], reason: 'empty-slip' };
    }

    const items = [parseCard(cards[cards.length - 1], slipRoot)];
    return {
      ok: true,
      empty: false,
      items,
      source: 'dom',
      reason: ''
    };
  }

  return readBtiBetSlip();
})();
