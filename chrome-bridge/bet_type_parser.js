/**
 * Bet type parser for BC.Game / x10x10s slip items.
 * Mirrors arb_desktop/betslip/bet_type.py
 */
(function () {
  "use strict";

  const BET_TYPE_LABELS = {
    MONEYLINE: "승무패",
    SPREAD: "핸디캡",
    TOTAL: "언더/오버",
    TEAM_TOTAL: "팀 합계",
    DOUBLE_CHANCE: "더블찬스",
    DRAW_NO_BET: "무승부 제외",
    BTTS: "양팀 득점",
    CORRECT_SCORE: "정확한 스코어",
    HALF_TIME_FULL_TIME: "전반/후반",
    ODD_EVEN: "홀짝",
    FIRST_GOAL: "첫 득점",
    LAST_GOAL: "마지막 득점",
    WINNING_MARGIN: "승리 마진",
    PLAYER_PROP: "선수 프로프",
    SPECIAL: "스페셜",
    UNKNOWN: "미확인",
  };

  const TOTAL_MARKET_PATTERNS = [
    /토탈\s*골/i,
    /총\s*골/i,
    /총\s*득점/i,
    /합계\s*득점/i,
    /총점/i,
    /득점\s*합계/i,
    /total\s*goals?/i,
    /goals?\s*total/i,
    /total\s*points?/i,
    /game\s*total/i,
    /match\s*total/i,
    /\btotals?\b/i,
    /\bo\s*\/\s*u\b/i,
    /\bover\s*\/\s*under\b/i,
    /언더\s*\/\s*오버/i,
    /오버\s*\/\s*언더/i,
    /언더오버/i,
    /오버언더/i,
    /언더\/오버/i,
    /오버\/언더/i,
    /합계/i,
    /득점/i,
    /total/i,
    /over\s*under/i,
    /under\s*over/i,
  ];

  const PERIOD_PATTERNS = [
    [/전반|1\s*피리어드|1st\s*half|first\s*half|1h/i, "1H"],
    [/후반|2\s*피리어드|2nd\s*half|second\s*half|2h/i, "2H"],
    [/1\s*쿼터|1st\s*quarter|1q/i, "Q1"],
    [/2\s*쿼터|2nd\s*quarter|2q/i, "Q2"],
    [/3\s*쿼터|3rd\s*quarter|3q/i, "Q3"],
    [/4\s*쿼터|4th\s*quarter|4q/i, "Q4"],
    [/1\s*세트|1st\s*set/i, "SET1"],
    [/2\s*세트|2nd\s*set/i, "SET2"],
    [/3\s*세트|3rd\s*set/i, "SET3"],
    [/4\s*세트|4th\s*set/i, "SET4"],
    [/5\s*세트|5th\s*set/i, "SET5"],
    [/풀타임|full\s*time|ft\b/i, "FT"],
    [/정규시간|regulation/i, "REG"],
  ];

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function looksLikeOdds(value) {
  if (value == null) return false;
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return n >= 1.01 && n <= 50.0;
  }

  function isTotalMarketText(text) {
    const t = normalizeText(text);
    if (!t) return false;
    return TOTAL_MARKET_PATTERNS.some((re) => re.test(t));
  }

  function selectionImpliesTotal(selection) {
    const s = normalizeText(selection);
    if (!s) return false;
    if (/\b(over|under|오버|언더)\b/i.test(s)) return true;
    if (/\b[ou]\s*[+-]?\d/i.test(s)) return true;
    if (/(이상|이하)/.test(s)) return true;
    return false;
  }

  function detectSide(text) {
    const t = normalizeText(text);
    if (!t) return null;
    // selection 우선 — 마켓명 "언더/오버"의 "오버" 오탐 방지
    if (/\b(over|오버|이상)\b/i.test(t)) return "OVER";
    if (/\b(under|언더|이하)\b/i.test(t)) return "UNDER";
    if (/\bo\s*[+-]?\d/i.test(t)) return "OVER";
    if (/\bu\s*[+-]?\d/i.test(t)) return "UNDER";
    if (/\b[ou]\s*\(\s*[+-]?\d/i.test(t)) return t.toLowerCase().startsWith("o") ? "OVER" : "UNDER";
    return null;
  }

  function extractTotalLine(text, side, odds) {
    const t = normalizeText(text);
    if (!t) return null;

    const sideWord = side === "OVER" ? "over|오버|o|이상" : side === "UNDER" ? "under|언더|u|이하" : "over|under|오버|언더|o|u|이상|이하";
    const patterns = [
      new RegExp(`(?:${sideWord})\\s*\\(\\s*([+-]?\\d+(?:\\.\\d+)?)\\s*\\)`, "i"),
      new RegExp(`(?:${sideWord})\\s*([+-]?\\d+(?:\\.\\d+)?)`, "i"),
      new RegExp(`\\b([ou])\\s*([+-]?\\d+(?:\\.\\d+)?)`, "i"),
      /\(\s*([+-]?\d+(?:\.\d+)?)\s*\)/,
      /([+-]?\d+(?:\.\d+)?)/,
    ];

    for (const re of patterns) {
      const m = t.match(re);
      if (!m) continue;
      const raw = m[m.length - 1];
      const val = Math.abs(parseFloat(raw));
      if (!Number.isFinite(val)) continue;
      if (odds != null && looksLikeOdds(val) && Math.abs(val - Number(odds)) < 0.001) continue;
      if (looksLikeOdds(val) && val < 5.0 && !/\(\s*\d/.test(t) && !/\b[ou]\s*\d/i.test(t)) continue;
      return val;
    }
    return null;
  }

  function extractLine(text, betType, side, odds) {
    if (betType === "TOTAL") return extractTotalLine(text, side, odds);
    const t = normalizeText(text);
    const m = t.match(/([+-]?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const val = parseFloat(m[1]);
    if (!Number.isFinite(val)) return null;
    if (odds != null && looksLikeOdds(val) && Math.abs(val - Number(odds)) < 0.001) return null;
    return val;
  }

  function detectPeriod(text) {
    const t = normalizeText(text);
    for (const [re, period] of PERIOD_PATTERNS) {
      if (re.test(t)) return period;
    }
    return "FT";
  }

  function detectBetType(market, selection) {
    const m = normalizeText(market);
    const s = normalizeText(selection);
    const combined = `${m} ${s}`.trim();

    if (isTotalMarketText(m) || isTotalMarketText(s) || selectionImpliesTotal(s) || selectionImpliesTotal(m)) {
      return "TOTAL";
    }
    if (/핸디|handicap|spread|hcp/i.test(combined)) return "SPREAD";
    if (/승무패|1x2|moneyline|match\s*winner|승패/i.test(combined)) return "MONEYLINE";
    if (/더블\s*찬스|double\s*chance/i.test(combined)) return "DOUBLE_CHANCE";
    if (/무승부\s*제외|draw\s*no\s*bet|dnb/i.test(combined)) return "DRAW_NO_BET";
    if (/양팀\s*득점|both\s*teams?\s*to\s*score|btts/i.test(combined)) return "BTTS";
    if (/정확한\s*스코어|correct\s*score/i.test(combined)) return "CORRECT_SCORE";
    if (/전반.*후반|half.*full|ht\/ft/i.test(combined)) return "HALF_TIME_FULL_TIME";
    if (/홀짝|odd\s*even|odd\/even/i.test(combined)) return "ODD_EVEN";
    if (/첫\s*득점|first\s*goal/i.test(combined)) return "FIRST_GOAL";
    if (/마지막\s*득점|last\s*goal/i.test(combined)) return "LAST_GOAL";
    if (/승리\s*마진|winning\s*margin/i.test(combined)) return "WINNING_MARGIN";
    if (/선수|player/i.test(combined)) return "PLAYER_PROP";
  if (/팀\s*합계|team\s*total/i.test(combined)) return "TEAM_TOTAL";
    return "UNKNOWN";
  }

  function buildDisplaySelection(betType, side, line, selection) {
    if (betType === "TOTAL" && side && line != null) {
      const label = side === "OVER" ? "오버" : "언더";
      const formatted = Number.isInteger(line) ? String(line) : String(line);
      return `${label} ${formatted}`;
    }
    if (betType === "SPREAD" && line != null) {
      const sign = line > 0 ? "+" : "";
      const formatted = Number.isInteger(line) ? String(line) : String(line);
      return `${sign}${formatted}`;
    }
    return normalizeText(selection);
  }

  function parseBetItem(market, selection, odds) {
    const rawMarket = normalizeText(market);
    const rawSelection = normalizeText(selection);
    const combined = `${rawMarket} ${rawSelection}`.trim();
    const betType = detectBetType(rawMarket, rawSelection);
    const period = detectPeriod(combined);
    const side = detectSide(rawSelection) || detectSide(combined);
    const line = extractLine(combined, betType, side, odds);
    const marketNormalized = betType === "TOTAL" ? "언더/오버" : rawMarket;
    const displaySelection = buildDisplaySelection(betType, side, line, rawSelection);
    const parseReason = betType === "UNKNOWN" ? "bet_type_unrecognized" : "";

    return {
      bet_type: betType,
      bet_type_label: BET_TYPE_LABELS[betType] || BET_TYPE_LABELS.UNKNOWN,
      market_normalized: marketNormalized,
      period,
      line,
      side,
      display_selection: displaySelection,
      raw_market_text: rawMarket,
      raw_selection_text: rawSelection,
      normalized_bet_type: betType,
      parsed_side: side,
      parsed_line: line,
      parsed_odds: odds != null ? Number(odds) : null,
      parse_reason: parseReason,
    };
  }

  function validateBetPair(x10, bc) {
    if (!x10 || !bc) {
      return { ok: false, reason: "missing_data", detail: "한쪽 베팅 정보가 없습니다." };
    }
    if (x10.bet_type === "UNKNOWN" || bc.bet_type === "UNKNOWN") {
      return { ok: false, reason: "unknown", detail: "배팅 타입을 확인할 수 없습니다." };
    }
    if (x10.bet_type !== bc.bet_type) {
      return {
        ok: false,
        reason: "bet_type_mismatch",
        detail: `배팅 타입 불일치: ${x10.bet_type_label} vs ${bc.bet_type_label}`,
      };
    }
    if (x10.period !== bc.period) {
      return {
        ok: false,
        reason: "period_mismatch",
        detail: `피리어드 불일치: ${x10.period} vs ${bc.period}`,
      };
    }
    if (x10.bet_type === "TOTAL" || x10.bet_type === "SPREAD" || x10.bet_type === "TEAM_TOTAL") {
      if (x10.line == null || bc.line == null) {
        return { ok: false, reason: "line_missing", detail: "기준점 정보가 없습니다." };
      }
      if (Math.abs(x10.line - bc.line) > 0.02) {
        return {
          ok: false,
          reason: "line_mismatch",
          detail: `기준점 불일치: ${x10.line} vs ${bc.line}`,
        };
      }
    }
    if (x10.bet_type === "TOTAL" || x10.bet_type === "SPREAD") {
      if (!x10.side || !bc.side) {
        return { ok: false, reason: "side_missing", detail: "오버/언더 또는 홈/원정 정보가 없습니다." };
      }
      if (x10.side === bc.side) {
        return { ok: false, reason: "same_side", detail: `같은 방향: ${x10.side}` };
      }
    }
    return { ok: true, reason: "ok", detail: "정상" };
  }

  function enrichSlipItem(item, event) {
    const market = item?.market || "";
    const selection = item?.selection || "";
    const odds = item?.odds;
    const parsed = parseBetItem(market, selection, odds);
    return {
      ...item,
      event: event || item?.event || "",
      raw_market_text: parsed.raw_market_text || market,
      raw_selection_text: parsed.raw_selection_text || selection,
      display_selection: parsed.display_selection || selection,
      bet_type: parsed.bet_type,
      market_normalized: parsed.market_normalized,
      period: parsed.period,
      line: parsed.line,
      side: parsed.side,
      normalized_bet_type: parsed.normalized_bet_type,
      parsed_side: parsed.parsed_side,
      parsed_line: parsed.parsed_line,
      parsed_odds: parsed.parsed_odds,
      parse_reason: parsed.parse_reason,
    };
  }

  window.ArbBetTypeParser = {
    parseBetItem,
    enrichSlipItem,
    validateBetPair,
    BET_TYPE_LABELS,
  };
})();
