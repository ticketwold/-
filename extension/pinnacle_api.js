/**
 * Pinnacle Guest API (background service worker)
 */
const PINNACLE_SPORTS = {
  football: 29,
  baseball: 3,
  basketball: 4,
  esports: 12,
  tennis: 33,
};

const PinnacleAPI = {
  _apiKey: "",

  async getApiKey() {
    if (this._apiKey) return this._apiKey;
    const res = await fetch("https://www.pinnacle.com/config/app.json");
    const cfg = await res.json();
    this._apiKey = cfg.api.haywire.apiKey;
    return this._apiKey;
  },

  headers() {
    return {
      "x-api-key": this._apiKey,
      Accept: "application/json",
      Referer: "https://www.pinnacle.com/",
    };
  },

  americanToDecimal(price) {
    const p = parseFloat(price);
    if (p >= 100) return p / 100 + 1;
    if (p <= -100) return 100 / Math.abs(p) + 1;
    return p;
  },

  async fetchSport(sportKey) {
    const sportId = PINNACLE_SPORTS[sportKey] || PINNACLE_SPORTS.football;
    await this.getApiKey();

    const base = "https://guest.api.arcadia.pinnacle.com/0.1";
    const [matchupsRes, marketsRes] = await Promise.all([
      fetch(`${base}/sports/${sportId}/matchups?withSpecials=false&brandId=0`, { headers: this.headers() }),
      fetch(`${base}/sports/${sportId}/markets/straight`, { headers: this.headers() }),
    ]);

    const matchups = await matchupsRes.json();
    const markets = await marketsRes.json();

    const map = {};
    for (const m of matchups) {
      if (m.type !== "matchup" || !m.hasMarkets || m.isLive) continue;
      const parts = m.participants || (m.parent || {}).participants || [];
      let home = null;
      let away = null;
      for (const p of parts) {
        if (p.alignment === "home") home = p.name;
        if (p.alignment === "away") away = p.name;
      }
      if (!home || !away) continue;
      map[m.id] = {
        homeTeam: home,
        awayTeam: away,
        league: m.league?.name || "",
        sport: sportKey,
      };
    }

    const ml = {};
    const totals = {};
    for (const mk of markets) {
      if (mk.period !== 0) continue;
      const mid = mk.matchupId;
      if (!map[mid]) continue;
      if (mk.type === "moneyline") ml[mid] = mk;
      if (mk.type === "total") totals[mid] = mk;
    }

    const results = [];
    for (const [mid, info] of Object.entries(map)) {
      const entry = { ...info, matchupId: mid, odds: {} };

      if (ml[mid]) {
        for (const p of ml[mid].prices || []) {
          const dec = this.americanToDecimal(p.price);
          if (p.designation === "home") entry.odds.home = dec;
          if (p.designation === "away") entry.odds.away = dec;
          if (p.designation === "draw") entry.odds.draw = dec;
        }
      }

      if (entry.odds.home && entry.odds.away) {
        results.push(entry);
      }
    }

    return { sport: sportKey, count: results.length, matches: results };
  },

  searchMatches(sportKey, query) {
    return this.fetchSport(sportKey).then((data) => {
      const q = MatchMatcher.normalize(query);
      if (!q) return data;
      const hits = data.matches.filter((m) => {
        const blob = MatchMatcher.normalize(`${m.homeTeam} ${m.awayTeam}`);
        return blob.includes(q);
      });
      return { ...data, hits, hitCount: hits.length };
    });
  },
};
