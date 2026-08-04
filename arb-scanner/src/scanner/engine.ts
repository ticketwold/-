import type { DiagnosticReport, OddsQuote, ScanContext, SiteId } from '@core/types';
import { createLogger } from '@core/logger';
import { detectSiteId, getAdapter } from './adapters';
import { countShadowRoots, getFrameDepth, queryAllDeep } from './dom-walker';
import { MutationWatch } from './mutation-watch';
import { watchSpaNavigation } from './spa-watch';
import { SEL } from './stable-selectors';

const log = createLogger('engine');

export type ScanResult = {
  quotes: OddsQuote[];
  ctx: ScanContext;
};

export type EngineOptions = {
  siteId: SiteId;
  debounceMs?: number;
  onScan: (result: ScanResult) => void;
  diagnostic?: boolean;
};

type Session = {
  ctx: ScanContext;
  mutation: MutationWatch;
  stop: () => void;
};

export class ScannerEngine {
  private sessions = new Map<Document, Session>();
  private opts: EngineOptions;
  private lastQuotes: OddsQuote[] = [];
  private cacheKey = '';
  private cacheTs = 0;
  private cacheTtl = 150;

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  start(): () => void {
    const doc = document;
    this.attach(doc, location.href);

    const iframeObs = new MutationObserver(() => {
      doc.querySelectorAll('iframe').forEach((iframe) => {
        try {
          const child = iframe.contentDocument;
          if (child?.body) {
            const href = iframe.src || child.location?.href || '';
            this.attach(child, href);
          }
        } catch {
          /* cross-origin */
        }
      });
    });

    if (doc.body) {
      iframeObs.observe(doc.body, { childList: true, subtree: true });
      doc.querySelectorAll('iframe').forEach((f) => {
        try {
          if (f.contentDocument?.body) this.attach(f.contentDocument, f.src);
        } catch {
          /* ignore */
        }
      });
    }

    const stopSpa = watchSpaNavigation(() => this.scanAll(true));
    this.scanAll(true);

    return () => {
      stopSpa();
      iframeObs.disconnect();
      for (const s of this.sessions.values()) s.stop();
      this.sessions.clear();
    };
  }

  getLastQuotes(): OddsQuote[] {
    return this.lastQuotes;
  }

  runDiagnostic(): DiagnosticReport {
    const siteId = this.opts.siteId;
    const coef = queryAllDeep(document, SEL.bc.winnerCoef).length;
    const sc = queryAllDeep(document, SEL.x10.slipCard).length + queryAllDeep(document, SEL.x10.stake).length;
    const isTop = window === window.top;
    const hasChildSlip = [...document.querySelectorAll('iframe')].some((f) => {
      try {
        const d = f.contentDocument;
        if (!d) return false;
        return (
          d.querySelectorAll(SEL.bc.winnerCoef).length > 0 ||
          d.querySelectorAll(SEL.x10.stake).length > 0
        );
      } catch {
        return /betslip|sportscenter|betby/i.test(f.src || '');
      }
    });

    const verdict: string[] = [];
    if (isTop && hasChildSlip && coef === 0 && sc === 0) {
      verdict.push('현재는 메인 프레임에서 실행 중입니다.');
      verdict.push('배당은 iframe 안에 있습니다.');
      verdict.push('scanner를 iframe으로 이동해야 합니다.');
    } else if (!isTop && coef === 0 && sc === 0) {
      verdict.push('현재는 iframe에서 실행 중입니다.');
      verdict.push('selector가 존재하지 않습니다.');
    } else if (coef > 0 || sc > 0) {
      verdict.push(isTop ? '현재 frame에 selector 존재.' : 'iframe에서 selector 발견 — 정상 slip frame 가능.');
    }

    const moConnected = [...this.sessions.values()].some((s) => s.mutation.isConnected());

    return {
      frameUrl: location.href,
      locationHref: location.href,
      isTopFrame: isTop,
      frameDepth: getFrameDepth(),
      readyState: document.readyState,
      origin: location.origin,
      siteId,
      winnerCoefCount: coef,
      sportscenterCount: sc,
      shadowRootCount: countShadowRoots(document),
      mutationObserverConnected: moConnected,
      iframeCount: document.querySelectorAll('iframe').length,
      quotesFound: this.lastQuotes.length,
      selectors: [
        coef ? `bet__winner-coef (${coef})` : null,
        sc ? `sportscenter/slip (${sc})` : null,
      ].filter(Boolean) as string[],
      verdict,
      timestamp: new Date().toISOString(),
    };
  }

