// background.js - Service Worker
const PIN_API_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';

// 피나클 스포츠 ID 매핑 (라이브 대상)
const PIN_SPORT_IDS = {
  soccer: 29,
  baseball: 3,
  basketball: 4
};

// 피나클 프리매치 스포츠 ID 매핑
const PIN_PREMATCH_SPORT_IDS = {
  soccer: 29,
  baseball: 3,
  basketball: 4,
  esports: 12,
  tennis: 33
};

// 스포츠 ID → 한국어 이름
const PIN_SPORT_LABEL = {
  29: '축구', 3: '야구', 4: '농구', 12: '이스포츠', 33: '테니스'
};

// BTI 스포츠 ID → 피나클 스포츠 ID 매핑
const BTI_TO_PIN_SPORT = {
  1: 29,   // 축구
  6: 3,    // 야구
  7: 4,    // 농구
  59: 12,  // 이스포츠
  2: 33    // 테니스
};

// BTI 마켓 타입
const BTI_MARKET_TYPES = 'ML0%2CHC0%2COU0%2CML39%2COU39%2CHC39%2CML587';

// SBOBET GraphQL 쿼리 해시 (퍼시스티드 쿼리)
const SBO_EVENTS_HASH = '21a58973cc890d563921d09e95f3c778c13deb6c4b30720b21f1a668848ecec4';
const SBO_ODDS_HASH = 'a7b8c2d3084b3d374e3e9f869c7986a21f242d4d26cd566cc8b692f84e019731';

// SBOBET 토큰 캐시 (content script에서 전달받음)
let sbobetToken = null;
let sbobetApiBase = 'https://queennew-prod.zzllrrcc33.com';

// 미국식 머니라인 → 소수 배당 변환
function usOddsToDecimal(us) {
  if (us >= 100) return (us / 100) + 1;
  if (us < 0) return (100 / Math.abs(us)) + 1;
  return 1;
}

// 팀명 정규화 (비교용)
function normTeam(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9가-힣]/g, '');
}

// 두 팀명 유사도 체크 (한쪽이 다른쪽에 포함되거나 앞 4자 일치)
function teamMatch(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // 앞 4자 일치
  if (na.length >= 4 && nb.length >= 4 && na.slice(0, 4) === nb.slice(0, 4)) return true;
  return false;
}

// 피나클 API 호출
async function fetchPin(path, lang = 'ko') {
  const res = await fetch('https://api.arcadia.pinnacle.com/0.1' + path, {
    headers: {
      'X-Api-Key': PIN_API_KEY,
      'Accept-Language': lang,
      'X-Device-UUID': 'arb-bot-prematch'
    },
    credentials: 'omit'
  });
  return res.json();
}

const BTI_HOST_HINTS = [
  'bti-sports.io', 'bti-sports.com', 'live8588.com', 'fxf774.com',
  'indonesiawinner.com', 'eviran66.com', 'auremi88.com'
];
// /sports 경로만으로 BTI 판별 시 polymarket.com 등 오탐 — 제외 목록
const BTI_EXCLUDED_HOSTS = [
  'polymarket.com', 'pinnacle.com', 'draftkings.com', 'fanduel.com',
  'betfair.com', 'bovada.lv', 'google.com', 'youtube.com', 'facebook.com'
];
const BTI_PATH_HINTS = /sportsbook|asian-view/i;
const PBC_BTI_GAMECODES = ['19', '20', '21', '22', '23'];
// manifest host_permissions와 동일 — executeScript/sendMessage 가능 도메인만
const INJECTABLE_HOST_SUFFIXES = [
  'auremi88.com', 'bti-sports.com', 'bti-sports.io', 'eviran66.com',
  'indonesiawinner.com', 'jjddgg.com', 'mervani99.com', 'pbc00.com',
  'pinnacle.com', 'live8588.com', 'fxf774.com', 'wg88ss.com',
  'zzddqq.com', 'zzllrrcc33.com', 'arcadia.pinnacle.com'
];

function isInjectableUrl(url) {
  if (!url || url === 'about:blank') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return INJECTABLE_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith('.' + suffix));
  } catch (_) {
    return false;
  }
}

function isExcludedBtiHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return BTI_EXCLUDED_HOSTS.some((x) => h === x || h.endsWith('.' + x));
  } catch (_) {
    return false;
  }
}

function isDirectBtiTabUrl(url) {
  if (!url || url === 'about:blank' || isExcludedBtiHost(url)) return false;
  return BTI_HOST_HINTS.some((h) => url.includes(h));
}

function isBtiHost(url) {
  if (!url || url === 'about:blank' || isExcludedBtiHost(url)) return false;
  if (BTI_HOST_HINTS.some((h) => url.includes(h))) return true;
  try {
    const u = new URL(url);
    if (!isInjectableUrl(url)) return false;
    const path = u.pathname.toLowerCase();
    if (BTI_PATH_HINTS.test(path)) return true;
    if (/prod\d+/i.test(url) && (u.hostname.includes('bti') || u.hostname.includes('sports'))) return true;
    if ((u.hostname.includes('bti-sports') || u.hostname.includes('live8588') || u.hostname.includes('fxf774'))
        && /\/sports(?:\/|$)/i.test(path)) return true;
  } catch (_) {}
  return false;
}

function isInjectableBtiFrame(url) {
  return isInjectableUrl(url) && isBtiHost(url);
}

function scorePbcBtiTab(url) {
  if (!url || !url.includes('pbc00.com')) return 0;
  const m = url.match(/[?&]gamecode=(\d+)/);
  if (m && PBC_BTI_GAMECODES.includes(m[1])) return 10;
  return 1;
}

async function getAllTabFrames(tabId) {
  if (!chrome.webNavigation?.getAllFrames) return [{ frameId: 0, url: '' }];
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      resolve(frames?.length ? frames : [{ frameId: 0, url: '' }]);
    });
  });
}

async function probeIframeSrcs(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => Array.from(document.querySelectorAll('iframe'))
        .map((f) => f.src || f.getAttribute('src') || '')
        .filter((s) => s && s.startsWith('http'))
    });
    return results?.[0]?.result || [];
  } catch (_) {
    return [];
  }
}

async function probeBtiFramesByPing(tabId, frames) {
  const found = [];
  for (const frame of frames) {
    if (frame.frameId === 0) continue;
    if (frame.url && !isInjectableUrl(frame.url)) continue;
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: frame.frameId });
      if (!ping) continue;
      const href = ping.href || frame.url || '';
      if (ping.buttonCount || ping.hasSlip || isBtiHost(href)) {
        found.push({ frameId: frame.frameId, url: href, score: 14 });
      }
    } catch (_) {}
  }
  return found;
}

