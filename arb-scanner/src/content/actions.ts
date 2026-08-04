import type { SiteId } from '@core/types';
import { queryAllDeep } from '@scanner/dom-walker';
import { parseOddsText, readOddsFromElement } from '@scanner/odds-parser';
import { SEL } from '@scanner/stable-selectors';
import type { ActionResult, SlipState } from '@core/types';

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
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
    if (/베팅하기|Place Bet|Bet Now/i.test(t)) return btn as HTMLButtonElement;
  }
  return null;
}

export function findBcStakeInput(): HTMLInputElement | null {
  for (const el of queryAllDeep(document, SEL.bc.stake)) {
    if (el instanceof HTMLInputElement && el.type !== 'hidden') return el;
  }
  return null;
}

function findBcBetButton(): HTMLButtonElement | null {
  for (const btn of queryAllDeep(document, 'button')) {
    const t = (btn.textContent || '').trim();
    if (/베팅하기|Place Bet|Bet$/i.test(t)) return btn as HTMLButtonElement;
  }
  return null;
}

export function readX10Slip(): SlipState | null {
  const cards = queryAllDeep(document, SEL.x10.slipCard);
  const card = cards[cards.length - 1];
  if (!card) {
    const stake = findX10StakeInput();
    if (!stake) return null;
    const root = stake.closest('[class*="betslip"], aside') || document.body;
    const at = parseOddsText(root.textContent || '');
    if (!at) return null;
    return {
      odds: at,
      selection: 'slip',
      eventName: root.querySelector(SEL.x10.slipEvent)?.textContent?.trim() || '',
      stake: parseInt(stake.value || '0', 10) || 0,
      source: 'slip',
      updatedAt: Date.now(),
    };
  }
  let odds: number | null = null;
  for (const el of queryAllDeep(card, '[class*="odds"], [class*="Odds"]')) {
    odds = readOddsFromElement(el);
    if (odds) break;
  }
  if (!odds) odds = parseOddsText(card.textContent || '');
  if (!odds) return null;
  const stakeEl = findX10StakeInput();
  return {
    odds,
    selection: card.querySelector(SEL.x10.slipTitle)?.textContent?.trim() || 'slip',
    eventName: card.querySelector(SEL.x10.slipEvent)?.textContent?.trim() || '',
    stake: stakeEl ? parseInt(stakeEl.value || '0', 10) || 0 : 0,
    source: 'slip',
    updatedAt: Date.now(),
  };
}

export function readBcSlip(): SlipState | null {
  const coefs = queryAllDeep(document, SEL.bc.winnerCoef);
  const el = coefs[coefs.length - 1];
  if (!el) return null;
  const odds = readOddsFromElement(el);
  if (!odds) return null;
  const root = el.closest(SEL.bc.slipRoot) || el.parentElement;
  const stakeEl = findBcStakeInput();
  return {
    odds,
    selection: root?.querySelector(SEL.bc.selection)?.textContent?.trim() || 'slip',
    eventName: root?.querySelector(SEL.bc.event)?.textContent?.trim() || 'bc-slip',
    stake: stakeEl ? parseFloat(stakeEl.value || '0') || 0 : 0,
    source: 'slip',
    updatedAt: Date.now(),
  };
}

export function setX10Stake(amountKrw: number): ActionResult {
  const input = findX10StakeInput();
  if (!input) return { ok: false, reason: 'x10-stake-input-missing' };
  const want = Math.max(1000, Math.round(amountKrw));
  setInputValue(input, String(want));
  const got = parseInt(input.value || '0', 10);
  return got > 0 ? { ok: true, stake: got } : { ok: false, reason: 'x10-stake-not-applied' };
}

export function setBcStake(amountUsdt: number): ActionResult {
  const input = findBcStakeInput();
  if (!input) return { ok: false, reason: 'bc-stake-input-missing' };
  const want = Math.max(0.01, Math.round(amountUsdt * 100) / 100);
  setInputValue(input, String(want));
  const got = parseFloat(input.value || '0');
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
  const fill = setBcStake(amountUsdt);
  if (!fill.ok) return fill;
  await new Promise((r) => setTimeout(r, 250));
  const btn = findBcBetButton();
  if (!btn || btn.disabled) return { ok: false, reason: 'bc-bet-button-missing' };
  btn.scrollIntoView?.({ block: 'center' });
  btn.click();
  return { ok: true, success: true, stake: fill.stake };
}

export function readSlipForSite(siteId: SiteId): SlipState | null {
  return siteId === 'x10' ? readX10Slip() : readBcSlip();
}
