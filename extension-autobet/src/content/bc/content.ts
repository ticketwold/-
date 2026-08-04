import './content.legacy';
import { runDomProbe } from '@scanner/dom-probe';

declare global {
  interface Window {
    __bcDomProbe?: () => ReturnType<typeof runDomProbe>;
  }
}

/**
 * polymarket_content.js — bc.game shell (베팅 UI·observer).
 * slip 파싱은 bc_slip_read.js의 __bcReadNativeSlip에 위임.
 * 여기서 scanner를 또 띄우지 않음 (중복·split-brain 방지).
 */
window.__bcDomProbe = () => runDomProbe('bc-content');

console.log(
  '[BC shell] boot',
  window === window.top ? 'top' : 'iframe',
  (location.href || '').slice(0, 100)
);