async function getBtiFrameCandidates(tabId, tabUrl) {
  const frames = await getAllTabFrames(tabId);
  const candidates = [];

  for (const frame of frames) {
    if (!frame.url || frame.url === 'about:blank') continue;
    if (!isInjectableBtiFrame(frame.url)) continue;
    let score = 0;
    if (BTI_HOST_HINTS.some((h) => frame.url.includes(h))) score = 20;
    else if (BTI_PATH_HINTS.test(frame.url)) score = 12;
    if (score > 0) candidates.push({ frameId: frame.frameId, url: frame.url, score });
  }

  if (!candidates.length) {
    const srcs = await probeIframeSrcs(tabId);
    for (const src of srcs) {
      if (!isBtiHost(src)) continue;
      try {
        const origin = new URL(src).origin;
        const match = frames.find((f) => f.url && f.url.startsWith(origin));
        if (match && isInjectableBtiFrame(match.url)) {
          candidates.push({ frameId: match.frameId, url: match.url, score: 15 });
        }
      } catch (_) {}
    }
    if (!candidates.length && srcs.some(isBtiHost)) {
      candidates.push(...await probeBtiFramesByPing(tabId, frames));
    }
  }

  if (!candidates.length && tabUrl && isInjectableBtiFrame(tabUrl)) {
    candidates.push({ frameId: 0, url: tabUrl, score: 5 });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// pbc00 탭 안 BTI iframe origin (쿠키가 iframe에 있음)
async function resolveBtiApiOrigin(tabId, tabUrl) {
  if (tabUrl && tabUrl.includes('fxf774.com')) {
    return new URL(tabUrl).origin;
  }
  if (tabUrl && isDirectBtiTabUrl(tabUrl)) {
    return new URL(tabUrl).origin;
  }

  const candidates = await getBtiFrameCandidates(tabId, tabUrl);
  for (const c of candidates) {
    try {
      const origin = new URL(c.url).origin;
      console.log('[BTI] API origin:', origin, 'frame=', c.frameId);
      return origin;
    } catch (_) {}
  }

  const srcs = await probeIframeSrcs(tabId);
  for (const src of srcs) {
    if (!isBtiHost(src)) continue;
    try {
      console.log('[BTI] iframe src에서 origin 추출:', src.substring(0, 80));
      return new URL(src).origin;
    } catch (_) {}
  }

  console.warn('[BTI] iframe 미발견 — prod188 폴백');
  return 'https://prod188.bti-sports.io';
}

async function getBtiFrameIds(tabId, tabUrl) {
  const candidates = await getBtiFrameCandidates(tabId, tabUrl);
  const ids = [...new Set(candidates.map((c) => c.frameId))];
  if (ids.length) return ids;
  if (tabUrl && isInjectableBtiFrame(tabUrl)) return [0];
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getAllFrameIdsForFetch(tabId, tabUrl) {
  const candidates = await getBtiFrameCandidates(tabId, tabUrl);
  const ordered = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!seen.has(c.frameId)) { ordered.push(c.frameId); seen.add(c.frameId); }
  }
  // BTI iframe이 없고 탭 자체가 BTI 도메인이면 top frame만 시도
  if (!ordered.length && tabUrl && isInjectableBtiFrame(tabUrl)) {
    ordered.push(0);
  }
  return ordered;
}

async function fetchJsonInFrame(tabId, frameId, path) {
  const apiPath = path.startsWith('http') ? path : path;

  try {
    const viaContent = await chrome.tabs.sendMessage(
      tabId,
      { type: 'FETCH_BTI_JSON', url: apiPath.startsWith('http') ? apiPath : null, path: apiPath.startsWith('http') ? null : apiPath },
      { frameId }
    );
    if (viaContent?.ok && viaContent.data !== undefined) return viaContent.data;
  } catch (_) {}

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: async (p) => {
        try {
          const fetchUrl = p.startsWith('http') ? p : (location.origin.replace(/\/$/, '') + p);
          const res = await fetch(fetchUrl, { credentials: 'include' });
          if (!res.ok) return { error: String(res.status), url: fetchUrl };
          return await res.json();
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [apiPath]
    });
  } catch (e) {
    if (/Cannot access contents of url/i.test(e.message)) {
      throw new Error('inject 권한 없음 (비BTI iframe 건너뜀)');
    }
    throw e;
  }
  const result = results?.[0]?.result;
  if (!result || result.error) throw new Error(String(result?.error || '응답 없음') + (result?.url ? ` @ ${result.url}` : ''));
  return result;
}

// BTI API 호출 — BTI iframe 컨텍스트에서 fetch (iframe location.origin 사용)
async function fetchBtiViaTab(tabId, path, tabUrl) {
  let lastError = '응답 없음';

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000);
    const frameIds = await getAllFrameIdsForFetch(tabId, tabUrl);
    if (!frameIds.length) {
      lastError = 'BTI iframe 없음 — pbc00 BTI 화면(gamecode=19) 새로고침';
      continue;
    }

    for (const frameId of frameIds) {
      try {
        const data = await fetchJsonInFrame(tabId, frameId, path);
        console.log('[BTI] API OK', path.slice(0, 70), 'frame=', frameId);
        return data;
      } catch (e) {
        lastError = e.message;
        console.warn('[BTI] frame', frameId, '실패:', e.message);
      }
    }
  }

  throw new Error('BTI fetch 실패: ' + lastError);
}

// API 실패 시 BTI iframe 배당판 DOM 스캔 (content script PING으로 프레임 탐색)
async function scrapeBtiDomFromTab(tabId) {
  const frames = await getAllTabFrames(tabId);
  const events = [];

  let tryFrames = frames.filter((f) => isInjectableBtiFrame(f.url));
  if (!tryFrames.length) {
    const pingHits = await probeBtiFramesByPing(tabId, frames);
    tryFrames = pingHits.map((h) => ({ frameId: h.frameId, url: h.url }));
  }

  for (const frame of tryFrames) {
    try {
      const ping = await chrome.tabs.sendMessage(
        tabId,
        { type: 'PING' },
        { frameId: frame.frameId }
      );
      if (!ping || (!ping.buttonCount && !ping.hasSlip)) continue;

      const res = await chrome.tabs.sendMessage(
        tabId,
        { type: 'SCRAPE_BOARD' },
        { frameId: frame.frameId }
      );
      if (!res?.events?.length) continue;

      for (const ev of res.events) {
        events.push({
          id: ev.eventId || ev.eventText,
          home: ev.homeTeam,
          away: ev.awayTeam,
          sportId: 0,
          markets: ev.selections || [],
          _domFallback: true
        });
      }
    } catch (_) {}
  }

  if (events.length) console.log('[BTI] DOM 폴백:', events.length, '경기');
  return events;
}

async function pickBtiTab() {
  const tabs = await chrome.tabs.query({});
  let bestPbc = null;
  let bestDirect = null;

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (tab.url.includes('pbc00.com')) {
      const score = scorePbcBtiTab(tab.url);
      if (score >= 10 && (!bestPbc || score > bestPbc.score)) {
        bestPbc = { tab, score };
      }
      continue;
    }
    if (isDirectBtiTabUrl(tab.url)) {
      const score = tab.url.includes('fxf774.com') ? 8 : 5;
      if (!bestDirect || score > bestDirect.score) {
        bestDirect = { tab, score };
      }
    }
  }

  // pbc00 BTI 화면(gamecode=19) 최우선 — polymarket 등 다른 /sports 탭보다 우선
  if (bestPbc) return { id: bestPbc.tab.id, url: bestPbc.tab.url };
  if (bestDirect) return { id: bestDirect.tab.id, url: bestDirect.tab.url };
  return null;
}

// BTI 진단 (팝업 로그용)
async function diagBtiSearch() {
  const btiTab = await pickBtiTab();
  if (!btiTab) return { ok: false, error: 'BTI/pbc00 탭 없음' };

  const frames = await getAllTabFrames(btiTab.id);
  const candidates = await getBtiFrameCandidates(btiTab.id, btiTab.url);
  const iframeSrcs = await probeIframeSrcs(btiTab.id);
  const apiOrigin = await resolveBtiApiOrigin(btiTab.id, btiTab.url);

  let apiTest = { ok: false, error: 'not tried' };
  let prematchTest = { ok: false, error: 'not tried' };
  try {
    const data = await fetchBtiViaTab(
      btiTab.id,
      '/api/sportscenter/inplay/markets?language=KO&marketTypes=ML0&minimumOdds=1.1&draft=false',
      btiTab.url
    );
    apiTest = { ok: true, count: Array.isArray(data) ? data.length : 0, type: Array.isArray(data) ? 'array' : typeof data };
  } catch (e) {
    apiTest = { ok: false, error: e.message };
  }
  try {
    const pm = await fetchBtiViaTab(
      btiTab.id,
      '/api/eventlist/eu/sports/v2/1/upcoming/eventUpdates?marketTypeIds=ML0',
      btiTab.url
    );
    const rows = extractEventlistRows(pm);
    prematchTest = { ok: true, count: rows.length };
  } catch (e) {
    prematchTest = { ok: false, error: e.message };
  }

  const domEvents = await scrapeBtiDomFromTab(btiTab.id);
  const framePings = [];
  const pingFrames = frames.filter((f) => isInjectableUrl(f.url)).slice(0, 12);
  for (const frame of pingFrames) {
    try {
      const ping = await chrome.tabs.sendMessage(btiTab.id, { type: 'PING' }, { frameId: frame.frameId });
      if (ping) framePings.push({ frameId: frame.frameId, url: (frame.url || '').slice(0, 80), ...ping });
    } catch (_) {}
  }

  return {
    ok: true,
    tabUrl: btiTab.url,
    apiOrigin,
    iframeSrcs: iframeSrcs.slice(0, 5),
    frameCount: frames.length,
    candidates: candidates.slice(0, 5).map((c) => ({ frameId: c.frameId, url: c.url.slice(0, 80), score: c.score })),
    apiTest,
    prematchTest,
    domEventCount: domEvents.length,
    framePings
  };
}

// BTI 탭 ID + URL 찾기 (background.js에서 사용)
async function findBtiTabId() {
  const tab = await pickBtiTab();
  return tab ? tab.id : null;
}

// 피나클 탭 찾기 (content script 메시지 전송용)
async function findPinnacleTab() {
  const PIN_DOMAINS = ['pinnacle.com'];
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (PIN_DOMAINS.some(d => tab.url.includes(d))) return tab;
  }
  return null;
}

// 피나클 탭 content script에 FETCH_PREMATCH 메시지 전송 → 한국어 팀명 수집
async function getPinPrematchMatchupsKo(sportId) {
  try {
    const pinTab = await findPinnacleTab();
    if (!pinTab) {
      console.warn('[피나클] 피나클 탭 없음 - pinnacle.com을 열어주세요');
      return null; // null 반환 시 영문 팀명 폴백 사용
    }

    const result = await chrome.tabs.sendMessage(pinTab.id, {
      type: 'FETCH_PREMATCH',
      sportId
    });

    if (!result || !result.ok) {
      console.warn(`[피나클] FETCH_PREMATCH 실패 sportId=${sportId}:`, result?.error || '응답 없음');
      return null;
    }

    // matchup 배열로 변환
    return Object.entries(result.matchups).map(([id, m]) => ({
      id,
      home: m.home,
      away: m.away,
      league: m.league,
      sportId,
      startTime: m.startTime || null,
      odds: {} // 배당은 별도 API로 수집
    }));
  } catch(e) {
    console.error(`[피나클] getPinPrematchMatchupsKo sportId=${sportId} error:`, e.message);
    return null;
  }
}

