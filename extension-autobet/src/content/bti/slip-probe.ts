import {
  detectSlipFrameKind,
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

export function probeSlipDom(): SlipProbeResult {
  const kind = detectSlipFrameKind();
  const input = findSlipBetInput();
  const cards = findSlipCards();
  let atOdds = 0;
  let cardOdds = 0;
  let selectionText = '';

  const root = findSlipObserverRoot();
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
  document.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) shadowHosts++;
  });

  return {
    frameKind: kind,
    href: location.href,
    isTop: window === window.top,
    hasCounter: !!input,
    slipCardCount: cards.length,
    atOdds,
    cardOdds,
    selectionText,
    observerRootTag: root instanceof Element ? root.tagName.toLowerCase() : 'document',
    shadowHosts,
  };
}

export function readSlipOddsFromProbedDom(): {
  odds: number;
  selectionText: string;
  source: string;
  fromSlip: boolean;
} | null {
  const kind = detectSlipFrameKind();
  if (frameShouldSkipSlipRead(kind)) return null;
  if (!frameCanHostBetSlip(kind) && !findSlipBetInput()) return null;

  const cards = findSlipCards();
  for (let i = cards.length - 1; i >= 0; i--) {
    const card = cards[i];
    if (!card) continue;
    const rawOdds = readOddsFromSlipCardElement(card);
    if (rawOdds == null || rawOdds <= 1.01) continue;
    const odds = rawOdds;
    const selectionText = card.querySelector(SLIP_TITLE_SELECTOR)?.textContent?.trim() || '';
    return {
      odds,
      selectionText,
      source: kind === 'sportscenter-betslip' ? 'sportscenter-slip' : 'widgets-x-slip',
      fromSlip: true,
    };
  }

  const root = findSlipObserverRoot();
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

/** 프레임 역할을 documentElement에 기록 — engine probe에서 식별 */
export function markSlipFrameOnDom(): void {
  const kind = detectSlipFrameKind();
  try {
    document.documentElement.setAttribute('data-autobet-slip-frame', kind);
    const probe = probeSlipDom();
    if (probe.atOdds > 1.01 || probe.cardOdds > 1.01) {
      document.documentElement.setAttribute('data-autobet-slip-odds', String(probe.atOdds || probe.cardOdds));
    }
  } catch {
    /* ignore */
  }
}
