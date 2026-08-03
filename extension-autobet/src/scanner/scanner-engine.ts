import { getAdapter } from './adapters';
import { countIframes, countShadowHosts } from './dom-tree';
import { IframeRegistry } from './iframe-registry';
import { MutationHub } from './mutation-hub';
import { PortalWatcher } from './portal-watcher';
import { detectSiteIdFromContext, isJunkFrameHref } from './site-detector';
import type {
  BetSlipNode,
  OddsChangeCallback,
  OddsPayload,
  ScanContext,
  ScanProbeResult,
  SiteAdapter,
  SiteId,
} from './types';

type DocSession = {
  ctx: ScanContext;
  adapter: SiteAdapter;
  hub: MutationHub;
  portal: PortalWatcher;
  lastKey: string;
  teardown: () => void;
};

export type ScannerEngineOptions = {
  siteId?: SiteId;
  bootstrapSource?: 'bti' | 'bcgame' | 'stake';
  onOddsChange: OddsChangeCallback;
  rootDoc?: Document;
};

/**
 * DOM Scanner Engine — iframe → shadow → portal → MO → adapter
 */
export class ScannerEngine {
  private opts: ScannerEngineOptions;
  private sessions = new Map<Document, DocSession>();
  private iframeRegistry: IframeRegistry | null = null;
  private topTeardown: (() => void) | null = null;
  private bestPayload: OddsPayload | null = null;

  constructor(opts: ScannerEngineOptions) {
    this.opts = opts;
  }

  start(): () => void {
    const doc = this.opts.rootDoc ?? document;
    this.topTeardown = this.attachDocument(doc, location.href, 'top', 0);

    this.iframeRegistry = new IframeRegistry(doc, (childDoc, href) => {
      return this.attachDocument(childDoc, href, 'iframe', 1);
    });
    const stopIframes = this.iframeRegistry.start();

    return () => {
      stopIframes();
      this.topTeardown?.();
      this.topTeardown = null;
      for (const session of this.sessions.values()) session.teardown();
      this.sessions.clear();
      this.bestPayload = null;
    };
  }

  probe(): ScanProbeResult {
    const best = this.scanAll();
    const ctx = best?.ctx;
    const slip = best?.slip;
    const odds = best?.odds;

    return {
      siteId: ctx?.siteId ?? this.resolveSiteId(location.href),
      frameLabel: ctx?.frameLabel ?? 'unknown',
      href: ctx?.href ?? location.href,
      hasBetSlip: !!slip,
      slipCardCount: slip?.cards.length ?? 0,
      odds: odds?.odds ?? 0,
      selectionText: odds?.selectionText ?? '',
      stake: best?.stake ?? null,
      payout: best?.payout ?? null,
      shadowHostCount: ctx ? countShadowHosts(ctx.doc) : 0,
      iframeCount: ctx ? countIframes(ctx.doc) : 0,
      confidence: slip?.confidence ?? 0,
    };
  }

  readOdds(): OddsPayload | null {
    const best = this.scanAll();
    if (!best?.odds) return null;

    const via = best.ctx.via === 'iframe' ? 'iframe-child' : 'native-frame';
    return {
      ...best.odds,
      stake: best.stake,
      payout: best.payout,
      sourceKind: best.odds.source,
      via,
      frameLabel: best.ctx.frameLabel,
    };
  }

  private resolveSiteId(href: string): SiteId {
    return this.opts.siteId ?? detectSiteIdFromContext(href, this.opts.bootstrapSource);
  }

  private makeContext(doc: Document, href: string, via: ScanContext['via'], depth: number): ScanContext {
    const siteId = this.resolveSiteId(href);
    const adapter = getAdapter(siteId);
    let frameLabel = 'unknown';

    if (isJunkFrameHref(href)) {
      frameLabel = 'junk';
    } else if (adapter && 'classifyFrame' in adapter && typeof adapter.classifyFrame === 'function') {
      frameLabel = adapter.classifyFrame(href, doc);
    } else if (adapter) {
      frameLabel = via === 'top' ? 'top' : 'iframe';
    }

    return { doc, href, depth, siteId, frameLabel, via };
  }

