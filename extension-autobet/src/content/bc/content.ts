import './content.legacy';
import type { OddsPayload } from '@scanner/types';
import { startScanner } from '@scanner/bootstrap';
import { logDomProbe, runDomProbe } from '@scanner/dom-probe';
import { setOddsDebug } from '@scanner/odds-parser';

declare global {
  interface Window {
    __bcReadNativeSlip?: () => Record<string, unknown> | null;
    __bcScannerProbe?: () => ReturnType<ReturnType<typeof startScanner>['probe']>;
    __bcDomProbe?: () => ReturnType<typeof runDomProbe>;
    __domScannerActive?: boolean;
    __domScannerWrapped?: boolean;
  }
}

try {
  setOddsDebug(localStorage.getItem('autobet-odds-debug') === '1');
} catch {
  /* ignore */
}

function notifyOdds(slip: Record<string, unknown> | null, cartChange?: boolean) {
  if (slip?.odds) {
    console.log('[DOM Scanner / BC.Game] odds:', slip.odds, 'source:', slip.source || slip.sourceKind);
  }
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
window.__bcScannerProbe = () => scanner.probe();
window.__bcDomProbe = () => runDomProbe('bc-content');

/** bc_slip_read.js가 load한 뒤 scanner + legacy readNativeSlip 병합 */
function installBcReadWrapper(): void {
  if (window.__domScannerWrapped) return;
  const legacy = window.__bcReadNativeSlip;
  if (typeof legacy !== 'function') return;

  window.__bcReadNativeSlip = () => {
    const scanned = scanner.readOdds();
    if (scanned?.odds && scanned.odds > 1.01) {
      return {
        ok: true,
        odds: scanned.odds,
        selectionText: scanned.selectionText || '',
        outcome: scanned.selectionText || '',
        teamLabel: scanned.selectionText || '',
        sourceKind: scanned.sourceKind || scanned.source || 'bc-winner-coef',
        fromSlip: true,
        method: 'dom-scanner',
        href: location.href,
      };
    }
    return legacy();
  };
  window.__domScannerWrapped = true;
  console.log('[DOM Scanner / BC.Game] read wrapper installed');
}

const wrapObserver = new MutationObserver(() => installBcReadWrapper());
if (document.documentElement) {
  wrapObserver.observe(document.documentElement, { childList: true, subtree: true });
}
installBcReadWrapper();
requestAnimationFrame(installBcReadWrapper);

console.log(
  '[DOM Scanner / BC.Game] boot',
  window === window.top ? 'top' : 'iframe',
  (location.href || '').slice(0, 100)
);

const bootProbe = () => logDomProbe('bc-content', scanner.probe());
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootProbe, { once: true });
} else {
  bootProbe();
}
setTimeout(bootProbe, 2500);
