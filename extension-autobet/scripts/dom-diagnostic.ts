/**
 * Real-site DOM diagnostic — injected into page like content script
 */
export function runDomDiagnostic(label: string): Record<string, unknown> {
  const DECIMAL_RE = /\b(\d{1,2}\.\d{2,2,4})\b/;
  const AT_RE = /@\s*(\d{1,2}\.\d{2,4})/;
  const SUSPENDED_RE = /정지된|suspended|coefSuspended/i;

  const report: Record<string, unknown> = {
    label,
    href: location.href,
    isTop: window === window.top,
    frameDepth: (() => {
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
    })(),
    bodyLen: document.body?.innerHTML?.length ?? 0,
    bodyPreview: (document.body?.innerHTML || '').slice(0, 500),
    winnerCoef: [] as unknown[],
    counterInput: [] as unknown[],
    slipMarkers: [] as unknown[],
    oddsElements: [] as unknown[],
    shadowHosts: [] as unknown[],
    iframes: [] as unknown[],
    scannerWouldFail: [] as string[],
    contentScriptLikely: true,
  };

  // 1. bet__winner-coef
  const coefEls = document.querySelectorAll('.bet__winner-coef, [class*="bet__winner-coef"], [class*="winner-coef"]');
  report.winnerCoefCount = coefEls.length;
  coefEls.forEach((el, i) => {
    if (i < 20) {
      (report.winnerCoef as unknown[]).push({
        tag: el.tagName,
        class: el.className,
        text: (el.textContent || '').trim().slice(0, 40),
        suspended: SUSPENDED_RE.test(el.className + (el.textContent || '')),
        path: cssPath(el),
      });
    }
  });

  // 2. x10 counter
  document.querySelectorAll('#counter, input[placeholder*="베팅"], input[id="counter"]').forEach((el, i) => {
    if (i < 5) {
      (report.counterInput as unknown[]).push({
        tag: el.tagName,
        id: (el as HTMLElement).id,
        placeholder: (el as HTMLInputElement).placeholder,
        path: cssPath(el),
      });
    }
  });

  // 3. Shadow DOM recursive
  function openShadow(el: Element): ShadowRoot | null {
    if (el.shadowRoot) return el.shadowRoot;
    return null;
  }

  function walkShadow(root: Node, depth = 0, via = 'light'): void {
    if (depth > 32) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      const el = root as Element;
      const cls = String(el.className || '');
      const text = (el.textContent || '').trim();

      if (openShadow(el)) {
        (report.shadowHosts as unknown[]).push({
          tag: el.tagName,
          class: cls.slice(0, 80),
          via,
          depth,
        });
        walkShadow(openShadow(el)!, depth + 1, 'shadow');
      }

      // coef in shadow
      if (/bet__winner-coef|winner-coef/i.test(cls)) {
        (report.winnerCoef as unknown[]).push({
          tag: el.tagName,
          class: cls,
          text: text.slice(0, 40),
          via,
          depth,
          path: cssPath(el),
        });
      }

      // slip markers
      if (/betslip|bet-slip|betInformation|BetSecondary/i.test(cls) || el.id === 'counter') {
        if ((report.slipMarkers as unknown[]).length < 15) {
          (report.slipMarkers as unknown[]).push({
            tag: el.tagName,
            class: cls.slice(0, 100),
            text: text.slice(0, 60),
            via,
            depth,
          });
        }
      }
    }

    for (const child of root.childNodes) {
      walkShadow(child, depth + 1, via);
    }
  }

  if (document.body) walkShadow(document.body);

  // 4. Trace elements with decimal odds text
  const all = document.querySelectorAll('*');
  const seen = new Set<string>();
  all.forEach((el) => {
    if (!(el instanceof Element)) return;
    const ownText = getDirectText(el);
    if (!ownText || ownText.length > 20) return;
    const isOdds = /^\d{1,2}\.\d{2,4}$/.test(ownText) || AT_RE.test(ownText);
    if (!isOdds) return;
    if (SUSPENDED_RE.test(ownText)) return;
    const n = parseFloat(ownText.replace(/@/g, '').trim());
    if (!n || n <= 1.01 || n >= 100) return;
    const key = `${ownText}_${cssPath(el)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if ((report.oddsElements as unknown[]).length < 30) {
      (report.oddsElements as unknown[]).push({
        text: ownText,
        odds: n,
        tag: el.tagName,
        class: String(el.className || '').slice(0, 120),
        id: el.id,
        testId: el.getAttribute('data-testid'),
        aria: el.getAttribute('aria-label'),
        inIframe: window !== window.top,
        inSlip: isInSlipContext(el),
        path: cssPath(el),
      });
    }
  });

  // 5. iframes
  document.querySelectorAll('iframe').forEach((iframe, i) => {
    if (i >= 15) return;
    const src = iframe.src || iframe.getAttribute('src') || '';
    let accessible = false;
    let childBodyLen = 0;
    let childCoefCount = 0;
    try {
      const doc = iframe.contentDocument;
      if (doc?.body) {
        accessible = true;
        childBodyLen = doc.body.innerHTML.length;
        childCoefCount = doc.querySelectorAll('.bet__winner-coef, [class*="winner-coef"]').length;
      }
    } catch {
      accessible = false;
    }
    (report.iframes as unknown[]).push({
      src: src.slice(0, 150),
      accessible,
      childBodyLen,
      childCoefCount,
      isBetslip: /betslip|sportscenter|widgets-x|bti-sports/i.test(src),
    });
  });

  // 6. Why scanner returns 0
  const fails = report.scannerWouldFail as string[];
  if ((report.winnerCoefCount as number) === 0 && (report.counterInput as unknown[]).length === 0) {
    fails.push('NO_SLIP_MARKERS_IN_THIS_FRAME');
  }
  if ((report.iframes as unknown[]).some((f: unknown) => (f as { isBetslip: boolean; accessible: boolean }).isBetslip && !(f as { accessible: boolean }).accessible)) {
    fails.push('BETSLIP_IFRAME_CROSS_ORIGIN_OR_NOT_LOADED');
  }
  if ((report.iframes as unknown[]).some((f: unknown) => (f as { isBetslip: boolean; childCoefCount: number }).isBetslip && (f as { childCoefCount: number }).childCoefCount > 0)) {
    fails.push('ODDS_INSIDE_ACCESSIBLE_BETSLIP_IFRAME');
  }
  if ((report.shadowHosts as unknown[]).length > 0 && (report.winnerCoefCount as number) === 0) {
    fails.push('SHADOW_DOM_PRESENT_COEF_NOT_IN_LIGHT_DOM');
  }
  if (window !== window.top) {
    fails.push('RUNNING_INSIDE_IFRAME');
  } else if ((report.iframes as unknown[]).length > 0 && (report.winnerCoefCount as number) === 0) {
    fails.push('TOP_FRAME_SHELL_ODDS_LIKELY_IN_CHILD_IFRAME');
  }

  return report;
}

function getDirectText(el: Element): string {
  let t = '';
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) t += n.textContent || '';
  }
  return t.replace(/\s+/g, ' ').trim();
}

function isInSlipContext(el: Element): boolean {
  const p = el.closest('[class*="betslip"], [class*="bet-slip"], [class*="betInformation"], aside, [class*="Betslip"]');
  return !!p;
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
