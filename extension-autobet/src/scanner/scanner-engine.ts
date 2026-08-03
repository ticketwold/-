import { getAdapter } from './adapters';
import { countIframes, countShadowHosts } from './dom-tree';
import { findBcWinnerCoefElements } from './selector-engine';
import { IframeRegistry } from './iframe-registry';
import { MutationHub } from './mutation-hub';
import { PortalWatcher } from './portal-watcher';
import { detectSiteIdFromContext, isJunkFrameHref } from './site-detector';
import { clearScannerHit, getScannerTrace, setScannerNullReason } from './scanner-trace';
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
  lastConfidence: number;
  teardown: () => void;
};

export type ScannerEngineOptions = {
  siteId?: SiteId;
  bootstrapSource?: 'bti' | 'bcgame' | 'stake';
  onOddsChange: OddsChangeCallback;
  rootDoc?: Document;
  /** 테스트/iframe용 — location.href 대신 사용 */
  rootHref?: string;
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
    const href = this.opts.rootHref ?? location.href;
    this.topTeardown = this.attachDocument(doc, href, 'top', 0);

    this.iframeRegistry = new IframeRegistry(doc, (childDoc, href, _iframe, depth) => {
      return this.attachDocument(childDoc, href, 'iframe', depth);
    });
    const stopIframes = this.iframeRegistry.start();

    const onNav = () => {
      this.bestPayload = null;
      this.attachDocument(doc, href, 'top', 0);
      for (const session of [...this.sessions.values()]) {
        this.onDocMutate(session.ctx, session.adapter, true);
      }
    };
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);

    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
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
    const zeroReasons: string[] = [];

    if (!best) zeroReasons.push('SCAN_ALL_RETURNED_NULL');
    if (!slip) zeroReasons.push('NO_BETSLIP_NODE');
    if (!odds || odds.odds <= 0) zeroReasons.push('NO_ODDS_PARSED');

    const activeCtx = ctx ?? this.makeContext(document, location.href, 'top', 0);
    const adapter = getAdapter(activeCtx.siteId);
    if (adapter && !adapter.canScan(activeCtx)) {
      zeroReasons.push(`CAN_SCAN_FALSE:${activeCtx.frameLabel}`);
    }

    const coefCount = findBcWinnerCoefElements(
      activeCtx.doc.documentElement || activeCtx.doc.body
    ).length;

    if (coefCount > 0 && (!odds || odds.odds <= 0)) {
      zeroReasons.push(`COEF_IN_DOM_BUT_NOT_READ:${coefCount}`);
    }

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
      winnerCoefCount: coefCount,
      sessionCount: this.sessions.size,
      zeroReasons,
    };
  }

  readOdds(): OddsPayload | null {
    const best = this.scanAll();
    if (!best?.odds) {
      if (!best) setScannerNullReason('scanAll: 모든 session에서 odds 없음');
      else if (!best.slip) setScannerNullReason('scanAll: betSlip node 없음');
      else setScannerNullReason('scanAll: findOdds null 또는 odds<=0');
      return null;
    }

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

  getDiagnostics(): {
    trace: ReturnType<typeof getScannerTrace>;
    sessions: Array<{
      href: string;
      frameLabel: string;
      via: string;
      mutationObserver: ReturnType<MutationHub['getObserverStatus']>;
    }>;
  } {
    const sessions: Array<{
      href: string;
      frameLabel: string;
      via: string;
      mutationObserver: ReturnType<MutationHub['getObserverStatus']>;
    }> = [];

    for (const session of this.sessions.values()) {
      sessions.push({
        href: session.ctx.href,
        frameLabel: session.ctx.frameLabel,
        via: session.ctx.via,
        mutationObserver: session.hub.getObserverStatus(),
      });
    }

    return { trace: getScannerTrace(), sessions };
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
    if (!adapter) return () => {};

    if (!doc.body && !doc.documentElement) return () => {};

    let slipCache: BetSlipNode | null = null;

    const hub = new MutationHub({
      doc,
      resolveAnchor: () => {
        slipCache = adapter.canScan(ctx) ? adapter.findBetSlip(ctx) : null;
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
      lastConfidence: 0,
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
        session.lastConfidence = 0;
        this.recomputeBestAndEmit(cartChange);
      }
      return;
    }

    const key = `${result.odds.odds.toFixed(3)}_${result.odds.selectionText || ''}`;
    const confidence = result.slip?.confidence ?? 0;
    if (key === session.lastKey && !cartChange && confidence <= session.lastConfidence) return;
    session.lastKey = key;
    session.lastConfidence = confidence;

    const via = ctx.via === 'iframe' ? 'iframe-child' : 'native-frame';
    const payload: OddsPayload = {
      ...result.odds,
      stake: result.stake,
      payout: result.payout,
      sourceKind: result.odds.source,
      via,
      frameLabel: ctx.frameLabel,
    };

    this.considerBest(payload, confidence);
    this.emitBest(this.bestPayload, cartChange);
  }

  private recomputeBestAndEmit(cartChange: boolean): void {
    this.bestPayload = null;
    let bestConf = 0;
    for (const session of this.sessions.values()) {
      const result = this.scanContext(session.ctx, session.adapter);
      if (!result?.odds) continue;
      const conf = result.slip?.confidence ?? 0;
      if (conf >= bestConf) {
        bestConf = conf;
        const via = session.ctx.via === 'iframe' ? 'iframe-child' : 'native-frame';
        this.bestPayload = {
          ...result.odds,
          stake: result.stake,
          payout: result.payout,
          sourceKind: result.odds.source,
          via,
          frameLabel: session.ctx.frameLabel,
        };
      }
    }
    this.emitBest(this.bestPayload, cartChange);
  }

  private considerBest(payload: OddsPayload, confidence: number): void {
    const prev = this.bestPayload;
    const prevConf = (prev as OddsPayload & { _conf?: number })?._conf ?? 0;
    if (!prev || confidence >= prevConf) {
      this.bestPayload = payload;
      (this.bestPayload as OddsPayload & { _conf?: number })._conf = confidence;
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
    if (!adapter.canScan(ctx)) {
      setScannerNullReason(`canScan=false (frameLabel=${ctx.frameLabel}, href=${ctx.href.slice(0, 80)})`);
      return null;
    }
    const slip = adapter.findBetSlip(ctx);
    if (!slip) {
      setScannerNullReason(`findBetSlip=null (frameLabel=${ctx.frameLabel})`);
      clearScannerHit();
      return null;
    }
    const odds = adapter.findOdds(ctx, slip);
    if (!odds) {
      setScannerNullReason(`findOdds=null (frameLabel=${ctx.frameLabel}, cards=${slip.cards.length})`);
      clearScannerHit();
      return { ctx, slip, odds: null, stake: null, payout: null };
    }
    if (odds.odds <= 0) {
      setScannerNullReason(`findOdds: odds<=0 (source=${odds.source})`);
      clearScannerHit();
      return { ctx, slip, odds: null, stake: null, payout: null };
    }
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
