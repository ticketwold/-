import type { OddsQuote, ScanContext } from '@core/types';
import { baseQuote, type SiteAdapter } from './base-adapter';
import { queryAllDeep, getDirectText } from '@scanner/dom-walker';
import { parseOddsText, readOddsFromElement } from '@scanner/odds-parser';
import { SEL } from '@scanner/stable-selectors';

export class X10Adapter implements SiteAdapter {
  readonly siteId = 'x10' as const;

  classifyFrame(href: string): string {
    if (!href || href === 'about:blank') return 'junk';
    if (/sportscenter\/betslip|widgets-x/i.test(href)) return 'betslip-frame';
    if (/in-play|\/match\//i.test(href) && !/betslip|sportscenter/i.test(href)) return 'shell';
    return 'default';
  }

  canScan(ctx: ScanContext): boolean {
    if (ctx.frameLabel === 'junk') return false;
    if (ctx.frameLabel === 'shell') {
      return queryAllDeep(ctx.doc, SEL.x10.stake).length > 0;
    }
    return true;
  }

  observerRoot(ctx: ScanContext): ParentNode | null {
    const input = queryAllDeep(ctx.doc, SEL.x10.stake)[0];
    if (input) {
      return (
        input.closest('[class*="betslip"], [class*="Betslip"], aside, section') ||
        input.parentElement ||
        ctx.doc.body
      );
    }
    const card = queryAllDeep(ctx.doc, SEL.x10.slipCard)[0];
    return card?.parentElement || ctx.doc.body;
  }

  scanSlip(ctx: ScanContext): OddsQuote[] {
    const out: OddsQuote[] = [];
    const cards = queryAllDeep(ctx.doc, SEL.x10.slipCard);

    for (const card of cards) {
      if (card.closest(SEL.x10.boardBtn)) continue;
      const title =
        card.querySelector(SEL.x10.slipTitle)?.textContent?.trim() ||
        card.querySelector(SEL.x10.slipEvent)?.textContent?.trim() ||
        '';
      const event =
        card.querySelector(SEL.x10.slipEvent)?.textContent?.trim() ||
        card.closest('[class*="betslip"]')?.textContent?.slice(0, 80) ||
        '';
      const league = card.querySelector(SEL.x10.slipLeague)?.textContent?.trim();
      const startTime =
        card.querySelector(SEL.x10.slipTime)?.getAttribute('datetime') ||
        card.querySelector(SEL.x10.slipTime)?.textContent?.trim();

      let odds: number | null = null;
      for (const el of queryAllDeep(card, '[class*="odds"], [class*="Odds"], [class*="coefficient"]')) {
        odds = readOddsFromElement(el);
        if (odds) break;
      }
      if (!odds) {
        const at = parseOddsText(card.textContent || '');
        if (at) odds = at;
      }
      if (!odds) continue;

      out.push(
        baseQuote(ctx, {
          eventName: event || 'unknown',
          league,
          startTime,
          selection: title || 'slip',
          odds,
          source: 'slip',
          inShadowDom: false,
          confidence: 0.9,
        })
      );
    }

    const stake = queryAllDeep(ctx.doc, SEL.x10.stake)[0];
    if (!out.length && stake) {
      const root = stake.closest('[class*="betslip"], aside') || ctx.doc.body;
      const at = parseOddsText(root?.textContent || '');
      if (at) {
        out.push(
          baseQuote(ctx, {
            eventName: root?.querySelector(SEL.x10.slipEvent)?.textContent?.trim() || 'slip',
            selection: root?.querySelector(SEL.x10.slipTitle)?.textContent?.trim() || 'slip',
            odds: at,
            source: 'slip',
            inShadowDom: false,
            confidence: 0.75,
          })
        );
      }
    }
    return out;
  }

  scanBoard(ctx: ScanContext): OddsQuote[] {
    const out: OddsQuote[] = [];
    const buttons = queryAllDeep(ctx.doc, SEL.x10.boardBtn);

    for (const btn of buttons) {
      const oddsEl = btn.querySelector(SEL.x10.boardOdds) || btn;
      const odds = readOddsFromElement(oddsEl as Element);
      if (!odds) continue;

      const row = btn.closest('[class*="event"], [class*="Event"], li, tr') || btn.parentElement;
      const event =
        row?.querySelector('[class*="eventName"], [class*="EventName"]')?.textContent?.trim() || '';
      const league = row?.querySelector('[class*="league"]')?.textContent?.trim();
      const label = btn.getAttribute('aria-label') || getDirectText(btn).slice(0, 20) || 'board';

      out.push(
        baseQuote(ctx, {
          eventName: event || 'board',
          league,
          selection: label,
          odds,
          source: 'board',
          inShadowDom: false,
          confidence: 0.7,
        })
      );
    }
    return out.slice(0, 40);
  }
}
