import './slip-read.legacy';
import { startScanner } from '@scanner/bootstrap';
import { startAutoDiagnostic } from '@scanner/auto-diagnostic';
import { runDomProbe } from '@scanner/dom-probe';
import { NOOP_ODDS_CHANGE } from '@scanner/slip-read-bridge';
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

const isBetbyCdn = /betby\.com|sptpub\.com|sptsportscdn\.com|biahosted\.com|cocoesports\.com/i.test(
  location.href
);

try {
  setOddsDebug(localStorage.getItem('autobet-odds-debug') === '1');
} catch {
  /* ignore */
}

/** bc_slip_read.js — Betby CDN + bc.game all_frames. 유일한 BC scanner 인스턴스 */
const scanner = startScanner({
  source: 'bcgame',
  onOddsChange: NOOP_ODDS_CHANGE,
});

window.__domScannerActive = true;
window.__bcScannerProbe = () => scanner.probe();
window.__bcDomProbe = () => runDomProbe('bc-slip-read');

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
  console.log('[BC slip-read] scanner→legacy wrapper installed');
}

const wrapObserver = new MutationObserver(() => installBcReadWrapper());
if (document.documentElement) {
  wrapObserver.observe(document.documentElement, { childList: true, subtree: true });
}
installBcReadWrapper();
requestAnimationFrame(installBcReadWrapper);

console.log(
  '[BC slip-read] boot',
  isBetbyCdn ? 'betby-cdn' : 'bc-game-frame',
  window === window.top ? 'top' : 'iframe',
  (location.href || '').slice(0, 100)
);

startAutoDiagnostic({
  scriptEntry: 'bc_slip_read.js',
  scanner,
  label: isBetbyCdn ? 'BC / betby-cdn' : 'BC / bc_slip_read',
});
