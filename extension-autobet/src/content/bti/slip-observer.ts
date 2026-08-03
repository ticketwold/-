import { detectSlipFrameKindInDoc, slipDocContext } from './slip-doc-context';
import { frameShouldSkipSlipRead } from './slip-frame-kind';
import { findSlipObserverRoot } from './shadow-query';
import { markSlipFrameOnDom, readSlipOddsFromProbedDom } from './slip-probe';

export type OddsNotify = (slip: Record<string, unknown> | null, cartChange?: boolean) => void;

/**
 * 단일 document(또는 iframe.contentDocument) 내부 Bet Slip MutationObserver.
 * - setInterval 없음
 * - slip root 미존재 시 doc.body 감시 → root 출현 시 observer 재부착 (MutationObserver만)
 */
export function startSlipDomObserverInDocument(
  doc: Document,
  notify: OddsNotify,
  hrefHint?: string,
  via: 'native-frame' | 'iframe-child' = 'native-frame'
): () => void {
  const ctx = slipDocContext(doc, hrefHint);
  const kind = detectSlipFrameKindInDoc(ctx);
  if (frameShouldSkipSlipRead(kind)) {
    return () => {};
  }

  let lastKey = '';
  let pending = false;
  let slipObserver: MutationObserver | null = null;
  let bootstrapObserver: MutationObserver | null = null;
  let observedRoot: ParentNode | null = null;

  const oddsKey = (slip: { odds?: number; selectionText?: string } | null) => {
    if (!slip?.odds || slip.odds <= 1) return '';
    return `${slip.odds.toFixed(3)}_${slip.selectionText || ''}`;
  };

  const check = (cartChange = false) => {
    markSlipFrameOnDom(ctx);
    const slip = readSlipOddsFromProbedDom(ctx);
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
    notify({ ...slip, sourceKind: slip.source, via }, cartChange);
  };

  const schedule = (cartChange = false) => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      check(cartChange);
    });
  };

  const attachSlipRootObserver = (): boolean => {
    const root = findSlipObserverRoot(ctx.doc);
    if (!root || root === observedRoot) return !!observedRoot;

    slipObserver?.disconnect();
    observedRoot = root;
    slipObserver = new MutationObserver(() => schedule(false));
    slipObserver.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-testid', 'aria-label', 'value', 'data-state'],
    });
    schedule(false);
    return true;
  };

  const attachBootstrapObserver = () => {
    const body = ctx.doc.body;
    if (!body) return;

    bootstrapObserver?.disconnect();
    bootstrapObserver = new MutationObserver(() => {
      if (attachSlipRootObserver()) {
        /* slip root observer active — bootstrap keeps watching for root replacement */
      }
    });
    bootstrapObserver.observe(body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-testid', 'aria-label', 'value', 'data-state', 'src'],
    });

    attachSlipRootObserver();
  };

  const onInput = () => schedule(false);
  const onClick = () => schedule(true);

  attachBootstrapObserver();
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('click', onClick, true);
  schedule(false);

  return () => {
    slipObserver?.disconnect();
    bootstrapObserver?.disconnect();
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('click', onClick, true);
  };
}

/** @deprecated use startSlipDomObserverInDocument */
export function startSlipDomObserver(notify: OddsNotify): () => void {
  return startSlipDomObserverInDocument(document, notify, location.href, 'native-frame');
}
