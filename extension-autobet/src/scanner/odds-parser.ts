/** 정지/마감 텍스트 — 배당으로 파싱하지 않음 */
export const SUSPENDED_TEXT_RE =
  /^(정지된|정지됨|정지|마감|closed|suspended|locked|unavailable|pause|paused)$/i;

export const SUSPENDED_CLASS_RE = /suspended|coefSuspended|_Suspended|is-suspended|is-locked/i;

let debugOdds = false;

export function setOddsDebug(enabled: boolean): void {
  debugOdds = enabled;
}

export function isSuspendedOddsText(text: string): boolean {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (SUSPENDED_TEXT_RE.test(t)) return true;
  if (/정지된|정지됨|마감|suspended|unavailable|locked/i.test(t) && !/\d+\.\d{2}/.test(t)) return true;
  return false;
}

export function isSuspendedOddsElement(el: Element): boolean {
  const text = (el.textContent || '').trim();
  if (isSuspendedOddsText(text)) return true;
  const cls = String(el.className || '');
  if (SUSPENDED_CLASS_RE.test(cls)) return true;
  const aria = el.getAttribute('aria-disabled');
  if (aria === 'true') return true;
  return false;
}

export function parseOddsString(raw: string, label = ''): number | null {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text || isSuspendedOddsText(text)) {
    if (debugOdds && text) console.log('[odds-parser] skip suspended:', label, JSON.stringify(text));
    return null;
  }

  if (debugOdds) console.log('[odds-parser] raw:', label, JSON.stringify(text));

  const at = text.match(/@\s*(\d{1,2}\.\d{2,4})/);
  if (at?.[1]) {
    const n = parseFloat(at[1]);
    if (debugOdds) console.log('[odds-parser] @ match:', label, n);
    return clampOdds(n);
  }

  if (/^\d{1,2}\.\d{2,4}$/.test(text)) {
    const n = parseFloat(text);
    if (debugOdds) console.log('[odds-parser] decimal:', label, n);
    return clampOdds(n);
  }

  const m = text.match(/\b(\d{1,2}\.\d{2,4})\b/);
  if (m?.[1]) {
    const n = parseFloat(m[1]);
    if (debugOdds) console.log('[odds-parser] embedded:', label, n);
    return clampOdds(n);
  }

  return null;
}

export function clampOdds(n: number): number | null {
  if (!Number.isFinite(n) || n <= 1.01 || n >= 100) return null;
  return Math.round(n * 1000) / 1000;
}
