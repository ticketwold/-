import './slip-read.legacy';
import type { OddsPayload } from '@scanner/types';
import { startScanner } from '@scanner/bootstrap';
import { startAutoDiagnostic } from '@scanner/auto-diagnostic';
import { runDomProbe } from '@scanner/dom-probe';
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

function notifyOdds(slip: Record<string, unknown> | null, cartChange?: boolean) {
  if (slip?.odds) {
    console.log(
      '[DOM Scanner / BC slip-read]',
      slip.odds,
      'source:',
      slip.source || slip.sourceKind,
      'frame:',
      slip.frameLabel || location.href.slice(0, 80)
    );
  }
  try {
    chrome.runtime.sendMessage({
      type: 'ODDS_CHANGED',
      source: 'bcgame',
      slip: slip || null,
      suspended: !slip,
      cartChange: !!cartChange,
      frameKind: slip?.frameLabel || (isBetbyCdn ? 'betby-widget' : 'bc-slip-read'),
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
  console.log('[DOM Scanner / BC slip-read] read wrapper installed');
}

const wrapObserver = new MutationObserver(() => installBcReadWrapper());
if (document.documentElement) {
  wrapObserver.observe(document.documentElement, { childList: true, subtree: true });
}
installBcReadWrapper();
requestAnimationFrame(installBcReadWrapper);

console.log(
  '[DOM Scanner / BC slip-read] boot',
  isBetbyCdn ? 'betby-cdn' : 'bc-game-frame',
  window === window.top ? 'top' : 'iframe',
  (location.href || '').slice(0, 100)
);

startAutoDiagnostic({
  scriptEntry: 'bc_slip_read.js',
  scanner,
  label: isBetbyCdn ? 'BC / betby-cdn (bc_slip_read)' : 'BC / bc_slip_read',
});
