import type { SlipFrameKind } from './slip-frame-kind';
import {
  isInPlayShellHref,
  isSportscenterBetslipHref,
  isWidgetsXHref,
} from './slip-frame-kind';

/** iframe.contentDocument 또는 현재 document 기준 컨텍스트 */
export type SlipDocContext = {
  doc: Document;
  href: string;
};

export function slipDocContext(doc: Document = document, hrefHint?: string): SlipDocContext {
  const href = hrefHint || doc.location?.href || '';
  return { doc, href };
}

export function detectSlipFrameKindInDoc(ctx: SlipDocContext): SlipFrameKind {
  const u = String(ctx.href || '');
  if (!u || u === 'about:blank') return 'junk';
  if (/livechatinc|liveplugins|recaptcha|player\.twitch|streambridge\.feedconstruct\.com\/player/i.test(u)) {
    return 'junk';
  }
  if (isSportscenterBetslipHref(u)) return 'sportscenter-betslip';
  if (isWidgetsXHref(u)) return 'widgets-x';
  if (isInPlayShellHref(u)) return 'shell-top';

  const root = ctx.doc;
  const hasBoard = !!root.querySelector(
    'button[class*="master_fe_Selections_selection"], button[class*="Selections_selection"]'
  );
  const hasCounter = !!root.querySelector(
    '#counter, input[class*="CounterSecondary"], input[class*="Counter"]'
  );
  if (hasCounter && !hasBoard) return 'sportscenter-betslip';
  if (hasBoard) return 'board-iframe';
  return 'unknown';
}

export const BETSLIP_IFRAME_SRC_RE =
  /betslip|sportscenter|widgets-x|\/bet\b|bet-slip|bet_slip/i;

export function isBetslipIframeElement(iframe: HTMLIFrameElement): boolean {
  const src = String(iframe.src || iframe.getAttribute('src') || '');
  if (!src || src === 'about:blank') return false;
  if (/livechatinc|liveplugins|recaptcha|player\.twitch/i.test(src)) return false;
  return BETSLIP_IFRAME_SRC_RE.test(src);
}
