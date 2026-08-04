/** 안정 selector — CSS module 해시 제외, BEM prefix / data-* 우선 */
export const SEL = {
  x10: {
    stake: '#counter, input[placeholder*="베팅"], input[id="counter"]',
    slipCard: '[class*="BetSecondary_bet"], [class*="betInformation"]',
    slipTitle: '[class*="betInformation__title"]',
    slipEvent: '[class*="betInformation__eventName"], [class*="eventName"]',
    slipLeague: '[class*="betInformation__league"], [class*="leagueName"]',
    slipTime: '[class*="betInformation__time"], time, [datetime]',
    boardBtn: 'button[class*="Selections_selection"]',
    boardOdds: '[class*="Selections_odds"]',
  },
  bc: {
    winnerCoef: '.bet__winner-coef, [class*="bet__winner-coef"]:not([class*="Suspended"])',
    slipRoot: '[class*="betslip"], [class*="bet-slip"], [data-testid*="betslip"]',
    stake: 'input[placeholder*="stake"], input[placeholder*="베팅"], input[type="text"][inputmode="decimal"]',
    selection: '[class*="betInformation__title"], [class*="coupon"] [class*="title"]',
    event: '[class*="eventName"], [class*="EventName"]',
    boardOdds: '[class*="odd"], [class*="Odds"]',
  },
} as const;
