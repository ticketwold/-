from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum


class BetType(str, Enum):
    MONEYLINE = "MONEYLINE"
    MONEYLINE_1X2 = "MONEYLINE_1X2"
    SET_1_MONEYLINE = "SET_1_MONEYLINE"
    SET_2_MONEYLINE = "SET_2_MONEYLINE"
    MAP_1_MONEYLINE = "MAP_1_MONEYLINE"
    MAP_2_MONEYLINE = "MAP_2_MONEYLINE"
    MATCH_WINNER = "MATCH_WINNER"
    HANDICAP = "HANDICAP"
    ASIAN_HANDICAP = "ASIAN_HANDICAP"
    TOTAL = "TOTAL"
    TEAM_TOTAL = "TEAM_TOTAL"
    SET_HANDICAP = "SET_HANDICAP"
    MAP_HANDICAP = "MAP_HANDICAP"
    INNING_MONEYLINE = "INNING_MONEYLINE"
    WITH_OT = "WITH_OT"
    WITHOUT_OT = "WITHOUT_OT"
    UNKNOWN = "UNKNOWN"


class BetPeriod(str, Enum):
    FULL_GAME = "FULL_GAME"
    SET_1 = "SET_1"
    SET_2 = "SET_2"
    MAP_1 = "MAP_1"
    MAP_2 = "MAP_2"
    INNING = "INNING"
    WITH_OT = "WITH_OT"
    WITHOUT_OT = "WITHOUT_OT"
    UNKNOWN = "UNKNOWN"


class BetSide(str, Enum):
    HOME = "HOME"
    AWAY = "AWAY"
    DRAW = "DRAW"
    OVER = "OVER"
    UNDER = "UNDER"
    UNKNOWN = "UNKNOWN"


BET_TYPE_LABELS: dict[BetType, str] = {
    BetType.MONEYLINE: "머니라인 / 승패",
    BetType.MONEYLINE_1X2: "승무패",
    BetType.SET_1_MONEYLINE: "1세트 승패",
    BetType.SET_2_MONEYLINE: "2세트 승패",
    BetType.MAP_1_MONEYLINE: "1번 맵 승패",
    BetType.MAP_2_MONEYLINE: "2번 맵 승패",
    BetType.MATCH_WINNER: "경기 승자",
    BetType.HANDICAP: "핸디캡",
    BetType.ASIAN_HANDICAP: "아시안 핸디캡",
    BetType.TOTAL: "언더/오버",
    BetType.TEAM_TOTAL: "팀별 언더/오버",
    BetType.SET_HANDICAP: "세트 핸디캡",
    BetType.MAP_HANDICAP: "맵 핸디캡",
    BetType.INNING_MONEYLINE: "이닝 승패",
    BetType.WITH_OT: "연장 포함 승패",
    BetType.WITHOUT_OT: "연장 제외 승패",
    BetType.UNKNOWN: "확인 필요",
}

PERIOD_LABELS: dict[BetPeriod, str] = {
    BetPeriod.FULL_GAME: "전체 경기",
    BetPeriod.SET_1: "1세트",
    BetPeriod.SET_2: "2세트",
    BetPeriod.MAP_1: "1번 맵",
    BetPeriod.MAP_2: "2번 맵",
    BetPeriod.INNING: "이닝",
    BetPeriod.WITH_OT: "연장 포함",
    BetPeriod.WITHOUT_OT: "연장 제외",
    BetPeriod.UNKNOWN: "—",
}


@dataclass(slots=True)
class ParsedBet:
    display_selection: str = ""
    raw_market_text: str = ""
    raw_selection_text: str = ""
    bet_type: BetType = BetType.UNKNOWN
    period: BetPeriod = BetPeriod.UNKNOWN
    line: float | None = None
    side: BetSide = BetSide.UNKNOWN
    parse_reason: str = ""

    @property
    def bet_type_label(self) -> str:
        return BET_TYPE_LABELS.get(self.bet_type, self.bet_type.value)

    @property
    def period_label(self) -> str:
        return PERIOD_LABELS.get(self.period, self.period.value)

    @property
    def line_label(self) -> str:
        if self.line is None:
            return "없음"
        return f"{self.line:g}"


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _extract_line(text: str, bet_type: BetType) -> float | None:
    if bet_type in {BetType.TOTAL, BetType.TEAM_TOTAL}:
        m = re.search(r"(\d+\.\d+)", text or "")
        if m:
            return abs(float(m.group(1)))
        return None
    if bet_type in {
        BetType.HANDICAP,
        BetType.ASIAN_HANDICAP,
        BetType.SET_HANDICAP,
        BetType.MAP_HANDICAP,
    }:
        m = re.search(r"([+-]\d+(?:\.\d+)?)", text or "")
        if m:
            return abs(float(m.group(1)))
    return None


