"""라이브 검증 매칭 로직 단위 테스트."""

from arb_desktop.validation.matcher import LiveVerifyLogger, match_events
from arb_desktop.validation.models import TeamOdds, VerifyEvent


def _api(home, away, odds: list[tuple[str, float]], eid=None):
    return VerifyEvent(
        event_id=eid or f"{home}|{away}".lower(),
        home=home,
        away=away,
        title=f"{home} vs {away}",
        odds=[TeamOdds(team=t, decimal=o, market="Match Winner", source="api") for t, o in odds],
        feed="live",
    )


def _screen(home, away, odds: list[tuple[str, float]]):
    return VerifyEvent(
        event_id=f"{home}|{away}".lower(),
        home=home,
        away=away,
        title=f"{home} vs {away}",
        odds=[TeamOdds(team=t, decimal=o, market="screen-ml", source="screen") for t, o in odds],
        feed="screen",
    )


def test_exact_match_logs(capsys):
    api = [_api("T1", "Gen.G", [("T1", 2.15), ("Gen.G", 1.72)])]
    screen = [_screen("T1", "Gen.G", [("T1", 2.15), ("Gen.G", 1.72)])]
    report = match_events(api, screen)
    assert report.matched_count == 1
    LiveVerifyLogger().log_report(report)
    out = capsys.readouterr().out
    assert "[EVENT MATCH]" in out
    assert "경기명: T1 vs Gen.G" in out
    assert "API odds:" in out
    assert "SCREEN odds:" in out
    assert "차이:" in out


def test_odds_diff_detected(capsys):
    api = [_api("DRX", "KT Rolster", [("DRX", 1.95), ("KT Rolster", 1.88)])]
    screen = [_screen("DRX", "KT Rolster", [("DRX", 2.00), ("KT Rolster", 1.88)])]
    report = match_events(api, screen, odds_tolerance=0.03)
    assert report.matches[0].matched is False
    LiveVerifyLogger().log_report(report)
    out = capsys.readouterr().out
    assert "[EVENT MATCH FAIL]" in out
    assert "차이:" in out


def test_team_normalization_fail(capsys):
    api = [_api("Gen.G Esports", "T1", [("Gen.G Esports", 1.7), ("T1", 2.2)])]
    screen = [_screen("GenG", "T1", [("GenG", 1.7), ("T1", 2.2)])]
    report = match_events(api, screen)
    # fuzzy should still match Gen.G / GenG
    assert report.matched_count == 1


def test_api_not_found(capsys):
    screen = [_screen("Unknown A", "Unknown B", [("Unknown A", 2.0), ("Unknown B", 1.8)])]
    report = match_events([], screen)
    assert report.matched_count == 0
    LiveVerifyLogger().log_report(report)
    out = capsys.readouterr().out
    assert "team name 정규화 실패" in out or "API 경기 없음" in out


def test_market_type_mismatch(capsys):
    api = [
        VerifyEvent(
            event_id="alpha|beta",
            home="Team Alpha",
            away="Team Beta",
            title="Team Alpha vs Team Beta",
            odds=[TeamOdds(team="Team Alpha", decimal=1.9, market="Handicap -1.5", source="api")],
            feed="live",
        )
    ]
    screen = [_screen("Team Alpha", "Team Beta", [("Team Alpha", 1.9), ("Team Beta", 2.0)])]
    report = match_events(api, screen)
    assert report.matches[0].matched is False
    assert any("market type" in r.value for r in report.matches[0].fail_reasons)
