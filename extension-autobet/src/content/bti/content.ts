import './content.legacy';
import { detectSlipFrameKind, frameShouldSkipSlipRead } from './slip-frame-kind';
import { markSlipFrameOnDom, probeSlipDom, readSlipOddsFromProbedDom } from './slip-probe';
import { startSlipDomObserver } from './slip-observer';

declare global {
  interface Window {
    __btiSlipProbe?: () => ReturnType<typeof probeSlipDom>;
    __btiReadSlipOdds?: () => ReturnType<typeof readSlipOddsFromProbedDom>;
  }
}

const kind = detectSlipFrameKind();
markSlipFrameOnDom();

window.__btiSlipProbe = () => probeSlipDom();
window.__btiReadSlipOdds = () => readSlipOddsFromProbedDom();

if (!frameShouldSkipSlipRead(kind)) {
  startSlipDomObserver((slip, cartChange) => {
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
  });
}

console.log(
  '[텐텐뱃 slip-frame]',
  kind,
  window === window.top ? 'top' : 'iframe',
  (location.href || '').slice(0, 80)
);