// BTI 탭 ID + URL 함께 반환 (API base 결정용)
async function findBtiTab() {
  return pickBtiTab();
}

// SBOBET GraphQL API 호출 (토큰 필요)
async function fetchSboGql(operationName, variables, hash) {
  if (!sbobetToken) throw new Error('SBOBET 토큰 없음');
  const params = new URLSearchParams({
    operationName,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } })
  });
  const res = await fetch(`${sbobetApiBase}/api?${params}`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    credentials: 'omit'
  });
  const data = await res.json();
  if (data.errors) throw new Error('SBO API 오류: ' + JSON.stringify(data.errors));
  return data.data;
}

// SBOBET 스포츠명 매핑 (피나클 sportId → SBOBET sport 문자열)
const SBO_SPORT_MAP = {
  29: 'Soccer',
  3: 'Baseball',
  4: 'Basketball'
};

// SBOBET 라이브 경기 목록 가져오기
async function getSboLiveMatchups(sport) {
  try {
    const data = await fetchSboGql('EventsQuery', {
      query: {
        sport,
        filter: { presetFilter: 'Live', date: 'Today' },
        oddsCategory: 'All',
        timeZone: 'UTC__4',
        lang: 'KO_KR',
        token: sbobetToken
      }
    }, SBO_EVENTS_HASH);

    const events = data?.events || [];
    return events.filter(e => e.isLive).map(e => ({
      id: e.id,
      home: e.homeTeam?.teamName || '',
      away: e.awayTeam?.teamName || '',
      league: e.tournament?.tournamentName || '',
      sport
    }));
  } catch(e) {
    console.error('getSboLiveMatchups error:', e.message);
    return [];
  }
}

// SBOBET 경기 배당 가져오기
async function getSboOdds(eventId) {
  try {
    const data = await fetchSboGql('OddsQuery', {
      query: {
        id: eventId,
        filter: 'Live',
        marketFilter: 'NewBetType',
        oddsCategory: 'All',
        priceStyle: 'Euro',
        lang: 'KO_KR',
        token: sbobetToken
      }
    }, SBO_ODDS_HASH);

    return data?.event || data?.odds || data || null;
  } catch(e) {
    console.error('getSboOdds error:', e.message, 'eventId:', eventId);
    return null;
  }
}

// SBOBET 배당 파싱 (OddsQuery 응답 구조 기반)
function parseSboOdds(oddsData) {
  const result = { ml: [], ah: [], ou: [] };
  if (!oddsData) return result;

  // OddsQuery 응답 구조 탐색
  const markets = oddsData.markets || oddsData.marketGroups || [];
  for (const mg of markets) {
    const subMarkets = mg.markets || mg.subMarkets || [mg];
    for (const m of subMarkets) {
      const marketName = (m.name || m.marketName || m.type || '').toLowerCase();
      const selections = m.selections || m.odds || [];

      // ML (머니라인/승패)
      if (marketName.includes('money') || marketName.includes('머니') ||
          marketName.includes('1x2') || marketName.includes('win') ||
          marketName.includes('승패') || marketName.includes('ml')) {
        for (const s of selections) {
          const odds = parseFloat(s.price || s.odds || s.value || 0);
          const name = (s.name || s.team || s.selection || '').toLowerCase();
          if (odds > 1) {
            const side = name.includes('home') || name.includes('홈') ? 'home' :
                         name.includes('away') || name.includes('원정') ? 'away' : 'draw';
            if (side !== 'draw') result.ml.push({ side, odds, name: s.name || '' });
          }
        }
      }
      // AH (핸디캡)
      else if (marketName.includes('handicap') || marketName.includes('hdp') ||
               marketName.includes('핸디') || marketName.includes('ah')) {
        for (const s of selections) {
          const odds = parseFloat(s.price || s.odds || s.value || 0);
          const line = parseFloat(s.handicap || s.points || s.spread || 0);
          const name = (s.name || s.team || '').toLowerCase();
          if (odds > 1) {
            const side = name.includes('home') || name.includes('홈') ? 'h' : 'a';
            result.ah.push({ side, line, odds, name: s.name || '' });
          }
        }
      }
      // OU (오버언더)
      else if (marketName.includes('over') || marketName.includes('under') ||
               marketName.includes('오버') || marketName.includes('언더') ||
               marketName.includes('total') || marketName.includes('ou')) {
        for (const s of selections) {
          const odds = parseFloat(s.price || s.odds || s.value || 0);
          const line = parseFloat(s.points || s.total || s.line || 0);
          const name = (s.name || s.selection || '').toLowerCase();
          if (odds > 1) {
            const side = name.includes('under') || name.includes('언더') ? 'u' : 'o';
            result.ou.push({ side, line, odds, name: s.name || '' });
          }
        }
      }
    }
  }
  return result;
}

// 피나클 라이브 경기 목록 + 배당 가져오기
async function getPinLiveMatchups(sportId) {
  try {
    // 라이브 matchup 목록
    const matchups = await fetchPin(`/sports/${sportId}/matchups?isLive=true`);
    if (!Array.isArray(matchups) || matchups.length === 0) return [];

    // 배당 (highlighted straight)
    const markets = await fetchPin(`/sports/${sportId}/markets/highlighted/straight?primaryOnly=false`);
    if (!Array.isArray(markets)) return [];

    // matchupId → 배당 맵
    const oddsMap = {};
    for (const m of markets) {
      if (!oddsMap[m.matchupId]) oddsMap[m.matchupId] = {};
      const key = `${m.type}_${m.period}`;
      oddsMap[m.matchupId][key] = m;
    }

    return matchups
      .filter(mu => mu.isLive && mu.participants && mu.participants.length >= 2)
      .map(mu => ({
        id: mu.id,
        home: mu.participants.find(p => p.alignment === 'home')?.name || mu.participants[0]?.name,
        away: mu.participants.find(p => p.alignment === 'away')?.name || mu.participants[1]?.name,
        league: mu.league?.name || '',
        sportId,
        odds: oddsMap[mu.id] || {}
      }));
  } catch (e) {
    console.error('getPinLiveMatchups error:', e);
    return [];
  }
}

// 피나클 프리매치 경기 목록 + 배당 가져오기 (isLive=false)
async function getPinPrematchMatchups(sportId) {
  try {
    // 프리매치 matchup 목록 (isLive=false, 최대 500개)
    const matchups = await fetchPin(`/sports/${sportId}/matchups?isLive=false`);
    if (!Array.isArray(matchups) || matchups.length === 0) return [];

    // 배당 (highlighted straight - 프리매치 포함)
    const markets = await fetchPin(`/sports/${sportId}/markets/highlighted/straight?primaryOnly=false`);
    if (!Array.isArray(markets)) return [];

    // matchupId → 배당 맵
    const oddsMap = {};
    for (const m of markets) {
      if (!oddsMap[m.matchupId]) oddsMap[m.matchupId] = {};
      const key = `${m.type}_${m.period}`;
      oddsMap[m.matchupId][key] = m;
    }

    return matchups
      .filter(mu => !mu.isLive && mu.participants && mu.participants.length >= 2)
      .map(mu => ({
        id: mu.id,
        home: mu.participants.find(p => p.alignment === 'home')?.name || mu.participants[0]?.name,
        away: mu.participants.find(p => p.alignment === 'away')?.name || mu.participants[1]?.name,
        league: mu.league?.name || '',
        sportId,
        startTime: mu.startTime || null,
        odds: oddsMap[mu.id] || {}
      }));
  } catch (e) {
    console.error('getPinPrematchMatchups error:', e);
    return [];
  }
}

