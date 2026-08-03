/**
 * 안정적인 BEM / data 속성 selector (React CSS module 해시 class 제외)
 * betInformation__, bet__winner-coef 등 사이트가 유지하는 클래스만 사용
 */

/** BTI / x10x10s Bet Slip */
export const X10_STAKE_INPUT =
  '#counter, input[placeholder*="베팅"], input[placeholder*="베팅금"], input[id="counter"]';

export const X10_SLIP_CARD =
  '[class*="BetSecondary_bet"], [class*="betInformation"], [data-testid*="bet-slip"], [data-testid*="betslip"]';

export const X10_SLIP_TITLE = '[class*="betInformation__title"]';
export const X10_SLIP_EVENT = '[class*="betInformation__eventName"], [class*="eventName"]';
export const X10_SLIP_ODDS =
  '[class*="UpdateNotification"], [class*="Selections_odds"], [class*="coefficient"], [class*="Coefficient"]';

/** BC.Game / Betby Bet Slip */
export const BC_WINNER_COEF = '.bet__winner-coef, [class*="bet__winner-coef"]:not([class*="Suspended"])';
export const BC_WINNER_COEF_ANY = '.bet__winner-coef, [class*="bet__winner-coef"]';
export const BC_SLIP_ROOT =
  '[class*="betslip"], [class*="bet-slip"], [data-testid*="betslip"], [data-testid*="bet-slip"], aside';
