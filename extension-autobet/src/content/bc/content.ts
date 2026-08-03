import './content.legacy';
import type { OddsPayload } from '@scanner/types';
import { startScanner } from '@scanner/bootstrap';

declare global {
  interface Window {
    __bcReadNativeSlip?: () => ReturnType<ReturnType<typeof startScanner>['readOdds']>;
    __bcScannerProbe?: () => ReturnType<ReturnType<typeof startScanner>['probe']>;
    __domScannerActive?: boolean;
  }
}

function notifyOdds(slip: Record<string, unknown> | null, cartChange?: boolean) {
  try {
    chrome.runtime.sendMessage({
      type: 'ODDS_CHANGED',
      source: 'bcgame',
      slip: slip || null,
      suspended: !slip,
      cartChange: !!cartChange,
    });
  } catch {
    /* extension context invalidated */
  }
}

const scanner = startScanner({
  source: 'bcgame',
  onOddsChange: (slip: OddsPayload | null, cartChange?: boolean) =>
    notifyOdds(slip as Record<string, unknown> | null, cartChange),
});

window.__domScannerActive = true;
window.__bcReadNativeSlip = () => scanner.readOdds();
window.__bcScannerProbe = () => scanner.probe();

console.log('[DOM Scanner / BC.Game]', window === window.top ? 'top' : 'iframe', (location.href || '').slice(0, 80));
