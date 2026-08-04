/** 안정 selector — CSS module 해시 제외, BEM prefix / data-* 우선 */
export const SEL = {
  x10: {
    stake:
      '#counter, input[class*="CounterSecondary_input"], input[class*="CounterSecondary"], input[class*="counter__input"], input[placeholder="베팅금"], input[placeholder*="베팅"], input[id="counter"]',
    slipCard:
      '[class*="betslip_fe_BetSecondary_bet"], [class*="BetSecondary_bet"], [class*="BetslipBet"], [class*="betInformation"], [data-testid*="bet-slip"], [data-testid*="betslip"]',
    slipTitle: '[class*="betInformation__title"]',
    slipEvent: '[class*="betInformation__eventName"], [class*="eventName"]',
    slipLeague: '[class*="betInformation__league"], [class*="leagueName"]',
    slipTime: '[class*="betInformation__time"], time, [datetime]',
    oddsHints:
      '[class*="UpdateNotification"], [class*="Selections_odds"], [class*="odds"], [class*="Odds"], [class*="coefficient"], [class*="Coefficient"]',
    boardBtn: 'button[class*="Selections_selection"], button[class*="master_fe_Selections_selection"]',
    boardOdds: '[class*="Selections_odds"]',
  },
  bc: {
    winnerCoef:
      '.bet__winner-coef, [class*="bet__winner-coef"]:not([class*="Suspended"]), [class*="winner-coef"]:not([class*="Suspended"])',
    slipRoot:
      '[class*="betslip"], [class*="bet-slip"], [class*="Betslip"], [data-testid*="betslip"], [class*="betslip-root"]',
    stake:
      'input[placeholder*="stake"], input[placeholder*="베팅"], input[placeholder*="Stake"], input[type="text"][inputmode="decimal"], input[class*="stake"]',
    selection: '[class*="betInformation__title"], [class*="coupon"] [class*="title"], [class*="selection"]',
    event: '[class*="eventName"], [class*="EventName"], [class*="event-name"]',
    boardOdds: '[class*="odd"], [class*="Odds"]',
  },
} as const;