// BTI 라이브 경기 목록 + 배당 가져오기 (BTI 탭 executeScript 방식)
async function getBtiLiveMatchups(btiTabId) {
  let btiTabUrl = null;
  if (!btiTabId) {
    const btiTab = await findBtiTab();
    if (!btiTab) { console.warn('[BTI] 열린 BTI 탭 없음 - pbc00.com을 열어주세요'); return []; }
    btiTabId = btiTab.id;
    btiTabUrl = btiTab.url;
  } else {
    // tabId만 주어진 경우 URL 조회
    try {
      const tab = await chrome.tabs.get(btiTabId);
      btiTabUrl = tab.url;
    } catch(e) {}
  }
  const isFxf = btiTabUrl && btiTabUrl.includes('fxf774.com');
  try {
    let data = null;
    if (isFxf) {
      // fxf774.com: same-origin featured-matches API (라이브 필터링 포함)
      const fxfUrl = `/api/sportscenter/carousels/featured-matches/markets?language=KO&customerLevel=0&selectedOptionId=0&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`;
      data = await fetchBtiViaTab(btiTabId, fxfUrl, btiTabUrl).catch(() => null);
      // IsLive 필터링
      if (Array.isArray(data)) data = data.filter(ev => ev.markets && ev.markets.some(m => m.IsLive));
      if (!Array.isArray(data) || !data.length) {
        // 폴백: 필터 없이 전체 반환
        data = await fetchBtiViaTab(btiTabId, fxfUrl, btiTabUrl).catch(() => null);
      }
    } else {
      // 기존 BTI: inplay API 우선, fallback: featured-matches
      const liveUrl = `/api/sportscenter/inplay/markets?language=KO&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`;
      data = await fetchBtiViaTab(btiTabId, liveUrl, btiTabUrl).catch(() => null);
      if (!Array.isArray(data)) {
        const fallbackUrl = `/api/sportscenter/carousels/featured-matches/markets?language=KO&customerLevel=0&selectedOptionId=0&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`;
        data = await fetchBtiViaTab(btiTabId, fallbackUrl, btiTabUrl).catch(() => null);
      }
    }
    if (!Array.isArray(data)) { console.warn('[BTI] 응답이 배열 아님:', data); return await scrapeBtiDomFromTab(btiTabId); }

    const result = [];
    for (const event of data) {
      if (!event.id || !event.markets) continue;
      let home = '', away = '';
      const markets = event.markets;
      if (markets.length > 0) {
        const m0 = markets[0];
        if (m0.Selections) {
          const homeSel = m0.Selections.find(s => s.Side === 'H' || s.Side === 'Home');
          const awaySel = m0.Selections.find(s => s.Side === 'A' || s.Side === 'Away');
          if (homeSel) home = homeSel.Name || homeSel.TeamName || '';
          if (awaySel) away = awaySel.Name || awaySel.TeamName || '';
        }
        if (!home && m0.EventName) {
          const parts = m0.EventName.split(' vs ');
          if (parts.length >= 2) { home = parts[0].trim(); away = parts[1].trim(); }
        }
      }
      result.push({
        id: event.id,
        home,
        away,
        sportId: markets[0]?.SportId || 0,
        markets: event.markets
      });
    }
    return result;
  } catch (e) {
    console.error('getBtiLiveMatchups error:', e);
    return await scrapeBtiDomFromTab(btiTabId);
  }
}

// BTI eventlist 응답 행 추출 (포맷 변형 대응)
function extractEventlistRows(rawData) {
  if (!rawData) return [];
  if (Array.isArray(rawData)) return rawData;
  if (Array.isArray(rawData.data)) return rawData.data;
  if (Array.isArray(rawData.events)) return rawData.events;
  if (rawData.data && Array.isArray(rawData.data.events)) return rawData.data.events;
  return [];
}

function parseEventlistRow(row, btiSportId) {
  const r = Array.isArray(row) ? row : Object.values(row);
  if (!r || r.length < 8) return null;

  const eventId = r[0];
  if (!eventId) return null;
  if (r[12] === true || r[13] === true) return null;

  let home = '', away = '', homeKo = '', awayKo = '';
  const teams = r[8];
  if (Array.isArray(teams)) {
    for (const t of teams) {
      if (!Array.isArray(t) || t.length < 3) continue;
      const nameObj = t[1];
      const side = t[2];
      let nameEn = '', nameKo = '';
      if (nameObj && typeof nameObj === 'object') {
        nameEn = nameObj.EN || '';
        nameKo = nameObj.KO || '';
      } else {
        nameEn = String(nameObj || '');
      }
      const name = nameEn || nameKo;
      if (side === 'Home') { home = name; homeKo = nameKo; }
      else if (side === 'Away') { away = name; awayKo = nameKo; }
    }
  }

  if (!home && r[10]) {
    const parts = String(r[10]).split(' vs ');
    if (parts.length >= 2) { home = parts[0].trim(); away = parts[1].trim(); }
  }
  if (!home) return null;

  return {
    id: String(eventId),
    home, away, homeKo, awayKo,
    sportId: BTI_TO_PIN_SPORT[btiSportId] || 0,
    btiSportId,
    league: r[2] || '',
    markets: [],
    rawRow: r,
    startTime: r[11] || null
  };
}

async function fetchBtiFeaturedPrematch(btiTabId, btiTabUrl) {
  const path = `/api/sportscenter/carousels/featured-matches/markets?language=KO&customerLevel=0&selectedOptionId=0&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`;
  const data = await fetchBtiViaTab(btiTabId, path, btiTabUrl);
  if (!Array.isArray(data)) return [];

  const result = [];
  for (const event of data) {
    if (!event.id || !event.markets?.length) continue;
    if (event.markets.some((m) => m.IsLive)) continue;

    let home = '', away = '';
    const m0 = event.markets[0];
    if (m0.Selections) {
      const homeSel = m0.Selections.find((s) => s.Side === 'H' || s.Side === 'Home');
      const awaySel = m0.Selections.find((s) => s.Side === 'A' || s.Side === 'Away');
      if (homeSel) home = homeSel.Name || homeSel.TeamName || '';
      if (awaySel) away = awaySel.Name || awaySel.TeamName || '';
    }
    if (!home && m0.EventName) {
      const parts = m0.EventName.split(' vs ');
      if (parts.length >= 2) { home = parts[0].trim(); away = parts[1].trim(); }
    }
    if (!home) continue;

    const btiSportId = m0.SportId || 0;
    result.push({
      id: String(event.id),
      home, away,
      sportId: BTI_TO_PIN_SPORT[btiSportId] || 0,
      btiSportId,
      league: m0.LeagueName || '',
      markets: event.markets,
      startTime: event.StartDate || null,
      _source: 'featured-matches'
    });
  }
  return result;
}

let lastBtiPrematchDiag = { errors: [], sources: {}, apiOrigin: '' };

// BTI 프리매치 전체 경기 목록 + 배당 가져오기
async function getBtiPrematchMatchups(btiTabId, btiTabUrl) {
  const BTI_SPORT_IDS = [1, 6, 7, 59, 2];
  const MARKET_TYPE_MAP = {
    1:  'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619%2CML167',
    6:  'ML0%2COU0%2CHC0%2CML619%2COU619%2CHC619',
    7:  'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619',
    59: 'ML587%2CML0%2COU0%2CHC0%2CML619%2COU619%2CHC619',
    2:  'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619'
  };

  const allEvents = [];
  const errors = [];
  const sources = {};

  try {
    lastBtiPrematchDiag.apiOrigin = await resolveBtiApiOrigin(btiTabId, btiTabUrl);
  } catch (_) {}

  for (const sportId of BTI_SPORT_IDS) {
    const paths = [
      `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?becomeLiveIn=3&isAllMarkets=true&marketTypeIds=${MARKET_TYPE_MAP[sportId] || 'HC0%2COU0%2CML0'}`,
      `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?isAllMarkets=false&marketTypeIds=ML0%2COU0%2CHC0`,
      `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?marketTypeIds=ML0`
    ];
    let sportCount = 0;
    for (const url of paths) {
      try {
        const rawData = await fetchBtiViaTab(btiTabId, url, btiTabUrl);
        const rows = extractEventlistRows(rawData);
        for (const row of rows) {
          const ev = parseEventlistRow(row, sportId);
          if (ev) { allEvents.push(ev); sportCount++; }
        }
        if (sportCount > 0) {
          sources[`sport${sportId}`] = `eventlist:${sportCount}`;
          break;
        }
      } catch (e) {
        errors.push(`sport${sportId}: ${e.message}`);
      }
    }
  }

  if (!allEvents.length) {
    try {
      const featured = await fetchBtiFeaturedPrematch(btiTabId, btiTabUrl);
      if (featured.length) {
        allEvents.push(...featured);
        sources.featured = featured.length;
        console.log('[BTI] 프리매치 featured-matches 폴백:', featured.length);
      }
    } catch (e) {
      errors.push(`featured: ${e.message}`);
    }
  }

  if (!allEvents.length) {
    const domEvents = await scrapeBtiDomFromTab(btiTabId);
    if (domEvents.length) {
      allEvents.push(...domEvents);
      sources.dom = domEvents.length;
      console.warn('[BTI] 프리매치 API 0건 — DOM 폴백:', domEvents.length);
    }
  }

  lastBtiPrematchDiag = { errors: errors.slice(0, 8), sources, apiOrigin: lastBtiPrematchDiag.apiOrigin };
  console.log('[BTI] 프리매치 수집:', allEvents.length, lastBtiPrematchDiag);
  return allEvents;
}

