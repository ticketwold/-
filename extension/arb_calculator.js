/**
 * 양방배팅 계산기 (확장 프로그램용)
 */
const ArbCalculator = {
  minProfitMargin: 0.5,
  totalStake: 100000,

  implied(odds) {
    return 1 / odds;
  },

  toDecimal(raw) {
    const v = parseFloat(raw);
    if (!v || Number.isNaN(v)) return 0;
    if (v < 1) return v + 1;
    if (v >= 100) return v / 100 + 1;
    if (v <= -100) return 100 / Math.abs(v) + 1;
    return v;
  },

  /** 2-way moneyline 양방 검사 */
  checkMoneyline2Way(homeA, awayB, match, siteA = "Pinnacle", siteB = "BTI") {
    const combos = [
      [{ outcome: "home", odds: homeA, site: siteA }, { outcome: "away", odds: awayB, site: siteB }],
      [{ outcome: "away", odds: awayB, site: siteA }, { outcome: "home", odds: homeA, site: siteB }],
    ];
    let best = null;
    for (const legs of combos) {
      const opp = this._calcLegs(match, "moneyline", legs);
      if (opp && (!best || opp.profitMargin > best.profitMargin)) best = opp;
    }
    return best;
  },

  /** 3-way (홈/무/원) */
  checkMoneyline3Way(oddsMapA, oddsMapB, match) {
    const outcomes = ["home", "draw", "away"];
    const sources = [oddsMapA, oddsMapB];
    let best = null;

    for (let mask = 0; mask < 8; mask++) {
      const legs = [];
      let valid = true;
      for (let i = 0; i < 3; i++) {
        const src = sources[(mask >> i) & 1];
        const o = src[outcomes[i]];
        if (!o) { valid = false; break; }
        legs.push({ outcome: outcomes[i], odds: o.odds, site: o.site });
      }
      if (!valid) continue;
      const opp = this._calcLegs(match, "moneyline", legs);
      if (opp && (!best || opp.profitMargin > best.profitMargin)) best = opp;
    }
    return best;
  },

  _calcLegs(match, marketType, legs) {
    const impliedSum = legs.reduce((s, l) => s + this.implied(l.odds), 0);
    if (impliedSum >= 1) return null;

    const profitMargin = (1 - impliedSum) * 100;
    const allocations = legs.map((l) => {
      const stake = Math.round(this.totalStake * this.implied(l.odds) / impliedSum);
      return {
        site: l.site,
        outcome: l.outcome,
        odds: l.odds,
        stake,
        return: Math.round(stake * l.odds),
      };
    });
    const total = allocations.reduce((s, a) => s + a.stake, 0);
    const guaranteedProfit = allocations[0].return - total;

    return {
      match,
      marketType,
      profitMargin: Math.round(profitMargin * 100) / 100,
      totalStake: total,
      guaranteedProfit: Math.round(guaranteedProfit),
      allocations,
    };
  },

  findOpportunities(pinnacleMatches, btiEvents, minMargin) {
    const min = minMargin ?? this.minProfitMargin;
    const opps = [];

    for (const pin of pinnacleMatches) {
      for (const bti of btiEvents) {
        if (!MatchMatcher.sameMatch(pin, bti)) continue;

        const match = {
          home: pin.homeTeam || bti.homeTeam,
          away: pin.awayTeam || bti.awayTeam,
          sport: pin.sport || bti.sport || "",
        };

        // BTI ML selections
        const btiMl = (bti.moneyline || bti.selections || []).filter((s) => s.marketKind === "ml" || !s.marketKind);
        const pinHome = pin.odds?.home;
        const pinAway = pin.odds?.away;
        const pinDraw = pin.odds?.draw;

        if (pinHome && pinAway) {
          for (const sel of btiMl) {
            const label = (sel.selectionText || "").toLowerCase();
            const homeNorm = match.home.toLowerCase();
            const awayNorm = match.away.toLowerCase();
            let btiOdds = sel.odds;
            let btiSide = null;
            if (label.includes(homeNorm.slice(0, 4)) || homeNorm.includes(label.slice(0, 4))) btiSide = "home";
            else if (label.includes(awayNorm.slice(0, 4)) || awayNorm.includes(label.slice(0, 4))) btiSide = "away";

            if (btiSide === "home") {
              const o = this.checkMoneyline2Way(pinAway, btiOdds, match, "Pinnacle", "BTI");
              if (o && o.profitMargin >= min) opps.push(o);
            } else if (btiSide === "away") {
              const o = this.checkMoneyline2Way(pinHome, btiOdds, match, "Pinnacle", "BTI");
              if (o && o.profitMargin >= min) opps.push(o);
            }
          }

          // 직접 홈/원정 odds pair
          const btiHome = btiMl.find((s) => MatchMatcher.similar(s.selectionText, match.home));
          const btiAway = btiMl.find((s) => MatchMatcher.similar(s.selectionText, match.away));
          if (btiHome && btiAway) {
            const o1 = this.checkMoneyline2Way(pinHome, btiAway.odds, match);
            const o2 = this.checkMoneyline2Way(btiHome.odds, pinAway, match);
            [o1, o2].forEach((o) => { if (o && o.profitMargin >= min) opps.push(o); });
          }
          if (pinDraw) {
            const btiDraw = btiMl.find((s) => /무|draw|x/i.test(s.selectionText || ""));
            if (btiDraw) {
              const o = this.checkMoneyline3Way(
                { home: { odds: pinHome, site: "Pinnacle" }, draw: { odds: pinDraw, site: "Pinnacle" }, away: { odds: pinAway, site: "Pinnacle" } },
                { home: btiHome ? { odds: btiHome.odds, site: "BTI" } : {}, draw: btiDraw ? { odds: btiDraw.odds, site: "BTI" } : {}, away: btiAway ? { odds: btiAway.odds, site: "BTI" } : {} },
                match,
              );
              if (o && o.profitMargin >= min) opps.push(o);
            }
          }
        }
      }
    }

    opps.sort((a, b) => b.profitMargin - a.profitMargin);
    const seen = new Set();
    return opps.filter((o) => {
      const k = `${o.match.home}|${o.match.away}|${o.profitMargin}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
};
