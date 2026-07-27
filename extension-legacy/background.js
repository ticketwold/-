// background.js - Service Worker
importScripts('sites_config.js');

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
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9가-힣]/g, '');
}

function hasHangul(name) {
  return /[가-힣]/.test(String(name || ''));
}

function stripTeamDecor(name) {
  return String(name || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 두 팀명 유사도 체크 (한쪽이 다른쪽에 포함되거나 앞 4자 일치)
function latinWords(name) {
  return (String(name || '').toLowerCase().match(/[a-z]{4,}/g) || []);
}

function hangulChunks(name) {
  return (stripTeamDecor(name).match(/[가-힣]{2,}/g) || []);
}

function teamMatch(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb || na.length < 2 || nb.length < 2) return false;
  if (na === 'vs' || nb === 'vs') return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // 앞 4자 일치
  if (na.length >= 4 && nb.length >= 4 && na.slice(0, 4) === nb.slice(0, 4)) return true;
  // 한글 음역명 부분 일치 (플라멩구 ↔ 플라멘스 등)
  if (hasHangul(a) && hasHangul(b)) {
    const ha = hangulChunks(a), hb = hangulChunks(b);
    for (const x of ha) {
      for (const y of hb) {
        if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return true;
        if (x.length >= 3 && y.length >= 3 && x.slice(0, 3) === y.slice(0, 3)) return true;
      }
    }
  }
  // 영문 핵심 단어 일치 (Barcelona, Emelec, Tottenham 등)
  const wa = latinWords(a), wb = latinWords(b);
  if (wa.length && wb.length) {
    for (const x of wa) {
      for (const y of wb) {
        if (x === y || (x.length >= 5 && y.length >= 5 && (x.includes(y) || y.includes(x)))) return true;
      }
    }
  }
  return false;
}

function collectNameVariants(...names) {
  const out = [];
  for (const n of names) {
    if (!n || normTeam(n).length < 2) continue;
    if (!out.some((x) => normTeam(x) === normTeam(n))) out.push(n);
  }
  return out;
}

function eventStartMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function startTimesClose(pin, bti, maxMin = 25) {
  const pt = eventStartMs(pin.startTime);
  const bt = eventStartMs(bti.startTime);
  if (!pt || !bt) return false;
  return Math.abs(pt - bt) <= maxMin * 60 * 1000;
}

function koPairKey(home, away) {
  return `${normTeam(home)}|${normTeam(away)}`;
}

// 피나클(EN/KO) ↔ BTI(EN/KO) 모든 조합으로 경기 매칭
function matchupTeamsMatch(pin, bti) {
  const pinHomes = collectNameVariants(pin.home, pin.homeEn, pin.homeKo);
  const pinAways = collectNameVariants(pin.away, pin.awayEn, pin.awayKo);
  const btiHomes = collectNameVariants(bti.home, bti.homeEn, bti.homeKo, bti.eventHome);
  const btiAways = collectNameVariants(bti.away, bti.awayEn, bti.awayKo, bti.eventAway);
  if (!pinHomes.length || !pinAways.length || !btiHomes.length || !btiAways.length) return false;

  function teamsAlign(ph, pa, bh, ba) {
    return teamMatch(ph, bh) && teamMatch(pa, ba);
  }

  for (const ph of pinHomes) {
    for (const pa of pinAways) {
      for (const bh of btiHomes) {
        for (const ba of btiAways) {
          if (teamsAlign(ph, pa, bh, ba)) return true;
        }
      }
      for (const bh of btiAways) {
        for (const ba of btiHomes) {
          if (teamsAlign(ph, pa, bh, ba)) return true;
        }
      }
    }
  }

  // 시작시간 근접 + 한쪽 팀명 일치 (교차언어 폴백)
  if (startTimesClose(pin, bti)) {
    for (const ph of pinHomes) {
      for (const pa of pinAways) {
        for (const bh of btiHomes) {
          for (const ba of btiAways) {
            const hOk = teamMatch(ph, bh) || teamMatch(ph, ba);
            const aOk = teamMatch(pa, ba) || teamMatch(pa, bh);
            if (hOk && aOk) return true;
          }
        }
      }
    }
  }
  return false;
}

function countTeamMatches(pinList, btiList, sportId) {
  let n = 0;
  for (const pin of pinList) {
    if (btiList.some((b) => b.sportId === sportId && matchupTeamsMatch(pin, b))) n++;
  }
  return n;
}

function btiRowMarketCount(row) {
  const r = Array.isArray(row) ? row : (row ? Object.values(row) : []);
  for (const idx of [19, 18, 20, 17]) {
    if (Array.isArray(r[idx]) && r[idx].length > 0) return r[idx].length;
  }
  return 0;
}

function btiMarketsFromRow(rawRow) {
  if (!rawRow) return null;
  const r = Array.isArray(rawRow) ? rawRow : Object.values(rawRow);
  for (const idx of [19, 18, 20, 17]) {
    if (Array.isArray(r[idx]) && r[idx].length > 0) return r[idx];
  }
  return null;
}

function countBtiWithMarkets(events) {
  return events.filter((e) => btiRowMarketCount(e.rawRow) > 0).length;
}

// 피나클 matchups API → 실제 경기만 추출 (리그/특수 마켓 행 제외, parent participants 폴백)
function parsePinMatchupsFromApi(matchups, sportId) {
  if (!Array.isArray(matchups)) return [];
  const byId = {};
  for (const m of matchups) byId[m.id] = m;

  function getParticipants(mu) {
    const direct = mu.participants;
    if (Array.isArray(direct) && direct.length >= 2 && direct.some((p) => p?.name)) {
      return direct;
    }
    if (mu.parent?.participants?.length >= 2) return mu.parent.participants;
    let pid = mu.parentId;
    for (let depth = 0; depth < 6 && pid; depth++) {
      const parent = byId[pid];
      if (!parent) break;
      if (parent.participants?.length >= 2 && parent.participants.some((p) => p?.name)) {
        return parent.participants;
      }
      pid = parent.parentId;
    }
    return [];
  }

  const result = [];
  for (const mu of matchups) {
    if (mu.isLive) continue;
    if (mu.type && mu.type !== 'matchup') continue;
    if (mu.hasMarkets === false) continue;

    const parts = getParticipants(mu);
    if (parts.length < 2) continue;

    const home = parts.find((p) => p.alignment === 'home')?.name || parts[0]?.name || '';
    const away = parts.find((p) => p.alignment === 'away')?.name || parts[1]?.name || '';
    if (!home || !away) continue;
    if (normTeam(home).length < 2 || normTeam(away).length < 2) continue;

    result.push({
      id: mu.id,
      home,
      away,
      league: mu.league?.name || '',
      sportId,
      startTime: mu.startTime || null
    });
  }
  return result;
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
  'indonesiawinner.com', 'jjddgg.com', 'mervani99.com', 'pbc00.com', 'x10x10s.com',
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
  return scoreWrapperBtiTab(url);
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
    if (isSiteWrapperUrl(tab.url)) {
      const score = scoreWrapperBtiTab(tab.url);
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

  // x10x10s / pbc00 BTI 화면(gamecode=19) 최우선
  if (bestPbc) return { id: bestPbc.tab.id, url: bestPbc.tab.url };
  if (bestDirect) return { id: bestDirect.tab.id, url: bestDirect.tab.url };
  return null;
}

// BTI 진단 (팝업 로그용)
async function diagBtiSearch() {
  const btiTab = await pickBtiTab();
  if (!btiTab) {
    const tabs = await chrome.tabs.query({});
    const pbcAny = tabs.filter((t) => isSiteWrapperUrl(t.url || '')).map((t) => t.url).slice(0, 3);
    return {
      ok: false,
      error: 'BTI 탭 없음 — x10x10s.com?gamecode=19 (10벳 스포츠) 화면을 열어주세요',
      wrapperTabsOpen: tabs.filter((t) => isSiteWrapperUrl(t.url || '')).map((t) => t.url).slice(0, 3)
    };
  }

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

// 피나클 탭 찾기 (content script 메시지 전송용, pbc00 iframe 포함)
async function findPinnacleTab() {
  const PIN_HINTS = ['pinnacle.com', 'eviran66.com', 'mervani99.com', 'auremi88.com'];
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (PIN_HINTS.some((d) => tab.url.includes(d))) {
      return { id: tab.id, frameId: 0, url: tab.url };
    }
  }

  for (const tab of tabs) {
    if (!tab.url?.includes('pbc00.com')) continue;
    const gm = tab.url.match(/[?&]gamecode=(\d+)/);
    if (gm && !['1', '2', '3', '4', '5'].includes(gm[1])) continue;
    const frames = await getAllTabFrames(tab.id);
    for (const frame of frames) {
      if (frame.url && PIN_HINTS.some((d) => frame.url.includes(d))) {
        return { id: tab.id, frameId: frame.frameId, url: frame.url };
      }
    }
  }
  return null;
}

// 피나클 haywire API 키 (app.json)
let cachedPinHaywireKey = '';
// MAIN world 인터셉터가 background로 보낸 한글 팀명 캐시
const pinKoCacheBySport = {};

async function fetchPinHaywireApiKey() {
  if (cachedPinHaywireKey) return cachedPinHaywireKey;
  try {
    const res = await fetch('https://www.pinnacle.com/config/app.json');
    const cfg = await res.json();
    cachedPinHaywireKey = cfg?.api?.haywire?.apiKey || '';
  } catch (_) {}
  return cachedPinHaywireKey;
}

function scorePinFrame(frame) {
  const u = frame.url || '';
  let score = 0;
  if (u.includes('pinnacle.com') && !u.includes('pbc00.com')) score += 40;
  if (u.includes('eviran66.com') || u.includes('auremi88.com') || u.includes('mervani99.com')) score += 30;
  if (frame.frameId > 0) score += 5;
  return score;
}

async function findAllPinnacleFrames() {
  const PIN_HINTS = ['pinnacle.com', 'eviran66.com', 'mervani99.com', 'auremi88.com'];
  const out = [];
  const seen = new Set();
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (!tab.url) continue;
    if (PIN_HINTS.some((d) => tab.url.includes(d))) {
      const key = `${tab.id}:0`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ id: tab.id, frameId: 0, url: tab.url });
      }
    }
    if (!tab.url.includes('pbc00.com')) continue;
    const gm = tab.url.match(/[?&]gamecode=(\d+)/);
    if (gm && !['1', '2', '3', '4', '5'].includes(gm[1])) continue;
    const frames = await getAllTabFrames(tab.id);
    for (const frame of frames) {
      if (!frame.url || !PIN_HINTS.some((d) => frame.url.includes(d))) continue;
      const key = `${tab.id}:${frame.frameId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: tab.id, frameId: frame.frameId, url: frame.url });
    }
  }
  return out.sort((a, b) => scorePinFrame(b) - scorePinFrame(a));
}

// inject용 — 피나클 iframe에서 세션 쿠키로 한국어 팀명 수집
async function pinPrematchKoInjectFn(sportId, haywireKey) {
  const PAGE_KEY = 'AI9lc7vjxbF2W9JnS9OJN6VJ7eRLlKuM';
  const keys = [...new Set([window.__PIN_API_KEY, PAGE_KEY, haywireKey].filter((k) => k && k.length > 15))];

  function getParticipants(mu, byId) {
    const direct = mu.participants;
    if (Array.isArray(direct) && direct.length >= 2 && direct.some((p) => p?.name)) return direct;
    if (mu.parent?.participants?.length >= 2) return mu.parent.participants;
    let pid = mu.parentId;
    for (let d = 0; d < 6 && pid; d++) {
      const p = byId[pid];
      if (!p) break;
      if (p.participants?.length >= 2 && p.participants.some((x) => x?.name)) return p.participants;
      pid = p.parentId;
    }
    return [];
  }

  function parseMatchups(data) {
    const byId = {};
    for (const m of data) byId[m.id] = m;
    const matchups = {};
    let koCount = 0;
    for (const mu of data) {
      if (mu.isLive || (mu.type && mu.type !== 'matchup') || mu.hasMarkets === false) continue;
      const parts = getParticipants(mu, byId);
      if (parts.length < 2) continue;
      const home = parts.find((p) => p.alignment === 'home')?.name || parts[0]?.name || '';
      const away = parts.find((p) => p.alignment === 'away')?.name || parts[1]?.name || '';
      if (!home || !away) continue;
      if (/[가-힣]/.test(home + away)) koCount++;
      matchups[mu.id] = { home, away, league: mu.league?.name || '', startTime: mu.startTime || null };
    }
    return { matchups, koCount, total: Object.keys(matchups).length };
  }

  try {
    const cached = window.__pinMatchupCache?.[sportId];
    if (cached?.matchups && Object.keys(cached.matchups).length > 0) {
      return {
        ok: true,
        matchups: cached.matchups,
        count: cached.total || Object.keys(cached.matchups).length,
        koCount: cached.koCount || 0,
        source: 'main-cache',
        frame: location.href
      };
    }

    if (!window.__pinInterceptInstalled) {
        const origFetch = window.fetch;
        window.fetch = async function(input, init) {
          const url = typeof input === 'string' ? input : (input?.url || '');
          if (url.includes('arcadia.pinnacle.com') && init?.headers) {
            const headers = init.headers;
            let key = null;
            if (headers instanceof Headers) key = headers.get('X-Api-Key');
            else if (typeof headers === 'object') key = headers['X-Api-Key'] || headers['x-api-key'];
            if (key && key.length > 15) window.__PIN_API_KEY = key;
          }
          return origFetch.call(this, input, init);
        };
        window.__pinInterceptInstalled = true;
      }

      const url = `https://api.arcadia.pinnacle.com/0.1/sports/${sportId}/matchups?isLive=false&withSpecials=false`;
      const headers = {
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.1',
        Accept: 'application/json'
      };

      let best = null;
      for (const apiKey of keys) {
        const res = await fetch(url, { headers: { ...headers, 'X-Api-Key': apiKey }, credentials: 'include' });
        if (!res.ok) continue;
        const data = await res.json();
        if (!Array.isArray(data)) continue;
        const parsed = parseMatchups(data);
        if (!parsed.total) continue;
        if (!best || parsed.koCount > best.koCount || (parsed.koCount === best.koCount && parsed.total > best.total)) {
          best = { ...parsed, apiKeyUsed: apiKey.slice(0, 8) };
        }
        if (parsed.koCount > 0) break;
      }

      if (!best?.total) return { ok: false, error: 'matchups 0건 (프리매치 종목 화면 클릭 후 재시도)' };
      return { ok: true, matchups: best.matchups, count: best.total, koCount: best.koCount, source: 'inject-fetch', frame: location.href };
    } catch (e) {
      return { ok: false, error: e.message };
    }
}

