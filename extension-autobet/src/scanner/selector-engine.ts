import { walkElements } from './dom-tree';
import { deepQueryAll } from '../content/bti/shadow-query';
import {
  clampOdds,
  isSuspendedOddsElement,
  isSuspendedOddsText,
  parseOddsString,
} from './odds-parser';
import { BC_WINNER_COEF_ANY, X10_SLIP_CARD, X10_SLIP_ODDS, X10_SLIP_TITLE, X10_STAKE_INPUT } from './stable-selectors';

const AT_ODDS_RE = /@\s*(\d{1,2}\.\d{2,4})/;
const MONEY_RE = /([\d,]+(?:\.\d+)?)/;

export function parseDecimalOdds(text: string, label = ''): number | null {
  return parseOddsString(text, label);
}

export function parseMoney(text: string): number | null {
  const m = String(text || '').replace(/,/g, '').match(MONEY_RE);
  if (!m?.[1]) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normText(s: string): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function textIncludesAny(text: string, needles: string[]): boolean {
  const t = text.toLowerCase();
  return needles.some((n) => t.includes(n.toLowerCase()));
}

export function findStakeInputs(root: ParentNode): HTMLInputElement[] {
  const out: HTMLInputElement[] = [];
  const seen = new Set<Element>();

  walkElements(root, (el) => {
    if (!(el instanceof HTMLInputElement)) return;
    if (seen.has(el)) return;
    seen.add(el);

    const ph = (el.placeholder || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const testId = (el.getAttribute('data-testid') || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const type = (el.type || '').toLowerCase();

    const isStake =
      id === 'counter' ||
      ph.includes('베팅') ||
      ph.includes('stake') ||
      ph.includes('wager') ||
      aria.includes('stake') ||
      aria.includes('wager') ||
      aria.includes('bet amount') ||
      testId.includes('stake') ||
      testId.includes('wager') ||
      testId.includes('amount') ||
      (role === 'spinbutton' && type !== 'hidden');

    if (isStake) out.push(el);
  });

  if (!out.length) {
    try {
      deepQueryAll(root, X10_STAKE_INPUT).forEach((el) => {
        if (el instanceof HTMLInputElement && !seen.has(el)) out.push(el);
      });
    } catch {
      /* ignore */
    }
  }

  return out;
}

/** BTI slip card — stable BEM + @ odds 텍스트 */
export function findX10SlipCards(root: ParentNode): Element[] {
  const cards: Element[] = [];
  const seen = new Set<Element>();

  const addCard = (el: Element) => {
    if (seen.has(el)) return;
    if (isInsideBoardButton(el)) return;
    seen.add(el);
    cards.push(el);
  };

  try {
    deepQueryAll(root, X10_SLIP_CARD).forEach((el) => {
      if (el instanceof Element) addCard(el);
    });
    root.querySelectorAll(X10_SLIP_CARD).forEach((el) => {
      if (el instanceof Element) addCard(el);
    });
  } catch {
    /* ignore */
  }

  walkElements(root, (el) => {
    if (seen.has(el)) return;
    const text = normText(el.textContent || '');
    if (!AT_ODDS_RE.test(text) || text.length > 800) return;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 30 || r.height < 16) return;
    const hasTitle = !!el.querySelector(X10_SLIP_TITLE);
    if (hasTitle || (el.children.length >= 1 && text.length < 500)) addCard(el);
  });

  return cards.filter((c) => !isInsideBoardButton(c));
}

function isInsideBoardButton(el: Element): boolean {
  return !!el.closest('button[class*="Selections_selection"], button[class*="master_fe_Selections_selection"]');
}

export function findSlipCardCandidates(root: ParentNode): Element[] {
  const x10 = findX10SlipCards(root);
  if (x10.length) return x10;

  const cards: Element[] = [];
  const seen = new Set<Element>();

  walkElements(root, (el) => {
    if (seen.has(el)) return;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 20 || r.height < 12) return;

    const testId = (el.getAttribute('data-testid') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const text = normText(el.textContent || '');

    const isSlipMarker =
      testId.includes('bet-slip') ||
      testId.includes('betslip') ||
      aria.includes('bet slip') ||
      aria.includes('betslip');

    const hasAtOdds = AT_ODDS_RE.test(text);

    if (isSlipMarker || (hasAtOdds && text.length < 600)) {
      if (!cards.some((c) => c.contains(el) || el.contains(c))) {
        seen.add(el);
        cards.push(el);
      }
    }
  });

  return cards;
}

/** BC.Game bet__winner-coef — 정지된(suspended) 제외 */
export function findBcWinnerCoefElements(root: ParentNode): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();

  const consider = (el: Element) => {
    if (seen.has(el) || isSuspendedOddsElement(el)) return;
    const text = (el.textContent || '').trim();
    if (isSuspendedOddsText(text)) return;
    const odds = parseOddsString(text, 'bet__winner-coef');
    if (!odds) return;
    seen.add(el);
    out.push(el);
  };

  walkElements(root, (el) => {
    const cls = String(el.className || '');
    if (cls.includes('bet__winner-coef') || el.matches?.('.bet__winner-coef')) {
      consider(el);
    }
  });

  try {
    root.querySelectorAll(BC_WINNER_COEF_ANY).forEach((el) => {
      if (el instanceof Element) consider(el);
    });
  } catch {
    /* ignore */
  }

  return out;
}

export function findBetSlipContainer(_root: ParentNode, anchor: Element): Element {
  let node: Element | null = anchor;
  for (let i = 0; i < 12 && node; i++) {
    const testId = (node.getAttribute('data-testid') || '').toLowerCase();
    const aria = (node.getAttribute('aria-label') || '').toLowerCase();
    const cls = String(node.className || '');
    const tag = node.tagName.toLowerCase();
    if (
      testId.includes('betslip') ||
      testId.includes('bet-slip') ||
      aria.includes('bet slip') ||
      aria.includes('betslip') ||
      cls.includes('betslip') ||
      cls.includes('bet-slip') ||
      tag === 'aside'
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return anchor.parentElement || anchor;
}

export function readOddsFromElement(el: Element): number | null {
  if (isSuspendedOddsElement(el)) return null;

  const direct = parseOddsString((el.textContent || '').trim(), 'element');
  if (direct) return direct;

  for (const sel of [X10_SLIP_ODDS, '[data-testid*="odds"]', '[aria-label*="odds"]', '[role="status"]']) {
    try {
      for (const child of el.querySelectorAll(sel)) {
        if (isSuspendedOddsElement(child)) continue;
        const t = normText(child.textContent || '');
        const n = parseOddsString(t, sel);
        if (n) return n;
      }
    } catch {
      /* ignore */
    }
  }

  let found: number | null = null;
  walkElements(el, (child) => {
    if (found != null || child === el || isSuspendedOddsElement(child)) return;
    const t = normText(child.textContent || '');
    const n = parseOddsString(t, 'child');
    if (n) found = n;
  });
  return found;
}

export function readLabelAdjacentNumber(root: ParentNode, labels: string[]): number | null {
  let found: number | null = null;
  walkElements(root, (el) => {
    if (found != null) return;
    const text = normText(el.textContent || '');
    if (!textIncludesAny(text, labels) || text.length > 120) return;
    const sib = el.nextElementSibling;
    if (sib) {
      const n = parseMoney(sib.textContent || '');
      if (n) found = n;
    }
    const parent = el.parentElement;
    if (parent && found == null) {
      const n = parseMoney(parent.textContent || '');
      if (n && n > 1) found = n;
    }
  });
  return found;
}

export function findBetButtons(root: ParentNode): Element[] {
  const out: Element[] = [];
  walkElements(root, (el) => {
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return;
    const text = normText(el.textContent || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if (
      textIncludesAny(text, ['place bet', 'bet now', '베팅', '배팅', 'confirm', '베팅하기']) ||
      textIncludesAny(aria, ['place bet', 'bet'])
    ) {
      out.push(el);
    }
  });
  return out;
}

export function readSelectionFromX10Card(card: Element): string {
  const title = card.querySelector(X10_SLIP_TITLE)?.textContent?.trim();
  if (title) return normText(title);
  return readSelectionFromGeneric(card);
}

export function readSelectionFromGeneric(card: Element): string {
  const title =
    card.querySelector('[data-testid*="selection"], [data-testid*="outcome"], [aria-label*="selection"]')
      ?.textContent?.trim() || '';
  if (title) return normText(title);

  const lines = normText(card.textContent || '')
    .split(/\s{2,}|@/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 80 && !/^\d+\.\d+$/.test(s) && !isSuspendedOddsText(s));
  return lines[0] || '';
}

export { clampOdds, isSuspendedOddsElement, isSuspendedOddsText };
