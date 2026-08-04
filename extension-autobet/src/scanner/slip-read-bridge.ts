import type { ScannerHandle } from './bootstrap';
import { readSlipOddsFromProbedDom } from '../content/bti/slip-probe';

export type UnifiedSlipRead = {
  odds: number;
  selectionText: string;
  source: string;
  fromSlip: boolean;
  sourceKind?: string;
  method?: string;
};

/** BTI: scanner → shadow-query slip-probe (검증된 legacy DOM 경로) */
export function readBtiSlipUnified(scanner: ScannerHandle): UnifiedSlipRead | null {
  try {
    const scanned = scanner.readOdds();
    if (scanned?.odds && scanned.odds > 1.01) {
      return {
        odds: scanned.odds,
        selectionText: scanned.selectionText || '',
        source: scanned.source || scanned.sourceKind || 'dom-scanner',
        sourceKind: scanned.sourceKind || scanned.source,
        fromSlip: true,
        method: 'dom-scanner',
      };
    }
  } catch {
    /* scanner miss — fall through */
  }

  try {
    const probed = readSlipOddsFromProbedDom();
    if (probed?.odds && probed.odds > 1.01) {
      return {
        odds: probed.odds,
        selectionText: probed.selectionText || '',
        source: probed.source,
        sourceKind: probed.source,
        fromSlip: true,
        method: 'shadow-query-probe',
      };
    }
  } catch {
    /* ignore */
  }

  return null;
}

/** BC: __bcReadNativeSlip 결과를 content.legacy 형식으로 정규화 */
export function readBcSlipFromNativeHook(): UnifiedSlipRead | null {
  const fn = (globalThis as { __bcReadNativeSlip?: () => Record<string, unknown> | null })
    .__bcReadNativeSlip;
  if (typeof fn !== 'function') return null;

  try {
    const hit = fn();
    const odds = hit?.odds as number | undefined;
    if (!hit || !odds || odds <= 1.01) return null;
    return {
      odds,
      selectionText: String(hit.selectionText || hit.teamLabel || hit.outcome || ''),
      source: String(hit.method || hit.sourceKind || 'bc-native-slip'),
      sourceKind: String(hit.sourceKind || hit.method || 'bc-native-slip'),
      fromSlip: hit.fromSlip !== false,
      method: String(hit.method || 'bc-native-slip'),
    };
  } catch {
    return null;
  }
}

/** Scanner는 push 금지 — legacy observer만 ODDS_CHANGED 발행 */
export const NOOP_ODDS_CHANGE = (): void => {};
