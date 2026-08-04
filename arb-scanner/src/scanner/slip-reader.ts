import type { SiteId, SlipState } from '@core/types';
import { queryAllDeep, walkElements } from './dom-walker';
import { parseOddsText, readOddsFromElement } from './odds-parser';
import { SEL } from './stable-selectors';

function isVisible(el: Element): boolean {
  try {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  } catch {
    /* ignore */
  }
  return true;
}

function findX10Stake(doc: Document): HTMLInputElement | null {
  for (const el of queryAllDeep(doc, SEL.x10.stake)) {
    if (el instanceof HTMLInputElement && el.type !== 'hidden') return el;
  }
  return null;
}

function findBcStake(doc: Document): HTMLInputElement | null {
  for (const el of queryAllDeep(doc, SEL.bc.stake)) {
    if (el instanceof HTMLInputElement && el.type !== 'hidden') return el;
  }
  return null;
}

function closestMatch(el: Element, selectors: string): Element | null {
  for (const sel of selectors.split(',').map((s) => s.trim())) {
    if (!sel) continue;
    try {
      const found = el.closest(sel);
      if (found) return found;
    } catch {
      /* invalid selector */
    }
  }
  return null;
}

function hasStakeDescendant(card: Element): boolean {
  for (const sel of SEL.x10.stake.split(',').map((s) => s.trim())) {
    if (!sel || sel.startsWith('#')) continue;
    if (card.querySelector(sel)) return true;
  }
  return false;
}

function findX10SlipCards(doc: Document): Element[] {
  return queryAllDeep(doc, SEL.x10.slipCard).filter((card) => {
    if (!isVisible(card)) return false;
    if (card.closest(SEL.x10.boardBtn.split(',')[0]!.trim())) return false;
    if (hasStakeDescendant(card)) return false;
    return true;
  });
}

function slipFromInnerText(doc: Document, siteId: SiteId): SlipState | null {
  const text = doc.body?.innerText || '';
  if (!/bet\s*slip|betslip|베팅\s*슬립|배팅카트|bet\s*cart/i.test(text)) return null;
  const matches = [...text.matchAll(/@\s*(\d{1,2}\.\d{2,4})/g)]
    .map((m) => parseOddsText(m[1] || ''))
    .filter((n): n is number => n != null && n > 1.01);
  if (!matches.length) {
    const dec = [...text.matchAll(/\b(\d{1,2}\.\d{2,3})\b/g)]
      .map((m) => parseOddsText(m[1] || ''))
      .filter((n): n is number => n != null && n > 1.01 && n < 20);
    if (!dec.length) return null;
    matches.push(dec[dec.length - 1]!);
  }
  const odds = matches[matches.length - 1]!;
  const stakeEl = siteId === 'x10' ? findX10Stake(doc) : findBcStake(doc);
  return {
    odds,
    selection: 'slip',
    eventName: text.split('\n').find((l) => l.trim().length > 8)?.trim().slice(0, 80) || 'text-slip',
    stake: stakeEl
      ? siteId === 'x10'
        ? parseInt(stakeEl.value || '0', 10) || 0
        : parseFloat(stakeEl.value || '0') || 0
      : 0,
    source: 'slip',
    updatedAt: Date.now(),
  };
}

function readOddsFromContainer(container: Element): number | null {
  for (const sel of SEL.x10.oddsHints.split(', ')) {
    for (const el of queryAllDeep(container, sel.trim())) {
      const odds = readOddsFromElement(el);
      if (odds) return odds;
    }
  }
  return parseOddsText(container.textContent || '');
}

function findX10SlipRoot(doc: Document): Element | null {
  const stake = findX10Stake(doc);
  if (stake) {
    const root =
      closestMatch(stake, '[class*="betslip_fe"], [class*="Betslip"], [class*="betslip-root"], [class*="betslip"], aside, section') ||
      stake.parentElement;
    if (root) return root;
  }
  const cards = findX10SlipCards(doc);
  if (cards.length) {
    const card = cards[cards.length - 1]!;
    return (
      closestMatch(card, '[class*="betslip_fe"], [class*="Betslip"], [class*="betslip-root"], [class*="betslip"], aside') ||
      card
    );
  }
  return null;
}

