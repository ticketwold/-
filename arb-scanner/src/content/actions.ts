import type { SiteId } from '@core/types';
import { queryAllDeep, walkElements } from '@scanner/dom-walker';
import { readBcSlipFromDoc, readSlipFromDoc, readX10SlipFromDoc } from '@scanner/slip-reader';
import { SEL } from '@scanner/stable-selectors';
import type { ActionResult, SlipState } from '@core/types';

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

export function findX10StakeInput(): HTMLInputElement | null {
  for (const el of queryAllDeep(document, SEL.x10.stake)) {
    if (el instanceof HTMLInputElement) return el;
  }
  return null;
}

function findX10BetButton(): HTMLButtonElement | null {
  for (const btn of queryAllDeep(document, 'button')) {
    const t = (btn.textContent || '').trim();
    if (/배당\s*수락|베팅하기|Place Bet|Bet Now/i.test(t)) return btn as HTMLButtonElement;
  }
  for (const el of queryAllDeep(document, '[class*="PlaceBet"], [class*="place-bet"]')) {
    const btn = el.closest('button') || (el instanceof HTMLButtonElement ? el : null);
    if (btn) return btn;
  }
  return null;
}

function scoreBcStakeInput(input: HTMLInputElement): number {
  let score = 0;
  const id = input.id || '';
  const ph = input.placeholder || '';
  const cls = input.className || '';
  const blob = `${id} ${ph} ${cls}`.toLowerCase();
  if (id === 'counter') score += 200;
  if (/usdt|stake|베팅|counter/i.test(blob)) score += 90;
  const rect = input.getBoundingClientRect?.();
  if (rect && rect.left > (window.innerWidth || 800) * 0.45) score += 70;
  if (input.closest('[class*="betslip"], [class*="bet-slip"], [class*="Betslip"]')) score += 220;
  return score;
}

export function findBcStakeInput(): HTMLInputElement | null {
  const candidates: HTMLInputElement[] = [];
  for (const el of queryAllDeep(document, SEL.bc.stake)) {
    if (el instanceof HTMLInputElement && el.type !== 'hidden') candidates.push(el);
  }
  walkElements(document.body || document.documentElement, (el) => {
    if (!(el instanceof HTMLInputElement) || el.type === 'hidden') return;
    const blob = `${el.placeholder} ${el.className} ${el.id}`.toLowerCase();
    if (/usdt|stake|베팅|counter|decimal/i.test(blob) || el.inputMode === 'decimal') {
      candidates.push(el);
    }
  });
  if (!candidates.length) return null;
  return candidates.sort((a, b) => scoreBcStakeInput(b) - scoreBcStakeInput(a))[0]!;
}

function findBcBetButton(): HTMLButtonElement | null {
  for (const btn of queryAllDeep(document, 'button')) {
    const t = (btn.textContent || '').trim();
    if (/^베팅하기$|Place Bet|place bet/i.test(t)) return btn as HTMLButtonElement;
  }
  return null;
}

export function readX10Slip(): SlipState | null {
  return readX10SlipFromDoc(document);
}

export function readBcSlip(): SlipState | null {
  return readBcSlipFromDoc(document);
}

export function setX10Stake(amountKrw: number): ActionResult {
  const input = findX10StakeInput();
  if (!input) return { ok: false, reason: 'x10-stake-input-missing' };
  const want = Math.max(1000, Math.round(amountKrw));
  setInputValue(input, String(want));
  const got = parseInt(String(input.value || '0').replace(/,/g, ''), 10);
  return got > 0 ? { ok: true, stake: got } : { ok: false, reason: 'x10-stake-not-applied' };
}

function applyBcStakeValue(input: HTMLInputElement, str: string): void {
  input.focus?.();
  try {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, str);
  } catch {
    /* ignore */
  }
  setInputValue(input, str);
  input.blur?.();
}

export async function setBcStake(amountUsdt: number): Promise<ActionResult> {
  const input = findBcStakeInput();
  if (!input) return { ok: false, reason: 'bc-stake-input-missing' };
  const want = Math.max(0.01, Math.round(amountUsdt * 100) / 100);
  const str = String(want);

  const tries = [str, `${str} `, str];
  for (const val of tries) {
    applyBcStakeValue(input, val);
    await new Promise((r) => setTimeout(r, 120));
    const got = parseFloat(String(input.value || '0').replace(/,/g, ''));
    if (got > 0 && Math.abs(got - want) < 0.25) return { ok: true, stake: got };
  }

  // char-by-char fallback
  input.focus?.();
  setInputValue(input, '');
  for (const ch of str) {
    setInputValue(input, (input.value || '') + ch);
    await new Promise((r) => setTimeout(r, 18));
  }
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  const got = parseFloat(String(input.value || '0').replace(/,/g, ''));
  return got > 0 ? { ok: true, stake: got } : { ok: false, reason: 'bc-stake-not-applied' };
}

export async function placeX10Bet(amountKrw: number): Promise<ActionResult> {
  const fill = setX10Stake(amountKrw);
  if (!fill.ok) return fill;
  await new Promise((r) => setTimeout(r, 200));
  const btn = findX10BetButton();
  if (!btn || btn.disabled) return { ok: false, reason: 'x10-bet-button-missing' };
  btn.click();
  return { ok: true, success: true, stake: fill.stake };
}

export async function placeBcBet(amountUsdt: number): Promise<ActionResult> {
  const fill = await setBcStake(amountUsdt);
  if (!fill.ok) return fill;
  await new Promise((r) => setTimeout(r, 250));
  const btn = findBcBetButton();
  if (!btn || btn.disabled) return { ok: false, reason: 'bc-bet-button-missing' };
  btn.scrollIntoView?.({ block: 'center' });
  btn.click();
  return { ok: true, success: true, stake: fill.stake };
}

export function readSlipForSite(siteId: SiteId): SlipState | null {
  return readSlipFromDoc(siteId, document);
}
