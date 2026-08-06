from __future__ import annotations

from typing import Callable

from arb_desktop.core.team_matcher import matchup_teams_match, norm_team, team_match
from arb_desktop.validation.api_reader import is_ml_market
from arb_desktop.validation.models import (
    EventMatchResult,
    LiveVerifyReport,
    MatchFailReason,
    OddsDiff,
    TeamOdds,
    VerifyEvent,
)

ODDS_TOLERANCE = 0.03


def _format_odds_map(odds: list[TeamOdds]) -> str:
    if not odds:
        return "(없음)"
    parts = []
    for o in sorted(odds, key=lambda x: x.team):
        m = f"[{o.market}]" if o.market and o.market != "screen-ml" else ""
        parts.append(f"{o.team}={o.decimal:.3f}{m}")
    return ", ".join(parts)


def _format_diffs(diffs: list[OddsDiff]) -> str:
    if not diffs:
        return "(비교 불가)"
    parts = []
    for d in diffs:
        if d.delta is None:
            parts.append(f"{d.team}=N/A")
        else:
            sign = "+" if d.delta > 0 else ""
            parts.append(f"{d.team}={sign}{d.delta:.3f}")
    return ", ".join(parts)


def _find_api_for_screen(
    screen: VerifyEvent,
    api_events: list[VerifyEvent],
    used_api_ids: set[str],
) -> tuple[VerifyEvent | None, list[MatchFailReason], str]:
    reasons: list[MatchFailReason] = []
    detail_parts: list[str] = []

    # 1) event_id exact match
    for api in api_events:
        if api.event_id in used_api_ids:
            continue
        if api.event_id and api.event_id == screen.event_id:
            if matchup_teams_match(api.home, api.away, screen.home, screen.away):
                return api, [], ""
            reasons.append(MatchFailReason.EVENT_ID_MISMATCH)
            detail_parts.append(
                f"event_id 동일({api.event_id}) but 팀명 불일치: "
                f"API[{api.home} vs {api.away}] SCREEN[{screen.home} vs {screen.away}]"
            )

    # 2) team name fuzzy match
    candidates: list[VerifyEvent] = []
    for api in api_events:
        if api.event_id in used_api_ids:
            continue
        if matchup_teams_match(api.home, api.away, screen.home, screen.away):
            candidates.append(api)

    if len(candidates) == 1:
        api = candidates[0]
        if api.event_id != screen.event_id:
            detail_parts.append(
                f"event_id 불일치: API={api.event_id} SCREEN={screen.event_id} (팀명 매칭 성공)"
            )
        return api, reasons, "; ".join(detail_parts)

    if len(candidates) > 1:
        reasons.append(MatchFailReason.EVENT_ID_MISMATCH)
        detail_parts.append(f"팀명 매칭 후보 {len(candidates)}개 — event id로 구분 필요")
        return None, reasons, "; ".join(detail_parts)

    # 3) partial team match diagnostics
    partial_home = [a for a in api_events if a.event_id not in used_api_ids and team_match(a.home, screen.home)]
    partial_away = [a for a in api_events if a.event_id not in used_api_ids and team_match(a.away, screen.away)]
    if partial_home or partial_away:
        reasons.append(MatchFailReason.TEAM_NAME_NORMALIZATION_FAILED)
        detail_parts.append(
            f"부분 매칭 — home후보={len(partial_home)} away후보={len(partial_away)} "
            f"SCREEN norm=[{norm_team(screen.home)}|{norm_team(screen.away)}]"
        )
    else:
        reasons.append(MatchFailReason.API_EVENT_NOT_FOUND)
        detail_parts.append("API에 대응 경기 없음")

    return None, reasons, "; ".join(detail_parts)