def _detect_period(blob: str) -> BetPeriod:
    if re.search(r"1\s*(?:st|번)?\s*(?:set|세트)", blob, re.I):
        return BetPeriod.SET_1
    if re.search(r"2\s*(?:nd|번)?\s*(?:set|세트)", blob, re.I):
        return BetPeriod.SET_2
    if re.search(r"(?:map|맵)\s*1|1\s*(?:st|번)?\s*(?:map|맵)", blob, re.I):
        return BetPeriod.MAP_1
    if re.search(r"(?:map|맵)\s*2|2\s*(?:nd|번)?\s*(?:map|맵)", blob, re.I):
        return BetPeriod.MAP_2
    if re.search(r"이닝|inning", blob, re.I):
        return BetPeriod.INNING
    if re.search(r"연장\s*포함|including\s*overtime|with\s*ot", blob, re.I):
        return BetPeriod.WITH_OT
    if re.search(r"연장\s*제외|excluding\s*overtime|without\s*ot|정규\s*시간", blob, re.I):
        return BetPeriod.WITHOUT_OT
    return BetPeriod.FULL_GAME


def _detect_side(blob: str, selection: str) -> BetSide:
    s = _norm(f"{blob} {selection}")
    sel = selection or ""
    if re.search(r"\b(over|오버)\b", s) or re.search(r"\bo\s*[\d.]", s):
        return BetSide.OVER
    if re.search(r"\b(under|언더)\b", s) or re.search(r"\bu\s*[\d.]", s):
        return BetSide.UNDER
    if re.search(r"\b(draw|무|x|tie|비김|무승부)\b", s):
        return BetSide.DRAW
    if re.search(r"\b(away|원정|b팀|team\s*b)\b", s) or re.search(r"B팀", sel):
        return BetSide.AWAY
    if re.search(r"\b(home|홈|a팀|team\s*a)\b", s) or re.search(r"A팀", sel):
        return BetSide.HOME
    if re.search(r"\bw2\b", s):
        return BetSide.AWAY
    if re.search(r"\bw1\b", s):
        return BetSide.HOME
    if "+" in selection or re.search(r"\+\d", selection):
        return BetSide.HOME
    if re.search(r"-\d", selection):
        return BetSide.AWAY
    if re.search(r"\b승\b", selection) and not re.search(r"\b(over|under|오버|언더)\b", s):
        return BetSide.HOME
    return BetSide.UNKNOWN


def _detect_bet_type(market: str, selection: str) -> tuple[BetType, BetPeriod]:
    blob = _norm(f"{market} {selection}")
    period = _detect_period(blob)

    if re.search(r"\b(over|under|오버|언더|total|합계|득점)\b", blob):
        if re.search(r"팀|team", blob):
            return BetType.TEAM_TOTAL, period
        return BetType.TOTAL, period

    if re.search(r"(?:asian\s*)?handicap|핸디|spread|아시안", blob, re.I) or re.search(r"[+-]\d+(?:\.\d+)?", selection or ""):
        if period == BetPeriod.SET_1 or period == BetPeriod.SET_2:
            return BetType.SET_HANDICAP, period
        if period in {BetPeriod.MAP_1, BetPeriod.MAP_2}:
            return BetType.MAP_HANDICAP, period
        if re.search(r"asian|아시안", blob, re.I):
            return BetType.ASIAN_HANDICAP, period
        return BetType.HANDICAP, period

    if re.search(r"승무패|1x2|3\s*way|draw", blob, re.I):
        return BetType.MONEYLINE_1X2, period

    if period == BetPeriod.SET_1:
        return BetType.SET_1_MONEYLINE, period
    if period == BetPeriod.SET_2:
        return BetType.SET_2_MONEYLINE, period
    if period == BetPeriod.MAP_1:
        return BetType.MAP_1_MONEYLINE, period
    if period == BetPeriod.MAP_2:
        return BetType.MAP_2_MONEYLINE, period
    if period == BetPeriod.INNING:
        return BetType.INNING_MONEYLINE, period
    if period == BetPeriod.WITH_OT:
        return BetType.WITH_OT, period
    if period == BetPeriod.WITHOUT_OT:
        return BetType.WITHOUT_OT, period

    if re.search(r"match\s*winner|경기\s*승자|winner", blob, re.I):
        return BetType.MATCH_WINNER, period

    if re.search(r"moneyline|money\s*line|\bml\b|승패|승자|우승|winner|win\b", blob, re.I):
        return BetType.MONEYLINE, period

    if re.search(r"\bw[12]\b", blob) or re.search(r"\b승\b", selection):
        return BetType.MONEYLINE, period

    return BetType.UNKNOWN, period


