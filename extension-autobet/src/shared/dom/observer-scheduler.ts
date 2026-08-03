export type LoopTask = {
  id: string;
  intervalMs: number;
  run: () => void;
  when?: () => boolean;
};

/** Single rAF scheduler — replaces multiple setInterval loops (panel / content). */
export class RafLoopScheduler {
  private tasks = new Map<string, LoopTask>();
  private lastRun = new Map<string, number>();
  private rafId = 0;
  private running = false;

  register(task: LoopTask): void {
    this.tasks.set(task.id, task);
    if (!this.running) this.start();
  }

  unregister(id: string): void {
    this.tasks.delete(id);
    this.lastRun.delete(id);
    if (this.tasks.size === 0) this.stop();
  }

  clear(): void {
    this.tasks.clear();
    this.lastRun.clear();
    this.stop();
  }

  private start(): void {
    this.running = true;
    const tick = (now: number) => {
      if (!this.running) return;
      for (const task of this.tasks.values()) {
        if (task.when && !task.when()) continue;
        const prev = this.lastRun.get(task.id) ?? 0;
        if (now - prev >= task.intervalMs) {
          this.lastRun.set(task.id, now);
          task.run();
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }
}

export type DomObserverOptions = {
  root?: ParentNode;
  onChange: () => void;
  attributeFilter?: string[];
};

/** MutationObserver helper with microtask debounce (replaces polling for DOM). */
export function observeDomChanges(opts: DomObserverOptions): () => void {
  const root = opts.root ?? document.body;
  if (!root) return () => {};

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      opts.onChange();
    });
  };

  const observer = new MutationObserver(schedule);
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: opts.attributeFilter ?? [
      'class',
      'data-testid',
      'aria-label',
      'aria-pressed',
      'data-state',
      'data-selected',
    ],
  });

  root.addEventListener('input', schedule, true);
  return () => {
    observer.disconnect();
    root.removeEventListener('input', schedule, true);
  };
}
