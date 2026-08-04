import type { OddsQuote, ScanContext, SiteId } from '@core/types';

export interface SiteAdapter {
  readonly siteId: SiteId;
  classifyFrame(href: string, doc: Document): string;
  canScan(ctx: ScanContext): boolean;
  scanSlip(ctx: ScanContext): OddsQuote[];
  scanBoard(ctx: ScanContext): OddsQuote[];
  observerRoot(ctx: ScanContext): ParentNode | null;
}

export function quoteId(siteId: SiteId, source: string, event: string, sel: string): string {
  return `${siteId}:${source}:${event}:${sel}`.slice(0, 120);
}

export function baseQuote(
  ctx: ScanContext,
  partial: Omit<OddsQuote, 'id' | 'siteId' | 'frameUrl' | 'frameDepth' | 'timestamp'>
): OddsQuote {
  return {
    id: quoteId(ctx.siteId, partial.source, partial.eventName, partial.selection),
    siteId: ctx.siteId,
    frameUrl: ctx.href,
    frameDepth: ctx.frameDepth,
    timestamp: Date.now(),
    ...partial,
  };
}