def build_display_selection(market: str, selection: str, side: BetSide, line: float | None) -> str:
    sel = (selection or "").strip()
    if sel:
        return sel
    if side == BetSide.OVER and line is not None:
        return f"오버 {line:g}"
    if side == BetSide.UNDER and line is not None:
        return f"언더 {line:g}"
    if side == BetSide.HOME and line is not None:
        return f"+{line:g}" if line > 0 else f"{line:g}"
    return market.strip() or "—"


def parse_bet_item(
    *,
    market: str = "",
    selection: str = "",
    event: str = "",
    display_selection: str = "",
    raw_market_text: str = "",
    raw_selection_text: str = "",
    bet_type: str = "",
    period: str = "",
    line: float | None = None,
    side: str = "",
) -> ParsedBet:
    """Parse or enrich structured bet fields from slip item data."""
    rm = raw_market_text or market
    rs = raw_selection_text or selection
    blob = f"{rm} {rs} {event}"

    parsed_type, parsed_period = _detect_bet_type(rm, rs)
    if bet_type:
        try:
            parsed_type = BetType(str(bet_type).upper())
        except ValueError:
            pass

    if period:
        try:
            parsed_period = BetPeriod(str(period).upper())
        except ValueError:
            pass

    parsed_side = _detect_side(blob, rs)
    if side:
        try:
            parsed_side = BetSide(str(side).upper())
        except ValueError:
            pass

    parsed_line = line if line is not None else _extract_line(rs, parsed_type)
    if parsed_type in {BetType.TOTAL, BetType.TEAM_TOTAL} and parsed_line is not None:
        parsed_line = abs(parsed_line)

    if parsed_type in {BetType.HANDICAP, BetType.ASIAN_HANDICAP, BetType.SET_HANDICAP, BetType.MAP_HANDICAP}:
        hc = re.search(r"([+-]\d+(?:\.\d+)?)", rs or "")
        if hc:
            try:
                parsed_line = abs(float(hc.group(1)))
            except ValueError:
                pass

    disp = display_selection.strip() or build_display_selection(rm, rs, parsed_side, parsed_line)
    reason = ""
    if parsed_type == BetType.UNKNOWN:
        reason = "bet-type-unparsed"

    return ParsedBet(
        display_selection=disp,
        raw_market_text=rm,
        raw_selection_text=rs,
        bet_type=parsed_type,
        period=parsed_period,
        line=parsed_line,
        side=parsed_side,
        parse_reason=reason,
    )


def _type_family(bt: BetType) -> str:
    if bt in {BetType.MONEYLINE, BetType.MONEYLINE_1X2, BetType.SET_1_MONEYLINE, BetType.SET_2_MONEYLINE,
              BetType.MAP_1_MONEYLINE, BetType.MAP_2_MONEYLINE, BetType.MATCH_WINNER,
              BetType.INNING_MONEYLINE, BetType.WITH_OT, BetType.WITHOUT_OT}:
        return "MONEYLINE"
    if bt in {BetType.TOTAL, BetType.TEAM_TOTAL}:
        return "TOTAL"
    if bt in {BetType.HANDICAP, BetType.ASIAN_HANDICAP, BetType.SET_HANDICAP, BetType.MAP_HANDICAP}:
        return "HANDICAP"
    return "UNKNOWN"


@dataclass(slots=True)
class BetPairValidation:
    ok: bool
    reason: str = ""
    mismatch_kind: str = ""
    combined_type_label: str = ""
    x10_type_label: str = ""
    bc_type_label: str = ""
    line_label: str = "없음"
    verify_label: str = ""


