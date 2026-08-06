const SUSPENDED = /정지된|suspended|closed|unavailable/i;
const DECIMAL = /^\d{1,2}\.\d{2,4}$/;
const AT_ODDS = /@\s*(\d{1,2}\.\d{2,4})/;

export function parseOddsText(text: string): number | null {
  const t = String(text || '').trim();
  if (!t || SUSPENDED.test(t)) return null;
  const at = t.match(AT_ODDS);
  const raw = at?.[1] ?? (DECIMAL.test(t) ? t : null);
  if (!raw) return null;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 1.01 || n >= 100) return null;
  return Math.round(n * 1000) / 1000;
}

export function isSuspendedEl(el: Element): boolean {
  const blob = `${el.className} ${el.textContent}`.slice(0, 120);
  return SUSPENDED.test(blob);
}

export function readOddsFromElement(el: Element): number | null {
  if (isSuspendedEl(el)) return null;
  const direct = parseOddsText(
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent || '')
      .join('')
  );
  if (direct) return direct;
  return parseOddsText(el.textContent || '');
}
