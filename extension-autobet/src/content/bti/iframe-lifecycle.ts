import { isBetslipIframeElement } from './slip-doc-context';
import { startSlipDomObserverInDocument, type OddsNotify } from './slip-observer';

type IframeBinding = {
  iframe: HTMLIFrameElement;
  teardown: () => void;
  loadHandler: () => void;
  srcAttrObserver: MutationObserver | null;
};

const bindings = new WeakMap<HTMLIFrameElement, IframeBinding>();

function getIframeDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    return iframe.contentDocument;
  } catch {
    return null;
  }
}

function teardownBinding(iframe: HTMLIFrameElement): void {
  const binding = bindings.get(iframe);
  if (!binding) return;
  binding.teardown();
  binding.srcAttrObserver?.disconnect();
  iframe.removeEventListener('load', binding.loadHandler);
  bindings.delete(iframe);
}

function connectIframeDocument(iframe: HTMLIFrameElement, notify: OddsNotify): void {
  teardownBinding(iframe);

  const doc = getIframeDocument(iframe);
  if (!doc?.body) return;

  const src = iframe.src || iframe.getAttribute('src') || doc.location?.href || '';
  const teardown = startSlipDomObserverInDocument(doc, notify, src, 'iframe-child');

  const loadHandler = () => {
    connectIframeDocument(iframe, notify);
  };

  iframe.addEventListener('load', loadHandler);

  bindings.set(iframe, {
    iframe,
    teardown,
    loadHandler,
    srcAttrObserver: null,
  });
}

function watchIframeSrcUntilReady(iframe: HTMLIFrameElement, notify: OddsNotify): void {
  if (bindings.has(iframe)) return;

  const srcAttrObserver = new MutationObserver(() => {
    if (isBetslipIframeElement(iframe)) tryConnect();
  });

  const tryConnect = () => {
    if (!isBetslipIframeElement(iframe)) return false;
    const doc = getIframeDocument(iframe);
    if (doc?.body) {
      srcAttrObserver.disconnect();
      connectIframeDocument(iframe, notify);
      return true;
    }
    return false;
  };

  const loadHandler = () => {
    tryConnect();
  };

  iframe.addEventListener('load', loadHandler);
  srcAttrObserver.observe(iframe, { attributes: true, attributeFilter: ['src'] });

  bindings.set(iframe, {
    iframe,
    teardown: () => {},
    loadHandler,
    srcAttrObserver,
  });

  tryConnect();
}

function inspectIframe(iframe: HTMLIFrameElement, notify: OddsNotify): void {
  if (!isBetslipIframeElement(iframe)) {
    watchIframeSrcUntilReady(iframe, notify);
    return;
  }

  const doc = getIframeDocument(iframe);
  if (doc?.body) {
    connectIframeDocument(iframe, notify);
    return;
  }

  watchIframeSrcUntilReady(iframe, notify);
}

function scanForIframes(root: ParentNode, notify: OddsNotify): void {
  if (root instanceof HTMLIFrameElement) {
    inspectIframe(root, notify);
  }
  root.querySelectorAll('iframe').forEach((iframe) => inspectIframe(iframe, notify));
}

/**
 * Top shell: document.body MutationObserver → betslip iframe 추가 감지
 * → load → contentDocument → 내부 MutationObserver (polling 없음)
 */
export function startBetslipIframeLifecycle(notify: OddsNotify): () => void {
  const tracked = new Set<HTMLIFrameElement>();

  const trackIframe = (iframe: HTMLIFrameElement) => {
    if (tracked.has(iframe)) return;
    tracked.add(iframe);
    inspectIframe(iframe, notify);
  };

  const bodyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLIFrameElement) trackIframe(node);
        else if (node instanceof Element) scanForIframes(node, notify);
      }
      for (const node of mutation.removedNodes) {
        if (node instanceof HTMLIFrameElement) {
          teardownBinding(node);
          tracked.delete(node);
        }
      }
    }
  });

  const boot = () => {
    const body = document.body;
    if (!body) return;
    bodyObserver.observe(body, { childList: true, subtree: true });
    scanForIframes(body, notify);
  };

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  return () => {
    bodyObserver.disconnect();
    tracked.forEach((iframe) => teardownBinding(iframe));
    tracked.clear();
  };
}