  private attachDocument(doc: Document, href: string, via: ScanContext['via'], depth: number): () => void {
    if (this.sessions.has(doc)) {
      this.sessions.get(doc)?.teardown();
      this.sessions.delete(doc);
    }

    const ctx = this.makeContext(doc, href, via, depth);
    const adapter = getAdapter(ctx.siteId);
    if (!adapter || !adapter.canScan(ctx)) {
      return () => {};
    }

    let slipCache: BetSlipNode | null = null;

    const hub = new MutationHub({
      doc,
      resolveAnchor: () => {
        slipCache = adapter.findBetSlip(ctx);
        return adapter.observerAnchor(ctx, slipCache);
      },
      onMutate: (cartChange) => this.onDocMutate(ctx, adapter, cartChange),
    });

    const portal = new PortalWatcher(doc, () => {
      this.onDocMutate(ctx, adapter, true);
    });

    const stopHub = hub.start();
    const stopPortal = portal.start();

    const teardown = () => {
      stopHub();
      stopPortal();
      this.sessions.delete(doc);
    };

    this.sessions.set(doc, {
      ctx,
      adapter,
      hub,
      portal,
      lastKey: '',
      teardown,
    });

    this.onDocMutate(ctx, adapter, false);
    this.markDom(ctx);

    return teardown;
  }

  private onDocMutate(ctx: ScanContext, adapter: SiteAdapter, cartChange = false): void {
    const session = this.sessions.get(ctx.doc);
    if (!session) return;

    this.markDom(ctx);
    const result = this.scanContext(ctx, adapter);
    if (!result?.odds) {
      if (session.lastKey !== '') {
        session.lastKey = '';
        this.emitBest(null, cartChange);
      }
      return;
    }

    const key = `${result.odds.odds.toFixed(3)}_${result.odds.selectionText || ''}`;
    if (key === session.lastKey && !cartChange) return;
    session.lastKey = key;

    const via = ctx.via === 'iframe' ? 'iframe-child' : 'native-frame';
    const payload: OddsPayload = {
      ...result.odds,
      stake: result.stake,
      payout: result.payout,
      sourceKind: result.odds.source,
      via,
      frameLabel: ctx.frameLabel,
    };

    this.considerBest(payload);
    this.emitBest(this.bestPayload, cartChange);
  }

  private considerBest(payload: OddsPayload): void {
    const prev = this.bestPayload;
    if (!prev || payload.odds >= prev.odds) {
      this.bestPayload = payload;
    }
  }

  private emitBest(slip: OddsPayload | null, cartChange: boolean): void {
    try {
      this.opts.onOddsChange(slip, cartChange);
    } catch {
      /* extension invalidated */
    }
  }

  private scanContext(ctx: ScanContext, adapter: SiteAdapter) {
    if (!adapter.canScan(ctx)) return null;
    const slip = adapter.findBetSlip(ctx);
    if (!slip) return null;
    const odds = adapter.findOdds(ctx, slip);
    if (!odds) return { ctx, slip, odds: null, stake: null, payout: null };
    const stake = adapter.findStake(ctx, slip);
    const payout = adapter.findPayout(ctx, slip);
    return { ctx, slip, odds, stake, payout };
  }

  private scanAll() {
    let best: ReturnType<typeof this.scanContext> = null;
    for (const session of this.sessions.values()) {
      const result = this.scanContext(session.ctx, session.adapter);
      if (!result?.odds) continue;
      if (!best || (result.slip?.confidence ?? 0) > (best.slip?.confidence ?? 0)) {
        best = result;
      }
    }
    if (!best) {
      const siteId = this.resolveSiteId(location.href);
      const adapter = getAdapter(siteId);
      if (adapter) {
        const ctx = this.makeContext(document, location.href, 'top', 0);
        if (adapter.canScan(ctx)) best = this.scanContext(ctx, adapter);
      }
    }
    return best;
  }

  private markDom(ctx: ScanContext): void {
    try {
      const adapter = getAdapter(ctx.siteId);
      if (!adapter) return;
      const slip = adapter.findBetSlip(ctx);
      ctx.doc.documentElement.setAttribute('data-autobet-slip-frame', ctx.frameLabel);
      if (slip) {
        const odds = adapter.findOdds(ctx, slip);
        if (odds?.odds) {
          ctx.doc.documentElement.setAttribute('data-autobet-slip-odds', String(odds.odds));
        }
      }
    } catch {
      /* cross-origin */
    }
  }
}