async function readPinMainCacheFromFrame(pinTab, sportId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: pinTab.id, frameIds: [pinTab.frameId || 0] },
      world: 'MAIN',
      func: (sid) => {
        const cache = window.__pinMatchupCache?.[sid];
        if (!cache?.matchups || !Object.keys(cache.matchups).length) return null;
        return {
          ok: true,
          matchups: cache.matchups,
          count: cache.total || Object.keys(cache.matchups).length,
          koCount: cache.koCount || 0,
          source: 'main-cache'
        };
      },
      args: [sportId]
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function ensurePinMainInterceptor(pinTab) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: pinTab.id, frameIds: [pinTab.frameId || 0] },
      world: 'MAIN',
      files: ['pinnacle_main.js']
    });
    await sleep(200);
    return true;
  } catch (_) {
    return false;
  }
}

async function ensurePinContentScript(tabId, frameId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId });
    if (ping?.ok) return true;
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['pinnacle_content.js']
    });
    await sleep(300);
    return true;
  } catch (_) {
    return false;
  }
}

async function fetchPinKoViaContentScript(pinTab, sportId) {
  const frameId = pinTab.frameId || 0;
  await ensurePinContentScript(pinTab.id, frameId);
  try {
    const res = await chrome.tabs.sendMessage(
      pinTab.id,
      { type: 'FETCH_PREMATCH', sportId },
      { frameId }
    );
    return res || { ok: false, error: 'content script 응답 없음' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 피나클 iframe에서 한국어 팀명 fetch (content script → inject 폴백)
async function fetchPinKoViaInject(pinTab, sportId) {
  const haywireKey = await fetchPinHaywireApiKey();
  const worlds = ['MAIN', 'ISOLATED'];

  for (const world of worlds) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: pinTab.id, frameIds: [pinTab.frameId || 0] },
        world,
        func: pinPrematchKoInjectFn,
        args: [sportId, haywireKey]
      });
      if (chrome.runtime.lastError) {
        continue;
      }
      const result = results?.[0]?.result;
      if (result && typeof result.then === 'function') {
        const settled = await result;
        if (settled?.ok) return settled;
      } else if (result?.ok) {
        return result;
      }
    } catch (_) {}
  }
  return { ok: false, error: `inject 실패 frame=${pinTab.frameId} url=${(pinTab.url || '').slice(0, 60)}` };
}

