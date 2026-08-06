import type { OddsQuote } from './types';

const MAX = 200;

export class OddsHistory {
  private entries: OddsQuote[] = [];

  push(quote: OddsQuote): void {
    this.entries.push(quote);
    if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
  }

  pushMany(quotes: OddsQuote[]): void {
    for (const q of quotes) this.push(q);
  }

  getRecent(limit = 50): OddsQuote[] {
    return this.entries.slice(-limit);
  }

  getBySite(siteId: OddsQuote['siteId']): OddsQuote[] {
    return this.entries.filter((e) => e.siteId === siteId);
  }

  clear(): void {
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }
}

export const globalOddsHistory = new OddsHistory();
