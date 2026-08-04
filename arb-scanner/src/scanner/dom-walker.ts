export type WalkVia = 'light' | 'shadow';

const MAX_DEPTH = 48;

export function openShadow(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    return chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

export type WalkCallback = (node: Node, depth: number, via: WalkVia) => void;

/** light + shadow DOM 재귀 순회 */
export function walkDom(root: Node, cb: WalkCallback, depth = 0, via: WalkVia = 'light'): void {
  if (depth > MAX_DEPTH) return;
  cb(root, depth, via);

  if (root.nodeType === Node.DOCUMENT_NODE) {
    const doc = root as Document;
    if (doc.documentElement) walkDom(doc.documentElement, cb, depth + 1, via);
    return;
  }

  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE || root.nodeType === Node.ELEMENT_NODE) {
    const container = root as Element | DocumentFragment;
    for (const child of container.childNodes) walkDom(child, cb, depth + 1, via);
    if (root.nodeType === Node.ELEMENT_NODE) {
      const sr = openShadow(root as Element);
      if (sr) walkDom(sr, cb, depth + 1, 'shadow');
    }
  }
}

export function walkElements(
  root: ParentNode,
  cb: (el: Element, depth: number, via: WalkVia) => void
): void {
  walkDom(root as Node, (node, d, v) => {
    if (node.nodeType === Node.ELEMENT_NODE) cb(node as Element, d, v);
  });
}

export function queryAllDeep(root: ParentNode, selector: string): Element[] {
  const selectors = selector
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Element[] = [];
  const seen = new Set<Element>();
  walkElements(root, (el) => {
    for (const sel of selectors) {
      if (el.matches?.(sel) && !seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
      try {
        el.querySelectorAll(sel).forEach((m) => {
          if (!seen.has(m)) {
            seen.add(m);
            out.push(m);
          }
        });
      } catch {
        /* invalid selector */
      }
    }
  });
  return out;
}

export function countShadowRoots(doc: Document): number {
  let n = 0;
  walkElements(doc.documentElement || doc.body, (el) => {
    if (openShadow(el)) n++;
  });
  return n;
}

export function getFrameDepth(): number {
  let d = 0;
  let w: Window = window;
  try {
    while (w !== w.parent) {
      d++;
      w = w.parent;
    }
  } catch {
    return -1;
  }
  return d;
}

export function getDirectText(el: Element): string {
  let t = '';
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) t += n.textContent || '';
  }
  return t.replace(/\s+/g, ' ').trim();
}
