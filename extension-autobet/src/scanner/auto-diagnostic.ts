import { countShadowHosts } from './dom-tree';
import { resolveManifestInjection } from './manifest-context';
import { getScannerTrace } from './scanner-trace';
import { findBcWinnerCoefElements, findStakeInputs, findX10SlipCards } from './selector-engine';
import type { ScanProbeResult } from './types';
import type { ScannerHandle } from './bootstrap';

export type AutoDiagnosticReport = {
  frameUrl: string;
  locationHref: string;
  isTopFrame: boolean;
  iframeDepth: number;
  readyState: DocumentReadyState;
  origin: string;
  winnerCoefCount: number;
  sportscenterElementCount: number;
  shadowRootCount: number;
  mutationObserverConnected: boolean;
  mutationObserverDetail: string;
  scannerLastSelector: string;
  scannerLastOuterHtml: string;
  scannerNullReason: string;
  manifestScriptEntry: string;
  manifestMatchedPatterns: string[];
  manifestAllFrames: boolean;
  frameVerdict: string[];
  scannerProbe: ScanProbeResult | null;
  timestamp: string;
};

export type AutoDiagnosticOptions = {
  scriptEntry: string;
  scanner: ScannerHandle;
  label?: string;
};

let lastLogKey = '';
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function iframeDepth(): number {
  let d = 0;
  let w: Window = window;
  try {
    while (w !== w.parent) {
      d++;
      w = w.parent;
    }
  } catch {
    return -1;
  }
  return d;
}

function countSportscenterElements(): number {
  const selectors = [
    'iframe[src*="sportscenter"]',
    '[class*="sportscenter"]',
    '[class*="betInformation"]',
    '[class*="BetSecondary"]',
    '[class*="CounterSecondary"]',
    '#counter',
    'input[placeholder*="베팅"]',
  ];
  const seen = new Set<Element>();
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => seen.add(el));
    } catch {
      /* ignore */
    }
  }
  return seen.size;
}

function countWinnerCoef(): number {
  const walk = findBcWinnerCoefElements(document.documentElement || document.body).length;
  if (walk > 0) return walk;
  return document.querySelectorAll(
    '.bet__winner-coef, [class*="bet__winner-coef"], span.bet__winner-coef'
  ).length;
}

function hasSlipMarkersInFrame(): boolean {
  return (
    countWinnerCoef() > 0 ||
    findStakeInputs(document).length > 0 ||
    findX10SlipCards(document).length > 0 ||
    countSportscenterElements() > 0
  );
}