def _pair_odds(api: VerifyEvent, screen: VerifyEvent) -> tuple[list[OddsDiff], list[MatchFailReason], str]:
    reasons: list[MatchFailReason] = []
    detail_parts: list[str] = []
    diffs: list[OddsDiff] = []

    api_ml = [o for o in api.odds if not o.market or is_ml_market(o.market)]
    screen_ml = screen.odds

    if not api_ml:
        non_ml = [o.market for o in api.odds if o.market]
        reasons.append(MatchFailReason.MARKET_TYPE_MISMATCH)
        detail_parts.append(f"API ML 배당 없음 — markets={non_ml[:5]}")
        return diffs, reasons, "; ".join(detail_parts)

    if len(api_ml) != len(screen_ml):
        reasons.append(MatchFailReason.ODDS_COUNT_MISMATCH)
        detail_parts.append(f"배당 수 API={len(api_ml)} SCREEN={len(screen_ml)}")

    used_screen: set[int] = set()
    for ao in api_ml:
        best_idx = None
        best_team = None
        for i, so in enumerate(screen_ml):
            if i in used_screen:
                continue
            if team_match(ao.team, so.team) or team_match(ao.team, api.home) and team_match(so.team, screen.home):
                best_idx = i
                best_team = so
                break
            if team_match(ao.team, api.away) and team_match(so.team, screen.away):
                best_idx = i
                best_team = so
                break

        if best_idx is None:
            # try any unmatched screen odds by value proximity
            for i, so in enumerate(screen_ml):
                if i not in used_screen and abs(ao.decimal - so.decimal) < 0.05:
                    best_idx = i
                    best_team = so
                    reasons.append(MatchFailReason.TEAM_NAME_NORMALIZATION_FAILED)
                    detail_parts.append(f"팀명 불일치 — API[{ao.team}] ≈ SCREEN[{so.team}] (배당 근접 매칭)")
                    break

        if best_team is None:
            reasons.append(MatchFailReason.TEAM_NAME_NORMALIZATION_FAILED)
            detail_parts.append(f"SCREEN에 API 팀 없음: {ao.team}")
            diffs.append(OddsDiff(team=ao.team, api_odds=ao.decimal, screen_odds=None))
            continue

        used_screen.add(best_idx)
        diffs.append(OddsDiff(team=ao.team, api_odds=ao.decimal, screen_odds=best_team.decimal))

    for i, so in enumerate(screen_ml):
        if i not in used_screen:
            diffs.append(OddsDiff(team=so.team, api_odds=None, screen_odds=so.decimal))
            reasons.append(MatchFailReason.TEAM_NAME_NORMALIZATION_FAILED)
            detail_parts.append(f"API에 SCREEN 팀 없음: {so.team}")

    return diffs, reasons, "; ".join(detail_parts)


def match_events(
    api_events: list[VerifyEvent],
    screen_events: list[VerifyEvent],
    *,
    odds_tolerance: float = ODDS_TOLERANCE,
) -> LiveVerifyReport:
    matches: list[EventMatchResult] = []
    used_api: set[str] = set()

    for screen in screen_events:
        api, match_reasons, match_detail = _find_api_for_screen(screen, api_events, used_api)
        if api is None:
            matches.append(
                EventMatchResult(
                    matched=False,
                    title=screen.title,
                    screen_event=screen,
                    fail_reasons=match_reasons or [MatchFailReason.API_EVENT_NOT_FOUND],
                    detail=match_detail,
                )
            )
            continue

        used_api.add(api.event_id)
        diffs, odds_reasons, odds_detail = _pair_odds(api, screen)
        all_reasons = list(match_reasons) + odds_reasons
        detail = "; ".join(x for x in [match_detail, odds_detail] if x)

        max_delta = max((abs(d.delta) for d in diffs if d.delta is not None), default=0.0)
        paired = [d for d in diffs if d.api_odds is not None and d.screen_odds is not None]
        matched = (
            len(paired) > 0
            and max_delta <= odds_tolerance
            and MatchFailReason.MARKET_TYPE_MISMATCH not in all_reasons
            and all(d.delta is not None and abs(d.delta) <= odds_tolerance for d in paired)
        )

        if not paired:
            matched = False
            if MatchFailReason.ODDS_COUNT_MISMATCH not in all_reasons:
                all_reasons.append(MatchFailReason.ODDS_COUNT_MISMATCH)

        matches.append(
            EventMatchResult(
                matched=matched,
                title=screen.title,
                api_event=api,
                screen_event=screen,
                odds_diffs=diffs,
                fail_reasons=all_reasons,
                detail=detail,
            )
        )

    unmatched_api = [a for a in api_events if a.event_id not in used_api]
    matched_screen_ids = {m.screen_event.event_id for m in matches if m.screen_event}
    unmatched_screen = [s for s in screen_events if s.event_id not in matched_screen_ids]

    return LiveVerifyReport(
        api_events=api_events,
        screen_events=screen_events,
        matches=matches,
        unmatched_api=unmatched_api,
        unmatched_screen=unmatched_screen,
    )


