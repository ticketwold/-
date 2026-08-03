import { walkElements } from './dom-tree';
import { findBcWinnerCoefElements, findStakeInputs, findX10SlipCards } from './selector-engine';
import type { ScanProbeResult } from './types';

const AT_RE = /@\s*(\d{1,2}\.\d{2,4})/;
const SUSPENDED_RE = /정지된|suspended|coefSuspended/i;

export type DomProbeCause =
  | 'selector_not_in_dom'
  | 'odds_in_child_iframe'
  | 'odds_in_shadow_dom'
  | 'content_script_not_in_slip_frame'
  | 'slip_empty_or_suspended'
  | 'cross_origin_iframe'
  | 'shell_frame_no_slip'
  | 'unknown';

export type DomProbeReport = {
  label: string;
  href: string;
  isTop: boolean;
  frameDepth: number;
  bodyLen: number;
  bodyPreview: string;
  winnerCoefCountLight: number;
  winnerCoefCountShadow: number;
  winnerCoefCountTotal: number;
  winnerCoef: Array<{ tag: string; class: string; text: string; via: string; path: string }>;
  counterInput: Array<{ id: string; placeholder: string; path: string }>;
  slipMarkers: Array<{ tag: string; class: string; text: string; via: string }>;
  oddsElements: Array<{
    text: string;
    odds: number;
    tag: string;
    class: string;
    inSlip: boolean;
    via: string;
    path: string;
  }>;
  shadowHosts: Array<{ tag: string; class: string; via: string; depth: number }>;
  iframes: Array<{
    src: string;
    accessible: boolean;
    childBodyLen: number;
    childCoefCount: number;
    childCounter: number;
    childOdds: Array<{ text: string; class: string; path: string }>;
    isBetslip: boolean;
  }>;
  scannerWouldFail: string[];
  primaryCause: DomProbeCause;
  causeDetail: string;
  matchingSelectors: string[];
};

export function runDomProbe(label: string): DomProbeReport {
  const report: DomProbeReport = {
    label,
    href: location.href,
    isTop: window === window.top,
    frameDepth: frameDepth(),
    bodyLen: document.body?.innerHTML?.length ?? 0,
    bodyPreview: (document.body?.innerHTML || '').slice(0, 1500),
    winnerCoefCountLight: 0,
    winnerCoefCountShadow: 0,
    winnerCoefCountTotal: 0,
    winnerCoef: [],
    counterInput: [],
    slipMarkers: [],
    oddsElements: [],
    shadowHosts: [],
    iframes: [],
    scannerWouldFail: [],
    primaryCause: 'unknown',
    causeDetail: '',
    matchingSelectors: [],
  };

  const lightCoef = document.querySelectorAll(
    '.bet__winner-coef, [class*="bet__winner-coef"], span.bet__winner-coef'
  );
  report.winnerCoefCountLight = lightCoef.length;
  lightCoef.forEach((el, i) => {
    if (i >= 25) return;
    report.winnerCoef.push({
      tag: el.tagName,
      class: String(el.className || ''),
      text: (el.textContent || '').trim().slice(0, 50),
      via: 'light',
      path: cssPath(el),
    });
  });

  walkElements(document.body || document.documentElement, (el, _depth, via) => {
    const cls = String(el.className || '');
    if (/bet__winner-coef|winner-coef/i.test(cls) && report.winnerCoef.length < 40) {
      if (!report.winnerCoef.some((w) => w.path === cssPath(el))) {
        report.winnerCoef.push({
          tag: el.tagName,
          class: cls,
          text: (el.textContent || '').trim().slice(0, 50),
          via,
          path: cssPath(el),
        });
      }
      if (via === 'shadow') report.winnerCoefCountShadow++;
    }

    if (el.shadowRoot && report.shadowHosts.length < 30) {
      report.shadowHosts.push({
        tag: el.tagName,
        class: cls.slice(0, 80),
        via,
        depth: _depth,
      });
    }

    if (
      (/betslip|bet-slip|betInformation|BetSecondary|sport-betslip/i.test(cls) || el.id === 'counter') &&
      report.slipMarkers.length < 20
    ) {
      report.slipMarkers.push({
        tag: el.tagName,
        class: cls.slice(0, 120),
        text: (el.textContent || '').trim().slice(0, 80),
        via,
      });
    }
  });

  report.winnerCoefCountTotal = findBcWinnerCoefElements(document.documentElement || document.body).length;
  if (!report.winnerCoefCountTotal) {
    report.winnerCoefCountTotal = report.winnerCoef.length;
  }

  findStakeInputs(document).forEach((el, i) => {
    if (i >= 8) return;
    report.counterInput.push({
      id: el.id,
      placeholder: el.placeholder || '',
      path: cssPath(el),
    });
  });

  traceOddsElements(report);
  probeIframes(report);
  collectMatchingSelectors(report);
  diagnoseFailures(report);

  return report;
}

