import './content.legacy';
import type { OddsPayload } from '@scanner/types';
import { startScanner } from '@scanner/bootstrap';
import { detectSiteId } from '@scanner/site-detector';

declare global {
  interface Window {
    __btiSlipProbe?: () => ReturnType<ReturnType<typeof startScanner>['probe']>;
    __btiReadSlipOdds?: () => ReturnType<ReturnType<typeof startScanner>['readOdds']>;
    __domScannerActive?: boolean;
  }
}

const detected = detectSiteId(location.href);
const siteId = detected === 'unknown' ? 'x10' : detected;

function notifyOdds(slip: Record<string, unknown> | null, cartChange?: boolean) {
  try {
    chrome.runtime.sendMessage({
      type: 'ODDS_CHANGED',
      source: 'bti',
      slip: slip || null,
      suspended: !slip,
      cartChange: !!cartChange,
      frameKind: slip?.frameLabel ?? 'scanner',
    });
  } catch {
    /* extension context invalidated */
  }
}

const scanner = startScanner({
  source: 'bti',
  siteId: siteId === 'x10' ? 'x10' : undefined,
  onOddsChange: (slip: OddsPayload | null, cartChange?: boolean) =>
    notifyOdds(slip as Record<string, unknown> | null, cartChange),
});

window.__domScannerActive = true;
window.__btiSlipProbe = () => scanner.probe();
window.__btiReadSlipOdds = () => scanner.readOdds();

console.log(
  '[DOM Scanner / 텐텐뱃]',
  siteId,
  window === window.top ? 'top' : 'iframe',
  (location.href || '').slice(0, 80)
);
