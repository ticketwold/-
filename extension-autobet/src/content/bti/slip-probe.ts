import {
  detectSlipFrameKindInDoc,
  slipDocContext,
  type SlipDocContext,
} from './slip-doc-context';
import {
  frameCanHostBetSlip,
  frameShouldSkipSlipRead,
  type SlipFrameKind,
} from './slip-frame-kind';
import {
  findSlipBetInput,
  findSlipCards,
  findSlipObserverRoot,
  readAtOddsFromText,
  readOddsFromSlipCardElement,
  SLIP_EVENT_SELECTOR,
  SLIP_TITLE_SELECTOR,
} from './shadow-query';

export type SlipProbeResult = {
  frameKind: SlipFrameKind;
  href: string;
  isTop: boolean;
  hasCounter: boolean;
  slipCardCount: number;
  atOdds: number;
  cardOdds: number;
  selectionText: string;
  observerRootTag: string;
  shadowHosts: number;
};

export function probeSlipDom(ctx: SlipDocContext = slipDocContext()): SlipProbeResult {
  const kind = detectSlipFrameKindInDoc(ctx);
  const input = findSlipBetInput(ctx.doc);
  const cards = findSlipCards(ctx.doc);
  let atOdds = 0;
  let cardOdds = 0;
  let selectionText = '';

  const root = findSlipObserverRoot(ctx.doc);
  const rootText = (root.textContent || '').replace(/\s+/g, ' ');
  atOdds = readAtOddsFromText(rootText) || 0;

  const lastCard = cards[cards.length - 1];
  if (lastCard) {
    cardOdds = readOddsFromSlipCardElement(lastCard) || 0;
    selectionText =
      lastCard.querySelector(SLIP_TITLE_SELECTOR)?.textContent?.trim() ||
      lastCard.querySelector(SLIP_EVENT_SELECTOR)?.textContent?.trim() ||
      '';
  }

  let shadowHosts = 0;
  ctx.doc.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) shadowHosts++;
  });

  return {
    frameKind: kind,
    href: ctx.href,
    isTop: ctx.doc === document && window === window.top,
    hasCounter: !!input,
    slipCardCount: cards.length,
    atOdds,
    cardOdds,
    selectionText,
    observerRootTag: root instanceof Element ? root.tagName.toLowerCase() : 'document',
    shadowHosts,
  };
}

export function readSlipOddsFromProbedDom(
  ctx: SlipDocContext = slipDocContext()
): {
  odds: number;
  selectionText: string;
  source: string;
  fromSlip: boolean;
} | null {
  const kind = detectSlipFrameKindInDoc(ctx);
  if (frameShouldSkipSlipRead(kind)) return null;
  if (!frameCanHostBetSlip(kind) && !findSlipBetInput(ctx.doc)) return null;

  const cards = findSlipCards(ctx.doc);
  for (let i = cards.length - 1; i >= 0; i--) {
    const card = cards[i];
    if (!card) continue;
    const rawOdds = readOddsFromSlipCardElement(card);
    if (rawOdds == null || rawOdds <= 1.01) continue;
    const selectionText = card.querySelector(SLIP_TITLE_SELECTOR)?.textContent?.trim() || '';
    return {
      odds: rawOdds,
      selectionText,
      source: kind === 'sportscenter-betslip' ? 'sportscenter-slip' : 'widgets-x-slip',
      fromSlip: true,
    };
  }

  const root = findSlipObserverRoot(ctx.doc);
  const atRaw = readAtOddsFromText((root.textContent || '').replace(/\s+/g, ' '));
  if (atRaw != null && atRaw > 1.01) {
    return {
      odds: atRaw,
      selectionText: '',
      source: kind === 'sportscenter-betslip' ? 'sportscenter-at' : 'widgets-x-at',
      fromSlip: true,
    };
  }

  return null;
}

export function markSlipFrameOnDom(ctx: SlipDocContext = slipDocContext()): void {
  const kind = detectSlipFrameKindInDoc(ctx);
  try {
    ctx.doc.documentElement.setAttribute('data-autobet-slip-frame', kind);
    const probe = probeSlipDom(ctx);
    if (probe.atOdds > 1.01 || probe.cardOdds > 1.01) {
      ctx.doc.documentElement.setAttribute(
        'data-autobet-slip-odds',
        String(probe.atOdds || probe.cardOdds)
      );
    }
  } catch {
    /* cross-origin guard */
  }
}
