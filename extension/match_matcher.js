/**
 * 팀명 매칭 (Pinnacle ↔ BTI)
 */
const MatchMatcher = {
  normalize(name) {
    return (name || "")
      .toLowerCase()
      .replace(/\s*(fc|sc|cf|afc)\s*/gi, " ")
      .replace(/ø/g, "o").replace(/ö/g, "o")
      .replace(/[^a-z0-9가-힣\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  },

  similar(a, b) {
    const x = this.normalize(a);
    const y = this.normalize(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.includes(y) || y.includes(x)) return true;
    const xw = new Set(x.split(" "));
    const yw = new Set(y.split(" "));
    const overlap = [...xw].filter((w) => yw.has(w));
    return overlap.length >= Math.min(xw.size, yw.size) * 0.5;
  },

  matchKey(home, away, sport = "") {
    const teams = [this.normalize(home), this.normalize(away)].sort();
    return sport ? `${sport}|${teams[0]}|${teams[1]}` : `${teams[0]}|${teams[1]}`;
  },

  sameMatch(a, b) {
    if (this.similar(a.homeTeam, b.homeTeam) && this.similar(a.awayTeam, b.awayTeam)) return true;
    if (this.similar(a.homeTeam, b.awayTeam) && this.similar(a.awayTeam, b.homeTeam)) return true;
    return false;
  },
};