// 프리매치 양방 기회 탐색 (피나클 vs BTI)
function findPrematchArbitrageOpportunities(pinMatchups, btiMatchups, sportId) {
  const opportunities = [];
  const isSoccer = sportId === 29;
  const isBaseball = sportId === 3;
  const isBasketball = sportId === 4;
  const isEsports = sportId === 12;
  const isTennis = sportId === 33;
  const sportLabel = PIN_SPORT_LABEL[sportId] || '기타';

  for (const pin of pinMatchups) {
    // BTI에서 동일 경기 찾기 (pinSportId 일치 + 팀명 매칭)
    // BTI가 EN 키를 제공하면 영문 비교, 없으면 KO로 폴백
    const btiMatch = btiMatchups.find(b => {
      if (b.sportId !== sportId) return false;
      // EN 키 있으면 영문 비교
      const bHome = b.home; // EN 우선으로 이미 설정됨
      const bAway = b.away;
      return (teamMatch(pin.home, bHome) && teamMatch(pin.away, bAway)) ||
             (teamMatch(pin.home, bAway) && teamMatch(pin.away, bHome));
    });
    if (!btiMatch) continue;

    const pinOdds = parsePinOdds(pin.odds, sportId);
    const btiOdds = btiMatch.rawRow ? parseBtiOddsFromRow(btiMatch.rawRow) : parseBtiOdds(btiMatch.markets);

    // ML (축구 제외 전 종목)
    if (!isSoccer) {
      for (const pml of pinOdds.ml.filter(p => p.period === 0)) {
        for (const bml of btiOdds.ml) {
          const isOpposite = (pml.side === 'home' && (bml.side === 'A' || bml.side === 'Away')) ||
                             (pml.side === 'away' && (bml.side === 'H' || bml.side === 'Home'));
          if (!isOpposite) continue;
          const profit = calcArb(pml.odds, bml.odds);
          if (profit !== null && profit >= 0) {
            opportunities.push({
              sport: sportLabel, market: 'ML', period: 'ft',
              home: pin.home, away: pin.away, league: pin.league,
              pinSide: pml.side, pinOdds: pml.odds,
              btiSide: bml.side, btiOdds: bml.odds,
              profit: profit.toFixed(2),
              pinMatchupId: pin.id, btiEventId: btiMatch.id,
              startTime: pin.startTime, isPrematch: true
            });
          }
        }
      }
    }

    // AH 핸디코 (0.5 단위, 최대 ±3, 0.25/0.75 제외)
    const AH_LINES = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    for (const line of AH_LINES) {
      const pinAh = pinOdds.ah.filter(p => p.period === 0 && Math.abs(Math.abs(p.line) - line) < 0.1);
      const btiAh = btiOdds.ah.filter(b => Math.abs(Math.abs(b.line) - line) < 0.1);
      for (const pah of pinAh) {
        for (const bah of btiAh) {
          const isOpposite = (pah.side === 'home' && (bah.side === 'A' || bah.side === 'Away')) ||
                             (pah.side === 'away' && (bah.side === 'H' || bah.side === 'Home'));
          if (!isOpposite) continue;
          const profit = calcArb(pah.odds, bah.odds);
          if (profit !== null && profit >= 0) {
            opportunities.push({
              sport: sportLabel, market: `AH${pah.line >= 0 ? '+' : ''}${pah.line}`, period: 'ft',
              home: pin.home, away: pin.away, league: pin.league,
              pinSide: pah.side, pinOdds: pah.odds,
              btiSide: bah.side, btiOdds: bah.odds,
              profit: profit.toFixed(2),
              pinMatchupId: pin.id, btiEventId: btiMatch.id,
              startTime: pin.startTime, isPrematch: true
            });
          }
        }
      }
    }

    // OU 언오버 (축구 제외 전 종목, 0.5 단위)
    if (!isSoccer) {
      const OU_LINES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
      for (const line of OU_LINES) {
        const pinOu = pinOdds.ou.filter(p => p.period === 0 && Math.abs(p.line - line) < 0.1);
        const btiOu = btiOdds.ou.filter(b => Math.abs(b.line - line) < 0.1);
        for (const pou of pinOu) {
          for (const bou of btiOu) {
            const isOpposite = (pou.side === 'over' && (bou.side === 'U' || bou.side === 'Under')) ||
                               (pou.side === 'under' && (bou.side === 'O' || bou.side === 'Over'));
            if (!isOpposite) continue;
            const profit = calcArb(pou.odds, bou.odds);
            if (profit !== null && profit >= 0) {
              opportunities.push({
                sport: sportLabel, market: `OU${line}`, period: 'ft',
                home: pin.home, away: pin.away, league: pin.league,
                pinSide: pou.side, pinOdds: pou.odds,
                btiSide: bou.side, btiOdds: bou.odds,
                profit: profit.toFixed(2),
                pinMatchupId: pin.id, btiEventId: btiMatch.id,
                startTime: pin.startTime, isPrematch: true
              });
            }
          }
        }
      }
    }
  }

  return opportunities.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
}

// BTI 배당 파싱 - rawRow[19] 배열 구조 (eventlist API 응답)
// 마켓 구조: [marketId, marketName, marketName2, [typeId, ...], eventId, leagueId, sportId, selections, ...]
// 셀렉션 구조: [selId, {KO:name}, {KO:teamName}, isSuspended, price, isRemoved, [odds...], order, ..., {KO:side}, ..., line, ...]
function parseBtiOddsFromRow(rawRow) {
  const result = { ml: [], ah: [], ou: [] };
  if (!rawRow) return result;
  const markets = rawRow[19];
  if (!Array.isArray(markets)) return result;

  for (const m of markets) {
    if (!Array.isArray(m)) continue;
    const typeArr = m[3]; // [typeId, typeName, ...]
    const typeId = Array.isArray(typeArr) ? String(typeArr[0] || '') : String(m[0] || '');
    const sels = m[7]; // selections 배열
    if (!Array.isArray(sels)) continue;

    for (const s of sels) {
      if (!Array.isArray(s) || s.length < 5) continue;
      const isSuspended = s[3];
      const isRemoved = s[5];
      if (isSuspended || isRemoved) continue;

      const price = parseFloat(s[4]) || 0;
      if (price <= 1) continue;

      // side: s[9] = {KO:'Home'} 또는 {KO:'Away'} 또는 {KO:'동점'}
      const sideObj = s[9];
      const sideKo = (sideObj && typeof sideObj === 'object') ? (sideObj.KO || '') : String(sideObj || '');
      const side = sideKo.includes('Home') || sideKo.includes('홈') ? 'H' :
                   sideKo.includes('Away') || sideKo.includes('원정') ? 'A' :
                   sideKo.includes('동점') || sideKo.includes('Draw') ? 'D' : '';

      // 라인: s[13] (HC/OU 기준점)
      const line = parseFloat(s[13]) || 0;

      // 팀명: s[1] = {KO:'팀명'}
      const nameObj = s[1];
      const name = (nameObj && typeof nameObj === 'object') ? (nameObj.KO || '') : String(nameObj || '');

      if (typeId.startsWith('ML')) {
        if (side === 'D') continue; // 무승부 제외
        if (side) result.ml.push({ side, odds: price, name });
      } else if (typeId.startsWith('HC')) {
        if (side) result.ah.push({ side, line, odds: price, name });
      } else if (typeId.startsWith('OU')) {
        // 오버/언더 판별: 이름에서
        const isOver = name.includes('오버') || name.includes('Over');
        const isUnder = name.includes('언더') || name.includes('Under');
        if (isOver) result.ou.push({ side: 'O', line, odds: price, name });
        else if (isUnder) result.ou.push({ side: 'U', line, odds: price, name });
      }
    }
  }
  return result;
}

// BTI 배당 파싱 (마켓 타입별)
function parseBtiOdds(markets) {
  const result = { ml: [], ah: [], ou: [] };
  for (const m of markets) {
    const typeId = m.MarketType?._id || m._id || '';
    const sels = m.Selections || [];
    if (typeId.startsWith('ML')) {
      for (const s of sels) {
        const side = s.Side || '';
        const odds = parseFloat(s.Price) || 0;
        if (odds > 1) result.ml.push({ side, odds, name: s.Name || s.TeamName || '' });
      }
    } else if (typeId.startsWith('HC')) {
      for (const s of sels) {
        const side = s.Side || '';
        const line = parseFloat(s.Points || s.Handicap || 0);
        const odds = parseFloat(s.Price) || 0;
        if (odds > 1) result.ah.push({ side, line, odds, name: s.Name || s.TeamName || '' });
      }
    } else if (typeId.startsWith('OU')) {
      for (const s of sels) {
        const side = s.Side || '';
        const line = parseFloat(s.Points || s.Total || 0);
        const odds = parseFloat(s.Price) || 0;
        if (odds > 1) result.ou.push({ side, line, odds, name: s.Name || s.TeamName || '' });
      }
    }
  }
  return result;
}