function oddsInChildIframe(): boolean {
  for (const iframe of document.querySelectorAll('iframe')) {
    const src = iframe.src || iframe.getAttribute('src') || '';
    if (!/betslip|sportscenter|widgets-x|bti-sports|betby|sptpub/i.test(src)) continue;
    try {
      const doc = iframe.contentDocument;
      if (!doc?.body) continue;
      const coef = doc.querySelectorAll('.bet__winner-coef, [class*="winner-coef"]').length;
      const counter = doc.querySelectorAll('#counter, input[placeholder*="베팅"]').length;
      const cards = doc.querySelectorAll('[class*="betInformation"]').length;
      if (coef > 0 || counter > 0 || cards > 0) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function buildFrameVerdict(isTop: boolean, hasMarkers: boolean, childHasOdds: boolean): string[] {
  const lines: string[] = [];

  if (isTop && childHasOdds && !hasMarkers) {
    lines.push('현재는 메인 프레임에서 실행 중입니다.');
    lines.push('배당은 iframe 안에 있습니다.');
    lines.push('scanner를 iframe으로 이동해야 합니다.');
    return lines;
  }

  if (!isTop && !hasMarkers) {
    lines.push('현재는 iframe에서 실행 중입니다.');
    lines.push('selector가 존재하지 않습니다.');
    return lines;
  }

  if (isTop && !hasMarkers && !childHasOdds) {
    lines.push('현재는 메인 프레임에서 실행 중입니다.');
    lines.push('selector가 존재하지 않습니다.');
    lines.push('(슬립 미선택이거나 아직 로드되지 않았을 수 있습니다.)');
    return lines;
  }

  if (!isTop && hasMarkers) {
    lines.push('현재는 iframe에서 실행 중입니다.');
    lines.push('selector가 이 frame에 존재합니다. (정상 slip frame 가능성 높음)');
    return lines;
  }

  if (isTop && hasMarkers) {
    lines.push('현재는 메인 프레임에서 실행 중입니다.');
    lines.push('selector가 이 frame에 존재합니다.');
    return lines;
  }

  return lines;
}

export function runAutoDiagnostic(opts: AutoDiagnosticOptions): AutoDiagnosticReport {
  const isTop = window === window.top;
  const hasMarkers = hasSlipMarkersInFrame();
  const childHasOdds = oddsInChildIframe();
  const manifest = resolveManifestInjection(opts.scriptEntry);
  const diagnostics = opts.scanner.getDiagnostics?.() ?? { trace: getScannerTrace(), sessions: [] };
  const trace = diagnostics.trace;
  const probe = opts.scanner.probe();

  const moSessions = diagnostics.sessions;
  const moConnected = moSessions.some(
    (s) => s.mutationObserver.bootstrapConnected || s.mutationObserver.slipConnected
  );
  const moDetail = moSessions
    .map(
      (s) =>
        `[${s.frameLabel}] bootstrap=${s.mutationObserver.bootstrapConnected} slip=${s.mutationObserver.slipConnected} root=${s.mutationObserver.observedRootTag}`
    )
    .join(' | ');

  const report: AutoDiagnosticReport = {
    frameUrl: location.href,
    locationHref: location.href,
    isTopFrame: isTop,
    iframeDepth: iframeDepth(),
    readyState: document.readyState,
    origin: location.origin,
    winnerCoefCount: countWinnerCoef(),
    sportscenterElementCount: countSportscenterElements(),
    shadowRootCount: countShadowHosts(document),
    mutationObserverConnected: moConnected,
    mutationObserverDetail: moDetail || '(session 없음)',
    scannerLastSelector: trace.lastSelector || '(없음)',
    scannerLastOuterHtml: trace.lastOuterHtml || '(없음)',
    scannerNullReason: trace.nullReason || probe.zeroReasons?.join(', ') || '(없음)',
    manifestScriptEntry: opts.scriptEntry,
    manifestMatchedPatterns: manifest.matchedPatterns,
    manifestAllFrames: manifest.allFrames,
    frameVerdict: buildFrameVerdict(isTop, hasMarkers, childHasOdds),
    scannerProbe: probe,
    timestamp: new Date().toISOString(),
  };

  return report;
}

export function logAutoDiagnostic(opts: AutoDiagnosticOptions): AutoDiagnosticReport {
  const report = runAutoDiagnostic(opts);
  const label = opts.label || opts.scriptEntry;

  const logKey = [
    report.winnerCoefCount,
    report.sportscenterElementCount,
    report.scannerProbe?.odds ?? 0,
    report.scannerNullReason,
    report.isTopFrame,
  ].join('|');

  if (logKey === lastLogKey) return report;
  lastLogKey = logKey;

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`[Autobet 자동진단] ${label}`);
  console.log('═══════════════════════════════════════════════════════════');

  console.log('▶ Frame 정보');
  console.log('  frame URL:', report.frameUrl);
  console.log('  window.location.href:', report.locationHref);
  console.log('  window.top === window:', report.isTopFrame);
  console.log('  iframe 깊이:', report.iframeDepth);
  console.log('  document.readyState:', report.readyState);
  console.log('  content script origin:', report.origin);

  console.log('▶ DOM 카운트');
  console.log('  bet__winner-coef 개수:', report.winnerCoefCount);
  console.log('  sportscenter 관련 요소 개수:', report.sportscenterElementCount);
  console.log('  shadowRoot 개수:', report.shadowRootCount);

  console.log('▶ MutationObserver');
  console.log('  연결됨:', report.mutationObserverConnected);
  console.log('  상세:', report.mutationObserverDetail);

  console.log('▶ Scanner');
  console.log('  마지막 selector:', report.scannerLastSelector);
  console.log('  마지막 element outerHTML:', report.scannerLastOuterHtml);
  console.log('  null 반환 이유:', report.scannerNullReason);
  if (report.scannerProbe) {
    console.log('  probe:', {
      odds: report.scannerProbe.odds,
      frameLabel: report.scannerProbe.frameLabel,
      hasBetSlip: report.scannerProbe.hasBetSlip,
      zeroReasons: report.scannerProbe.zeroReasons,
      sessionCount: report.scannerProbe.sessionCount,
    });
  }

  console.log('▶ Manifest 주입');
  console.log('  script entry:', report.manifestScriptEntry);
  console.log('  matched patterns:', report.manifestMatchedPatterns.length ? report.manifestMatchedPatterns : '(매칭 없음)');
  console.log('  all_frames:', report.manifestAllFrames);

  console.log('▶ Frame 판정');
  for (const line of report.frameVerdict) {
    console.log(' ', line);
  }

  console.log('  timestamp:', report.timestamp);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  return report;
}

/**
 * content script 부트 시 자동 진단 — DOMContentLoaded, 지연, DOM 변경 시 재출력
 */
export function startAutoDiagnostic(opts: AutoDiagnosticOptions): () => void {
  const run = () => {
    try {
      opts.scanner.readOdds();
      logAutoDiagnostic(opts);
    } catch (e) {
      console.error('[Autobet 자동진단] 오류:', e);
    }
  };

  const scheduleDebounced = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 1500);
  };

  run();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  }

  const delays = [2500, 6000, 12000];
  const timers = delays.map((ms) => setTimeout(run, ms));

  let bodyObserver: MutationObserver | null = null;
  const attachObserver = () => {
    if (!document.body || bodyObserver) return;
    bodyObserver = new MutationObserver(scheduleDebounced);
    bodyObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-testid', 'src'],
    });
  };

  if (document.body) attachObserver();
  else document.addEventListener('DOMContentLoaded', attachObserver, { once: true });

  const globalName = '__autobetAutoDiag';
  (globalThis as Record<string, unknown>)[globalName] = run;

  return () => {
    timers.forEach(clearTimeout);
    if (debounceTimer) clearTimeout(debounceTimer);
    bodyObserver?.disconnect();
    delete (globalThis as Record<string, unknown>)[globalName];
  };
}
