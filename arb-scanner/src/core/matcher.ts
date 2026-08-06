import type { ArbitrageOpportunity, OddsQuote } from './types';

/** 팀명 정규화 — 매칭용 */
export function normalizeTeam(name: string): string {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

export function parseEventTeams(eventName: string): { home: string; away: string } {
  const t = eventName.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?)\s*(?:vs\.?|v\.?|VS|–|—|-)\s*(.+)$/i);
  if (m) return { home: normalizeTeam(m[1]), away: normalizeTeam(m[2]) };
  return { home: normalizeTeam(t), away: '' };
}

export function matchKeyFromEvent(eventName: string): string {
  const { home, away } = parseEventTeams(eventName);
  const parts = [home, away].filter(Boolean).sort();
  return parts.join('|');
}

export function teamsMatch(a: string, b: string): boolean {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

/** 동일 경기 매칭 */
export function findMatchingQuotes(
  x10Quotes: OddsQuote[],
  bcQuotes: OddsQuote[]
): Array<{ x10: OddsQuote; bc: OddsQuote; matchKey: string }> {
  const pairs: Array<{ x10: OddsQuote; bc: OddsQuote; matchKey: string }> = [];

  for (const x of x10Quotes) {
    const xKey = matchKeyFromEvent(x.eventName);
    if (!xKey) continue;
    for (const b of bcQuotes) {
      const bKey = matchKeyFromEvent(b.eventName);
      if (!bKey) continue;
      if (xKey === bKey || teamsMatch(x.eventName, b.eventName)) {
        pairs.push({ x10: x, bc: b, matchKey: xKey || bKey });
      }
    }
  }
  return pairs;
}

/** 2-leg 양방 수익률 (decimal odds) */
export function calcArbitrageProfit(oddsA: number, oddsB: number): number {
  if (oddsA <= 1 || oddsB <= 1) return -100;
  const implied = 1 / oddsA + 1 / oddsB;
  if (implied >= 1) return -100;
  return Math.round((1 / implied - 1) * 10000) / 100;
}

export function buildOpportunity(
  x10: OddsQuote,
  bc: OddsQuote,
  minProfit: number
): ArbitrageOpportunity {
  const profit = calcArbitrageProfit(x10.odds, bc.odds);
  return {
    matchKey: matchKeyFromEvent(x10.eventName),
    eventName: x10.eventName || bc.eventName,
    legX10: x10,
    legBc: bc,
    profitPercent: profit,
    viable: profit >= minProfit,
    detectedAt: Date.now(),
  };
}
