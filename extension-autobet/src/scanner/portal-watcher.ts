/**
 * React Portal 대응: body 하위 node 추가/제거 감시 → 재스캔 트리거
 */
export class PortalWatcher {
  private observer: MutationObserver | null = null;
  private onChange: () => void;
  private doc: Document;

  constructor(doc: Document, onChange: () => void) {
    this.doc = doc;
    this.onChange = onChange;
  }

  start(): () => void {
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        this.onChange();
      });
    };

    const boot = () => {
      const body = this.doc.body;
      if (!body) return;

      this.observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.addedNodes.length || m.removedNodes.length) {
            schedule();
            return;
          }
        }
      });

      this.observer.observe(body, {
        childList: true,
        subtree: false,
      });
    };

    if (this.doc.body) boot();
    else this.doc.addEventListener('DOMContentLoaded', boot, { once: true });

    return () => {
      this.observer?.disconnect();
      this.observer = null;
    };
  }
}
