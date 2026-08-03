const DEFAULT_ATTR_FILTER = [
  'aria-label',
  'aria-pressed',
  'aria-expanded',
  'aria-valuenow',
  'data-testid',
  'data-state',
  'data-selected',
  'data-value',
  'role',
  'value',
  'placeholder',
];

export type MutationHubOptions = {
  resolveAnchor: () => ParentNode | null;
  onMutate: (cartChange?: boolean) => void;
  doc: Document;
  attributeFilter?: string[];
};

/**
 * MutationObserver + root detach 시 자동 재연결.
 * setInterval 없음 — microtask debounce만 사용.
 */
export class MutationHub {
  private slipObserver: MutationObserver | null = null;
  private bootstrapObserver: MutationObserver | null = null;
  private observedRoot: ParentNode | null = null;
  private pending = false;
  private stopped = false;
  private opts: MutationHubOptions;
  private onInput: () => void;
  private onClick: () => void;

  constructor(opts: MutationHubOptions) {
    this.opts = opts;
    this.onInput = () => this.schedule(false);
    this.onClick = () => this.schedule(true);
  }

  start(): () => void {
    this.stopped = false;
    this.attachBootstrap();
    this.opts.doc.addEventListener('input', this.onInput, true);
    this.opts.doc.addEventListener('click', this.onClick, true);
    this.schedule(false);
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.slipObserver?.disconnect();
    this.bootstrapObserver?.disconnect();
    this.opts.doc.removeEventListener('input', this.onInput, true);
    this.opts.doc.removeEventListener('click', this.onClick, true);
    this.slipObserver = null;
    this.bootstrapObserver = null;
    this.observedRoot = null;
  }

  private schedule(cartChange: boolean): void {
    if (this.stopped || this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (!this.stopped) this.opts.onMutate(cartChange);
    });
  }

  private attachSlipRoot(): boolean {
    const root = this.opts.resolveAnchor();
    if (!root) return false;

    if (root === this.observedRoot && this.slipObserver) return true;

    if (!this.isConnected(root)) {
      this.observedRoot = null;
      this.slipObserver?.disconnect();
      this.slipObserver = null;
      return false;
    }

    this.slipObserver?.disconnect();
    this.observedRoot = root;
    this.slipObserver = new MutationObserver(() => this.schedule(false));
    this.slipObserver.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: this.opts.attributeFilter ?? DEFAULT_ATTR_FILTER,
    });
    return true;
  }

  private attachBootstrap(): void {
    const body = this.opts.doc.body;
    if (!body) return;

    this.bootstrapObserver?.disconnect();
    this.bootstrapObserver = new MutationObserver(() => {
      if (!this.isConnected(this.observedRoot)) {
        this.observedRoot = null;
        this.slipObserver?.disconnect();
        this.slipObserver = null;
      }
      this.attachSlipRoot();
    });

    this.bootstrapObserver.observe(body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: this.opts.attributeFilter ?? DEFAULT_ATTR_FILTER,
    });

    this.attachSlipRoot();
  }

  private isConnected(node: ParentNode | null): boolean {
    if (!node) return false;
    if (node === this.opts.doc || node === this.opts.doc.documentElement) return true;
    if (node instanceof Element) return node.isConnected;
    return !!(node as DocumentFragment).childNodes?.length;
  }
}
