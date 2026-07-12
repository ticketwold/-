/**
 * arb_calculator.js
 * Python arb_python의 calculator.py + match_matcher.py + odds_convert.py를 JS로 변환
 * 양방배팅 기회 탐지 + 최적 배팅금 계산 + 팀명 정규화 + 경기 매칭
 */

'use strict';

// ─────────────────────────────────────────────
// 배당 변환 유틸 (odds_convert.py)
// ─────────────────────────────────────────────

/**
 * 미국식 배당 → 유럽식(소수) 배당 변환
 * @param {number} american
 * @returns {number}
 */
function americanToDecimal(american) {
  if (american > 0) return Math.round((american / 100 + 1) * 1000) / 1000;
  return Math.round((100 / Math.abs(american) + 1) * 1000) / 1000;
}

// ─────────────────────────────────────────────
// 팀명 정규화 + 경기 매칭 (match_matcher.py)
// ─────────────────────────────────────────────

/**
 * 팀명 정규화 - 사이트 간 매칭용
 * @param {string} name
 * @returns {string}
 */
function normalizeTeam(name) {
  if (!name) return '';
  let n = name.toLowerCase().trim();

  // 특수문자 변환
  const charMap = { 'ø': 'o', 'ö': 'o', 'ü': 'u', 'é': 'e', 'è': 'e', 'ñ': 'n', 'ç': 'c', 'ß': 'ss' };
  for (const [from, to] of Object.entries(charMap)) {
    n = n.split(from).join(to);
  }

  // 접미사 제거
  const removals = [' fc', 'fc ', ' sc', 'sc ', ' cf', 'cf ', ' afc', 'afc ', ' fk', 'fk '];
  for (const r of removals) n = n.split(r).join(' ');

  // 약어 통일
  n = n.replace(/\bunited\b/g, 'utd').replace(/\bathletic\b/g, 'ath');

  // 특수문자 제거 (한글, 영문, 숫자, 공백만 유지)
  n = n.replace(/[^a-z0-9가-힣\s]/g, '');
  return n.replace(/\s+/g, ' ').trim();
}

/**
 * 두 팀명으로 정렬된 고유 매칭 키 생성 (순서 무관)
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @returns {string}
 */
function matchKey(homeTeam, awayTeam) {
  const teams = [normalizeTeam(homeTeam), normalizeTeam(awayTeam)].sort();
  return `${teams[0]}|${teams[1]}`;
}

/**
 * 팀명 유사도 비교
 * @param {string} nameA
 * @param {string} nameB
 * @param {number} threshold
 * @returns {boolean}
 */
function teamsSimilar(nameA, nameB, threshold = 0.8) {
  const a = normalizeTeam(nameA);
  const b = normalizeTeam(nameB);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  // 단어 겹침 비율
  const aWords = new Set(a.split(' ').filter(w => w.length > 1));
  const bWords = new Set(b.split(' ').filter(w => w.length > 1));
  const intersection = [...aWords].filter(w => bWords.has(w));
  const overlap = intersection.length / Math.max(aWords.size, bWords.size);
  return overlap >= threshold;
}

// ─────────────────────────────────────────────
// 양방배팅 계산기 (calculator.py)
// ─────────────────────────────────────────────

/**
 * 최적 배팅 금액 계산
 * @param {number[]} oddsValues - 배당 배열
 * @param {number} total - 총 투자금
 * @returns {number[]} 각 사이트별 배팅금
 */
function calcOptimalStakes(oddsValues, total) {
  const implied = oddsValues.map(o => 1.0 / o);
  const totalImplied = implied.reduce((a, b) => a + b, 0);
  return implied.map(i => Math.round(total * i / totalImplied));
}

/**
 * 양방배팅 기회 탐지 (moneyline)
 * 무승부 조합 제외
 * @param {object} moA - {site, match, odds: [{outcome, value}], marketType}
 * @param {object} moB
 * @param {number} minProfitMargin - 최소 수익률 (%)
 * @param {number} totalStake - 총 투자금
 * @returns {object|null} ArbitrageOpportunity 또는 null
 */
