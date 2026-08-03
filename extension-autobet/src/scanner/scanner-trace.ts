export type ScannerTrace = {
  lastSelector: string;
  lastOuterHtml: string;
  lastSource: string;
  lastOdds: number;
  nullReason: string;
  lastUpdatedAt: number;
};

const trace: ScannerTrace = {
  lastSelector: '',
  lastOuterHtml: '',
  lastSource: '',
  lastOdds: 0,
  nullReason: '아직 스캔하지 않음',
  lastUpdatedAt: 0,
};

export function getScannerTrace(): Readonly<ScannerTrace> {
  return trace;
}

export function setScannerHit(selector: string, el: Element | null, source: string, odds: number): void {
  trace.lastSelector = selector;
  trace.lastSource = source;
  trace.lastOdds = odds;
  trace.nullReason = '';
  trace.lastUpdatedAt = Date.now();
  if (el) {
    try {
      trace.lastOuterHtml = (el.outerHTML || '').slice(0, 800);
    } catch {
      trace.lastOuterHtml = '(outerHTML 접근 불가)';
    }
  } else {
    trace.lastOuterHtml = '';
  }
}

export function setScannerNullReason(reason: string): void {
  trace.nullReason = reason;
  trace.lastUpdatedAt = Date.now();
}

export function clearScannerHit(): void {
  trace.lastOdds = 0;
  trace.lastSelector = '';
  trace.lastOuterHtml = '';
  trace.lastSource = '';
}