export function readX10SlipFromDoc(doc: Document = document): SlipState | null {
  const cards = findX10SlipCards(doc);
  const card = cards[cards.length - 1];
  const stakeEl = findX10Stake(doc);

  if (card) {
    const odds = readOddsFromContainer(card);
    if (odds) {
      return {
        odds,
        selection: card.querySelector(SEL.x10.slipTitle)?.textContent?.trim() || 'slip',
        eventName: card.querySelector(SEL.x10.slipEvent)?.textContent?.trim() || '',
        stake: stakeEl ? parseInt(stakeEl.value || '0', 10) || 0 : 0,
        source: 'slip',
        updatedAt: Date.now(),
      };
    }
  }

  const root = findX10SlipRoot(doc);
  if (root) {
    const odds = readOddsFromContainer(root);
    if (odds) {
      return {
        odds,
        selection: root.querySelector(SEL.x10.slipTitle)?.textContent?.trim() || 'slip',
        eventName: root.querySelector(SEL.x10.slipEvent)?.textContent?.trim() || '',
        stake: stakeEl ? parseInt(stakeEl.value || '0', 10) || 0 : 0,
        source: 'slip',
        updatedAt: Date.now(),
      };
    }
  }

  return slipFromInnerText(doc, 'x10');
}

function findBcCoefElements(doc: Document): Element[] {
  const fromSelector = queryAllDeep(doc, SEL.bc.winnerCoef);
  if (fromSelector.length) return fromSelector;

  const fromWalk: Element[] = [];
  walkElements(doc.body || doc.documentElement, (el) => {
    const cls = String(el.className || '');
    if (/bet__winner-coef/i.test(cls)) fromWalk.push(el);
  });
  return fromWalk;
}

function readBcPayoutOdds(doc: Document): number | null {
  const text = doc.body?.innerText || '';
  const stakeM = text.match(/(?:총\s*베팅|total\s*stake|stake)\s*[:=]?\s*([\d,.]+)/i);
  const payoutM = text.match(/(?:예상\s*당첨|potential|payout|return)\s*[:=]?\s*([\d,.]+)/i);
  if (!stakeM?.[1] || !payoutM?.[1]) return null;
  const stake = parseFloat(stakeM[1].replace(/,/g, ''));
  const payout = parseFloat(payoutM[1].replace(/,/g, ''));
  if (!stake || !payout || stake <= 0) return null;
  return parseOddsText(String(Math.round((payout / stake) * 1000) / 1000));
}

export function readBcSlipFromDoc(doc: Document = document): SlipState | null {
  const coefs = findBcCoefElements(doc);
  const el = coefs[coefs.length - 1];
  if (el) {
    const odds = readOddsFromElement(el);
    if (!odds) return null;
    const root = closestMatch(el, SEL.bc.slipRoot) || el.parentElement;
    const stakeEl = findBcStake(doc);
    return {
      odds,
      selection: root?.querySelector(SEL.bc.selection)?.textContent?.trim() || 'slip',
      eventName: root?.querySelector(SEL.bc.event)?.textContent?.trim() || 'bc-slip',
      stake: stakeEl ? parseFloat(stakeEl.value || '0') || 0 : 0,
      source: 'slip',
      updatedAt: Date.now(),
    };
  }

  const slipRoot = queryAllDeep(doc, SEL.bc.slipRoot).find(isVisible);
  if (slipRoot) {
    const text = slipRoot.textContent || '';
    const labeled = text.match(/(?:total\s*odds?|combined\s*odds?|@)\s*(\d+\.\d{2,3})/i);
    const odds = labeled ? parseOddsText(labeled[1]) : parseOddsText(text);
    if (odds) {
      const stakeEl = findBcStake(doc);
      return {
        odds,
        selection: slipRoot.querySelector(SEL.bc.selection)?.textContent?.trim() || 'slip',
        eventName: slipRoot.querySelector(SEL.bc.event)?.textContent?.trim() || 'bc-slip',
        stake: stakeEl ? parseFloat(stakeEl.value || '0') || 0 : 0,
        source: 'slip',
        updatedAt: Date.now(),
      };
    }
  }

  return slipFromInnerText(doc, 'bcgame') ?? (() => {
    const odds = readBcPayoutOdds(doc);
    if (!odds) return null;
    const stakeEl = findBcStake(doc);
    return {
      odds,
      selection: 'slip',
      eventName: 'bc-payout',
      stake: stakeEl ? parseFloat(stakeEl.value || '0') || 0 : 0,
      source: 'slip' as const,
      updatedAt: Date.now(),
    };
  })();
}

export function readSlipFromDoc(siteId: SiteId, doc: Document = document): SlipState | null {
  return siteId === 'x10' ? readX10SlipFromDoc(doc) : readBcSlipFromDoc(doc);
}
