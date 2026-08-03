/**
 * iframe.contentDocument 또는 현재 document 기준 query.
 * selector 문자열은 기존과 동일 — 컨텍스트(root)만 분리.
 */
export function deepQueryAll(root: ParentNode, selector: string): Element[] {
  const seen = new Set<Element>();
  const out: Element[] = [];

  const walk = (node: ParentNode) => {
    for (const el of node.querySelectorAll(selector)) {
      if (!seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    }
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };

  walk(root);
  return out;
}

export function deepQueryOne(root: ParentNode, selector: string): Element | null {
  return deepQueryAll(root, selector)[0] ?? null;
}

export const SLIP_INPUT_SELECTORS = [
  '#counter',
  'input[class*="CounterSecondary_input"]',
  'input[class*="CounterSecondary"]',
  'input[class*="counter__input"]',
  'input[placeholder="베팅금"]',
  'input[placeholder*="베팅"]',
].join(', ');

export const SLIP_CARD_SELECTORS = [
  '[class*="betslip_fe_BetSecondary_bet"]',
  '[class*="BetSecondary_bet"]',
  '[data-testid*="bet-slip"]',
  '[data-testid*="betslip"]',
].join(', ');

export const SLIP_TITLE_SELECTOR = '[class*="betInformation__title"]';

export const SLIP_EVENT_SELECTOR =
  '[class*="betInformation__eventName"], [class*="eventName"]';

export const SLIP_ODDS_SELECTORS = [
  '[class*="UpdateNotification"]',
  '[class*="Selections_odds"]',
  '[class*="odds"]',
  '[class*="Odds"]',
  '[class*="coefficient"]',
  '[class*="Coefficient"]',
].join(', ');

export const BOARD_BUTTON_SELECTOR =
  'button[class*="master_fe_Selections_selection"], button[class*="Selections_selection"]';

export function findSlipBetInput(root: ParentNode = document): HTMLInputElement | null {
  const el = deepQueryOne(root, SLIP_INPUT_SELECTORS);
  return el instanceof HTMLInputElement ? el : null;
}

export function findSlipCards(root: ParentNode = document): Element[] {
  return deepQueryAll(root, SLIP_CARD_SELECTORS).filter((card) => {
    if (card.querySelector(SLIP_INPUT_SELECTORS)) return false;
    const r = card.getBoundingClientRect?.();
    return !!(r && r.width >= 2 && r.height >= 2);
  });
}

export function findSlipObserverRoot(doc: Document = document): ParentNode {
  const input = findSlipBetInput(doc);
  if (input) {
    const anchored =
      input.closest('[class*="betslip_fe"], [class*="Betslip"], [class*="betslip-root"]') ||
      input.closest('[class*="betslip"], [class*="Betslip"]');
    if (anchored) return anchored;
  }
  const cards = findSlipCards(doc);
  if (cards.length) {
    const root =
      cards[0]?.closest('[class*="betslip_fe"], [class*="Betslip"], [class*="betslip-root"]') ||
      cards[0]?.parentElement;
    if (root) return root;
  }
  return doc.body || doc.documentElement;
}

export function readAtOddsFromText(text: string): number | null {
  const m = String(text || '').replace(/\s+/g, ' ').match(/@\s*(\d+\.\d{2,4})/);
  if (!m?.[1]) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 1.01 || n >= 100) return null;
  return Math.round(n * 1000) / 1000;
}

export function readOddsFromSlipCardElement(card: Element): number | null {
  if (/정지된|정지됨|suspended|closed|unavailable/i.test(card.textContent || '')) return null;

  for (const el of deepQueryAll(card, SLIP_ODDS_SELECTORS)) {
    const t = (el.textContent || '').trim();
    if (/^정지된$|^정지$|^Suspended$/i.test(t)) continue;
    if (/^\d+\.\d{2,4}$/.test(t)) {
      console.log('[x10-slip] card odds raw:', JSON.stringify(t));
      const n = parseFloat(t);
      if (n > 1.01 && n < 100) return Math.round(n * 1000) / 1000;
    }
  }
  const at = readAtOddsFromText(card.textContent || '');
  if (at) return at;
  return null;
}
