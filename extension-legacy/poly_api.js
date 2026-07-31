'use strict';

const POLY_LIVE_MIN = 0.03;
const POLY_LIVE_MAX = 0.97;

const POLY_PRIORITY_SPORTS = new Set([
  'cs2', 'lol', 'dota2', 'val', 'wildrift', 'rl',
  'nba', 'nhl', 'nfl', 'mlb', 'wnba',
  'epl', 'ucl', 'bun', 'lal', 'fl1', 'sea', 'ere'
]);

function slugFromPolyUrl(url) {
  const s = String(url || '');
  let m = s.match(/\/predictions\/event\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  m = s.match(/\/event\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function parsePolyOutcomes(market) {
  try {
    const outcomes = typeof market.outcomes === 'string'
      ? JSON.parse(market.outcomes)
      : (market.outcomes || []);
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : (market.outcomePrices || market.outcome_prices || []);
    return { outcomes, prices };
  } catch (_) {
    return { outcomes: [], prices: [] };
  }
}

function isLivePolyPrice(p) {
  const f = parseFloat(p);
  return Number.isFinite(f) && f > POLY_LIVE_MIN && f < POLY_LIVE_MAX;
}

function isTeamOutcomeName(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  return !/^(yes|no|odd|even|over|under)$/i.test(n);
}

function parsePolyEventTeams(title) {
  let t = String(title || '').trim();
  t = t.replace(/^(?:(?:LoL|Counter-Strike|Dota\s*2|Valorant|CS2?|Rocket\s*League)\s*:\s*)/i, '');
  const m = t.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*\([^)]*\))?(?:\s+-.*)?$/i)
    || t.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (!m) return null;
  let away = m[2].trim();
  away = away.replace(/\s*\([^)]*\).*$/, '').replace(/\s+-\s+.*$/, '').trim();
  return { home: m[1].trim(), away };
}

function scorePolyMoneylineMarket(market, outcomes, prices) {
  let score = 0;
  const smt = market.sportsMarketType || '';
  const q = String(market.question || '');

  if (smt === 'moneyline') score += 120;
  else if (smt === 'child_moneyline') score += 50;
  else if (!smt) score += 20;
  else return -1;

  if (/game\s*\d|map\s*\d|kill handicap|odd\/even|o\/u|total/i.test(q)) score -= 80;
  if (market.closed) score -= 200;
  if (!prices.every(isLivePolyPrice)) score -= 150;
  if (!outcomes.every(isTeamOutcomeName)) return -1;

  return score;
}

function pickPolyMoneylineMarket(markets) {
  const candidates = [];
  for (const market of markets || []) {
    const { outcomes, prices } = parsePolyOutcomes(market);
    if (outcomes.length !== 2 || prices.length < 2) continue;
    const pf = prices.map((p) => parseFloat(p));
    const score = scorePolyMoneylineMarket(market, outcomes, pf);
    if (score < 0) continue;
    candidates.push({ market, outcomes, prices: pf, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function polyEventToMatchup(event) {
  const teams = parsePolyEventTeams(event.title);
  if (!teams) return null;

  const pick = pickPolyMoneylineMarket(event.markets);
  if (!pick) return null;

  const ml = [];
  for (let i = 0; i < 2; i++) {
    const dec = polyPriceToDecimal(pick.prices[i]);
    if (!dec) continue;
    ml.push({
      team: pick.outcomes[i],
      side: i === 0 ? 'home' : 'away',
      price: pick.prices[i],
      decimal: dec
    });
  }
  if (ml.length !== 2) return null;

  return {
    id: String(event.id),
    home: teams.home,
    away: teams.away,
    title: event.title,
    league: event.seriesSlug || '',
    ml
  };
}

function parsePolymarketEvents(events) {
  const result = [];
  const seen = new Set();
  for (const event of events || []) {
    const matchup = polyEventToMatchup(event);
    if (!matchup || seen.has(matchup.id)) continue;
    seen.add(matchup.id);
    result.push(matchup);
  }
  return result;
}

function polyTeamHintFromUrl(url) {
  const slug = slugFromPolyUrl(url);
  if (!slug) return '';
  const parts = slug.split('-').filter(Boolean);
  if (parts.length < 2) return '';
  return parts.slice(0, Math.min(4, parts.length - 2)).join(' ');
}

function pickPolyOutcomeForHint(ml, teamHint) {
  if (!ml?.length) return null;
  if (!teamHint) return ml[0];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hint = norm(teamHint);
  for (const row of ml) {
    const nt = norm(row.team);
    if (nt.includes(hint) || hint.includes(nt)) return row;
  }
  return ml[0];
}

function polyEventToSlip(event, teamHint = '', siteKey = 'polymarket') {
  const matchup = polyEventToMatchup(event);
  if (!matchup) return null;

  const row = pickPolyOutcomeForHint(matchup.ml, teamHint);
  if (!row) return null;

  const cents = Math.round(row.price * 1000) / 10;
  return {
    source: `${siteKey}-api`,
    odds: row.decimal,
    priceCents: cents,
    price: row.price,
    teamLabel: row.team,
    outcome: row.team,
    selectionText: `${row.team} @ ${cents}¢`,
    displayLabel: `${cents}¢ (${row.decimal.toFixed(3)})`,
    marketKind: 'ml',
    liveCents: true,
    homeTeam: matchup.home,
    awayTeam: matchup.away
  };
}

async function fetchPolyEventBySlug(slug) {
  if (!slug) return null;
  const url = `${SITE_CONFIG.GAMMA_API}/events?slug=${encodeURIComponent(slug)}&_t=${Date.now()}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Polymarket API ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data[0] : null;
}

async function fetchPolySportsList() {
  const url = `${SITE_CONFIG.GAMMA_API}/sports?_t=${Date.now()}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Polymarket sports API ${res.status}`);
  return res.json();
}

async function getPolymarketMatchups(limitPerSeries = 35, maxSports = 28) {
  const sports = await fetchPolySportsList();
  const sorted = [...sports].sort((a, b) => {
    const pa = POLY_PRIORITY_SPORTS.has(a.sport) ? 0 : 1;
    const pb = POLY_PRIORITY_SPORTS.has(b.sport) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return String(a.sport).localeCompare(String(b.sport));
  }).slice(0, maxSports);

  const allEvents = [];
  const seen = new Set();

  await Promise.all(sorted.map(async (sp) => {
    if (!sp.series) return;
    try {
      const url = `${SITE_CONFIG.GAMMA_API}/events?series_id=${sp.series}&active=true&closed=false&limit=${limitPerSeries}&_t=${Date.now()}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return;
      const events = await res.json();
      for (const e of events || []) {
        if (!e?.id || seen.has(e.id)) continue;
        seen.add(e.id);
        allEvents.push(e);
      }
    } catch (_) {}
  }));

  return parsePolymarketEvents(allEvents);
}
