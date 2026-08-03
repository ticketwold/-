/**
 * Shadow DOM 포함 deep query.
 * BTI Bet Slip: #counter는 shadow walk 있으나 카드/배당 쿼리는 light DOM만 쓰던 부분 보완.
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

/** Bet Slip 금액 입력 — 진단·코드 기준 selector */
export const SLIP_INPUT_SELECTORS = [
  '#counter',
  'input[class*="CounterSecondary_input"]',
  'input[class*="CounterSecondary"]',
  'input[class*="counter__input"]',
  'input[placeholder="베팅금"]',
  'input[placeholder*="베팅"]',
].join(', ');

/** 슬립 선택 카드 — betslip_fe_BetSecondary_bet (wrapper/counter 제외) */
export const SLIP_CARD_SELECTORS = [
  '[class*="betslip_fe_BetSecondary_bet"]',
  '[class*="BetSecondary_bet"]',
  '[data-testid*="bet-slip"]',
  '[data-testid*="betslip"]',
].join(', ');

/** 슬립 카드 내 선택명 */
export const SLIP_TITLE_SELECTOR = '[class*="betInformation__title"]';

/** 슬립 카드 내 이벤트명 */
export const SLIP_EVENT_SELECTOR =
  '[class*="betInformation__eventName"], [class*="eventName"]';

/** 슬립 배당 — @ 1.16 형식 또는 odds span */
export const SLIP_ODDS_SELECTORS = [
  '[class*="UpdateNotification"]',
  '[class*="Selections_odds"]',
  '[class*="odds"]',
  '[class*="Odds"]',
  '[class*="coefficient"]',
  '[class*="Coefficient"]',
].join(', ');

/** 배당판 버튼 (슬립이 아님 — 11.x 잘못 읽기 원인) */
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

export function findSlipObserverRoot(): ParentNode {
  const input = findSlipBetInput();
  if (input) {
    const anchored =
      input.closest('[class*="betslip_fe"], [class*="Betslip"], [class*="betslip-root"]') ||
      input.closest('[class*="betslip"], [class*="Betslip"]');
    if (anchored) return anchored;
  }
  const cards = findSlipCards();
  if (cards.length) {
    const root =
      cards[0]?.closest('[class*="betslip_fe"], [class*="Betslip"], [class*="betslip-root"]') ||
      cards[0]?.parentElement;
    if (root) return root;
  }
  return document.body || document.documentElement;
}

export function readAtOddsFromText(text: string): number | null {
  const m = String(text || '').replace(/\s+/g, ' ').match(/@\s*(\d+\.\d{2,4})/);
  if (!m?.[1]) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 1.01 || n >= 100) return null;
  return Math.round(n * 1000) / 1000;
}

export function readOddsFromSlipCardElement(card: Element): number | null {
  for (const el of deepQueryAll(card, SLIP_ODDS_SELECTORS)) {
    const t = (el.textContent || '').trim();
    if (/^\d+\.\d{2,4}$/.test(t)) {
      const n = parseFloat(t);
      if (n > 1.01 && n < 100) return Math.round(n * 1000) / 1000;
    }
  }
  const at = readAtOddsFromText(card.textContent || '');
  if (at) return at;
  return null;
}