function checkMoneylineArbitrage(moA, moB, minProfitMargin, totalStake) {
  const outcomes = ['home', 'away'];
  const bestCombos = [];

  for (const outcomeA of outcomes) {
    const oddsA = getBestOdds(moA, outcomeA);
    if (!oddsA) continue;

    for (const outcomeB of outcomes) {
      if (outcomeA === outcomeB) continue;
      // 무승부 포함 조합 제외
      if (outcomeA === 'draw' || outcomeB === 'draw') continue;

      const oddsB = getBestOdds(moB, outcomeB);
      if (!oddsB) continue;

      const impliedSum = 1 / oddsA + 1 / oddsB;
      if (impliedSum < 1) {
        const profitMargin = (1 - impliedSum) * 100;
        bestCombos.push({ profitMargin, outcomeA, oddsA, outcomeB, oddsB });
      }
    }
  }

  if (!bestCombos.length) return null;
  bestCombos.sort((a, b) => b.profitMargin - a.profitMargin);
  const best = bestCombos[0];

  if (best.profitMargin < minProfitMargin) return null;

  const stakes = calcOptimalStakes([best.oddsA, best.oddsB], totalStake);
  const actualTotal = stakes[0] + stakes[1];
  const guaranteedProfit = Math.round(stakes[0] * best.oddsA - actualTotal);

  return {
    match: moA.match,
    marketType: 'moneyline',
    line: null,
    profitMargin: Math.round(best.profitMargin * 10000) / 10000,
    totalStake: actualTotal,
    guaranteedProfit,
    allocations: [
      { site: moA.site, outcome: best.outcomeA, odds: best.oddsA, stake: stakes[0], potentialReturn: Math.round(stakes[0] * best.oddsA) },
      { site: moB.site, outcome: best.outcomeB, odds: best.oddsB, stake: stakes[1], potentialReturn: Math.round(stakes[1] * best.oddsB) },
    ],
  };
}

/**
 * 양방배팅 기회 탐지 (over/under)
 * @param {object} moA
 * @param {object} moB
 * @param {number} minProfitMargin
 * @param {number} totalStake
 * @returns {object|null}
 */
function checkOverUnderArbitrage(moA, moB, minProfitMargin, totalStake) {
  // 라인이 다르면 매칭 불가
  if (moA.line !== moB.line) return null;

  const combos = [
    { outcomeA: 'over', outcomeB: 'under' },
    { outcomeA: 'under', outcomeB: 'over' },
  ];

  const bestCombos = [];
  for (const { outcomeA, outcomeB } of combos) {
    const oddsA = getBestOdds(moA, outcomeA);
    const oddsB = getBestOdds(moB, outcomeB);
    if (!oddsA || !oddsB) continue;
    const impliedSum = 1 / oddsA + 1 / oddsB;
    if (impliedSum < 1) {
      bestCombos.push({ profitMargin: (1 - impliedSum) * 100, outcomeA, oddsA, outcomeB, oddsB });
    }
  }

  if (!bestCombos.length) return null;
  bestCombos.sort((a, b) => b.profitMargin - a.profitMargin);
  const best = bestCombos[0];

  if (best.profitMargin < minProfitMargin) return null;

  const stakes = calcOptimalStakes([best.oddsA, best.oddsB], totalStake);
  const actualTotal = stakes[0] + stakes[1];
  const guaranteedProfit = Math.round(stakes[0] * best.oddsA - actualTotal);

  return {
    match: moA.match,
    marketType: 'over_under',
    line: moA.line,
    profitMargin: Math.round(best.profitMargin * 10000) / 10000,
    totalStake: actualTotal,
    guaranteedProfit,
    allocations: [
      { site: moA.site, outcome: best.outcomeA, odds: best.oddsA, stake: stakes[0], potentialReturn: Math.round(stakes[0] * best.oddsA) },
      { site: moB.site, outcome: best.outcomeB, odds: best.oddsB, stake: stakes[1], potentialReturn: Math.round(stakes[1] * best.oddsB) },
    ],
  };
}