def validate_bet_pair(x10: ParsedBet, bc: ParsedBet) -> BetPairValidation:
    if x10.bet_type == BetType.UNKNOWN or bc.bet_type == BetType.UNKNOWN:
        return BetPairValidation(
            ok=False,
            reason="unknown-bet-type",
            mismatch_kind="UNKNOWN",
            x10_type_label=x10.bet_type_label,
            bc_type_label=bc.bet_type_label,
            combined_type_label="확인 필요",
            verify_label="자동배팅 불가",
        )

    if x10.bet_type != bc.bet_type:
        return BetPairValidation(
            ok=False,
            reason="bet-type-mismatch",
            mismatch_kind="BET_TYPE_MISMATCH",
            x10_type_label=x10.bet_type_label,
            bc_type_label=bc.bet_type_label,
            combined_type_label="서로 다른 타입",
            verify_label="자동배팅 불가",
        )

    if x10.period != bc.period and x10.period != BetPeriod.UNKNOWN and bc.period != BetPeriod.UNKNOWN:
        return BetPairValidation(
            ok=False,
            reason="period-mismatch",
            mismatch_kind="PERIOD_MISMATCH",
            x10_type_label=x10.bet_type_label,
            bc_type_label=bc.bet_type_label,
            combined_type_label="서로 다른 타입",
            verify_label="자동배팅 불가",
        )

    family = _type_family(x10.bet_type)
    line_label = x10.line_label if x10.line is not None else "없음"

    if family == "TOTAL":
        if x10.line is None or bc.line is None:
            return BetPairValidation(
                ok=False,
                reason="line-missing",
                mismatch_kind="LINE_MISMATCH",
                combined_type_label=x10.bet_type_label,
                line_label=line_label,
                verify_label="자동배팅 불가",
            )
        if abs(x10.line - bc.line) > 0.02:
            return BetPairValidation(
                ok=False,
                reason="line-mismatch",
                mismatch_kind="LINE_MISMATCH",
                combined_type_label=x10.bet_type_label,
                line_label=f"{x10.line:g} ≠ {bc.line:g}",
                verify_label="자동배팅 불가",
            )
        if x10.side == bc.side or x10.side == BetSide.UNKNOWN or bc.side == BetSide.UNKNOWN:
            return BetPairValidation(
                ok=False,
                reason="same-side",
                mismatch_kind="SIDE_MISMATCH",
                combined_type_label=x10.bet_type_label,
                line_label=f"{x10.line:g}",
                verify_label="자동배팅 불가",
            )
        if not ({x10.side, bc.side} == {BetSide.OVER, BetSide.UNDER}):
            return BetPairValidation(
                ok=False,
                reason="invalid-total-sides",
                mismatch_kind="SIDE_MISMATCH",
                combined_type_label=x10.bet_type_label,
                line_label=f"{x10.line:g}",
                verify_label="자동배팅 불가",
            )
        return BetPairValidation(
            ok=True,
            combined_type_label=x10.bet_type_label,
            line_label=f"{x10.line:g}",
            verify_label="정상",
        )

    if family == "HANDICAP":
        if x10.line is None or bc.line is None:
            return BetPairValidation(
                ok=False,
                reason="line-missing",
                mismatch_kind="LINE_MISMATCH",
                combined_type_label=x10.bet_type_label,
                verify_label="자동배팅 불가",
            )
        if abs(x10.line - bc.line) > 0.05:
            return BetPairValidation(
                ok=False,
                reason="line-mismatch",
                mismatch_kind="LINE_MISMATCH",
                combined_type_label=x10.bet_type_label,
                line_label=f"{x10.line:g} ≠ {bc.line:g}",
                verify_label="자동배팅 불가",
            )
        if x10.side == bc.side:
            return BetPairValidation(
                ok=False,
                reason="same-side",
                mismatch_kind="SIDE_MISMATCH",
                combined_type_label=x10.bet_type_label,
                line_label=f"{x10.line:g}",
                verify_label="자동배팅 불가",
            )
        return BetPairValidation(
            ok=True,
            combined_type_label=x10.bet_type_label,
            line_label=f"{x10.line:g}",
            verify_label="정상",
        )

    # Moneyline family
    if x10.side == bc.side and x10.side != BetSide.UNKNOWN:
        return BetPairValidation(
            ok=False,
            reason="same-side",
            mismatch_kind="SIDE_MISMATCH",
            combined_type_label=x10.bet_type_label,
            verify_label="자동배팅 불가",
        )
    if x10.side == BetSide.UNKNOWN or bc.side == BetSide.UNKNOWN:
        return BetPairValidation(
            ok=False,
            reason="side-unknown",
            mismatch_kind="SIDE_MISMATCH",
            combined_type_label=x10.bet_type_label,
            verify_label="확인 필요",
        )
    if x10.side == BetSide.DRAW or bc.side == BetSide.DRAW:
        if not ({x10.side, bc.side} <= {BetSide.HOME, BetSide.AWAY, BetSide.DRAW}):
            return BetPairValidation(
                ok=False,
                reason="invalid-1x2-sides",
                mismatch_kind="SIDE_MISMATCH",
                combined_type_label=x10.bet_type_label,
                verify_label="자동배팅 불가",
            )
    return BetPairValidation(
        ok=True,
        combined_type_label=x10.bet_type_label,
        line_label="없음",
        verify_label="서로 반대 선택",
    )