export function explainScannerZero(
  dom: DomProbeReport,
  scanner?: ScanProbeResult | null
): { reasons: string[]; primaryCause: DomProbeCause; detail: string } {
  const reasons = [...dom.scannerWouldFail];
  let primaryCause = dom.primaryCause;
  let detail = dom.causeDetail;

  if (scanner) {
    if (scanner.odds > 1.01) {
      return { reasons: [], primaryCause: 'unknown', detail: 'scanner has odds' };
    }
    if (!scanner.hasBetSlip) reasons.push('SCANNER_NO_BETSLIP_NODE');
    if (scanner.odds <= 0) reasons.push('SCANNER_ODDS_ZERO');
    if (scanner.frameLabel === 'junk' || scanner.frameLabel === 'shell-top') {
      reasons.push(`SCANNER_FRAME_SKIPPED:${scanner.frameLabel}`);
    }
  }

  if (dom.winnerCoefCountTotal > 0 && (!scanner || scanner.odds <= 0)) {
    reasons.push('SELECTOR_EXISTS_BUT_SCANNER_MISSED');
    primaryCause = 'selector_not_in_dom';
    detail = `DOM has ${dom.winnerCoefCountTotal} bet__winner-coef but scanner returned 0`;
  }

  if (dom.oddsElements.some((o) => o.inSlip) && (!scanner || scanner.odds <= 0)) {
    reasons.push('ODDS_TEXT_IN_SLIP_CONTEXT_SCANNER_MISSED');
  }

  return { reasons: [...new Set(reasons)], primaryCause, detail };
}

export function logDomProbe(label: string, scanner?: ScanProbeResult | null): DomProbeReport {
  const dom = runDomProbe(label);
  const explained = explainScannerZero(dom, scanner);

  console.group(`[DOM Probe / ${label}] ${location.href.slice(0, 120)}`);
  console.log('frame:', dom.isTop ? 'top' : 'iframe', 'depth:', dom.frameDepth);
  console.log('body.innerHTML length:', dom.bodyLen);
  console.log('body preview:', dom.bodyPreview.slice(0, 400));
  console.log(
    'span.bet__winner-coef count — light:',
    dom.winnerCoefCountLight,
    'shadow:',
    dom.winnerCoefCountShadow,
    'scanner-walk:',
    dom.winnerCoefCountTotal
  );
  if (dom.winnerCoef.length) console.log('winner-coef elements:', dom.winnerCoef);
  if (dom.counterInput.length) console.log('counter/stake inputs:', dom.counterInput);
  if (dom.shadowHosts.length) console.log('shadow hosts:', dom.shadowHosts);
  if (dom.iframes.length) console.log('iframes:', dom.iframes);
  if (dom.oddsElements.length) console.log('odds-like elements (querySelectorAll trace):', dom.oddsElements);
  if (dom.matchingSelectors.length) console.log('selectors matching real odds:', dom.matchingSelectors);
  console.log('scanner would fail:', explained.reasons);
  console.log('PRIMARY CAUSE:', explained.primaryCause, '—', explained.detail || dom.causeDetail);
  if (scanner) console.log('scanner probe:', scanner);
  console.groupEnd();

  return dom;
}

function frameDepth(): number {
  let d = 0;
  let w: Window = window;
  try {
    while (w !== w.parent) {
      d++;
      w = w.parent;
    }
  } catch {
    /* cross-origin */
  }
  return d;
}

function getDirectText(el: Element): string {
  let t = '';
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) t += n.textContent || '';
  }
  return t.replace(/\s+/g, ' ').trim();
}

