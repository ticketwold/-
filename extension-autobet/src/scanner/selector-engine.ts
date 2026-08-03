import { walkElements } from './dom-tree';

const ODDS_DECIMAL_RE = /\b(\d{1,2}\.\d{2,4})\b/;
const AT_ODDS_RE = /@\s*(\d{1,2}\.\d{2,4})/;
const MONEY_RE = /([\d,]+(?:\.\d+)?)/;

export function parseDecimalOdds(text: string): number | null {
  const t = String(text || '').replace(/\s+/g, ' ');
  const at = t.match(AT_ODDS_RE);
  if (at?.[1]) return clampOdds(parseFloat(at[1]));
  const m = t.match(ODDS_DECIMAL_RE);
  if (m?.[1]) return clampOdds(parseFloat(m[1]));
  return null;
}

export function clampOdds(n: number): number | null {
  if (!Number.isFinite(n) || n <= 1.01 || n >= 100) return null;
  return Math.round(n * 1000) / 1000;
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

/** id, data-*, aria, role, placeholder 기반 — CSS module class 해시 미사용 */
export function findStakeInputs(root: ParentNode): HTMLInputElement[] {
  const out: HTMLInputElement[] = [];
  const seen = new Set<Element>();

  walkElements(root, (el) => {
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
    if (seen.has(el)) return;
    seen.add(el);

    const input = el instanceof HTMLInputElement ? el : null;
    if (!input) return;

    const ph = (input.placeholder || '').toLowerCase();
    const aria = (input.getAttribute('aria-label') || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    const testId = (input.getAttribute('data-testid') || '').toLowerCase();
    const role = (input.getAttribute('role') || '').toLowerCase();
    const type = (input.type || '').toLowerCase();

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

    if (isStake) out.push(input);
  });

  return out;
}

/** Bet slip card 후보 — 텍스트에 @ odds 또는 selection 구조 */
export function findSlipCardCandidates(root: ParentNode): Element[] {
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
      testId.includes('bet_slip') ||
      aria.includes('bet slip') ||
      aria.includes('betslip');

    const hasAtOdds = AT_ODDS_RE.test(text);
    const hasDecimalOnly =
      !hasAtOdds &&
      ODDS_DECIMAL_RE.test(text) &&
      text.length < 400 &&
      !textIncludesAny(text, ['copyright', 'login', 'register']);

    if (isSlipMarker || (hasAtOdds && text.length < 600) || (hasDecimalOnly && el.children.length >= 1)) {
      if (!cards.some((c) => c.contains(el) || el.contains(c))) {
        seen.add(el);
        cards.push(el);
      }
    }
  });

  return cards.filter((card) => {
    const inputs = findStakeInputs(card);
    return inputs.length === 0;
  });
}

export function findBetSlipContainer(_root: ParentNode, anchor: Element): Element {
  let node: Element | null = anchor;
  for (let i = 0; i < 12 && node; i++) {
    const testId = (node.getAttribute('data-testid') || '').toLowerCase();
    const aria = (node.getAttribute('aria-label') || '').toLowerCase();
    const tag = node.tagName.toLowerCase();
    if (
      testId.includes('betslip') ||
      testId.includes('bet-slip') ||
      aria.includes('bet slip') ||
      aria.includes('betslip') ||
      tag === 'aside'
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return anchor.parentElement || anchor;
}

export function readOddsFromElement(el: Element): number | null {
  const text = normText(el.textContent || '');
  const at = parseDecimalOdds(text);
  if (at) return at;

  let found: number | null = null;
  walkElements(el, (child) => {
    if (found != null || child === el) return;
    const t = normText(child.textContent || '');
    if (/^\d{1,2}\.\d{2,4}$/.test(t)) {
      const n = clampOdds(parseFloat(t));
      if (n) found = n;
    }
  });
  if (found) return found;

  for (const child of el.querySelectorAll('[data-testid*="odds"], [aria-label*="odds"], [role="status"]')) {
    const t = normText(child.textContent || '');
    const n = parseDecimalOdds(t) ?? (/^\d{1,2}\.\d{2,4}$/.test(t) ? clampOdds(parseFloat(t)) : null);
    if (n) return n;
  }

  return null;
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
      textIncludesAny(text, ['place bet', 'bet now', '베팅', '배팅', 'confirm']) ||
      textIncludesAny(aria, ['place bet', 'bet'])
    ) {
      out.push(el);
    }
  });
  return out;
}
