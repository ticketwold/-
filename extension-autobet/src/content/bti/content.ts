import './content.legacy';
import type { OddsPayload } from '@scanner/types';
import { startScanner } from '@scanner/bootstrap';
import { startAutoDiagnostic } from '@scanner/auto-diagnostic';
import { runDomProbe } from '@scanner/dom-probe';
import { setOddsDebug } from '@scanner/odds-parser';
import { detectSiteId } from '@scanner/site-detector';
import { detectSlipFrameKind } from './slip-frame-kind';

declare global {
  interface Window {
    __btiSlipProbe?: () => ReturnType<ReturnType<typeof startScanner>['probe']>;
    __btiReadSlipOdds?: () => ReturnType<ReturnType<typeof startScanner>['readOdds']>;
    __btiDomProbe?: () => ReturnType<typeof runDomProbe>;
    __domScannerActive?: boolean;
  }
}

try {
  setOddsDebug(localStorage.getItem('autobet-odds-debug') === '1');
} catch {
  /* ignore */
}

const frameKind = detectSlipFrameKind();
const detected = detectSiteId(location.href);
const siteId = detected === 'unknown' ? 'x10' : detected;

function notifyOdds(slip: Record<string, unknown> | null, cartChange?: boolean) {
  if (slip?.odds) {
    console.log(
      '[DOM Scanner / 텐텐뱃] odds:',
      slip.odds,
      'source:',
      slip.source || slip.sourceKind,
      'frame:',
      slip.frameLabel || frameKind
    );
  }
  try {
    chrome.runtime.sendMessage({
      type: 'ODDS_CHANGED',
      source: 'bti',
      slip: slip || null,
      suspended: !slip,
      cartChange: !!cartChange,
      frameKind: slip?.frameLabel ?? frameKind,
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
window.__btiDomProbe = () => runDomProbe('bti-content');

console.log(
  '[DOM Scanner / 텐텐뱃] boot',
  siteId,
  frameKind,
  window === window.top ? 'top' : 'iframe',
  (location.href || '').slice(0, 100)
);

startAutoDiagnostic({
  scriptEntry: 'bti_content.js',
  scanner,
  label: `텐텐뱃 / ${frameKind}`,
});