function isInSlipContext(el: Element): boolean {
  return !!el.closest(
    '[class*="betslip"], [class*="bet-slip"], [class*="betInformation"], [class*="Betslip"], aside, [class*="coupon"]'
  );
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let i = 0; i < 8 && node; i++) {
    let seg = node.tagName.toLowerCase();
    if (node.id) seg += `#${node.id}`;
    else if (node.className && typeof node.className === 'string') {
      const c = node.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (c) seg += `.${c}`;
    }
    parts.unshift(seg);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function traceOddsElements(report: DomProbeReport): void {
  const seen = new Set<string>();
  document.querySelectorAll('*').forEach((el) => {
    const ownText = getDirectText(el);
    if (!ownText || ownText.length > 24) return;
    if (!/^\d{1,2}\.\d{2,4}$/.test(ownText) && !AT_RE.test(ownText)) return;
    if (SUSPENDED_RE.test(ownText)) return;
    const n = parseFloat(ownText.replace(/@/g, '').trim());
    if (!n || n <= 1.01 || n >= 100) return;
    const key = `${ownText}_${cssPath(el)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (report.oddsElements.length < 40) {
      report.oddsElements.push({
        text: ownText,
        odds: n,
        tag: el.tagName,
        class: String(el.className || '').slice(0, 150),
        inSlip: isInSlipContext(el),
        via: 'light',
        path: cssPath(el),
      });
    }
  });

  walkElements(document.body || document.documentElement, (el, _d, via) => {
    if (via === 'light') return;
    const ownText = getDirectText(el);
    if (!ownText || ownText.length > 24) return;
    if (!/^\d{1,2}\.\d{2,4}$/.test(ownText) && !AT_RE.test(ownText)) return;
    const n = parseFloat(ownText.replace(/@/g, '').trim());
    if (!n || n <= 1.01 || n >= 100) return;
    if (report.oddsElements.length < 40) {
      report.oddsElements.push({
        text: ownText,
        odds: n,
        tag: el.tagName,
        class: String(el.className || '').slice(0, 150),
        inSlip: isInSlipContext(el),
        via,
        path: cssPath(el),
      });
    }
  });
}

function probeIframes(report: DomProbeReport): void {
  document.querySelectorAll('iframe').forEach((iframe, i) => {
    if (i >= 25) return;
    const src = iframe.src || iframe.getAttribute('src') || '';
    let accessible = false;
    let childBodyLen = 0;
    let childCoefCount = 0;
    let childCounter = 0;
    const childOdds: Array<{ text: string; class: string; path: string }> = [];

    try {
      const doc = iframe.contentDocument;
      if (doc?.body) {
        accessible = true;
        childBodyLen = doc.body.innerHTML.length;
        childCoefCount = doc.querySelectorAll(
          '.bet__winner-coef, [class*="winner-coef"], span.bet__winner-coef'
        ).length;
        childCounter = doc.querySelectorAll('#counter, input[placeholder*="베팅"]').length;
        doc.querySelectorAll('*').forEach((el) => {
          const t = getDirectText(el);
          if ((/^\d{1,2}\.\d{2,4}$/.test(t) || AT_RE.test(t)) && childOdds.length < 15) {
            childOdds.push({ text: t, class: String(el.className || '').slice(0, 100), path: cssPath(el) });
          }
        });
      }
    } catch {
      accessible = false;
    }

    report.iframes.push({
      src: src.slice(0, 250),
      accessible,
      childBodyLen,
      childCoefCount,
      childCounter,
      childOdds,
      isBetslip: /betslip|sportscenter|widgets-x|bti-sports|sport-betslip|betby|sptpub/i.test(src),
    });
  });
}

function collectMatchingSelectors(report: DomProbeReport): void {
  const selectors: string[] = [];
  const tests: Array<{ sel: string; count: number }> = [
    { sel: 'span.bet__winner-coef', count: 0 },
    { sel: '.bet__winner-coef', count: 0 },
    { sel: '[class*="bet__winner-coef"]', count: 0 },
    { sel: '#counter', count: 0 },
    { sel: 'input[placeholder*="베팅"]', count: 0 },
    { sel: '[class*="betInformation"]', count: 0 },
    { sel: '[class*="CounterSecondary"]', count: 0 },
    { sel: '[data-testid*="betslip"]', count: 0 },
    { sel: '[class*="betslip"]', count: 0 },
  ];

  for (const t of tests) {
    try {
      t.count = document.querySelectorAll(t.sel).length;
      if (t.count > 0) selectors.push(`${t.sel} (${t.count})`);
    } catch {
      /* invalid selector */
    }
  }

  const x10Cards = findX10SlipCards(document);
  if (x10Cards.length) selectors.push(`findX10SlipCards (${x10Cards.length})`);

  const coefWalk = findBcWinnerCoefElements(document.documentElement || document.body);
  if (coefWalk.length) selectors.push(`findBcWinnerCoefElements/walk (${coefWalk.length})`);

  for (const o of report.oddsElements.filter((e) => e.inSlip).slice(0, 5)) {
    if (o.class) selectors.push(`odds-in-slip: ${o.tag}.${o.class.split(/\s+/)[0]} → "${o.text}"`);
  }

  report.matchingSelectors = selectors;
}

function diagnoseFailures(report: DomProbeReport): void {
  const fails = report.scannerWouldFail;

  const hasSlipMarkers =
    report.winnerCoefCountTotal > 0 ||
    report.counterInput.length > 0 ||
    report.slipMarkers.length > 0 ||
    findX10SlipCards(document).length > 0;

  const slipIframeWithOdds = report.iframes.some(
    (f) => f.isBetslip && f.accessible && (f.childCoefCount > 0 || f.childCounter > 0 || f.childOdds.length > 0)
  );
  const slipIframeBlocked = report.iframes.some((f) => f.isBetslip && !f.accessible);
  const shadowHasCoef = report.winnerCoef.some((w) => w.via === 'shadow');
  const slipOddsInDom = report.oddsElements.some((o) => o.inSlip);
  const isShell =
    /\/in-play\/|\/match\//i.test(report.href) &&
    !/betslip|sportscenter|widgets-x/i.test(report.href);

  if (!hasSlipMarkers && !slipOddsInDom) {
    fails.push('NO_SLIP_MARKERS_IN_THIS_FRAME');
  }
  if (slipIframeBlocked) fails.push('BETSLIP_IFRAME_CROSS_ORIGIN_OR_NOT_LOADED');
  if (slipIframeWithOdds) fails.push('ODDS_INSIDE_ACCESSIBLE_BETSLIP_IFRAME');
  if (report.shadowHosts.length > 0 && report.winnerCoefCountLight === 0 && report.winnerCoefCountTotal > 0) {
    fails.push('SHADOW_DOM_PRESENT_COEF_NOT_IN_LIGHT_DOM');
  }
  if (!report.isTop) fails.push('RUNNING_INSIDE_IFRAME');
  else if (report.iframes.length > 0 && !hasSlipMarkers) {
    fails.push('TOP_FRAME_SHELL_ODDS_LIKELY_IN_CHILD_IFRAME');
  }
  if (isShell) fails.push('X10_INPLAY_SHELL_NO_SLIP_DOM');

  if (slipIframeBlocked && report.isTop) {
    report.primaryCause = 'content_script_not_in_slip_frame';
    report.causeDetail =
      '배팅슬립이 cross-origin iframe 안에 있으며, 이 top frame content script로는 DOM 접근 불가. betslip iframe에서 별도 content script 실행 필요.';
  } else if (slipIframeWithOdds && report.isTop) {
    report.primaryCause = 'odds_in_child_iframe';
    report.causeDetail =
      '배당이 접근 가능한 child iframe 안에 있음. scanner는 해당 iframe document에서 실행되어야 함.';
  } else if (shadowHasCoef || fails.includes('SHADOW_DOM_PRESENT_COEF_NOT_IN_LIGHT_DOM')) {
    report.primaryCause = 'odds_in_shadow_dom';
    report.causeDetail = 'bet__winner-coef가 Shadow DOM 안에만 존재. openShadowRoot 순회 필요.';
  } else if (isShell && !hasSlipMarkers) {
    report.primaryCause = 'shell_frame_no_slip';
    report.causeDetail = 'x10 in-play shell frame — Bet Slip DOM은 sportscenter/betslip iframe에 있음.';
  } else if (!hasSlipMarkers && !slipIframeWithOdds) {
    report.primaryCause = 'selector_not_in_dom';
    report.causeDetail = '이 frame에 bet__winner-coef / #counter / slip card 없음 (슬립 미선택 또는 잘못된 frame).';
  } else if (hasSlipMarkers && report.winnerCoef.every((w) => SUSPENDED_RE.test(w.class + w.text))) {
    report.primaryCause = 'slip_empty_or_suspended';
    report.causeDetail = '슬립 요소는 있으나 정지됨(suspended) 상태.';
  } else if (!report.isTop && !hasSlipMarkers) {
    report.primaryCause = 'content_script_not_in_slip_frame';
    report.causeDetail = 'iframe에서 실행 중이나 이 frame에 slip marker 없음 — betslip 전용 iframe이 아닐 수 있음.';
  } else {
    report.primaryCause = 'unknown';
    report.causeDetail = 'DOM에 slip marker 존재 — scanner adapter/파싱 문제 가능.';
  }
}
