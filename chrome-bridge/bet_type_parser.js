/**
 * Bet type parser for chrome-bridge slip items.
 * Mirrors arb_desktop.betslip.bet_type logic.
 */
(function (global) {
  function norm(s) {
    return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function extractLine(text) {
    const m = String(text || "").match(/([+-]?\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[0]) : null;
  }

  function detectPeriod(blob) {
    if (/1\s*(?:st|번)?\s*(?:set|세트)/i.test(blob)) return "SET_1";
    if (/2\s*(?:nd|번)?\s*(?:set|세트)/i.test(blob)) return "SET_2";
    if (/(?:map|맵)\s*1|1\s*(?:st|번)?\s*(?:map|맵)/i.test(blob)) return "MAP_1";
    if (/(?:map|맵)\s*2|2\s*(?:nd|번)?\s*(?:map|맵)/i.test(blob)) return "MAP_2";
    if (/이닝|inning/i.test(blob)) return "INNING";
    if (/연장\s*포함|including\s*overtime|with\s*ot/i.test(blob)) return "WITH_OT";
    if (/연장\s*제외|excluding\s*overtime|without\s*ot|정규\s*시간/i.test(blob)) return "WITHOUT_OT";
    return "FULL_GAME";
  }

  function detectSide(blob, selection) {
    const s = norm(`${blob} ${selection}`);
    if (/\b(over|오버)\b/.test(s) || /\bo\s*[\d.]/.test(s)) return "OVER";
    if (/\b(under|언더)\b/.test(s) || /\bu\s*[\d.]/.test(s)) return "UNDER";
    if (/\b(draw|무|x|tie|비김|무승부)\b/.test(s)) return "DRAW";
    if (/\bw1\b/.test(s)) return "HOME";
    if (/\bw2\b/.test(s)) return "AWAY";
    if (/\+\d/.test(selection || "")) return "HOME";
    if (/-\d/.test(selection || "")) return "AWAY";
    if (/\b승\b/.test(selection || "") && !/\b(over|under|오버|언더)\b/.test(s)) return "HOME";
    return "UNKNOWN";
  }

  function detectBetType(market, selection) {
    const blob = norm(`${market} ${selection}`);
    const period = detectPeriod(blob);

    if (/\b(over|under|오버|언더|total|합계|득점)\b/.test(blob)) {
      return { bet_type: /팀|team/i.test(blob) ? "TEAM_TOTAL" : "TOTAL", period };
    }
    if (/(?:asian\s*)?handicap|핸디|spread|아시안/i.test(blob) || /[+-]\d+(?:\.\d+)?/.test(selection || "")) {
      if (period === "SET_1" || period === "SET_2") return { bet_type: "SET_HANDICAP", period };
      if (period === "MAP_1" || period === "MAP_2") return { bet_type: "MAP_HANDICAP", period };
      if (/asian|아시안/i.test(blob)) return { bet_type: "ASIAN_HANDICAP", period };
      return { bet_type: "HANDICAP", period };
    }
    if (/승무패|1x2|3\s*way|draw/i.test(blob)) return { bet_type: "MONEYLINE_1X2", period };
    if (period === "SET_1") return { bet_type: "SET_1_MONEYLINE", period };
    if (period === "SET_2") return { bet_type: "SET_2_MONEYLINE", period };
    if (period === "MAP_1") return { bet_type: "MAP_1_MONEYLINE", period };
    if (period === "MAP_2") return { bet_type: "MAP_2_MONEYLINE", period };
    if (period === "INNING") return { bet_type: "INNING_MONEYLINE", period };
    if (period === "WITH_OT") return { bet_type: "WITH_OT", period };
    if (period === "WITHOUT_OT") return { bet_type: "WITHOUT_OT", period };
    if (/match\s*winner|경기\s*승자|winner/i.test(blob)) return { bet_type: "MATCH_WINNER", period };
    if (/moneyline|money\s*line|\bml\b|승패|승자|우승|winner|win\b/i.test(blob)) return { bet_type: "MONEYLINE", period };
    if (/\bw[12]\b/.test(blob) || /\b승\b/.test(selection || "")) return { bet_type: "MONEYLINE", period };
    return { bet_type: "UNKNOWN", period };
  }

  function buildDisplaySelection(market, selection, side, line) {
    const sel = String(selection || "").trim();
    if (sel) return sel;
    if (side === "OVER" && line != null) return `오버 ${line}`;
    if (side === "UNDER" && line != null) return `언더 ${line}`;
    return String(market || "").trim() || "—";
  }

  function parseBetFields({ market = "", selection = "", event = "" }) {
    const rm = market || "";
    const rs = selection || "";
    const blob = `${rm} ${rs} ${event}`;
    const { bet_type, period } = detectBetType(rm, rs);
    const side = detectSide(blob, rs);
    let line = extractLine(rs);
    if ((bet_type === "TOTAL" || bet_type === "TEAM_TOTAL") && line != null) line = Math.abs(line);
    if (/HANDICAP/.test(bet_type)) {
      const hm = String(rs).match(/([+-]\d+(?:\.\d+)?)/);
      if (hm) line = Math.abs(parseFloat(hm[1]));
    }
    return {
      display_selection: buildDisplaySelection(rm, rs, side, line),
      raw_market_text: rm,
      raw_selection_text: rs,
      bet_type,
      period,
      line,
      side,
    };
  }

  function enrichSlipItem(item, event) {
    const fields = parseBetFields({
      market: item.market || "",
      selection: item.selection || "",
      event: event || item.event || "",
    });
    return { ...item, ...fields };
  }

  global.ArbBetTypeParser = { parseBetFields, enrichSlipItem, detectBetType, detectSide, detectPeriod };
})(typeof globalThis !== "undefined" ? globalThis : window);