// 피나클 배당 파싱
function parsePinOdds(oddsMap, sportId) {
  const result = { ml: [], ah: [], ou: [] };
  for (const [key, m] of Object.entries(oddsMap)) {
    if (!m.prices) continue;
    const prices = m.prices;
    if (m.type === 'moneyline') {
      for (const p of prices) {
        if (p.designation === 'draw') continue; // 무승부 제외
        result.ml.push({
          side: p.designation,
          odds: usOddsToDecimal(p.price),
          period: m.period
        });
      }
    } else if (m.type === 'spread') {
      for (const p of prices) {
        result.ah.push({
          side: p.designation,
          line: p.handicap || 0,
          odds: usOddsToDecimal(p.price),
          period: m.period
        });
      }
    } else if (m.type === 'total') {
      for (const p of prices) {
        result.ou.push({
          side: p.designation, // over/under
          line: m.prices[0]?.points || p.points || 0,
          odds: usOddsToDecimal(p.price),
          period: m.period
        });
      }
    }
  }
  return result;
}

// 양방 기회 계산
function calcArb(odds1, odds2) {
  if (odds1 <= 1 || odds2 <= 1) return null;
  const margin = (1 / odds1) + (1 / odds2);
  if (margin >= 1) return null;
  const profit = ((1 / margin) - 1) * 100;
  return profit;
}

// 경기 매칭 및 양방 기회 탐색 (피나클 vs BTI)
function findArbitrageOpportunities(pinMatchups, btiMatchups, sportId) {
  const opportunities = [];

  for (const pin of pinMatchups) {
    const btiMatch = btiMatchups.find(b => {
      return (teamMatch(pin.home, b.home) && teamMatch(pin.away, b.away)) ||
             (teamMatch(pin.home, b.away) && teamMatch(pin.away, b.home));
    });
    if (!btiMatch) continue;

    const pinOdds = parsePinOdds(pin.odds, sportId);
    const btiOdds = parseBtiOdds(btiMatch.markets);

    const isSoccer = sportId === 29;
    const isBaseball = sportId === 3;
    const isBasketball = sportId === 4;

    // ML (야구, 농구만)
    if (!isSoccer) {
      for (const pml of pinOdds.ml) {
        for (const bml of btiOdds.ml) {
          const isOpposite = (pml.side === 'home' && (bml.side === 'A' || bml.side === 'Away')) ||
                             (pml.side === 'away' && (bml.side === 'H' || bml.side === 'Home'));
          if (!isOpposite) continue;
          const profit = calcArb(pml.odds, bml.odds);
          if (profit !== null && profit >= 0) {
            opportunities.push({
              sport: sportId === 3 ? '야구' : '농구',
              market: 'ML', opponent: 'BTI',
              home: pin.home, away: pin.away, league: pin.league,
              pinSide: pml.side, pinOdds: pml.odds,
              btiSide: bml.side, btiOdds: bml.odds,
              profit: profit.toFixed(2),
              pinMatchupId: pin.id, btiEventId: btiMatch.id
            });
          }
        }
      }
    }

    // AH 핸디캡 (0.5 단위, 최대 ±3)
    const AH_LINES = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    for (const line of AH_LINES) {
      for (const pah of pinOdds.ah.filter(p => Math.abs(Math.abs(p.line) - line) < 0.1)) {
        for (const bah of btiOdds.ah.filter(b => Math.abs(Math.abs(b.line) - line) < 0.1)) {
          const isOpposite = (pah.side === 'home' && (bah.side === 'A' || bah.side === 'Away')) ||
                             (pah.side === 'away' && (bah.side === 'H' || bah.side === 'Home'));
          if (!isOpposite) continue;
          const profit = calcArb(pah.odds, bah.odds);
          if (profit !== null && profit >= 0) {
            opportunities.push({
              sport: isSoccer ? '축구' : isBaseball ? '야구' : '농구',
              market: `AH${pah.line > 0 ? '+' : ''}${pah.line}`, opponent: 'BTI',
              home: pin.home, away: pin.away, league: pin.league,
              pinSide: pah.side, pinOdds: pah.odds,
              btiSide: bah.side, btiOdds: bah.odds,
              profit: profit.toFixed(2),
              pinMatchupId: pin.id, btiEventId: btiMatch.id
            });
          }
        }
      }
    }

    // OU 오버언더 (0.5 단위, 최대 3)
    const OU_LINES = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    for (const line of OU_LINES) {
      for (const pou of pinOdds.ou.filter(p => Math.abs(p.line - line) < 0.1)) {
        for (const bou of btiOdds.ou.filter(b => Math.abs(b.line - line) < 0.1)) {
          const isOpposite = (pou.side === 'over' && (bou.side === 'U' || bou.side === 'Under')) ||
                             (pou.side === 'under' && (bou.side === 'O' || bou.side === 'Over'));
          if (!isOpposite) continue;
          const profit = calcArb(pou.odds, bou.odds);
          if (profit !== null && profit >= 0) {
            opportunities.push({
              sport: isSoccer ? '축구' : isBaseball ? '야구' : '농구',
              market: `OU${line}`, opponent: 'BTI',
              home: pin.home, away: pin.away, league: pin.league,
              pinSide: pou.side, pinOdds: pou.odds,
              btiSide: bou.side, btiOdds: bou.odds,
              profit: profit.toFixed(2),
              pinMatchupId: pin.id, btiEventId: btiMatch.id
            });
          }
        }
      }
    }
  }

  return opportunities.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
}

// 경기 매칭 및 양방 기회 탐색 (피나클 vs SBOBET)
async function findArbOpportunitiesSbo(pinMatchups, sboMatchups, sportId) {
  const opportunities = [];
  const isSoccer = sportId === 29;
  const isBaseball = sportId === 3;
  const isBasketball = sportId === 4;

  for (const pin of pinMatchups) {
    const sboMatch = sboMatchups.find(s => {
      return (teamMatch(pin.home, s.home) && teamMatch(pin.away, s.away)) ||
             (teamMatch(pin.home, s.away) && teamMatch(pin.away, s.home));
    });
    if (!sboMatch) continue;

    // SBOBET 배당 가져오기
    const sboOddsRaw = await getSboOdds(sboMatch.id);
    if (!sboOddsRaw) continue;

    const pinOdds = parsePinOdds(pin.odds, sportId);
    const sboOdds = parseSboOdds(sboOddsRaw);

    // ML (야구, 농구만)
    if (!isSoccer) {
      for (const pml of pinOdds.ml) {
        for (const sml of sboOdds.ml) {
          const isOpposite = (pml.side === 'home' && sml.side === 'away') ||
                             (pml.side === 'away' && sml.side === 'home');
          if (!isOpposite) continue;
          const profit = calcArb(pml.odds, sml.odds);
          if (profit !== null && profit >= 0) {
            opportunities.push({
              sport: isBaseball ? '야구' : '농구',
              market: 'ML', opponent: 'SBO',
              home: pin.home, away: pin.away, league: pin.league,
              pinSide: pml.side, pinOdds: pml.odds,
              btiSide: sml.side, btiOdds: sml.odds,
              profit: profit.toFixed(2),
              pinMatchupId: pin.id, sboEventId: sboMatch.id
            });
          }
        }
      }
    }

    // AH
    const AH_LINES = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    for (const line of AH_LINES) {
      for (const pah of pinOdds.ah.filter(p => Math.abs(Math.abs(p.line) - line) < 0.1)) {
        for (const sah of sboOdds.ah.filter(s => Math.abs(Math.abs(s.line) - line) < 0.1)) {
          const isOpposite = (pah.side === 'home' && sah.side === 'a') ||
                             (pah.side === 'away' && sah.side === 'h');
          if (!isOpposite) continue;
          const profit = calcArb(pah.odds, sah.odds);
          if (profit !== null && profit >= 0) {
            opportunities.push({
              sport: isSoccer ? '축구' : isBaseball ? '야구' : '농구',
              market: `AH${pah.line > 0 ? '+' : ''}${pah.line}`, opponent: 'SBO',
              home: pin.home, away: pin.away, league: pin.league,
              pinSide: pah.side, pinOdds: pah.odds,
              btiSide: sah.side, btiOdds: sah.odds,
              profit: profit.toFixed(2),
              pinMatchupId: pin.id, sboEventId: sboMatch.id
            });
          }
        }
      }
    }

    // OU
    const OU_LINES = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    for (const line of OU_LINES) {
      for (const pou of pinOdds.ou.filter(p => Math.abs(p.line - line) < 0.1)) {
        for (const sou of sboOdds.ou.filter(s => Math.abs(s.line - line) < 0.1)) {
          const isOpposite = (pou.side === 'over' && sou.side === 'u') ||
                             (pou.side === 'under' && sou.side === 'o');
          if (!isOpposite) continue;
          const profit = calcArb(pou.odds, sou.odds);
          if (profit !== null && profit >= 0) {
            opportunities.push({
              sport: isSoccer ? '축구' : isBaseball ? '야구' : '농구',
              market: `OU${line}`, opponent: 'SBO',
              home: pin.home, away: pin.away, league: pin.league,
              pinSide: pou.side, pinOdds: pou.odds,
              btiSide: sou.side, btiOdds: sou.odds,
              profit: profit.toFixed(2),
              pinMatchupId: pin.id, sboEventId: sboMatch.id
            });
          }
        }
      }
    }
  }

  return opportunities.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
}