async function fetchPinKoFromAnyFrame(sportId) {
  const frames = await findAllPinnacleFrames();
  if (!frames.length) return { ok: false, error: '피나클 탭/iframe 없음' };

  const bgCache = pinKoCacheBySport[sportId];
  if (bgCache?.matchups && Object.keys(bgCache.matchups).length > 0) {
    const koCount = Object.values(bgCache.matchups).filter((m) => hasHangul(m.home) || hasHangul(m.away)).length;
    if (koCount > 0 || bgCache.koCount > 0) {
      return { ok: true, matchups: bgCache.matchups, source: 'bg-cache', koCount: bgCache.koCount || koCount };
    }
  }

  let lastErr = '응답 없음';
  for (const frame of frames) {
    await ensurePinMainInterceptor(frame);

    let result = await readPinMainCacheFromFrame(frame, sportId);
    if (result?.ok && result.matchups && Object.keys(result.matchups).length > 0) {
      const koCount = Object.values(result.matchups).filter((m) => hasHangul(m.home) || hasHangul(m.away)).length;
      console.log(`[피나클] KO 캐시 frame=${frame.frameId} ${koCount}/${Object.keys(result.matchups).length}건 (${result.source})`);
      if (koCount > 0) return { ...result, koCount };
    }

    result = await fetchPinKoViaContentScript(frame, sportId);
    if (!result?.ok || !result.matchups || Object.keys(result.matchups).length === 0) {
      result = await fetchPinKoViaInject(frame, sportId);
    }
    if (result?.ok && result.matchups && Object.keys(result.matchups).length > 0) {
      const koCount = Object.values(result.matchups).filter((m) => hasHangul(m.home) || hasHangul(m.away)).length;
      console.log(`[피나클] KO 팀명 frame=${frame.frameId} ${koCount}/${Object.keys(result.matchups).length}건 (${result.source || 'fetch'})`);
      return result;
    }
    lastErr = result?.error || lastErr;
  }
  return { ok: false, error: lastErr + ' — 피나클 프리매치에서 축구 등 종목 클릭 후 재시도' };
}

