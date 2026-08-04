import './content.legacy';
import { startScanner } from '@scanner/bootstrap';
import { startAutoDiagnostic } from '@scanner/auto-diagnostic';
import { runDomProbe } from '@scanner/dom-probe';
import { NOOP_ODDS_CHANGE, readBtiSlipUnified } from '@scanner/slip-read-bridge';
import { setOddsDebug } from '@scanner/odds-parser';
import { detectSiteId } from '@scanner/site-detector';
import { detectSlipFrameKind } from './slip-frame-kind';

declare global {
  interface Window {
    __btiSlipProbe?: () => ReturnType<ReturnType<typeof startScanner>['probe']>;
    __btiReadSlipOdds?: () => ReturnType<typeof readBtiSlipUnified>;
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

/** Scanner = 읽기 전략만. ODDS_CHANGED는 content.legacy observer가 단독 발행 */
const scanner = startScanner({
  source: 'bti',
  siteId: siteId === 'x10' ? 'x10' : undefined,
  onOddsChange: NOOP_ODDS_CHANGE,
});

window.__domScannerActive = true;
window.__btiSlipProbe = () => scanner.probe();
window.__btiReadSlipOdds = () => readBtiSlipUnified(scanner);
window.__btiDomProbe = () => runDomProbe('bti-content');

console.log(
  '[BTI slip-read] boot',
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
