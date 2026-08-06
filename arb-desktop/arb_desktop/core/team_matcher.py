from __future__ import annotations

import re
from typing import Iterable


def norm_team(name: str) -> str:
    if not name:
        return ""
    return re.sub(r"[^a-z0-9가-힣]", "", name.lower().replace(" ", ""))


def has_hangul(name: str) -> bool:
    return bool(re.search(r"[가-힣]", name or ""))


def latin_words(name: str) -> list[str]:
    return re.findall(r"[a-z]{4,}", (name or "").lower())


def hangul_chunks(name: str) -> list[str]:
    return re.findall(r"[가-힣]{2,}", name or "")


def team_match(a: str, b: str) -> bool:
    na, nb = norm_team(a), norm_team(b)
    if not na or not nb or len(na) < 2 or len(nb) < 2:
        return False
    if na == nb:
        return True
    if na in nb or nb in na:
        return True
    if len(na) >= 4 and len(nb) >= 4 and na[:4] == nb[:4]:
        return True
    if has_hangul(a) and has_hangul(b):
        for x in hangul_chunks(a):
            for y in hangul_chunks(b):
                if len(x) >= 2 and len(y) >= 2 and (x in y or y in x):
                    return True
                if len(x) >= 3 and len(y) >= 3 and x[:3] == y[:3]:
                    return True
    for x in latin_words(a):
        for y in latin_words(b):
            if x == y or (len(x) >= 5 and len(y) >= 5 and (x in y or y in x)):
                return True
    return False


def collect_name_variants(*names: str) -> list[str]:
    out: list[str] = []
    for n in names:
        if not n or len(norm_team(n)) < 2:
            continue
        if not any(norm_team(x) == norm_team(n) for x in out):
            out.append(n)
    return out


def matchup_teams_match(a_home: str, a_away: str, b_home: str, b_away: str) -> bool:
    a_homes = collect_name_variants(a_home)
    a_aways = collect_name_variants(a_away)
    b_homes = collect_name_variants(b_home)
    b_aways = collect_name_variants(b_away)
    if not all([a_homes, a_aways, b_homes, b_aways]):
        return False

    def align(h1: str, aw1: str, h2: str, aw2: str) -> bool:
        return team_match(h1, h2) and team_match(aw1, aw2)

    for h1 in a_homes:
        for aw1 in a_aways:
            for h2 in b_homes:
                for aw2 in b_aways:
                    if align(h1, aw1, h2, aw2):
                        return True
            for h2 in b_aways:
                for aw2 in b_homes:
                    if align(h1, aw1, h2, aw2):
                        return True
    return False


def is_bti_home_side(side: str) -> bool:
    s = (side or "").lower()
    return s in {"h", "home", "1", "w1"}


def is_bti_away_side(side: str) -> bool:
    s = (side or "").lower()
    return s in {"a", "away", "2", "w2"}