// 자동 서치 상태
let searchRunning = false;
let searchInterval = null;
let searchMode = 'bti'; // 'bti' | 'sbo' | 'both'

async function runSearchOnce() {
  const hasSboToken = !!sbobetToken;
  const useBti = (searchMode === 'bti' || searchMode === 'both');
  const useSbo = (searchMode === 'sbo' || searchMode === 'both');

  // BTI 탭 ID 선택적 탐색
  let btiTabId = null;
  if (useBti) {
    btiTabId = await findBtiTabId();
    if (!btiTabId) console.warn('[BTI] 탭 없음 - pbc00.com을 열어주세요');
  }

  // 피나클 라이브 경기 조회 (항상)
  const [pinSoccer, pinBaseball, pinBasketball] = await Promise.all([
    getPinLiveMatchups(PIN_SPORT_IDS.soccer),
    getPinLiveMatchups(PIN_SPORT_IDS.baseball),
    getPinLiveMatchups(PIN_SPORT_IDS.basketball)
  ]);

  // BTI 양방 탐색 (bti 또는 both 모드일 때)
  let btiAll = [];
  let btiOpps = [];
  if (useBti && btiTabId) {
    btiAll = await getBtiLiveMatchups(btiTabId);
    btiOpps = [
      ...findArbitrageOpportunities(pinSoccer, btiAll, 29),
      ...findArbitrageOpportunities(pinBaseball, btiAll, 3),
      ...findArbitrageOpportunities(pinBasketball, btiAll, 4)
    ];
  }

  // SBOBET 양방 탐색 (토큰 있을 때만)
  let sboOpps = [];
  let sboStats = { sboSoccer: 0, sboBaseball: 0, sboBasketball: 0 };
  if (hasSboToken && useSbo) {
    const [sboSoccer, sboBaseball, sboBasketball] = await Promise.all([
      getSboLiveMatchups('Soccer'),
      getSboLiveMatchups('Baseball'),
      getSboLiveMatchups('Basketball')
    ]);
    sboStats = {
      sboSoccer: sboSoccer.length,
      sboBaseball: sboBaseball.length,
      sboBasketball: sboBasketball.length
    };

    const [sboOppsSoccer, sboOppsBaseball, sboOppsBasketball] = await Promise.all([
      findArbOpportunitiesSbo(pinSoccer, sboSoccer, 29),
      findArbOpportunitiesSbo(pinBaseball, sboBaseball, 3),
      findArbOpportunitiesSbo(pinBasketball, sboBasketball, 4)
    ]);
    sboOpps = [...sboOppsSoccer, ...sboOppsBaseball, ...sboOppsBasketball];
  }

  const allOpps = [...btiOpps, ...sboOpps]
    .sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));

  return {
    opportunities: allOpps,
    stats: {
      pinSoccer: pinSoccer.length,
      pinBaseball: pinBaseball.length,
      pinBasketball: pinBasketball.length,
      btiTotal: btiAll.length,
      btiTabFound: !!btiTabId,
      matched: allOpps.length,
      hasSboToken,
      ...sboStats
    }
  };
}

// 팝업으로 메시지 브로드캐스트
function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// 프리매치 서치 실행 (종목별 피나클 + BTI 전체 수집)
let prematchSearchRunning = false;
let prematchSearchInterval = null;