/**
 * MatchOdds에서 특정 outcome의 배당 조회
 * @param {object} mo - {odds: [{outcome, value}]}
 * @param {string} outcome
 * @returns {number|null}
 */
function getBestOdds(mo, outcome) {
  if (!mo || !mo.odds) return null;
  const found = mo.odds.find(o => o.outcome === outcome);
  return found ? found.value : null;
}

/**
 * 양방배팅 기회 탐지 (handicap/AH)
 * @param {object} moA
 * @param {object} moB
 * @param {number} minProfitMargin
 * @param {number} totalStake
 * @returns {object|null}
 */
function checkHandicapArbitrage(moA, moB, minProfitMargin, totalStake) {
  // 라인 절댓값이 같아야 매칭 가능
  if (moA.line == null || moB.line == null) return null;
  if (Math.abs(Math.abs(moA.line) - Math.abs(moB.line)) > 0.1) return null;

  // 핸디캡: A사이트 홈팀 핸디 + B사이트 어웨이팀 핸디 (반대편)
  const combos = [
    { outcomeA: 'home', outcomeB: 'away' },
    { outcomeA: 'away', outcomeB: 'home' },
  ];

  const bestCombos = [];
  for (const { outcomeA, outcomeB } of combos) {
    const oddsA = getBestOdds(moA, outcomeA);
    const oddsB = getBestOdds(moB, outcomeB);
    if (!oddsA || !oddsB) continue;
    const impliedSum = 1 / oddsA + 1 / oddsB;
    if (impliedSum < 1) {
      bestCombos.push({ profitMargin: (1 - impliedSum) * 100, outcomeA, oddsA, outcomeB, oddsB });
    }
  }

  if (!bestCombos.length) return null;
  bestCombos.sort((a, b) => b.profitMargin - a.profitMargin);
  const best = bestCombos[0];

  if (best.profitMargin < minProfitMargin) return null;

  const stakes = calcOptimalStakes([best.oddsA, best.oddsB], totalStake);
  const actualTotal = stakes[0] + stakes[1];
  const guaranteedProfit = Math.round(stakes[0] * best.oddsA - actualTotal);

  return {
    match: moA.match,
    marketType: 'handicap',
    line: moA.line,
    profitMargin: Math.round(best.profitMargin * 10000) / 10000,
    totalStake: actualTotal,
    guaranteedProfit,
    allocations: [
      { site: moA.site, outcome: best.outcomeA, odds: best.oddsA, stake: stakes[0], potentialReturn: Math.round(stakes[0] * best.oddsA) },
      { site: moB.site, outcome: best.outcomeB, odds: best.oddsB, stake: stakes[1], potentialReturn: Math.round(stakes[1] * best.oddsB) },
    ],
  };
}

/**
 * 두 사이트의 배당 목록에서 양방배팅 기회 탐지
 * @param {object[]} oddsA - [{match, site, marketType, line, odds}]
 * @param {object[]} oddsB
 * @param {number} minProfitMargin
 * @param {number} totalStake
 * @returns {object[]} ArbitrageOpportunity 배열
 */
