import type { OddsChangeCallback } from './types';

export type IframeDocHandler = (doc: Document, href: string, iframe: HTMLIFrameElement) => () => void;

type IframeBinding = {
  iframe: HTMLIFrameElement;
  teardown: () => void;
  loadHandler: () => void;
  srcObserver: MutationObserver | null;
};

/**
 * iframe 생성/제거/load/src 변경 감시.
 * 각 접근 가능한 contentDocument에 handler 등록.
 */
export class IframeRegistry {
  private bindings = new WeakMap<HTMLIFrameElement, IframeBinding>();
  private tracked = new Set<HTMLIFrameElement>();
  private bodyObserver: MutationObserver | null = null;
  private handler: IframeDocHandler;
  private rootDoc: Document;

  constructor(rootDoc: Document, handler: IframeDocHandler) {
    this.rootDoc = rootDoc;
    this.handler = handler;
  }

  start(): () => void {
    const boot = () => {
      const body = this.rootDoc.body;
      if (!body) return;

      this.bodyObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node instanceof HTMLIFrameElement) this.track(node);
            else if (node instanceof Element) this.scan(node);
          }
          for (const node of m.removedNodes) {
            if (node instanceof HTMLIFrameElement) this.untrack(node);
          }
        }
      });

      this.bodyObserver.observe(body, { childList: true, subtree: true });
      this.scan(body);
    };

    if (this.rootDoc.body) boot();
    else this.rootDoc.addEventListener('DOMContentLoaded', boot, { once: true });

    return () => this.stop();
  }

  stop(): void {
    this.bodyObserver?.disconnect();
    this.bodyObserver = null;
    for (const iframe of this.tracked) this.untrack(iframe);
    this.tracked.clear();
  }

  private scan(root: ParentNode): void {
    if (root instanceof HTMLIFrameElement) this.track(root);
    root.querySelectorAll('iframe').forEach((iframe) => this.track(iframe));
  }

  private track(iframe: HTMLIFrameElement): void {
    if (this.tracked.has(iframe)) return;
    this.tracked.add(iframe);
    this.connect(iframe);
  }

  private untrack(iframe: HTMLIFrameElement): void {
    const binding = this.bindings.get(iframe);
    if (binding) {
      binding.teardown();
      binding.srcObserver?.disconnect();
      iframe.removeEventListener('load', binding.loadHandler);
      this.bindings.delete(iframe);
    }
    this.tracked.delete(iframe);
  }

  private getDoc(iframe: HTMLIFrameElement): Document | null {
    try {
      return iframe.contentDocument;
    } catch {
      return null;
    }
  }

  private hrefOf(iframe: HTMLIFrameElement, doc: Document | null): string {
    return iframe.src || iframe.getAttribute('src') || doc?.location?.href || '';
  }

  private connect(iframe: HTMLIFrameElement): void {
    this.untrack(iframe);
    this.tracked.add(iframe);

    const doc = this.getDoc(iframe);
    if (doc?.body) {
      this.attachDoc(iframe, doc);
      return;
    }

    const loadHandler = () => {
      const d = this.getDoc(iframe);
      if (d?.body) this.attachDoc(iframe, d);
    };

    const srcObserver = new MutationObserver(() => {
      const d = this.getDoc(iframe);
      if (d?.body) this.attachDoc(iframe, d);
    });

    iframe.addEventListener('load', loadHandler);
    srcObserver.observe(iframe, { attributes: true, attributeFilter: ['src'] });

    this.bindings.set(iframe, {
      iframe,
      teardown: () => {},
      loadHandler,
      srcObserver,
    });
  }

  private attachDoc(iframe: HTMLIFrameElement, doc: Document): void {
    const prev = this.bindings.get(iframe);
    prev?.teardown();
    prev?.srcObserver?.disconnect();

    const href = this.hrefOf(iframe, doc);
    const teardown = this.handler(doc, href, iframe);

    const loadHandler = () => {
      const d = this.getDoc(iframe);
      if (d) this.attachDoc(iframe, d);
    };

    iframe.removeEventListener('load', prev?.loadHandler ?? loadHandler);
    iframe.addEventListener('load', loadHandler);

    this.bindings.set(iframe, {
      iframe,
      teardown,
      loadHandler,
      srcObserver: null,
    });
  }
}

/** @deprecated callback type alias */
export type { OddsChangeCallback };
