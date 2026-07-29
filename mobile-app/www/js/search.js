'use strict';

const BTI_MARKET_TYPES = 'ML0%2CHC0%2COU0';

function parseBtiSelectionPrice(s) {
  if (!s) return 0;
  for (const f of [s.Price, s.DisplayPrice, s.Odds, s.Decimal, s.price]) {
    const n = parseFloat(f);
    if (n > 1.001 && n < 500) return n;
  }
  return 0;
}

function parseBtiOdds(markets) {
  const result = { ml: [] };
  for (const m of markets || []) {
    const typeId = m.MarketType?._id || m._id || '';
    if (!String(typeId).startsWith('ML')) continue;
    for (const s of (m.Selections || [])) {
      const side = s.Side || '';
      const odds = parseBtiSelectionPrice(s);
      if (odds > 1) result.ml.push({ side, odds, name: s.Name || s.TeamName || '' });
    }
  }
  return result;
}

function parsePolyOutcomes(market) {
  try {
    const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : (market.outcomes || []);
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : (market.outcomePrices || market.outcome_prices || []);
    return { outcomes, prices };
  } catch (_) { return { outcomes: [], prices: [] }; }
}

function parsePolymarketEvents(events) {
  const result = [];
  for (const e of events || []) {
    const title = e.title || '';
    const vs = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+-|\s*\(|$)/i);
    if (!vs) continue;
    const home = vs[1].trim();
    const away = vs[2].trim();
    const ml = [];
    for (const m of (e.markets || [])) {
      const { outcomes, prices } = parsePolyOutcomes(m);
      if (outcomes.length !== 2 || prices.length < 2) continue;
      for (let i = 0; i < 2; i++) {
        const dec = polyPriceToDecimal(parseFloat(prices[i]));
        if (dec) ml.push({ team: outcomes[i], side: i === 0 ? 'home' : 'away', price: parseFloat(prices[i]), decimal: dec });
      }
    }
    if (!ml.length) continue;
    result.push({ id: String(e.id), home, away, title, league: e.seriesSlug || '', ml });
  }
  return result;
}

function parseBtiLiveEvents(data) {
  const result = [];
  for (const event of data || []) {
    if (!event.id || !event.markets?.length) continue;
    let home = '';
    let away = '';
    const m0 = event.markets[0];
    if (m0.Selections) {
      const h = m0.Selections.find((s) => s.Side === 'H' || s.Side === 'Home');
      const a = m0.Selections.find((s) => s.Side === 'A' || s.Side === 'Away');
      if (h) home = h.Name || h.TeamName || '';
      if (a) away = a.Name || a.TeamName || '';
    }
    if (!home && m0.EventName) {
      const parts = m0.EventName.split(' vs ');
      if (parts.length >= 2) { home = parts[0].trim(); away = parts[1].trim(); }
    }
    result.push({ id: event.id, home, away, markets: event.markets, sportId: m0.SportId || 0 });
  }
  return result;
}

function findArbOpportunities(btiList, polyList) {
  const opps = [];
  for (const bti of btiList) {
    const btiOdds = parseBtiOdds(bti.markets);
    const mlH = btiOdds.ml.find((m) => m.side === 'H' || m.side === 'Home');
    const mlA = btiOdds.ml.find((m) => m.side === 'A' || m.side === 'Away');
    if (!mlH?.odds || !mlA?.odds) continue;

    for (const poly of polyList) {
      if (!matchupTeamsMatch(bti, poly)) continue;
      for (const pm of poly.ml) {
        if (!pm.decimal) continue;
        const btiHome = teamMatch(pm.team, bti.home);
        const btiAway = teamMatch(pm.team, bti.away);
        let oppOdds = null;
        let btiSide = '';
        if (btiHome) { oppOdds = mlA.odds; btiSide = 'away'; }
        else if (btiAway) { oppOdds = mlH.odds; btiSide = 'home'; }
        else continue;

        const profit = calcArb(pm.decimal, oppOdds);
        if (profit === null || profit < 0) continue;
        opps.push({
          home: bti.home,
          away: bti.away,
          league: bti.league || poly.league,
          polyTeam: pm.team,
          polyOdds: pm.decimal.toFixed(3),
          polyPrice: pm.price,
          btiSide,
          btiOdds: oppOdds,
          profit: profit.toFixed(2)
        });
      }
    }
  }
  return opps.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
}

async function getPolymarketMatchups(limit = 120) {
  const url = `${SITE_CONFIG.GAMMA_API}/events?tag_id=${SITE_CONFIG.GAMMA_SPORTS_TAG}&active=true&closed=false&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Polymarket API ${res.status}`);
  return parsePolymarketEvents(await res.json());
}

async function fetchBtiLiveViaBridge() {
  const path = `/api/sportscenter/inplay/markets?language=KO&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`;
  const res = await MobileBridge.send('bti', { type: 'FETCH_BTI_JSON', path });
  if (!res?.ok || !Array.isArray(res.data)) throw new Error(res?.error || 'BTI API 실패');
  return parseBtiLiveEvents(res.data);
}

async function runArbSearch() {
  let btiAll = [];
  let btiTabFound = false;
  try {
    btiAll = await fetchBtiLiveViaBridge();
    btiTabFound = btiAll.length > 0;
  } catch (e) {
    console.warn('[BTI]', e.message);
  }

  let polyAll = [];
  try {
    polyAll = await getPolymarketMatchups(150);
  } catch (e) {
    console.warn('[Poly API]', e.message);
  }

  const opps = findArbOpportunities(btiAll, polyAll);
  return {
    opportunities: opps,
    stats: {
      btiTotal: btiAll.length,
      polyTotal: polyAll.length,
      matched: opps.length,
      btiTabFound,
      polyTabFound: polyAll.length > 0
    }
  };
}
