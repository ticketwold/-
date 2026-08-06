from __future__ import annotations

from typing import Any

from arb_desktop.core.team_matcher import (
    is_bti_away_side,
    is_bti_home_side,
    matchup_teams_match,
    team_match,
)
from arb_desktop.models import ArbOpportunity, Matchup, SiteId


def calc_arb(odds1: float, odds2: float) -> float | None:
    if not odds1 or not odds2 or odds1 <= 1 or odds2 <= 1:
        return None
    margin = (1 / odds1) + (1 / odds2)
    if margin >= 1:
        return None
    return ((1 / margin) - 1) * 100


def calc_bc_stake_usdt(bti_stake_krw: float, bti_odds: float, bc_odds: float, rate: float) -> float:
    if not rate or not bc_odds:
        return 0.0
    return round((bti_stake_krw * bti_odds) / (bc_odds * rate), 2)


def parse_bti_selection_price(selection: dict[str, Any]) -> float:
    for key in ("Price", "DisplayPrice", "Odds", "Decimal", "price", "odds"):
        val = selection.get(key)
        if val is None:
            continue
        try:
            n = float(val)
            if 1.001 < n < 500:
                return n
        except (TypeError, ValueError):
            continue
    return 0.0


def extract_bti_ml_odds(matchup: Matchup) -> tuple[float | None, float | None]:
    home_odds = away_odds = None
    for sel in matchup.moneyline:
        side = sel.side
        if is_bti_home_side(side):
            home_odds = sel.decimal
        elif is_bti_away_side(side):
            away_odds = sel.decimal
    if home_odds and away_odds:
        return home_odds, away_odds
    if len(matchup.moneyline) >= 2:
        return matchup.moneyline[0].decimal, matchup.moneyline[1].decimal
    return home_odds, away_odds


class OddsEngine:
    def __init__(self, min_profit_pct: float = 0.5, bti_stake_krw: float = 10_000, usdt_rate: float = 1400.0):
        self.min_profit_pct = min_profit_pct
        self.bti_stake_krw = bti_stake_krw
        self.usdt_rate = usdt_rate

    def find_opportunities(
        self,
        bti_matchups: list[Matchup],
        bc_matchups: list[Matchup],
        *,
        detection_ms: float = 0.0,
        calc_started_ns: int | None = None,
    ) -> list[ArbOpportunity]:
        from time import perf_counter_ns

        start = calc_started_ns or perf_counter_ns()
        opps: list[ArbOpportunity] = []

        for bti in bti_matchups:
            if bti.site != SiteId.BTI_X10:
                continue
            ml_h, ml_a = extract_bti_ml_odds(bti)
            if not ml_h or not ml_a:
                continue

            for bc in bc_matchups:
                if bc.site != SiteId.BC_GAME:
                    continue
                if not matchup_teams_match(bti.home, bti.away, bc.home, bc.away):
                    continue

                for bm in bc.moneyline:
                    if not bm.decimal or bm.decimal <= 1:
                        continue
                    bti_home = team_match(bm.team, bti.home)
                    bti_away = team_match(bm.team, bti.away)
                    opp_odds: float | None = None
                    bti_side = ""
                    if bti_home:
                        opp_odds = ml_a
                        bti_side = "away"
                    elif bti_away:
                        opp_odds = ml_h
                        bti_side = "home"
                    else:
                        continue

                    profit = calc_arb(bm.decimal, opp_odds)
                    if profit is None or profit < self.min_profit_pct:
                        continue

                    bc_stake = calc_bc_stake_usdt(self.bti_stake_krw, opp_odds, bm.decimal, self.usdt_rate)
                    calc_ms = (perf_counter_ns() - start) / 1_000_000
                    opps.append(
                        ArbOpportunity(
                            home=bti.home,
                            away=bti.away,
                            league=bti.league or bc.league,
                            bti_side=bti_side,
                            bti_odds=opp_odds,
                            bc_team=bm.team,
                            bc_odds=bm.decimal,
                            profit_pct=round(profit, 2),
                            bti_stake_krw=self.bti_stake_krw,
                            bc_stake_usdt=bc_stake,
                            usdt_rate=self.usdt_rate,
                            detection_ms=detection_ms,
                            calc_ms=calc_ms,
                        )
                    )

        opps.sort(key=lambda o: o.profit_pct, reverse=True)
        return opps
