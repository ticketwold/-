import { createLogger } from '@core/logger';

const log = createLogger('mutation');

export type MutationCallback = () => void;

export class MutationWatch {
  private slipObs: MutationObserver | null = null;
  private bootObs: MutationObserver | null = null;
  private root: ParentNode | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;

  constructor(
    private doc: Document,
    private resolveRoot: () => ParentNode | null,
    private onChange: MutationCallback,
    debounceMs = 300
  ) {
    this.debounceMs = debounceMs;
  }

  start(): () => void {
    this.stopped = false;
    this.attachBootstrap();
    this.schedule();
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.slipObs?.disconnect();
    this.bootObs?.disconnect();
    if (this.timer) clearTimeout(this.timer);
  }

  isConnected(): boolean {
    return !!(this.slipObs || this.bootObs);
  }

  observedRootTag(): string {
    if (!this.root) return 'none';
    if (this.root === this.doc.body) return 'body';
    if (this.root instanceof Element) return this.root.tagName.toLowerCase();
    return 'fragment';
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.stopped) {
        try {
          this.onChange();
        } catch (e) {
          log.catch('mutation callback', e);
        }
      }
    }, this.debounceMs);
  }

  private attachSlip(): void {
    const root = this.resolveRoot();
    if (!root || root === this.root) return;
    this.slipObs?.disconnect();
    this.root = root;
    this.slipObs = new MutationObserver(() => this.schedule());
    this.slipObs.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-testid', 'data-state', 'value', 'aria-label'],
    });
    log.debug('slip MO attached', this.observedRootTag());
  }

  private attachBootstrap(): void {
    const body = this.doc.body;
    if (!body) return;
    this.bootObs = new MutationObserver(() => {
      this.attachSlip();
      this.schedule();
    });
    this.bootObs.observe(body, { childList: true, subtree: true });
    this.attachSlip();
  }
}
