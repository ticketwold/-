/** x10x10s / BTI Bet Slip 프레임 종류 (코드·진단 기준) */
export type SlipFrameKind =
  | 'sportscenter-betslip'
  | 'widgets-x'
  | 'board-iframe'
  | 'shell-top'
  | 'junk'
  | 'unknown';

export function isSportscenterBetslipHref(href: string): boolean {
  return /\/api\/sportscenter\/betslip/i.test(href);
}

export function isWidgetsXHref(href: string): boolean {
  return /widgets-x/i.test(href);
}

/** 상위 in-play 셸 — 배당판만 있고 Bet Slip DOM 없음 */
export function isInPlayShellHref(href: string): boolean {
  if (!href) return false;
  if (/widgets-x|betslip|sportscenter|bti-sports|master_fe|Selections_selection/i.test(href)) {
    return false;
  }
  try {
    const u = new URL(href);
    if (!/x10x10s\.com$/i.test(u.hostname.replace(/^www\./, ''))) return false;
    return /\/in-play\/|\/match\//i.test(u.pathname);
  } catch {
    return /x10x10s\.com.*\/(in-play|match)\//i.test(href);
  }
}

export function detectSlipFrameKind(href = location.href): SlipFrameKind {
  const u = String(href || '');
  if (!u || u === 'about:blank') return 'junk';
  if (/livechatinc|liveplugins|recaptcha|player\.twitch|streambridge\.feedconstruct\.com\/player/i.test(u)) {
    return 'junk';
  }
  if (isSportscenterBetslipHref(u)) return 'sportscenter-betslip';
  if (isWidgetsXHref(u)) return 'widgets-x';
  if (isInPlayShellHref(u)) return 'shell-top';
  const hasBoard = !!document.querySelector(
    'button[class*="master_fe_Selections_selection"], button[class*="Selections_selection"]'
  );
  const hasCounter = !!document.querySelector(
    '#counter, input[class*="CounterSecondary"], input[class*="Counter"]'
  );
  if (hasCounter && !hasBoard) return 'sportscenter-betslip';
  if (hasBoard) return 'board-iframe';
  return 'unknown';
}

export function frameCanHostBetSlip(kind: SlipFrameKind): boolean {
  return kind === 'sportscenter-betslip' || kind === 'widgets-x';
}

export function frameShouldSkipSlipRead(kind: SlipFrameKind): boolean {
  return kind === 'shell-top' || kind === 'junk' || kind === 'unknown';
}