  logDiagnostic(): DiagnosticReport {
    const r = this.runDiagnostic();
    console.log('═══════════════════════════════════════════');
    console.log('[ArbScanner 진단]', r.siteId, r.frameUrl.slice(0, 100));
    console.log('  top:', r.isTopFrame, 'depth:', r.frameDepth, 'ready:', r.readyState);
    console.log('  origin:', r.origin);
    console.log('  bet__winner-coef:', r.winnerCoefCount, '| sportscenter:', r.sportscenterCount);
    console.log('  shadowRoot:', r.shadowRootCount, '| iframe:', r.iframeCount);
    console.log('  MutationObserver:', r.mutationObserverConnected);
    console.log('  quotes:', r.quotesFound, r.selectors);
    console.log('  verdict:', r.verdict.join(' / '));
    console.log('═══════════════════════════════════════════');
    return r;
  }

  private attach(doc: Document, href: string): void {
    if (this.sessions.has(doc)) return;
    const adapter = getAdapter(this.opts.siteId);
    const frameLabel = adapter.classifyFrame(href, doc);
    const ctx: ScanContext = {
      doc,
      href: href || location.href,
      siteId: this.opts.siteId,
      frameLabel,
      frameDepth: getFrameDepth(),
      isTop: window === window.top,
    };

    if (!adapter.canScan(ctx)) {
      log.debug(`skip frame ${frameLabel} ${href.slice(0, 80)}`);
      return;
    }

    const mutation = new MutationWatch(
      doc,
      () => adapter.observerRoot(ctx),
      () => this.scanAll(false),
      this.opts.debounceMs ?? 300
    );

    const stopMo = mutation.start();
    const session: Session = { ctx, mutation, stop: stopMo };
    this.sessions.set(doc, session);
    log.info(`attached ${frameLabel} ${href.slice(0, 80)}`);
  }

  private scanAll(force: boolean): void {
    const adapter = getAdapter(this.opts.siteId);
    const all: OddsQuote[] = [];

    for (const { ctx } of this.sessions.values()) {
      if (!adapter.canScan(ctx)) continue;
      try {
        all.push(...adapter.scanSlip(ctx), ...adapter.scanBoard(ctx));
      } catch (e) {
        log.catch('scan', e);
      }
    }

    if (!this.sessions.size) {
      const ctx: ScanContext = {
        doc: document,
        href: location.href,
        siteId: this.opts.siteId,
        frameLabel: adapter.classifyFrame(location.href, document),
        frameDepth: getFrameDepth(),
        isTop: window === window.top,
      };
      if (adapter.canScan(ctx)) {
        try {
          all.push(...adapter.scanSlip(ctx), ...adapter.scanBoard(ctx));
        } catch (e) {
          log.catch('scan-top', e);
        }
        this.opts.onScan({ quotes: all, ctx });
      }
      return;
    }

    const key = all.map((q) => `${q.odds}_${q.selection}_${q.source}`).join('|');
    const now = Date.now();
    if (!force && key === this.cacheKey && now - this.cacheTs < this.cacheTtl) return;
    this.cacheKey = key;
    this.cacheTs = now;
    this.lastQuotes = all;

    const bestCtx = [...this.sessions.values()][0]?.ctx ?? {
      doc: document,
      href: location.href,
      siteId: this.opts.siteId,
      frameLabel: 'top',
      frameDepth: getFrameDepth(),
      isTop: window === window.top,
    };

    this.opts.onScan({ quotes: all, ctx: bestCtx });

    if (this.opts.diagnostic) this.logDiagnostic();
  }
}

export { detectSiteId };
