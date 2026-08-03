import { detectSlipFrameKind, frameShouldSkipSlipRead } from './slip-frame-kind';
import { findSlipObserverRoot } from './shadow-query';
import { markSlipFrameOnDom, readSlipOddsFromProbedDom } from './slip-probe';

type OddsNotify = (slip: Record<string, unknown> | null, cartChange?: boolean) => void;

/**
 * Bet Slip 전용 MutationObserver.
 * - top shell(document.body) 감시는 iframe 내부 변경을 못 봄 → slip root만 감시
 * - Lazy mount: root가 없으면 body 감시 후 slip root 발견 시 재부착
 */
export function startSlipDomObserver(notify: OddsNotify): () => void {
  const kind = detectSlipFrameKind();
  if (frameShouldSkipSlipRead(kind)) {
    return () => {};
  }

  let lastKey = '';
  let pending = false;
  let observer: MutationObserver | null = null;
  let observedRoot: ParentNode | null = null;

  const oddsKey = (slip: { odds?: number; selectionText?: string } | null) => {
    if (!slip?.odds || slip.odds <= 1) return '';
    return `${slip.odds.toFixed(3)}_${slip.selectionText || ''}`;
  };

  const check = (cartChange = false) => {
    markSlipFrameOnDom();
    const slip = readSlipOddsFromProbedDom();
    if (!slip) {
      if (lastKey !== '') {
        lastKey = '';
        notify(null, cartChange);
      }
      return;
    }
    const key = oddsKey(slip);
    if (key === lastKey && !cartChange) return;
    lastKey = key;
    notify({ ...slip, sourceKind: slip.source }, cartChange);
  };

  const schedule = (cartChange = false) => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      check(cartChange);
    });
  };

  const attach = () => {
    const root = findSlipObserverRoot();
    if (!root || root === observedRoot) return;
    observer?.disconnect();
    observedRoot = root;
    observer = new MutationObserver(() => schedule(false));
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-testid', 'aria-label', 'value', 'data-state'],
    });
  };

  attach();
  const rootPoll = window.setInterval(attach, 400);

  document.addEventListener('input', () => schedule(false), true);
  document.addEventListener('click', () => schedule(true), true);

  schedule(false);

  return () => {
    observer?.disconnect();
    window.clearInterval(rootPoll);
  };
}
