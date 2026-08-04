import type { ContentMessage, OddsQuote, SiteId, SlipState } from '@core/types';
import { readSlipForSite } from './actions';

export function bestSlipQuote(quotes: OddsQuote[]): OddsQuote | null {
  const slips = quotes.filter((q) => q.source === 'slip' && q.odds > 1.01);
  if (!slips.length) return null;
  return slips.reduce((a, b) => (b.confidence >= a.confidence ? b : a));
}

export function resolveSlip(siteId: SiteId, quotes: OddsQuote[]): SlipState | null {
  const fromDom = readSlipForSite(siteId);
  if (fromDom?.odds && fromDom.odds > 1.01) return fromDom;

  const best = bestSlipQuote(quotes);
  if (best) {
    return {
      odds: best.odds,
      selection: best.selection,
      eventName: best.eventName,
      stake: fromDom?.stake ?? 0,
      source: 'slip',
      updatedAt: Date.now(),
    };
  }
  return fromDom;
}

export function emitScan(siteId: SiteId, quotes: OddsQuote[], frameUrl: string): void {
  if (quotes.length) {
    const batch: ContentMessage = { type: 'ODDS_BATCH', siteId, quotes, frameUrl };
    try {
      chrome.runtime.sendMessage(batch);
    } catch {
      /* invalidated */
    }
  }

  const slip = resolveSlip(siteId, quotes);
  if (!slip?.odds || slip.odds <= 1.01) return;
  const msg: ContentMessage = { type: 'SLIP_UPDATE', siteId, slip };
  try {
    chrome.runtime.sendMessage(msg);
  } catch {
    /* invalidated */
  }
}

export function emitSlipOnly(siteId: SiteId, quotes: OddsQuote[] = []): void {
  const slip = resolveSlip(siteId, quotes);
  if (!slip?.odds || slip.odds <= 1.01) return;
  try {
    chrome.runtime.sendMessage({ type: 'SLIP_UPDATE', siteId, slip } satisfies ContentMessage);
  } catch {
    /* invalidated */
  }
}