function findArbitrageOpportunities(oddsA, oddsB, minProfitMargin, totalStake) {
  const opportunities = [];

  // A사이트 기준 맵 생성
  const aMap = {};
  for (const mo of oddsA) {
    const key = `${matchKey(mo.match.homeTeam, mo.match.awayTeam)}|${mo.marketType}|${mo.line ?? ''}`;
    if (!aMap[key]) aMap[key] = [];
    aMap[key].push(mo);
  }

  for (const moB of oddsB) {
    const key = `${matchKey(moB.match.homeTeam, moB.match.awayTeam)}|${moB.marketType}|${moB.line ?? ''}`;

    let matchedA = aMap[key] || [];

    // 정확한 키 없으면 유사도 매칭
    if (!matchedA.length) {
      for (const [aKey, aList] of Object.entries(aMap)) {
        const [aTeamKey, aMarket, aLine] = aKey.split('|');
        const [bTeamKey, bMarket, bLine] = key.split('|');
        if (aMarket !== bMarket || aLine !== bLine) continue;
        const [aT1, aT2] = aTeamKey.split('|');
        const [bT1, bT2] = bTeamKey.split('|');
        if (teamsSimilar(aT1, bT1) && teamsSimilar(aT2, bT2)) {
          matchedA = aList;
          break;
        }
      }
    }

    for (const moA of matchedA) {
      let opp = null;
      if (moB.marketType === 'moneyline') {
        opp = checkMoneylineArbitrage(moA, moB, minProfitMargin, totalStake);
      } else if (moB.marketType === 'over_under') {
        opp = checkOverUnderArbitrage(moA, moB, minProfitMargin, totalStake);
      } else if (moB.marketType === 'handicap' || moB.marketType === 'spread') {
        opp = checkHandicapArbitrage(moA, moB, minProfitMargin, totalStake);
      }
      if (opp) {
        opportunities.push(opp);
        // 실시간 로그
        console.log(
          `[ARB] ${opp.match.homeTeam} vs ${opp.match.awayTeam} | ` +
          `${opp.marketType}${opp.line ? ' ' + opp.line : ''} | ` +
          `수익률 ${opp.profitMargin.toFixed(2)}% | 확정수익 ${opp.guaranteedProfit.toLocaleString()}원`
        );
      }
    }
  }

  return opportunities;
}

/**
 * Pinnacle API에서 배당 조회 (background.js에서 호출)
 * @param {string[]} sports - ['football', 'basketball', 'baseball']
 * @returns {Promise<object[]>} MatchOdds 배열
 */
async function fetchPinnacleOdds(sports) {
  const SPORT_IDS = { football: 29, soccer: 29, basketball: 4, baseball: 3, tennis: 33 };
  const API_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';

  // API 키 획득
  let apiKey = '';
  try {
    const cfgResp = await fetch('https://www.pinnacle.com/config/app.json');
    const cfg = await cfgResp.json();
    apiKey = cfg?.api?.haywire?.apiKey || '';
  } catch (e) {
    console.warn('[ARB] Pinnacle API 키 획득 실패:', e.message);
    return [];
  }

  const headers = { 'x-api-key': apiKey, 'Accept': 'application/json', 'Referer': 'https://www.pinnacle.com/' };
  const targetSports = sports || ['football', 'basketball', 'baseball'];
  const sportIds = [...new Set(targetSports.map(s => SPORT_IDS[s]).filter(Boolean))];

  const allOdds = [];
  for (const sportId of sportIds) {
    try {
      const [matchupsResp, marketsResp] = await Promise.all([
        fetch(`${API_BASE}/sports/${sportId}/matchups?isLive=true`, { headers }),
        fetch(`${API_BASE}/sports/${sportId}/markets/highlighted/straight?primaryOnly=false`, { headers }),
      ]);
      const matchups = await matchupsResp.json();
      const markets = await marketsResp.json();
      const parsed = parsePinnacleMarkets(matchups, markets, sportId);
      allOdds.push(...parsed);
    } catch (e) {
      console.warn(`[ARB] Pinnacle 스포츠 ${sportId} 조회 실패:`, e.message);
    }
  }
  return allOdds;
}

/**
 * Pinnacle matchups + markets 파싱
 */