// 피나클 탭 content script / inject → 한국어 팀명 수집
async function getPinPrematchMatchupsKo(sportId) {
  try {
    const result = await fetchPinKoFromAnyFrame(sportId);
    if (!result?.ok) {
      console.warn(`[피나클] FETCH_PREMATCH 실패 sportId=${sportId}:`, result?.error || '응답 없음');
      return null;
    }

    return Object.entries(result.matchups).map(([id, m]) => ({
      id,
      home: m.home,
      away: m.away,
      homeKo: m.home,
      awayKo: m.away,
      league: m.league,
      sportId,
      startTime: m.startTime || null,
      odds: {}
    }));
  } catch (e) {
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

    return parsePinMatchupsFromApi(
      matchups.filter((mu) => mu.isLive),
      sportId
    ).map((mu) => ({
      ...mu,
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

    return parsePinMatchupsFromApi(matchups, sportId).map((mu) => ({
      ...mu,
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

function isBtiEventlistRowLive(r) {
  if (!r || r.length < 8) return false;
  // r[12]=라이브, r[13]=중단/블록 (eventlist API 관례)
  if (r[12] === true || r[12] === 1) return true;
  if (r[13] === true || r[13] === 1) return true;
  const status = String(r[14] || r[15] || r[16] || '').toLowerCase();
  if (/live|inplay|in-play|진행/.test(status)) return true;
  const startRaw = r[11];
  if (startRaw) {
    const ts = typeof startRaw === 'number'
      ? (startRaw < 1e12 ? startRaw * 1000 : startRaw)
      : new Date(startRaw).getTime();
    if (ts && !Number.isNaN(ts) && ts < Date.now() - 3 * 60 * 1000) return true;
  }
  return false;
}

function parseEventlistRow(row, btiSportId) {
  const r = Array.isArray(row) ? row : Object.values(row);
  if (!r || r.length < 8) return null;

  const eventId = r[0];
  if (!eventId) return null;
  if (isBtiEventlistRowLive(r)) return null;

  let home = '', away = '';
  let homeEn = '', awayEn = '', homeKo = '', awayKo = '';
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
      if (side === 'Home') {
        homeEn = nameEn;
        homeKo = nameKo || (hasHangul(nameEn) ? nameEn : '');
        home = homeKo || nameEn;
      } else if (side === 'Away') {
        awayEn = nameEn;
        awayKo = nameKo || (hasHangul(nameEn) ? nameEn : '');
        away = awayKo || nameEn;
      }
    }
  }

  if (!home && r[10]) {
    const parts = String(r[10]).split(/\s+vs\s+/i);
    if (parts.length >= 2) {
      home = parts[0].trim();
      away = parts[1].trim();
      if (!homeEn) homeEn = home;
      if (!awayEn) awayEn = away;
    }
  }
  if (!home) return null;

  let eventHome = '', eventAway = '';
  if (r[10]) {
    const parts = String(r[10]).split(/\s+vs\s+/i);
    if (parts.length >= 2) {
      eventHome = parts[0].trim();
      eventAway = parts[1].trim();
      if (/[a-zA-Z]{2,}/.test(eventHome) && !homeEn) homeEn = eventHome;
      if (/[a-zA-Z]{2,}/.test(eventAway) && !awayEn) awayEn = eventAway;
    }
  }

  return {
    id: String(eventId),
    home, away, homeEn, awayEn, homeKo, awayKo, eventHome, eventAway,
    sportId: BTI_TO_PIN_SPORT[btiSportId] || 0,
    btiSportId,
    league: r[2] || '',
    markets: [],
    rawRow: r,
    startTime: r[11] || null
  };
}

// BTI eventlist EN 요청으로 영문 팀명 병합 (KO 음역명 ↔ 피나클 EN 매칭용)
async function enrichBtiEventsEnglish(btiTabId, btiTabUrl, events) {
  if (!events.length) return events;
  const byId = new Map(events.map((e) => [e.id, e]));
  const byKoPair = new Map();
  for (const e of events) {
    if (e.home && e.away) byKoPair.set(koPairKey(e.home, e.away), e);
  }
  const sportIds = [...new Set(events.map((e) => e.btiSportId).filter(Boolean))];
  if (!sportIds.length) sportIds.push(1, 6, 7, 59, 2);

  const MARKET_TYPE_MAP = {
    1: 'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619',
    6: 'ML0%2COU0%2CHC0',
    7: 'HC0%2COU0%2CML0',
    59: 'ML587%2CML0%2COU0%2CHC0',
    2: 'HC0%2COU0%2CML0'
  };

  for (const sportId of sportIds) {
    const enPaths = [
      `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?language=EN&isAllMarkets=true&marketTypeIds=${MARKET_TYPE_MAP[sportId] || 'ML0%2COU0%2CHC0'}`,
      `/api/eventlist/eu/sports/v2/${sportId}/early/eventUpdates?language=EN&isAllMarkets=true&marketTypeIds=${MARKET_TYPE_MAP[sportId] || 'ML0%2COU0%2CHC0'}`,
      `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?marketTypeIds=ML0&language=EN`
    ];
    let merged = 0;
    for (const path of enPaths) {
      try {
        const rows = extractEventlistRows(await fetchBtiViaTab(btiTabId, path, btiTabUrl));
        for (const row of rows) {
          const parsed = parseEventlistRow(row, sportId);
          if (!parsed) continue;
          let ev = byId.get(parsed.id);
          if (!ev && parsed.home && parsed.away) {
            ev = byKoPair.get(koPairKey(parsed.homeKo || parsed.home, parsed.awayKo || parsed.away));
          }
          if (!ev) continue;
          if (parsed.homeEn) { ev.homeEn = parsed.homeEn; merged++; }
          if (parsed.awayEn) { ev.awayEn = parsed.awayEn; merged++; }
          if (parsed.eventHome && /[a-zA-Z]{2,}/.test(parsed.eventHome)) ev.eventHome = parsed.eventHome;
          if (parsed.eventAway && /[a-zA-Z]{2,}/.test(parsed.eventAway)) ev.eventAway = parsed.eventAway;
        }
        if (merged > 0) break;
      } catch (_) {}
    }
  }
  return events;
}

// BTI eventlist — 배당(rawRow[19]) 없는 경기에 isAllMarkets 데이터 병합
async function enrichBtiEventMarkets(btiTabId, btiTabUrl, events) {
  const need = events.filter((e) => !btiRowMarketCount(e.rawRow));
  if (!need.length) return events;
  const byId = new Map(events.map((e) => [e.id, e]));
  const sportIds = [...new Set(need.map((e) => e.btiSportId).filter(Boolean))];
  const MARKET_TYPE_MAP = {
    1: 'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619%2CML167',
    6: 'ML0%2COU0%2CHC0%2CML619%2COU619%2CHC619',
    7: 'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619',
    59: 'ML587%2CML0%2COU0%2CHC0%2CML619%2COU619%2CHC619',
    2: 'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619'
  };

  for (const sportId of sportIds) {
    const url = `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?language=KO&isAllMarkets=true&marketTypeIds=${MARKET_TYPE_MAP[sportId] || 'HC0%2COU0%2CML0'}`;
    try {
      const rows = extractEventlistRows(await fetchBtiViaTab(btiTabId, url, btiTabUrl));
      for (const row of rows) {
        const r = Array.isArray(row) ? row : Object.values(row);
        const id = String(r[0] || '');
        const ev = byId.get(id);
        if (!ev || btiRowMarketCount(ev.rawRow) > 0) continue;
        const mkts = btiMarketsFromRow(r);
        if (!mkts) continue;
        ev.rawRow = r;
        ev.markets = mkts;
      }
    } catch (_) {}
  }
  return events;
}

function isBtiFeaturedEventLive(event) {
  if (!event) return true;
  if (event.IsLive === true || event.isLive === true) return true;
  if (event.LiveGameState || event.Clock) return true;
  const status = String(event.Status || event.EventStatus || event.State || '').toLowerCase();
  if (/live|inplay|진행/.test(status)) return true;
  if (event.markets?.some((m) => m.IsLive || m.isLive)) return true;
  return false;
}

async function fetchBtiFeaturedPrematch(btiTabId, btiTabUrl) {
  const path = `/api/sportscenter/carousels/featured-matches/markets?language=KO&customerLevel=0&selectedOptionId=0&marketTypes=${BTI_MARKET_TYPES}&minimumOdds=1.1&draft=false`;
  const data = await fetchBtiViaTab(btiTabId, path, btiTabUrl);
  if (!Array.isArray(data)) return [];

  const result = [];
  for (const event of data) {
    if (!event.id || !event.markets?.length) continue;
    if (isBtiFeaturedEventLive(event)) continue;

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

let lastBtiPrematchDiag = { errors: [], sources: {}, apiOrigin: '', liveFiltered: 0, dataSource: 'none' };

function btiPrematchPathsForSport(sportId, marketTypes) {
  const mt = marketTypes || 'HC0%2COU0%2CML0';
  const lang = 'language=KO';
  return [
    `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?${lang}&isAllMarkets=true&marketTypeIds=${mt}`,
    `/api/eventlist/eu/sports/v2/${sportId}/early/eventUpdates?${lang}&isAllMarkets=true&marketTypeIds=${mt}`,
    `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?${lang}&isAllMarkets=false&marketTypeIds=ML0%2COU0%2CHC0`,
    `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?${lang}&marketTypeIds=ML0`,
    `/api/eventlist/eu/sports/v2/${sportId}/upcoming/eventUpdates?${lang}&becomeLiveIn=24&isAllMarkets=true&marketTypeIds=ML0`
  ];
}

async function fetchBtiEventlistPrematchForSport(btiTabId, btiTabUrl, sportId, marketTypes) {
  const paths = btiPrematchPathsForSport(sportId, marketTypes);
  let best = [];
  let bestTag = '';
  let bestScore = -1;
  let liveFiltered = 0;

  for (const url of paths) {
    try {
      const rawData = await fetchBtiViaTab(btiTabId, url, btiTabUrl);
      const rows = extractEventlistRows(rawData);
      const parsed = [];
      let withMkts = 0;
      for (const row of rows) {
        const r = Array.isArray(row) ? row : Object.values(row);
        if (isBtiEventlistRowLive(r)) { liveFiltered++; continue; }
        const ev = parseEventlistRow(row, sportId);
        if (ev) {
          parsed.push(ev);
          if (btiRowMarketCount(ev.rawRow) > 0) withMkts++;
        }
      }
      const score = withMkts * 10000 + parsed.length;
      if (score > bestScore) {
        best = parsed;
        bestScore = score;
        bestTag = url.includes('/early/') ? 'early' : 'upcoming';
      }
    } catch (e) {
      // 다음 URL 시도
    }
  }
  return { events: best, tag: bestTag, liveFiltered, withMarkets: best.filter((e) => btiRowMarketCount(e.rawRow) > 0).length };
}

// BTI 프리매치 전체 경기 목록 + 배당 가져오기 (라이브/DOM 폴백 사용 안 함)
async function getBtiPrematchMatchups(btiTabId, btiTabUrl) {
  const BTI_SPORT_IDS = [1, 6, 7, 59, 2];
  const MARKET_TYPE_MAP = {
    1:  'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619%2CML167',
    6:  'ML0%2COU0%2CHC0%2CML619%2COU619%2CHC619',
    7:  'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619',
    59: 'ML587%2CML0%2COU0%2CHC0%2CML619%2COU619%2CHC619',
    2:  'HC0%2COU0%2CML0%2CHC619%2COU619%2CML619'
  };

  const byId = new Map();
  const errors = [];
  const sources = {};
  let liveFiltered = 0;
  let dataSource = 'eventlist';

  try {
    lastBtiPrematchDiag.apiOrigin = await resolveBtiApiOrigin(btiTabId, btiTabUrl);
  } catch (_) {}

  for (const sportId of BTI_SPORT_IDS) {
    try {
      const { events, tag, liveFiltered: lf } = await fetchBtiEventlistPrematchForSport(
        btiTabId, btiTabUrl, sportId, MARKET_TYPE_MAP[sportId]
      );
      liveFiltered += lf;
      if (events.length) {
        sources[`sport${sportId}`] = `${tag}:${events.length}`;
        for (const ev of events) byId.set(ev.id, ev);
      }
    } catch (e) {
      errors.push(`sport${sportId}: ${e.message}`);
    }
  }

  if (!byId.size) {
    try {
      const featured = await fetchBtiFeaturedPrematch(btiTabId, btiTabUrl);
      if (featured.length) {
        for (const ev of featured) byId.set(ev.id, ev);
        sources.featured = featured.length;
        dataSource = 'featured';
        console.log('[BTI] 프리매치 featured-matches 폴백:', featured.length);
      }
    } catch (e) {
      errors.push(`featured: ${e.message}`);
    }
  }

  const allEvents = [...byId.values()];

  if (!allEvents.length) {
    errors.push('프리매치 API 0건 — BTI 탭을 프리매치(조기/예정) 화면으로 전환 후 새로고침 (라이브 화면 DOM은 사용하지 않음)');
    dataSource = 'none';
  }

  if (allEvents.length) {
    try {
      await enrichBtiEventMarkets(btiTabId, btiTabUrl, allEvents);
      sources.withMarkets = countBtiWithMarkets(allEvents);
      await enrichBtiEventsEnglish(btiTabId, btiTabUrl, allEvents);
      sources.enriched = allEvents.filter((e) => e.homeEn || e.awayEn).length;
    } catch (e) {
      errors.push(`enrich: ${e.message}`);
    }
  }

  lastBtiPrematchDiag = {
    errors: errors.slice(0, 8),
    sources,
    apiOrigin: lastBtiPrematchDiag.apiOrigin,
    liveFiltered,
    dataSource
  };
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
      return matchupTeamsMatch(pin, b);
    });
    if (!btiMatch) continue;

    const pinOdds = parsePinOdds(pin.odds, sportId);
    const btiOdds = btiMatch.rawRow ? parseBtiOddsFromRow(btiMatch.rawRow) : parseBtiOdds(btiMatch.markets);
    const hasBtiOdds = btiOdds.ml.length + btiOdds.ah.length + btiOdds.ou.length > 0;
    if (!hasBtiOdds) continue;

    // ML (무승부 제외 2-way, 축구 포함)
    for (const pml of pinOdds.ml.filter((p) => p.period === 0)) {
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

    // OU 언오버 (0.5 단위)
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

  return opportunities.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
}

// BTI 배당 파싱 - rawRow[19] 배열 구조 (eventlist API 응답)
// 마켓 구조: [marketId, marketName, marketName2, [typeId, ...], eventId, leagueId, sportId, selections, ...]
// 셀렉션 구조: [selId, {KO:name}, {KO:teamName}, isSuspended, price, isRemoved, [odds...], order, ..., {KO:side}, ..., line, ...]
function parseBtiOddsFromRow(rawRow) {
  const result = { ml: [], ah: [], ou: [] };
  if (!rawRow) return result;
  const markets = btiMarketsFromRow(rawRow);
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
    const btiMatch = btiMatchups.find(b => matchupTeamsMatch(pin, b));
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
      return (matchupTeamsMatch(pin, s));
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
let searchMode = SITE_CONFIG.DEFAULT_SEARCH_MODE; // 'poly' | 'bti' | 'sbo' | 'both'

async function findPolymarketTab() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && isPolymarketUrl(tab.url)) return { id: tab.id, url: tab.url, frameId: 0 };
  }
  return null;
}

function polyPriceToDecimal(price) {
  const p = parseFloat(price);
  if (!p || p <= 0 || p >= 1) return null;
  return 1 / p;
}

function parsePolyOutcomes(market) {
  try {
    const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : (market.outcomes || []);
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : (market.outcome_prices || market.outcomePrices || []);
    return { outcomes, prices };
  } catch (_) {
    return { outcomes: [], prices: [] };
  }
}

function parsePolymarketSportsEvents(events) {
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
      if (outcomes.includes('Yes') && outcomes.includes('No')) {
        const win = (m.question || '').match(/Will (.+?) win/i);
        if (win) {
          ml.push({ team: win[1].trim(), side: 'yes', price: parseFloat(prices[0]), decimal: polyPriceToDecimal(prices[0]) });
        }
        continue;
      }
      for (let i = 0; i < 2; i++) {
        const dec = polyPriceToDecimal(prices[i]);
        if (dec) ml.push({ team: outcomes[i], side: i === 0 ? 'home' : 'away', price: parseFloat(prices[i]), decimal: dec });
      }
    }
    if (!ml.length) continue;
    result.push({
      id: String(e.id),
      home,
      away,
      title,
      league: e.seriesSlug || '',
      startTime: e.startDate || e.endDate || null,
      ml,
      sportId: 29
    });
  }
  return result;
}

async function getPolymarketSportsMatchups(limit = 120) {
  const url = `${SITE_CONFIG.GAMMA_API}/events?tag_id=100639&active=true&closed=false&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Polymarket API ${res.status}`);
  const data = await res.json();
  return parsePolymarketSportsEvents(data);
}

function findPolyArbitrageOpportunities(btiMatchups, polyMatchups, sportId) {
  const opportunities = [];
  const sportLabel = PIN_SPORT_LABEL[sportId] || '스포츠';
  for (const bti of btiMatchups) {
    if (bti.sportId && bti.sportId !== sportId) continue;
    const btiOdds = bti.rawRow ? parseBtiOddsFromRow(bti.rawRow) : parseBtiOdds(bti.markets || []);
    const mlH = btiOdds.ml.find((m) => m.side === 'H' || m.side === 'Home');
    const mlA = btiOdds.ml.find((m) => m.side === 'A' || m.side === 'Away');
    if (!mlH?.odds || !mlA?.odds) continue;

    for (const poly of polyMatchups) {
      if (!matchupTeamsMatch(
        { home: bti.home, away: bti.away, homeEn: bti.homeEn, awayEn: bti.awayEn },
        { home: poly.home, away: poly.away, homeEn: poly.home, awayEn: poly.away }
      )) continue;

      for (const pm of poly.ml) {
        if (!pm.decimal) continue;
        const btiHome = teamMatch(pm.team, bti.home) || teamMatch(pm.team, bti.homeEn);
        const btiAway = teamMatch(pm.team, bti.away) || teamMatch(pm.team, bti.awayEn);
        let btiOppOdds = null;
        let btiOppSide = '';
        if (btiHome) { btiOppOdds = mlA.odds; btiOppSide = 'away'; }
        else if (btiAway) { btiOppOdds = mlH.odds; btiOppSide = 'home'; }
        else continue;

        const profit = calcArb(pm.decimal, btiOppOdds);
        if (profit === null || profit < 0) continue;
        opportunities.push({
          sport: sportLabel,
          market: 'ML',
          period: 'ft',
          home: bti.home,
          away: bti.away,
          league: bti.league || poly.league,
          pinSide: pm.side,
          pinOdds: pm.decimal.toFixed(3),
          btiSide: btiOppSide,
          btiOdds: btiOppOdds,
          profit: profit.toFixed(2),
          polyTeam: pm.team,
          polyPrice: pm.price,
          btiEventId: bti.id,
          polyEventId: poly.id,
          startTime: bti.startTime || poly.startTime,
          source: 'poly'
        });
      }
    }
  }
  return opportunities.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
}

async function runSearchOnce() {
  if (searchMode === 'poly') {
    const btiTab = await pickBtiTab();
    let btiAll = [];
    if (btiTab) {
      try { btiAll = await getBtiLiveMatchups(btiTab.id); } catch (e) {
        console.warn('[10x10] BTI 라이브 수집 실패:', e.message);
      }
    }
    let polyAll = [];
    try { polyAll = await getPolymarketSportsMatchups(150); } catch (e) {
      console.warn('[Polymarket] API 실패:', e.message);
    }
    const polyTab = await findPolymarketTab();
    const opps = findPolyArbitrageOpportunities(btiAll, polyAll, 29);
    return {
      opportunities: opps,
      stats: {
        searchMode: 'poly',
        btiTotal: btiAll.length,
        btiTabFound: !!btiTab,
        polyTotal: polyAll.length,
        polyTabFound: !!polyTab,
        matched: opps.length,
        wrapper: btiTab ? wrapperLabel(btiTab.url) : null
      }
    };
  }

  const hasSboToken = !!sbobetToken;
  const useBti = (searchMode === 'bti' || searchMode === 'both');
  const useSbo = (searchMode === 'sbo' || searchMode === 'both');

  // BTI 탭 ID 선택적 탐색
  let btiTabId = null;
  if (useBti) {
    btiTabId = await findBtiTabId();
    if (!btiTabId) console.warn('[BTI] 탭 없음 - x10x10s.com 또는 pbc00.com BTI 화면을 열어주세요');
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

async function getPinPrematchForSport(pinSportId) {
  const koMatchups = await getPinPrematchMatchupsKo(pinSportId);
  let oddsMap = {};
  try {
    const markets = await fetchPin(`/sports/${pinSportId}/markets/highlighted/straight?primaryOnly=false`);
    if (Array.isArray(markets)) {
      for (const m of markets) {
        if (!oddsMap[m.matchupId]) oddsMap[m.matchupId] = {};
        oddsMap[m.matchupId][`${m.type}_${m.period}`] = m;
      }
    }
  } catch (_) {}

  const raw = await fetchPin(`/sports/${pinSportId}/matchups?isLive=false`);
  let parsed = parsePinMatchupsFromApi(raw, pinSportId).map((mu) => ({
    ...mu,
    homeEn: mu.home,
    awayEn: mu.away,
    odds: oddsMap[mu.id] || {}
  }));

  if (koMatchups?.length) {
    const koById = Object.fromEntries(koMatchups.map((m) => [String(m.id), m]));
    parsed = parsed.map((mu) => {
      const ko = koById[String(mu.id)];
      if (!ko) return mu;
      return {
        ...mu,
        homeKo: ko.homeKo || ko.home,
        awayKo: ko.awayKo || ko.away,
        home: ko.home || mu.home,
        away: ko.away || mu.away
      };
    });
  }
  return parsed;
}

function formatEventTimeKo(startTime) {
  const ms = eventStartMs(startTime);
  if (!ms) return '';
  return new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function filterEventsByHours(events, hours) {
  if (!hours || hours <= 0) return events;
  const maxT = Date.now() + hours * 3600000;
  return events.filter((e) => {
    const t = eventStartMs(e.startTime);
    return !t || t <= maxT;
  });
}

function serializePinListItem(mu, pinSportId) {
  const pinOdds = parsePinOdds(mu.odds || {}, pinSportId);
  const ml0 = pinOdds.ml.filter((p) => p.period === 0);
  return {
    id: String(mu.id),
    home: mu.home,
    away: mu.away,
    homeKo: mu.homeKo,
    awayKo: mu.awayKo,
    homeEn: mu.homeEn,
    awayEn: mu.awayEn,
    league: mu.league || '',
    startTime: mu.startTime,
    timeLabel: formatEventTimeKo(mu.startTime),
    mlHome: ml0.find((p) => p.side === 'home')?.odds,
    mlAway: ml0.find((p) => p.side === 'away')?.odds
  };
}

function serializeBtiListItem(ev) {
  const btiOdds = ev.rawRow ? parseBtiOddsFromRow(ev.rawRow) : parseBtiOdds(ev.markets || []);
  const mlH = btiOdds.ml.find((m) => m.side === 'H' || m.side === 'Home');
  const mlA = btiOdds.ml.find((m) => m.side === 'A' || m.side === 'Away');
  return {
    id: String(ev.id),
    home: ev.home,
    away: ev.away,
    homeEn: ev.homeEn,
    awayEn: ev.awayEn,
    league: ev.league || '',
    startTime: ev.startTime,
    timeLabel: formatEventTimeKo(ev.startTime),
    mlHome: mlH?.odds,
    mlAway: mlA?.odds,
    hasMarkets: btiRowMarketCount(ev.rawRow) > 0
  };
}

// 종목별 프리매치 경기 목록 (수동 매칭 UI용)
async function getPrematchSportLists(pinSportId, hours = 48) {
  const btiTab = await findBtiTab();
  if (!btiTab) return { ok: false, error: 'BTI 탭 없음 — pbc00.com을 열어주세요' };

  const [pinRaw, btiAll] = await Promise.all([
    getPinPrematchForSport(pinSportId),
    getBtiPrematchMatchups(btiTab.id, btiTab.url)
  ]);

  const btiRaw = btiAll.filter((e) => e.sportId === pinSportId);
  const pinFiltered = filterEventsByHours(pinRaw, hours);
  const btiFiltered = filterEventsByHours(btiRaw, hours);

  pinFiltered.sort((a, b) => eventStartMs(a.startTime) - eventStartMs(b.startTime));
  btiFiltered.sort((a, b) => eventStartMs(a.startTime) - eventStartMs(b.startTime));

  const pinKoHangul = pinFiltered.filter((m) => hasHangul(m.home) || hasHangul(m.away)).length;

  return {
    ok: true,
    sportId: pinSportId,
    sportLabel: PIN_SPORT_LABEL[pinSportId] || '기타',
    hours,
    pinList: pinFiltered.map((m) => serializePinListItem(m, pinSportId)),
    btiList: btiFiltered.map(serializeBtiListItem),
    pinFull: pinFiltered,
    btiFull: btiFiltered,
    pinKoHangul,
    btiWithMarkets: countBtiWithMarkets(btiFiltered),
    btiEnriched: btiFiltered.filter((e) => e.homeEn || e.awayEn).length
  };
}

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
    const koMatchups = koMatchupResults[i];
    const oddsMap = oddsResults[i];

    try {
      const raw = await fetchPin(`/sports/${sid}/matchups?isLive=false`);
      let parsed = parsePinMatchupsFromApi(raw, sid).map((mu) => ({
        ...mu,
        homeEn: mu.home,
        awayEn: mu.away,
        odds: oddsMap[mu.id] || {}
      }));

      if (koMatchups?.length) {
        const koById = Object.fromEntries(koMatchups.map((m) => [String(m.id), m]));
        parsed = parsed.map((mu) => {
          const ko = koById[String(mu.id)];
          if (!ko) return mu;
          return {
            ...mu,
            homeKo: ko.homeKo || ko.home,
            awayKo: ko.awayKo || ko.away,
            home: ko.home || mu.home,
            away: ko.away || mu.away
          };
        });
      }

      pinMatchupsBySport[sid] = parsed;
    } catch (e) {
      pinMatchupsBySport[sid] = [];
    }
  }

  const pinSoccer = pinMatchupsBySport[29] || [];
  const pinKoHangul = pinSoccer.filter((m) => hasHangul(m.home) || hasHangul(m.away)).length;
  const pinBaseball = pinMatchupsBySport[3] || [];
  const pinBasketball = pinMatchupsBySport[4] || [];
  const pinEsports = pinMatchupsBySport[12] || [];
  const pinTennis = pinMatchupsBySport[33] || [];

  const btiAll = await getBtiPrematchMatchups(btiTab.id, btiTab.url);
  let btiApiOrigin = lastBtiPrematchDiag.apiOrigin || '';
  try {
    if (!btiApiOrigin) btiApiOrigin = await resolveBtiApiOrigin(btiTab.id, btiTab.url);
  } catch (_) {}

  const teamMatched = countTeamMatches(pinSoccer, btiAll, 29)
    + countTeamMatches(pinBaseball, btiAll, 3)
    + countTeamMatches(pinBasketball, btiAll, 4)
    + countTeamMatches(pinEsports, btiAll, 12)
    + countTeamMatches(pinTennis, btiAll, 33);
  const btiWithMarkets = countBtiWithMarkets(btiAll);
  const btiEnriched = btiAll.filter((e) => e.homeEn || e.awayEn).length;

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
      pinKoHangul,
      btiApiOrigin,
      btiDomFallback: false,
      btiDataSource: lastBtiPrematchDiag.dataSource || 'eventlist',
      btiLiveFiltered: lastBtiPrematchDiag.liveFiltered || 0,
      btiFetchErrors: lastBtiPrematchDiag.errors,
      btiFetchSources: lastBtiPrematchDiag.sources,
      teamMatched,
      btiWithMarkets,
      btiEnriched,
      matched: allOpps.length,
      arbOpps: allOpps.length
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

  // 피나클 MAIN world 인터셉터 캐시 (한글 팀명)
  if (msg.type === 'PIN_CACHE_UPDATE') {
    if (msg.sportId && msg.matchups) {
      const prev = pinKoCacheBySport[msg.sportId];
      const koCount = msg.koCount || Object.values(msg.matchups).filter((m) => hasHangul(m.home) || hasHangul(m.away)).length;
      if (!prev || koCount >= (prev.koCount || 0)) {
        pinKoCacheBySport[msg.sportId] = {
          matchups: msg.matchups,
          koCount,
          total: msg.total || Object.keys(msg.matchups).length,
          updatedAt: Date.now(),
          tabId: sender.tab?.id,
          frameId: sender.frameId
        };
      }
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

  // 종목별 프리매치 경기 목록 (수동 매칭)
  if (msg.type === 'GET_PREMATCH_SPORT_LISTS') {
    getPrematchSportLists(msg.sportId || 29, msg.hours || 48)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // 수동 선택 경기 쌍 — 양방 기회 계산
  if (msg.type === 'CHECK_MANUAL_PREMATCH_PAIR') {
    try {
      const { pin, bti, sportId } = msg;
      if (!pin || !bti) {
        sendResponse({ ok: false, error: '경기 미선택' });
        return true;
      }
      const opps = findPrematchArbitrageOpportunities([pin], [bti], sportId || 29);
      sendResponse({ ok: true, opportunities: opps, teamMatch: matchupTeamsMatch(pin, bti) });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
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
          pinNames = parsePinMatchupsFromApi(matchups, 29)
            .slice(0, 10)
            .map((mu) => `${mu.home} vs ${mu.away}`);
        } catch (e) { pinNames = ['PIN 오류: ' + e.message]; }

        // 피나클 한국어 팀명 (iframe 세션)
        let pinKoNames = [];
        let pinKoMerged = [];
        const pinFrames = await findAllPinnacleFrames();
        if (pinFrames.length) {
          const koResult = await fetchPinKoFromAnyFrame(29);
          if (koResult?.ok) {
            pinKoMerged = Object.entries(koResult.matchups).map(([id, m]) => ({
              id, home: m.home, away: m.away, homeKo: m.home, awayKo: m.away,
              homeEn: m.home, awayEn: m.away, sportId: 29
            }));
            pinKoNames = Object.values(koResult.matchups).slice(0, 10).map((m) => `${m.home} vs ${m.away}`);
            const koN = pinKoMerged.filter((m) => hasHangul(m.home) || hasHangul(m.away)).length;
            if (koN === 0) pinKoNames.unshift('⚠️ 한글 팀명 0건 — 피나클 한국어 UI+로그인 확인');
          } else {
            pinKoNames = ['KO 실패: ' + (koResult?.error || '응답 없음') + ` (iframe ${pinFrames.length}개) — 피나클 프리매치에서 축구 클릭 후 F5`];
          }
        } else {
          pinKoNames = ['피나클 탭 없음 — pbc00 피나클(gamecode=1) 또는 pinnacle.com 탭 필요'];
        }

        // BTI 프리매치 전체(축구) + EN 병합
        let btiNames = [];
        let btiEvents = [];
        try {
          const btiAll = await getBtiPrematchMatchups(btiTab.id, btiTab.url);
          btiEvents = btiAll.filter((e) => e.sportId === 29).slice(0, 15);
          btiNames = btiEvents.slice(0, 10).map((ev) => {
            const ko = (ev.home && ev.away) ? `${ev.home} vs ${ev.away}` : '';
            const en = (ev.homeEn && ev.awayEn) ? `${ev.homeEn} vs ${ev.awayEn}` : '';
            if (en && ko && en !== ko) return `KO:${ko} | EN:${en}`;
            return ko || en;
          });
        } catch (e) { btiNames = ['BTI 오류: ' + e.message]; }

        const pinParsed = parsePinMatchupsFromApi(
          await fetchPin('/sports/29/matchups?isLive=false').catch(() => []),
          29
        ).map((mu) => {
          const ko = pinKoMerged.find((k) => String(k.id) === String(mu.id));
          if (!ko) return { ...mu, homeEn: mu.home, awayEn: mu.away };
          return {
            ...mu,
            homeKo: ko.homeKo, awayKo: ko.awayKo,
            home: ko.home || mu.home,
            away: ko.away || mu.away,
            homeEn: mu.home, awayEn: mu.away
          };
        });

        const matchSamples = [];
        for (const bti of btiEvents.slice(0, 15)) {
          for (const pin of pinParsed) {
            if (matchupTeamsMatch(pin, bti)) {
              const pinLabel = hasHangul(pin.home) ? pin.home : (pin.homeEn || pin.home);
              const btiLabel = bti.homeEn || bti.home;
              matchSamples.push(`PIN: ${pinLabel} vs ${pin.away || pin.awayEn} <-> BTI: ${btiLabel} vs ${bti.awayEn || bti.away}`);
              break;
            }
          }
        }

        sendResponse({
          pinSamples: pinNames,
          pinKoSamples: pinKoNames,
          pinCount: pinNames.length,
          pinKoCount: pinKoMerged.length,
          pinKoHangul: pinKoMerged.filter((m) => hasHangul(m.home) || hasHangul(m.away)).length,
          btiSamples: btiNames,
          btiCount: btiNames.length,
          btiEnriched: btiEvents.filter((e) => e.homeEn || e.awayEn).length,
          matchSamples
        });
      } catch(e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
});
