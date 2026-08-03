import './content.legacy';
import { startBetslipIframeLifecycle } from './iframe-lifecycle';
import { detectSlipFrameKind, frameCanHostBetSlip } from './slip-frame-kind';
import { slipDocContext } from './slip-doc-context';
import { markSlipFrameOnDom, probeSlipDom, readSlipOddsFromProbedDom } from './slip-probe';
import { startSlipDomObserverInDocument } from './slip-observer';

declare global {
  interface Window {
    __btiSlipProbe?: () => ReturnType<typeof probeSlipDom>;
    __btiReadSlipOdds?: () => ReturnType<typeof readSlipOddsFromProbedDom>;
  }
}

const kind = detectSlipFrameKind();
const ctx = slipDocContext();
markSlipFrameOnDom(ctx);

window.__btiSlipProbe = () => probeSlipDom(ctx);
window.__btiReadSlipOdds = () => readSlipOddsFromProbedDom(ctx);

function notifyOdds(slip: Record<string, unknown> | null, cartChange?: boolean) {
  try {
    chrome.runtime.sendMessage({
      type: 'ODDS_CHANGED',
      source: 'bti',
      slip: slip || null,
      suspended: !slip,
      cartChange: !!cartChange,
      frameKind: kind,
    });
  } catch {
    /* extension context invalidated */
  }
}

/**
 * Top shell: body MO → betslip iframe 감지 → load → contentDocument → 내부 MO
 * Betslip iframe (CS 직접 주입): 해당 document 내부 MO
 */
if (window === window.top || kind === 'shell-top') {
  startBetslipIframeLifecycle(notifyOdds);
}

if (frameCanHostBetSlip(kind)) {
  startSlipDomObserverInDocument(document, notifyOdds, location.href, 'native-frame');
}

console.log(
  '[텐텐뱃 slip-lifecycle]',
  kind,
  window === window.top ? 'top' : 'iframe',
  (location.href || '').slice(0, 80)
);
