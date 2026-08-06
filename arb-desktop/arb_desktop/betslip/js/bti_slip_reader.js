/**
 * x10x10s / BTI BetSlip reader — 현재 document(iframe) 내부 betslip 탐색.
 */
(function (options) {
  options = options || {};
  const DEBUG = !!options.debug;
  const SUSPENDED_RE = /정지된|정지됨|마감|closed|suspended|locked|unavailable/i;
  const SLIP_HINT_RE = /betslip|bet-slip|bet_slip|coupon|ticket|selections/i;

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

  function selectorHint(el) {
    if (!el) return '';
    if (el.id) return `#${el.id}`;
    const cls = String(el.className || '').split(/\s+/).filter(Boolean).find((c) => SLIP_HINT_RE.test(c) || /betInformation|BetSecondary/i.test(c));
    if (cls) return `.${cls}`;
    return el.tagName ? el.tagName.toLowerCase() : '';
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
      if (/mybets|bet-history|bethistory|openbets|settledbets|historybets/i.test(blob)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function findSlipRoots() {
    const roots = [];
    const seen = new Set();
    const selectors = [
      '[class*="betslip_fe"]',
      '[class*="Betslip"]',
      '[class*="betslip"]',
      '[class*="bet-slip"]',
      '[class*="coupon"]',
      '[class*="ticket"]',
      '[id*="betslip"]',
      '[data-testid*="betslip"]'
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el) || !visible(el) || isInsideBetHistory(el)) continue;
        const blob = `${el.className || ''} ${el.id || ''}`.toLowerCase();
        if (!SLIP_HINT_RE.test(blob) && !el.querySelector('[class*="betInformation"]')) continue;
        seen.add(el);
        roots.push(el);
      }
    }
    roots.sort((a, b) => text(b).length - text(a).length);
    return roots;
  }

  function getSlipCards(slipRoot) {
    const selectors = [
      '[class*="betslip_fe_BetSecondary_bet"]',
      '[class*="BetSecondary_bet"]',
      '[class*="betInformation"]'
    ];
    const seen = new Set();
    const cards = [];
    for (const sel of selectors) {
      for (const el of slipRoot.querySelectorAll(sel)) {
        if (seen.has(el) || isInsideBetHistory(el)) continue;
        const cn = String(el.className || '');
        if (cn.includes('wrapper') || cn.includes('counter') || cn.includes('badge') || cn.includes('PlaceBet') || cn.includes('Tab')) continue;
        const hasTitle = el.querySelector('[class*="betInformation__title"]');
        const txt = text(el);
        if (!hasTitle && txt.length < 10) continue;
        if (txt.length > 900) continue;
        seen.add(el);
        cards.push(el);
      }
    }
    return cards;
  }

  function detectMarket(marketTitle, selection) {
    const blob = `${marketTitle} ${selection}`;
    if (/오버|언더|over|under|total|O\/U|합계/i.test(blob)) return { market: marketTitle || 'Over/Under', normalized: 'Over/Under', kind: 'over_under' };
    if (/핸디|handicap|spread/i.test(blob)) return { market: marketTitle || 'Handicap', normalized: 'Handicap', kind: 'handicap' };
    if (/승패|승자|winner|moneyline|match winner|우승/i.test(blob)) return { market: marketTitle || 'Moneyline', normalized: 'Moneyline', kind: 'moneyline' };
    return { market: marketTitle || '', normalized: '', kind: 'unknown' };
  }

  function readOddsFromCard(card) {
    if (SUSPENDED_RE.test(text(card))) return null;
    for (const sp of card.querySelectorAll('[class*="UpdateNotification"], [class*="odds"], [class*="Odds"], [class*="price"], [class*="Price"]')) {
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

  function parseCard(card, slipRoot) {
    const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
    const selection = titleEls[0] ? titleEls[0].textContent.trim() : '';
    const marketTitle = titleEls[1] ? titleEls[1].textContent.trim() : '';
    const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
    const event = eventEl ? eventEl.textContent.trim() : '';
    const marketInfo = detectMarket(marketTitle, selection);
    const suspended = SUSPENDED_RE.test(text(card));
    const odds = suspended ? null : readOddsFromCard(card);
    return {
      event,
      market: marketInfo.market,
      market_normalized: marketInfo.normalized,
      selection,
      odds,
      status: suspended ? 'suspended' : (odds ? 'active' : 'odds_missing'),
      stake: readStake(slipRoot) || null,
      market_kind: marketInfo.kind,
      container_selector: selectorHint(card)
    };
  }

  function probe() {
    const frameUrl = location.href;
    const roots = findSlipRoots();
    const probes = roots.map((root) => ({
      container_selector: selectorHint(root),
      card_count: getSlipCards(root).length,
      text_preview: text(root).slice(0, 120)
    }));

    if (!roots.length) {
      return {
        ok: false,
        empty: true,
        items: [],
        reason: 'no-slip-root',
        frame_url: frameUrl,
        can_scan: false,
        probes,
        debug: DEBUG ? { frame_url: frameUrl, probes } : undefined
      };
    }

    for (const root of roots) {
      const cards = getSlipCards(root);
      if (!cards.length) continue;
      const items = [parseCard(cards[cards.length - 1], root)];
      if (items[0].event || items[0].selection) {
        return {
          ok: true,
          empty: false,
          items,
          source: 'dom',
          frame_url: frameUrl,
          container_selector: selectorHint(root),
          can_scan: true,
          probes
        };
      }
    }

    return {
      ok: true,
      empty: true,
      items: [],
      reason: 'empty-slip',
      frame_url: frameUrl,
      container_selector: selectorHint(roots[0]),
      can_scan: true,
      probes
    };
  }

  return probe();
})