async function runPrematchSearchOnce() {
  const btiTab = await findBtiTab();
  if (!btiTab) {
    return { opportunities: [], stats: { error: 'BTI 탭 미발견 - pbc00.com을 열어주세요', btiTabFound: false } };
  }

  const pinTab = await findPinnacleTab();
  // 피나클 탭 없어도 API 영문 폴백으로 진행 (차단하지 않음)

  const SPORT_IDS = [29, 3, 4, 12, 33];

  // 1단계: 한국어 팀명 수집 (피나클 탭 경유)
  const koMatchupResults = await Promise.all(SPORT_IDS.map(sid => getPinPrematchMatchupsKo(sid)));

  // 2단계: 배당 수집 (background에서 직접 API 호출)
  const oddsResults = await Promise.all(SPORT_IDS.map(async sid => {
    try {
      const markets = await fetchPin(`/sports/${sid}/markets/highlighted/straight?primaryOnly=false`);
      if (!Array.isArray(markets)) return {};
      const oddsMap = {};
      for (const m of markets) {
        if (!oddsMap[m.matchupId]) oddsMap[m.matchupId] = {};
        const key = `${m.type}_${m.period}`;
        oddsMap[m.matchupId][key] = m;
      }
      return oddsMap;
    } catch(e) { return {}; }
  }));

  // 한국어 팀명이 없으면 영문 팀명 폴백
  const pinMatchupsBySport = {};
  for (let i = 0; i < SPORT_IDS.length; i++) {
    const sid = SPORT_IDS[i];
    const koMatchups = koMatchupResults[i]; // null이면 영문 폴백
    const oddsMap = oddsResults[i];

    if (koMatchups !== null) {
      // 한국어 팀명 + 배당 결합
      pinMatchupsBySport[sid] = koMatchups.map(mu => ({
        ...mu,
        odds: oddsMap[mu.id] || {}
      }));
    } else {
      // 피나클 탭 없음: 영문 팀명으로 폴백
      try {
        const matchups = await fetchPin(`/sports/${sid}/matchups?isLive=false`);
        pinMatchupsBySport[sid] = Array.isArray(matchups)
          ? matchups.filter(mu => !mu.isLive && mu.participants?.length >= 2).map(mu => ({
              id: mu.id,
              home: mu.participants.find(p => p.alignment === 'home')?.name || mu.participants[0]?.name || '',
              away: mu.participants.find(p => p.alignment === 'away')?.name || mu.participants[1]?.name || '',
              league: mu.league?.name || '',
              sportId: sid,
              startTime: mu.startTime || null,
              odds: oddsMap[mu.id] || {}
            }))
          : [];
      } catch(e) { pinMatchupsBySport[sid] = []; }
    }
  }

  const pinSoccer = pinMatchupsBySport[29] || [];
  const pinBaseball = pinMatchupsBySport[3] || [];
  const pinBasketball = pinMatchupsBySport[4] || [];
  const pinEsports = pinMatchupsBySport[12] || [];
  const pinTennis = pinMatchupsBySport[33] || [];

  const btiAll = await getBtiPrematchMatchups(btiTab.id, btiTab.url);
  let btiApiOrigin = lastBtiPrematchDiag.apiOrigin || '';
  try {
    if (!btiApiOrigin) btiApiOrigin = await resolveBtiApiOrigin(btiTab.id, btiTab.url);
  } catch (_) {}

  // 양방 기회 탐색
  const allOpps = [
    ...findPrematchArbitrageOpportunities(pinSoccer, btiAll, 29),
    ...findPrematchArbitrageOpportunities(pinBaseball, btiAll, 3),
    ...findPrematchArbitrageOpportunities(pinBasketball, btiAll, 4),
    ...findPrematchArbitrageOpportunities(pinEsports, btiAll, 12),
    ...findPrematchArbitrageOpportunities(pinTennis, btiAll, 33)
  ].sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));

  return {
    opportunities: allOpps,
    stats: {
      pinSoccer: pinSoccer.length,
      pinBaseball: pinBaseball.length,
      pinBasketball: pinBasketball.length,
      pinEsports: pinEsports.length,
      pinTennis: pinTennis.length,
      pinTotal: pinSoccer.length + pinBaseball.length + pinBasketball.length + pinEsports.length + pinTennis.length,
      btiTotal: btiAll.length,
      btiTabFound: true,
      pinTabFound: !!pinTab,
      btiApiOrigin,
      btiDomFallback: btiAll.some((e) => e._domFallback),
      btiFetchErrors: lastBtiPrematchDiag.errors,
      btiFetchSources: lastBtiPrematchDiag.sources,
      matched: allOpps.length
    }
  };
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[양방봇] 확장프로그램 설치됨');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 팝업을 독립 창으로 열기
  if (msg.type === 'OPEN_WINDOW') {
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 400,
      height: 800,
      focused: true
    }, win => sendResponse({ windowId: win.id }));
    return true;
  }

  // SBOBET 토큰 등록 (content script에서 전달)
  if (msg.type === 'SBOBET_TOKEN') {
    if (msg.token) {
      sbobetToken = msg.token;
      if (msg.apiBase) sbobetApiBase = msg.apiBase;
      console.log('[양방봇] SBOBET 토큰 등록됨:', msg.hostname);
    }
    return false;
  }

  // SBOBET 토큰 상태 확인
  if (msg.type === 'GET_SBO_TOKEN_STATUS') {
    sendResponse({ hasToken: !!sbobetToken, apiBase: sbobetApiBase });
    return true;
  }

  // 서치 모드 설정
  if (msg.type === 'SET_SEARCH_MODE') {
    searchMode = msg.mode || 'bti';
    sendResponse({ ok: true, mode: searchMode });
    return true;
  }

  // 피나클 API fetch (CORS 우회)
  if (msg.type === 'FETCH_PIN_API') {
    fetch(msg.url, {
      headers: { 'X-Api-Key': PIN_API_KEY },
      credentials: 'omit'
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // BTI API fetch — pbc00 탭 iframe 경유 (쿠키 포함)
  if (msg.type === 'FETCH_BTI_API') {
    (async () => {
      try {
        const btiTab = await findBtiTab();
        if (!btiTab) {
          sendResponse({ ok: false, error: 'pbc00/BTI 탭 없음' });
          return;
        }
        let path = msg.path || '';
        if (!path && msg.url) {
          try { path = new URL(msg.url).pathname + new URL(msg.url).search; } catch (_) { path = msg.url; }
        }
        const data = await fetchBtiViaTab(btiTab.id, path, btiTab.url);
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // BTI 서치 진단
  if (msg.type === 'DIAG_BTI_SEARCH') {
    diagBtiSearch().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // SBOBET API fetch (CORS 우회 + 토큰 주입)
  if (msg.type === 'FETCH_SBO_API') {
    if (!sbobetToken) {
      sendResponse({ ok: false, error: 'SBOBET 토큰 없음 - wg88ss.com SBOBET 페이지를 먼저 열어주세요' });
      return true;
    }
    const params = new URLSearchParams({
      operationName: msg.operationName,
      variables: JSON.stringify({ ...msg.variables, query: { ...msg.variables?.query, token: sbobetToken } }),
      extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: msg.hash } })
    });
    fetch(`${sbobetApiBase}/api?${params}`, {
      headers: { 'Accept': 'application/json' },
      credentials: 'omit'
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // 자동 서치 시작 (1회 즉시 실행 후 결과 반환)
  if (msg.type === 'START_SEARCH') {
    if (msg.mode) searchMode = msg.mode;
    if (searchRunning) { sendResponse({ ok: true, msg: '이미 실행 중' }); return true; }
    searchRunning = true;
    runSearchOnce().then(result => {
      sendResponse({ ok: true, result });
      if (searchRunning) {
        searchInterval = setInterval(() => {
          runSearchOnce().then(r => broadcastToPopup({ type: 'SEARCH_RESULT', ...r }));
        }, 1000);
      }
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // 자동 서치 정지
  if (msg.type === 'STOP_SEARCH') {
    searchRunning = false;
    if (searchInterval) { clearInterval(searchInterval); searchInterval = null; }
    sendResponse({ ok: true });
    return true;
  }

  // 즉시 1회 서치
  if (msg.type === 'RUN_SEARCH_ONCE') {
    if (msg.mode) searchMode = msg.mode;
    runSearchOnce().then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // 프리매치 서치 시작
  if (msg.type === 'START_PREMATCH_SEARCH') {
    if (prematchSearchRunning) { sendResponse({ ok: true, msg: '이미 실행 중' }); return true; }
    prematchSearchRunning = true;
    runPrematchSearchOnce().then(result => {
      sendResponse({ ok: true, result });
      if (prematchSearchRunning) {
        prematchSearchInterval = setInterval(() => {
          runPrematchSearchOnce().then(r => broadcastToPopup({ type: 'PREMATCH_SEARCH_RESULT', ...r }));
        }, 30000); // 30초마다 갱신
      }
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // 프리매치 서치 정지
  if (msg.type === 'STOP_PREMATCH_SEARCH') {
    prematchSearchRunning = false;
    if (prematchSearchInterval) { clearInterval(prematchSearchInterval); prematchSearchInterval = null; }
    sendResponse({ ok: true });
    return true;
  }

  // 프리매치 1회 실행
  if (msg.type === 'RUN_PREMATCH_ONCE') {
    runPrematchSearchOnce().then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // 팀명 진단 - 피나클/BTI 실제 팀명 샘플 10개씩 비교
  if (msg.type === 'DIAG_TEAM_NAMES') {
    (async () => {
      try {
        const btiTab = await findBtiTab();
        if (!btiTab) return sendResponse({ error: 'BTI 탭 없음' });

        // 피나클 팀명 수집 (background 직접 API - 영문)
        let pinNames = [];
        try {
          const matchups = await fetchPin('/sports/29/matchups?isLive=false');
          if (Array.isArray(matchups)) {
            pinNames = matchups.slice(0, 10).map(mu => {
              const h = mu.participants?.find(p => p.alignment === 'home')?.name || '';
              const a = mu.participants?.find(p => p.alignment === 'away')?.name || '';
              return `${h} vs ${a}`;
            });
          }
        } catch(e) { pinNames = ['PIN 오류: ' + e.message]; }

        // 피나클 탭 content script 경유 팀명 수집 (한국어 시도)
        let pinKoNames = [];
        const pinTab = await findPinnacleTab();
        if (pinTab) {
          try {
            const koResult = await chrome.tabs.sendMessage(pinTab.id, { type: 'FETCH_PREMATCH', sportId: 29 });
            if (koResult && koResult.ok) {
              pinKoNames = Object.values(koResult.matchups).slice(0, 10).map(m => `${m.home} vs ${m.away}`);
            } else {
              pinKoNames = ['KO 실패: ' + (koResult?.error || '응답 없음')];
            }
          } catch(e) { pinKoNames = ['KO 오류: ' + e.message]; }
        } else {
          pinKoNames = ['피나클 탭 없음'];
        }

        // BTI 팀명 수집 (BTI 탭 경유)
        let btiNames = [];
        try {
          const url = '/api/eventlist/eu/sports/v2/1/upcoming/eventUpdates?becomeLiveIn=3&isAllMarkets=false&marketTypeIds=ML0';
          const rawData = await fetchBtiViaTab(btiTab.id, url, btiTab.url);
          const rows = rawData?.data;
          if (Array.isArray(rows)) {
            btiNames = rows.slice(0, 10).map(row => {
              const r = Array.isArray(row) ? row : Object.values(row);
              let homeEn = '', awayEn = '', homeKo = '', awayKo = '';
              const teams = r[8];
              if (Array.isArray(teams)) {
                for (const t of teams) {
                  if (!Array.isArray(t) || t.length < 3) continue;
                  const nameObj = t[1];
                  const side = t[2];
                  let en = '', ko = '';
                  if (nameObj && typeof nameObj === 'object') {
                    en = nameObj.EN || '';
                    ko = nameObj.KO || '';
                  } else {
                    en = String(nameObj || '');
                  }
                  if (side === 'Home') { homeEn = en; homeKo = ko; }
                  else if (side === 'Away') { awayEn = en; awayKo = ko; }
                }
              }
              const home = homeEn || homeKo;
              const away = awayEn || awayKo;
              if (!home && r[10]) {
                const parts = String(r[10]).split(' vs ');
                if (parts.length >= 2) return `${parts[0].trim()} vs ${parts[1].trim()} [이벤트명]`;
              }
              return `${home} vs ${away}`;
            });
          }
        } catch(e) { btiNames = ['BTI 오류: ' + e.message]; }

        // 매칭 시도 샘플 - BTI 첫 번째 팀명을 피나클 영문 팀명과 비교
        const matchSamples = [];
        if (btiNames.length > 0 && pinNames.length > 0) {
          const btiFirst = btiNames[0];
          const btiParts = btiFirst.split(' vs ');
          if (btiParts.length >= 2) {
            const btiHome = btiParts[0].trim();
            const btiAway = btiParts[1].trim();
            // normTeam 로직 직접 적용
            function normT(n) { return (n||'').toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9\uac00-\ud7a3]/g,''); }
            for (const pinPair of pinNames) {
              const pp = pinPair.split(' vs ');
              if (pp.length < 2) continue;
              const ph = normT(pp[0]), pa = normT(pp[1]);
              const bh = normT(btiHome), ba = normT(btiAway);
              if ((ph === bh || ph.includes(bh) || bh.includes(ph)) && (pa === ba || pa.includes(ba) || ba.includes(pa))) {
                matchSamples.push(`PIN: ${pinPair} <-> BTI: ${btiFirst}`);
              }
            }
          }
        }

        sendResponse({
          pinSamples: pinNames,
          pinKoSamples: pinKoNames,
          pinCount: pinNames.length,
          btiSamples: btiNames,
          btiCount: btiNames.length,
          matchSamples
        });
      } catch(e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
});
