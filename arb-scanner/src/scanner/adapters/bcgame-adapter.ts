import type { OddsQuote, ScanContext } from '@core/types';
import { baseQuote, type SiteAdapter } from './base-adapter';
import { queryAllDeep, walkElements } from '@scanner/dom-walker';
import { parseOddsText, readOddsFromElement } from '@scanner/odds-parser';
import { SEL } from '@scanner/stable-selectors';

export class BcGameAdapter implements SiteAdapter {
  readonly siteId = 'bcgame' as const;

  classifyFrame(href: string): string {
    if (!href || href === 'about:blank') return 'junk';
    if (/betby|sptpub|sptsportscdn|biahosted|cocoesports/i.test(href)) return 'betby';
    if (/bc\.game/i.test(href)) return 'bc-top';
    return 'default';
  }

  canScan(ctx: ScanContext): boolean {
    return ctx.frameLabel !== 'junk';
  }

  observerRoot(ctx: ScanContext): ParentNode | null {
    const coef = queryAllDeep(ctx.doc, SEL.bc.winnerCoef)[0];
    if (coef) {
      return coef.closest(SEL.bc.slipRoot) || coef.parentElement || ctx.doc.body;
    }
    const slip = queryAllDeep(ctx.doc, SEL.bc.slipRoot)[0];
    return slip || ctx.doc.body;
  }

  scanSlip(ctx: ScanContext): OddsQuote[] {
    const out: OddsQuote[] = [];

    for (const el of queryAllDeep(ctx.doc, SEL.bc.winnerCoef)) {
      const odds = readOddsFromElement(el);
      if (!odds) continue;
      const container = el.closest(SEL.bc.slipRoot) || el.parentElement;
      const event =
        container?.querySelector(SEL.bc.event)?.textContent?.trim() || 'bc-slip';
      const selection =
        container?.querySelector(SEL.bc.selection)?.textContent?.trim() || 'slip';

      out.push(
        baseQuote(ctx, {
          eventName: event,
          selection,
          odds,
          source: 'slip',
          inShadowDom: false,
          confidence: 0.95,
        })
      );
    }

    if (!out.length) {
      walkElements(ctx.doc.body || ctx.doc.documentElement, (el, _d, via) => {
        if (out.length) return;
        const cls = String(el.className || '');
        if (!/bet__winner-coef/i.test(cls)) return;
        const odds = readOddsFromElement(el);
        if (!odds) return;
        out.push(
          baseQuote(ctx, {
            eventName: 'bc-slip',
            selection: 'slip',
            odds,
            source: 'slip',
            inShadowDom: via === 'shadow',
            confidence: 0.9,
          })
        );
      });
    }

    const slipRoot = queryAllDeep(ctx.doc, SEL.bc.slipRoot)[0];
    if (slipRoot && !out.length) {
      const text = slipRoot.textContent || '';
      const labeled = text.match(/(?:total\s*odds?|@)\s*(\d+\.\d{2,3})/i);
      const odds = labeled ? parseOddsText(labeled[1]) : null;
      if (odds) {
        out.push(
          baseQuote(ctx, {
            eventName: slipRoot.querySelector(SEL.bc.event)?.textContent?.trim() || 'bc-slip',
            selection: slipRoot.querySelector(SEL.bc.selection)?.textContent?.trim() || 'slip',
            odds,
            source: 'slip',
            inShadowDom: false,
            confidence: 0.8,
          })
        );
      }
    }

    return out;
  }

  scanBoard(ctx: ScanContext): OddsQuote[] {
    const out: OddsQuote[] = [];
    const oddsEls = queryAllDeep(ctx.doc, SEL.bc.boardOdds);

    for (const el of oddsEls.slice(0, 60)) {
      if (el.closest(SEL.bc.slipRoot)) continue;
      const odds = readOddsFromElement(el);
      if (!odds) continue;
      const row = el.closest('[class*="event"], [class*="Event"], [class*="match"]');
      const event = row?.querySelector(SEL.bc.event)?.textContent?.trim() || 'board';

      out.push(
        baseQuote(ctx, {
          eventName: event,
          selection: el.getAttribute('data-testid') || 'board',
          odds,
          source: 'board',
          inShadowDom: false,
          confidence: 0.65,
        })
      );
    }
    return out;
  }
}
