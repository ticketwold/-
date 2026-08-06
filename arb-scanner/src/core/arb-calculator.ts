import type { ArbitrageOpportunity, OddsQuote, UserSettings } from './types';
import { buildOpportunity, findMatchingQuotes } from './matcher';
import { createLogger } from './logger';

const log = createLogger('arb');

export function scanArbitrage(
  x10Quotes: OddsQuote[],
  bcQuotes: OddsQuote[],
  settings: Pick<UserSettings, 'minProfitPercent'>
): ArbitrageOpportunity[] {
  const slipX10 = x10Quotes.filter((q) => q.source === 'slip' && q.odds > 1.01);
  const slipBc = bcQuotes.filter((q) => q.source === 'slip' && q.odds > 1.01);
  const boardX10 = x10Quotes.filter((q) => q.source === 'board');
  const boardBc = bcQuotes.filter((q) => q.source === 'board');

  const pairs = [
    ...findMatchingQuotes(slipX10, slipBc),
    ...findMatchingQuotes(slipX10, boardBc),
    ...findMatchingQuotes(boardX10, slipBc),
    ...findMatchingQuotes(boardX10, boardBc),
  ];

  const seen = new Set<string>();
  const out: ArbitrageOpportunity[] = [];

  for (const { x10, bc, matchKey } of pairs) {
    const key = `${matchKey}_${x10.selection}_${bc.selection}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const opp = buildOpportunity(x10, bc, settings.minProfitPercent);
    if (opp.viable) {
      log.info('양방 발견', { event: opp.eventName, profit: opp.profitPercent });
      out.push(opp);
    }
  }
  return out;
}