function parsePinnacleMarkets(matchups, markets, sportId) {
  const SPORT_NAME_MAP = { 'Soccer': 'football', 'Basketball': 'basketball', 'Baseball': 'baseball', 'Tennis': 'tennis' };

  // matchupId → 경기 정보 맵
  const matchupMap = {};
  for (const m of matchups) {
    if (m.type !== 'matchup' || !m.hasMarkets) continue;
    const participants = m.participants?.length ? m.participants : (m.parent?.participants || []);
    const home = participants.find(p => p.alignment === 'home')?.name;
    const away = participants.find(p => p.alignment === 'away')?.name;
    if (!home || !away) continue;

    const sportName = m.league?.sport?.name || '';
    matchupMap[m.id] = {
      homeTeam: home,
      awayTeam: away,
      league: m.league?.name || '',
      sport: SPORT_NAME_MAP[sportName] || sportName.toLowerCase(),
    };
  }

  // 마켓 파싱
  const mlByMatchup = {};
  const totalByMatchup = {};
  for (const mk of markets) {
    if (mk.period !== 0) continue;
    const mid = mk.matchupId;
    if (!matchupMap[mid]) continue;
    if (mk.type === 'moneyline') mlByMatchup[mid] = mk;
    else if (mk.type === 'total') totalByMatchup[mid] = mk;
  }

  const results = [];
  for (const [mid, info] of Object.entries(matchupMap)) {
    const match = { matchId: `pinnacle_${mid}`, homeTeam: info.homeTeam, awayTeam: info.awayTeam, league: info.league, sport: info.sport };

    // 승무패
    if (mlByMatchup[mid]) {
      const prices = mlByMatchup[mid].prices || [];
      const odds = [];
      for (const p of prices) {
        const outcomeMap = { home: 'home', away: 'away', draw: 'draw' };
        const outcome = outcomeMap[p.designation];
        if (!outcome) continue;
        odds.push({ outcome, value: americanToDecimal(p.price) });
      }
      if (odds.length >= 2) {
        results.push({ match, site: 'Pinnacle', marketType: 'moneyline', line: null, odds });
      }
    }

    // 오버/언더
    if (totalByMatchup[mid]) {
      const prices = totalByMatchup[mid].prices || [];
      const odds = [];
      let line = null;
      for (const p of prices) {
        if (p.points != null) line = p.points;
        if (p.designation === 'over') odds.push({ outcome: 'over', value: americanToDecimal(p.price), line: p.points });
        else if (p.designation === 'under') odds.push({ outcome: 'under', value: americanToDecimal(p.price), line: p.points });
      }
      if (odds.length >= 2 && line != null) {
        results.push({ match, site: 'Pinnacle', marketType: 'over_under', line, odds });
      }
    }
  }
  return results;
}

/**
 * BTI/SBO 슬립에서 MatchOdds 형식으로 변환
 * @param {object} slip - {homeTeam, awayTeam, odds, marketType, line, site}
 * @returns {object} MatchOdds
 */
function slipToMatchOdds(slip) {
  if (!slip) return null;
  const match = {
    matchId: `${slip.site}_slip`,
    homeTeam: slip.homeTeam || slip.home || '',
    awayTeam: slip.awayTeam || slip.away || '',
    league: slip.league || '',
    sport: slip.sport || 'football',
  };

  // outcome 결정
  let outcome = slip.outcome || slip.betType || 'home';
  if (typeof outcome === 'string') outcome = outcome.toLowerCase();

  const marketType = slip.marketType || (slip.line != null ? 'over_under' : 'moneyline');

  return {
    match,
    site: slip.site || 'BTI',
    marketType,
    line: slip.line ?? null,
    odds: [{ outcome, value: parseFloat(slip.odds) }],
  };
}

// 외부 노출 (popup.js에서 사용)
if (typeof window !== 'undefined') {
  window.ArbCalc = {
    americanToDecimal,
    normalizeTeam,
    matchKey,
    teamsSimilar,
    calcOptimalStakes,
    findArbitrageOpportunities,
    fetchPinnacleOdds,
    parsePinnacleMarkets,
    slipToMatchOdds,
    checkMoneylineArbitrage,
    checkOverUnderArbitrage,
    checkHandicapArbitrage,
  };
}