class LiveVerifyLogger:
    """필수 로그 포맷 출력."""

    def __init__(self, print_fn: Callable[[str], None] | None = None):
        self._print = print_fn or print

    def log_report(self, report: LiveVerifyReport) -> None:
        self._print("")
        self._print("=" * 60)
        self._print("BC.Game 라이브 검증 리포트")
        self._print("=" * 60)
        self._print(f"API: {report.api_source} ({len(report.api_events)}경기)")
        self._print(f"SCREEN: {report.screen_source} ({len(report.screen_events)}경기)")
        self._print(f"매칭 성공: {report.matched_count} / {len(report.matches)}")
        self._print("")

        for m in report.matches:
            self._log_match(m)

        for api in report.unmatched_api:
            self._log_fail(
                title=api.title,
                reasons=[MatchFailReason.SCREEN_EVENT_NOT_FOUND],
                detail=f"API event_id={api.event_id} — 화면에 없음",
                api_event=api,
            )

        for screen in report.unmatched_screen:
            if any(x.screen_event and x.screen_event.event_id == screen.event_id for x in report.matches):
                continue
            self._log_fail(
                title=screen.title,
                reasons=[MatchFailReason.API_EVENT_NOT_FOUND],
                detail="화면에만 존재",
                screen_event=screen,
            )

        self._print("=" * 60)

    def _log_match(self, m: EventMatchResult) -> None:
        if m.matched:
            self._print("[EVENT MATCH]")
            self._print(f"경기명: {m.title}")
            self._print(f"API odds: {_format_odds_map(m.api_event.odds if m.api_event else [])}")
            self._print(f"SCREEN odds: {_format_odds_map(m.screen_event.odds if m.screen_event else [])}")
            self._print(f"차이: {_format_diffs(m.odds_diffs)}")
            if m.api_event:
                self._print(f"  (API event_id={m.api_event.event_id})")
            self._print("")
            return

        self._log_fail(
            title=m.title,
            reasons=m.fail_reasons,
            detail=m.detail,
            api_event=m.api_event,
            screen_event=m.screen_event,
            diffs=m.odds_diffs,
        )

    def _log_fail(
        self,
        *,
        title: str,
        reasons: list[MatchFailReason],
        detail: str,
        api_event: VerifyEvent | None = None,
        screen_event: VerifyEvent | None = None,
        diffs: list[OddsDiff] | None = None,
    ) -> None:
        self._print("[EVENT MATCH FAIL]")
        self._print(f"경기명: {title}")
        if api_event:
            self._print(f"API odds: {_format_odds_map(api_event.odds)}")
            self._print(f"  API event_id: {api_event.event_id}")
        else:
            self._print("API odds: (매칭 실패)")
        if screen_event:
            self._print(f"SCREEN odds: {_format_odds_map(screen_event.odds)}")
        else:
            self._print("SCREEN odds: (없음)")
        if diffs:
            self._print(f"차이: {_format_diffs(diffs)}")
        self._print("매칭 실패 원인:")
        for r in reasons or [MatchFailReason.API_EVENT_NOT_FOUND]:
            self._print(f"  - {r.value}")
        if detail:
            self._print(f"  상세: {detail}")
        self._print("")
