const MAX_DEPTH = 64;

/** chrome.dom.openOrClosedShadowRoot 폴백 (BC closed shadow) */
export function openShadowRoot(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    const chromeDom = (globalThis as unknown as {
      chrome?: { dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null } };
    }).chrome?.dom;
    return chromeDom?.openOrClosedShadowRoot?.(el) ?? null;
  } catch {
    return null;
  }
}

export type WalkVisitor = (node: Node, depth: number, via: 'light' | 'shadow') => void;

/** light DOM + shadow DOM 재귀 순회 (querySelector 대체) */
export function walkNodes(root: Node, visitor: WalkVisitor, depth = 0, via: 'light' | 'shadow' = 'light'): void {
  if (depth > MAX_DEPTH) return;
  visitor(root, depth, via);

  if (root.nodeType === Node.DOCUMENT_NODE) {
    const doc = root as Document;
    if (doc.documentElement) walkNodes(doc.documentElement, visitor, depth + 1, via);
    return;
  }

  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE || root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element | DocumentFragment;
    for (const child of el.childNodes) {
      walkNodes(child, visitor, depth + 1, via);
    }
    if (root.nodeType === Node.ELEMENT_NODE) {
      const sr = openShadowRoot(root as Element);
      if (sr) walkNodes(sr, visitor, depth + 1, 'shadow');
    }
  }
}

/** Element 순회 (Document / ShadowRoot / Element root 허용) */
export function walkElements(
  root: ParentNode,
  visitor: (el: Element, depth: number, via: 'light' | 'shadow') => void,
  depth = 0,
  via: 'light' | 'shadow' = 'light'
): void {
  walkNodes(root as Node, (node, d, v) => {
    if (node.nodeType === Node.ELEMENT_NODE) visitor(node as Element, d, v);
  }, depth, via);
}

export function countShadowHosts(doc: Document): number {
  let n = 0;
  walkElements(doc.documentElement || doc.body, (el) => {
    if (openShadowRoot(el)) n++;
  });
  return n;
}

export function countIframes(doc: Document): number {
  return doc.querySelectorAll('iframe').length;
}

/** 접근 가능한 iframe contentDocument 목록 */
export function collectIframeDocuments(doc: Document): { iframe: HTMLIFrameElement; childDoc: Document; src: string }[] {
  const out: { iframe: HTMLIFrameElement; childDoc: Document; src: string }[] = [];
  doc.querySelectorAll('iframe').forEach((iframe) => {
    try {
      const childDoc = iframe.contentDocument;
      if (childDoc?.documentElement) {
        const src = iframe.src || iframe.getAttribute('src') || childDoc.location?.href || '';
        out.push({ iframe, childDoc, src });
      }
    } catch {
      /* cross-origin */
    }
  });
  return out;
}
