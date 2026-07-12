// popup.js - chrome.scripting.executeScript로 직접 탭에 함수 주입
// BTI 사이트가 chrome.runtime을 재정의하는 문제 우회

const MIN_PROFIT_PCT = 1.0;
const POLL_INTERVAL_MS = 100;

let botRunning = false;
let betInProgress = false;
let pollTimer = null;
let minBetAmount = 12000;
let lastOddsKey = null;
let lastBtiLineKey = null;
let lineTolerance = 0.06;  // 기준점 허용 오차
let manualMarket = null;   // null = 자동 감지, { period, type, side } = 수동 설정
let anchorSite = 'pin';    // 기준 사이트: 'pin' | 'bti' | 'sbo'
let usdtRate = 1400;       // USDT 환율 (원/USDT)

// MutationObserver 메시지로 받은 최신 슬립 캐시
let cachedPinSlip = null;
let cachedBtiSlip = null;
let cachedSboSlip = null;
let pendingPollTrigger = false;

// 자동 서치 상태
let searchRunning = false;
let selectedOpp = null;

// background 메시지 수신 (ODDS_CHANGED + SEARCH_RESULT)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ODDS_CHANGED') {
    if (msg.source === 'pinnacle' && msg.slip) {
      const prevKey = cachedPinSlip ? cachedPinSlip.marketKey : null;
      cachedPinSlip = msg.slip;
      // 피나클 클릭 시 BTI 자동 반대편 담기 (autoMirror ON 시)
      if (autoMirrorEnabled && msg.slip.marketKey && msg.slip.marketKey !== prevKey) {
        autoMirrorToBti(msg.slip);
      }
    }
    if (msg.source === 'bti' && msg.slip) cachedBtiSlip = msg.slip;
    if (msg.source === 'sbobet' && msg.slip) cachedSboSlip = msg.slip;
    if (botRunning && !betInProgress && !pendingPollTrigger) {
      pendingPollTrigger = true;
      setTimeout(() => { pendingPollTrigger = false; pollLoop(); }, 0);
    }
    return;
  }
  if (msg.type === 'SEARCH_RESULT') {
    renderSearchResult(msg);
    if (msg.stats) addLog(`서치: 피나클 ${(msg.stats.pinSoccer||0)+(msg.stats.pinBaseball||0)+(msg.stats.pinBasketball||0)}경기 / BTI ${msg.stats.btiTotal||0}경기 / 매칭 ${msg.stats.matched||0}개`, 'info');
    return;
  }
  if (msg.type === 'SEARCH_ERROR') {
    addLog('서치 오류: ' + msg.error, 'error');
    return;
  }
  if (msg.type === 'PREMATCH_SEARCH_RESULT') {
    renderPrematchResult(msg);
    if (msg.stats) {
      const s = msg.stats;
      addLog(`프리매치: 피나클 ${s.pinTotal||0}경기 / BTI ${s.btiTotal||0}경기 / 매칭 ${s.matched||0}개`, 'info');
    }
    return;
  }
  // 미리보기 업데이트
  if (!botRunning) {
    const p = cachedPinSlip, b = cachedBtiSlip;
    const profit = (p && b && p.odds > 1 && b.odds > 1) ? calcProfit(p.odds, b.odds) : null;
    updateUI(p, b, profit);
  }
});

// 라인 정규화: 소수점 반올림 오차 제거 (8.5 vs 8.51 등)
function normalizeLine(line) {
  if (line === null || line === undefined) return null;
  return Math.round(line * 4) / 4;  // 0.25 단위 반올림
}

// 두 라인이 허용 오차 이내인지 확인
function linesMatch(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= lineTolerance;
}

// 마켓 키 일치 여부 (타입/기간/방향 일치 + 기준점 허용 오차)
// side 반전 맵
const SIDE_OPPOSITE = { home: 'away', away: 'home', h: 'a', a: 'h', o: 'u', u: 'o' };

// 0.25/0.75 쿼터 라인 여부 확인
function isQuarterLine(line) {
  if (line === null || line === undefined) return false;
  const abs = Math.abs(line) % 1;
  return Math.abs(abs - 0.25) < 0.01 || Math.abs(abs - 0.75) < 0.01;
}

function normMatchTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9가-힣]/g, '');
}

function sameTeamName(a, b) {
  const na = normMatchTeamName(a);
  const nb = normMatchTeamName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const minLen = Math.min(na.length, nb.length);
  const maxLen = Math.max(na.length, nb.length);
  // 슬립 전체 텍스트(양 팀명 포함)가 짧은 팀명과 부분일치하는 오탐 방지
  if (maxLen > 50 && minLen < 30) return false;
  if (maxLen > minLen * 2.5 && minLen < 25) return false;
  return na.includes(nb) || nb.includes(na);
}

function isSlipBlobText(text) {
  const t = String(text || '');
  if (t.length > 45) return true;
  if (/머니\s*라인|money\s*line|moneyline|핸디캡|handicap|최대\s*베팅|@\s*\d|\bMLB\b|\bNFL\b|\bNBA\b/i.test(t)) return true;
  if ((t.match(/[-–—]/g) || []).length >= 2) return true;
  return false;
}

function resolveSelectedTeam(slip) {
  if (!slip) return '';
  const fromField = cleanSelectedTeamName(slip.selectedTeam || '');
  if (fromField && !isSlipBlobText(fromField) && !/^\d+(\.\d+)?$/.test(fromField)) return fromField;

  const side = String(slip.side || '').toLowerCase();
  if ((side === 'home' || side === 'h') && slip.homeTeam) return slip.homeTeam;
  if ((side === 'away' || side === 'a') && slip.awayTeam) return slip.awayTeam;

  const direct = cleanSelectedTeamName(slip.selectionText || '');
  if (direct && !isSlipBlobText(direct) && !/^\d+(\.\d+)?$/.test(direct)) return direct;
  return '';
}

function parseEventTeams(text) {
  const raw = String(text || '').trim();
  if (!raw) return { homeTeam: '', awayTeam: '' };
  const parts = raw.split(/\s+vs\s+|\s+VS\s+|\s+v\s+/i).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { homeTeam: parts[0], awayTeam: parts[1] };
  return { homeTeam: '', awayTeam: '' };
}

function cleanSelectedTeamName(text) {
  return String(text || '')
    .replace(/\s*[+-]?\d+\.?\d*\s*$/,'')
    .replace(/^(오버|언더|over|under)\s*\d+\.?\d*/i, '')
    .replace(/^(홈|어웨이|home|away)\s*/i, '')
    .trim();
}

function inferSelectedTeam(slip) {
  return resolveSelectedTeam(slip);
}

// side 정규화 (over/under ↔ o/u)
function normOuSide(s) {
  const x = String(s || '').toLowerCase();
  if (x === 'under' || x === 'u') return 'u';
  if (x === 'over' || x === 'o') return 'o';
  return x;
}

function marketsMatch(p, b) {
  if (!p || !b) return false;
  if (p.marketKind !== b.marketKind) return false;
  // ── 0.25/0.75 쿼터 핸디캡 제외 ──────────────────────────────────
  if (p.marketKind === 'ah' || b.marketKind === 'ah') {
    if (isQuarterLine(p.line) || isQuarterLine(b.line)) return false;
  }
  // period 불일치: ft vs '' 또는 ft vs undefined는 동일 취급
  // period 정규화: ft/full 동일 취급, map1=ft(전체 경기), mapN은 서로 일치해야 함
  const normPeriod = (v) => {
    if (!v || v === 'ft' || v === 'full') return 'ft';
    if (v === 'map1') return 'ft';
    return v;
  };
  if (normPeriod(p.period) !== normPeriod(b.period)) return false;

  if (p.marketKind === 'ml') {
    const pSide = (p.side || '').toLowerCase();
    const bSide = (b.side || '').toLowerCase();
    if (pSide === 'draw' || bSide === 'draw') return true;

    const pSelected = inferSelectedTeam(p);
    const bSelected = inferSelectedTeam(b);
    const isHome = (s) => s === 'home' || s === 'h';
    const isAway = (s) => s === 'away' || s === 'a';

    if (pSelected && bSelected) {
      const pTeams = (p.homeTeam && p.awayTeam) ? { homeTeam: p.homeTeam, awayTeam: p.awayTeam } : parseEventTeams(p.eventText);
      const bTeams = (b.homeTeam && b.awayTeam) ? { homeTeam: b.homeTeam, awayTeam: b.awayTeam } : parseEventTeams(b.eventText);
      if (pTeams.homeTeam && pTeams.awayTeam && bTeams.homeTeam && bTeams.awayTeam) {
        const sameOrder = sameTeamName(pTeams.homeTeam, bTeams.homeTeam) && sameTeamName(pTeams.awayTeam, bTeams.awayTeam);
        const reversedOrder = sameTeamName(pTeams.homeTeam, bTeams.awayTeam) && sameTeamName(pTeams.awayTeam, bTeams.homeTeam);
        if (sameOrder || reversedOrder) {
          return !sameTeamName(pSelected, bSelected);
        }
      }
      // 같은 경기인데 선택 팀명만 다르면 양방 (BTI side가 home으로 잘못 파싱되는 경우 보정)
      if (!sameTeamName(pSelected, bSelected)) return true;
    }

    return (isHome(pSide) && isAway(bSide)) || (isAway(pSide) && isHome(bSide));
  }

  if (p.marketKind === 'ah') {
    const bLineNorm = b.line !== null ? -b.line : null;
    return linesMatch(p.line, b.line) || linesMatch(p.line, bLineNorm);
  }

  if (p.marketKind === 'ou') {
    const pOu = normOuSide(p.side);
    const bOu = normOuSide(b.side);
    if (pOu !== 'o' && pOu !== 'u') return false;
    if (bOu !== 'o' && bOu !== 'u') return false;
    // 양방: 오버↔언더 반대 + 같은 기준점
    if (pOu === bOu) return false;
    return linesMatch(p.line, b.line);
  }

  return linesMatch(p.line, b.line);
}

/** marketsMatch 실패 이유 — 로그용 (라벨이 같아도 원인 구분) */
function explainMarketMismatch(p, b) {
  const pLabel = marketKeyToLabel(p.marketKey || buildMarketKey(p.period, p.marketKind, p.side, p.line));
  const bLabel = marketKeyToLabel(b.marketKey || buildMarketKey(b.period, b.marketKind, b.side, b.line));

  if (!p || !b) return '슬립 정보 부족';
  if (p.marketKind !== b.marketKind) {
    return `마켓 종류 다름 — 피나클: ${pLabel} / BTI: ${bLabel}`;
  }
  const normPeriod = (v) => {
    if (!v || v === 'ft' || v === 'full') return 'ft';
    if (v === 'map1') return 'ft';
    return v;
  };
  if (normPeriod(p.period) !== normPeriod(b.period)) {
    return `기간 다름 — 피나클: ${pLabel} / BTI: ${bLabel}`;
  }
  if (p.marketKind === 'ml') {
    const pSelected = inferSelectedTeam(p);
    const bSelected = inferSelectedTeam(b);
    const pSide = (p.side || '').toLowerCase();
    const bSide = (b.side || '').toLowerCase();
    const isHome = (s) => s === 'home' || s === 'h';
    const isAway = (s) => s === 'away' || s === 'a';
    if (pSelected && bSelected && sameTeamName(pSelected, bSelected)) {
      return `양쪽 같은 팀 — 피나클: ${pSelected} / BTI: ${bSelected} (한쪽은 반대 팀을 담아야 양방입니다)`;
    }
    if ((isHome(pSide) && isHome(bSide)) || (isAway(pSide) && isAway(bSide))) {
      const teams = pSelected && bSelected ? `피나클=${pSelected}, BTI=${bSelected}` : '홈↔어웨이 반대로 담기';
      return `양방은 반대편 필요 — 지금 양쪽 모두 ${pLabel.includes('홈') ? '홈' : '어웨이'} (${teams})`;
    }
  }
  if (p.marketKind === 'ah') {
    if (isQuarterLine(p.line) || isQuarterLine(b.line)) return '0.25/0.75 핸디캡은 제외됩니다';
    return `핸디 기준점 불일치 — 피나클: ${pLabel} / BTI: ${bLabel}`;
  }
  if (p.marketKind === 'ou') {
    const pOu = normOuSide(p.side);
    const bOu = normOuSide(b.side);
    const ouKr = (s) => (s === 'o' ? '오버' : s === 'u' ? '언더' : s);
    if (pOu === bOu) {
      return `양방은 오버↔언더 반대 필요 — 지금 양쪽 ${ouKr(pOu)} ${p.line ?? ''}`;
    }
    if (!linesMatch(p.line, b.line)) {
      return `OU 기준점 불일치 — 피나클: ${pLabel} / BTI: ${bLabel}`;
    }
  }
  return `조건 불일치 — 피나클: ${pLabel} / BTI: ${bLabel}`;
}

// 피나클 계열 도메인 (eviran66, mervani99, auremi88 + 직접 pinnacle.com)
const PINNACLE_PATTERNS = ['eviran66.com', 'mervani99.com', 'auremi88.com', 'pinnacle.com', 'eviran', 'mervani'];
// BTI 계열 도메인 (prod188 포함 모든 bti-sports.io 서브도메인 + live8588.com AVA BTI + fxf774.com)
const BTI_PATTERNS = ['bti-sports.io', 'bti-sports.com', 'indonesiawinner.com', 'live8588.com', 'fxf774.com', 'eviran66.com', 'auremi88.com'];
// SBOBET 계열 도메인 (wg88ss.com 안 iframe: zzllrrcc33.com)
const SBOBET_PATTERNS = ['zzllrrcc33.com', 'jjddgg.com', 'zzddqq.com', 'sports-sbomaind-play'];
const SBOBET_WRAPPER_PATTERNS = ['wg88ss.com'];
function isSbobetUrl(url) { return url && SBOBET_PATTERNS.some(p => url.includes(p)); }
function isSbobetWrapperUrl(url) { return url && SBOBET_WRAPPER_PATTERNS.some(p => url.includes(p)); }
// pbc00.com = 피나클/BTI 공용 래퍼 사이트
const WRAPPER_PATTERNS = ['pbc00.com'];
const PINNACLE_WRAPPER_PATTERNS = ['pbc00.com'];  // pbc00.com 안에 피나클 iframe
const BTI_WRAPPER_PATTERNS = ['pbc00.com'];       // pbc00.com 안에 BTI iframe도 있음

// 피나클 URL 판별 - account/my-bets 등 비게임 페이지 제외
const PINNACLE_EXCLUDE = ['/account/', '/my-bets', '/login', '/register', '/deposit', '/withdraw'];
function isPinnacleUrl(url) { return url && PINNACLE_PATTERNS.some(p => url.includes(p)); }
function isPinnacleGameUrl(url) {
  if (!isPinnacleUrl(url)) return false;
  if (PINNACLE_EXCLUDE.some(e => url.includes(e))) return false;
  return true;
}
// pbc00.com URL에서 gamecode로 피나클 구분 (gamecode=1 = 피나클)
function isPbcPinnacleUrl(url) {
  if (!url || !url.includes('pbc00.com')) return false;
  const m = url.match(/[?&]gamecode=(\d+)/);
  // gamecode=1 = 피나클, gamecode=19 = BTI (필요시 확장)
  return m ? ['1','2','3','4','5'].includes(m[1]) : false;
}
function isBtiUrl(url) { return url && BTI_PATTERNS.some(p => url.includes(p)); }
function isBtiFrameUrl(url) {
  if (!url || url === 'about:blank') return false;
  if (isBtiUrl(url)) return true;
  try {
    const u = new URL(url);
    if (/polymarket\.com|pinnacle\.com/i.test(u.hostname)) return false;
    const path = u.pathname.toLowerCase();
    return /sportsbook|asian-view/i.test(path)
      || ((u.hostname.includes('bti-sports') || u.hostname.includes('live8588') || u.hostname.includes('fxf774'))
          && /\/sports(?:\/|$)/i.test(path));
  } catch (_) {
    return false;
  }
}

/** 배당 텍스트 파싱 — 1.8, 1.80, 2.525 모두 허용 */
function parseOddsValue(txt) {
  const t = String(txt || '').trim();
  const n = parseFloat(t);
  if (!n || n <= 1.01 || n >= 100) return null;
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return null;
  return n;
}

async function getAllFrames(tabId) {
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => resolve(frames || []));
  });
}

async function readBtiSlipFromFrame(tabId, frameId) {
  try {
    const msg = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'READ_SLIP' }, { frameId }, (res) => resolve(res));
    });
    if (msg?.slip?.odds > 1) return msg.slip;
  } catch (_) {}
  return execInTab({ id: tabId, frameId }, btiReadSlipFn);
}
// pbc00.com URL에서 gamecode로 BTI/피나클 구분 (gamecode=19 → BTI, gamecode=1 → 피나클)
function isPbcBtiUrl(url) {
  if (!url || !url.includes('pbc00.com')) return false;
  // gamecode=19 = BTI, gamecode=1 = 피나클 (필요시 확장)
  const m = url.match(/[?&]gamecode=(\d+)/);
  if (m) return ['19','20','21','22','23'].includes(m[1]);  // BTI gamecode 목록
  // gamecode 없으면 iframe URL로 판단
  return false;
}

// ─── 탭 탐색 ─────────────────────────────────────────────────────────
// 반환: { pinTab, pinSlipTab, btiTab }
// pinTab/pinSlipTab: 피나클 슬립이 있는 mervani99.com iframe (pbc00.com wrapper)
// btiTab: BTI 슬립 (직접 탭 또는 pbc00.com wrapper 안 iframe)
async function findTabs() {
  const tabs = await chrome.tabs.query({});
  let pinTab = null, pinSlipTab = null, btiTab = null, sboTab = null;

  const allDirectPin = tabs.filter(t => isPinnacleGameUrl(t.url));
  const directPin = allDirectPin.length > 0 ? allDirectPin[allDirectPin.length - 1] : null;
  if (directPin) {
    pinTab = { ...directPin, frameId: 0 };
    pinSlipTab = { ...directPin, frameId: 0 };
  }

  const directBti = tabs.find(t => isBtiUrl(t.url) && !t.url.includes('pbc00.com'));
  if (directBti) btiTab = { ...directBti, frameId: 0 };

  const directSbo = tabs.find(t => isSbobetUrl(t.url));
  if (directSbo) sboTab = { ...directSbo, frameId: 0 };

  const scorePbcBti = (url) => {
    const m = url.match(/[?&]gamecode=(\d+)/);
    return m && ['19', '20', '21', '22', '23'].includes(m[1]) ? 10 : 1;
  };
  const allPbcTabs = tabs
    .filter(t => t.url && t.url.includes('pbc00.com'))
    .sort((a, b) => scorePbcBti(b.url) - scorePbcBti(a.url));
  const allWgTabs = tabs.filter(t => t.url && isSbobetWrapperUrl(t.url));

  for (const wTab of [...allPbcTabs, ...allWgTabs]) {
    const frames = await getAllFrames(wTab.id);
    for (const frame of frames) {
      if (isPinnacleGameUrl(frame.url) && !frame.url.includes('dp-iframe')) {
        pinTab = { id: wTab.id, url: frame.url, frameId: frame.frameId };
        pinSlipTab = pinTab;
      }
      if (!btiTab && isBtiFrameUrl(frame.url)) {
        btiTab = { id: wTab.id, url: frame.url, frameId: frame.frameId };
      }
      if (!sboTab && isSbobetUrl(frame.url)) {
        sboTab = { id: wTab.id, url: frame.url, frameId: frame.frameId };
      }
    }
  }

  // BTI iframe URL 미매칭 시 — pbc00 모든 프레임에서 슬립 프로브
  if (!btiTab && allPbcTabs.length) {
    for (const pbc of allPbcTabs) {
      const frames = await getAllFrames(pbc.id);
      const ordered = [...frames].sort((a, b) => (a.frameId === 0 ? 1 : 0) - (b.frameId === 0 ? 1 : 0));
      for (const frame of ordered) {
        const slip = await readBtiSlipFromFrame(pbc.id, frame.frameId);
        if (slip && slip.odds > 1) {
          btiTab = { id: pbc.id, url: frame.url || pbc.url, frameId: frame.frameId };
          cachedBtiSlip = slip;
          break;
        }
      }
      if (btiTab) break;
    }
  }

  return { pinTab, pinSlipTab, btiTab, sboTab };
}

// ─── 마켓 매칭 키 생성 헬퍼 ──────────────────────────────────────────
function buildMarketKey(period, type, side, line) {
  if (type === 'ml') return `${period}_ml_${side}`;
  const normLine = normalizeLine(line);
  if (type === 'ah') return `${period}_ah_${side}_${normLine}`;
  if (type === 'ou') return `${period}_ou_${side}_${normLine}`;
  return `${period}_${type}_${side}`;
}

// ─── BTI 기준점으로 피나클 배당판 자동 클릭 함수 (iframe에 주입) ────
function pinnacleClickLineFn(line, side) {
  const sideKr = side === 'u' ? '언더' : '오버';
  const sideEn = side === 'u' ? 'under' : 'over';

  // 현재 슬립에 담긴 종목 확인 (이미 같은 기준점이면 클릭 불필요)
  const slip = document.querySelector('[class*="BetSlipStyled"]');
  if (slip) {
    const slipText = slip.textContent || '';
    const lineInSlip = slipText.match(/(?:오버|언더)[\s]+([\d]+\.?[\d]*)/i);
    if (lineInSlip) {
      const currentLine = parseFloat(lineInSlip[1]);
      const currentSide = slipText.toLowerCase().includes('언더') ? 'u' : 'o';
      if (Math.abs(currentLine - line) < 0.01 && currentSide === side) {
        return { clicked: false, reason: 'already_correct', currentLine, currentSide };
      }
    }
  }

  // 버튼 텍스트 기반 매칭 (피나클은 id가 비어있음)
  // 예: "언더 2.51.909" 또는 "언더 2.5 1.909" 형태
  const allBtns = document.querySelectorAll('button');
  let targetBtn = null;
  const lineStr = String(line);

  for (const btn of allBtns) {
    const txt = btn.textContent.trim();
    const hasSide = txt.includes(sideKr) || txt.toLowerCase().includes(sideEn);
    if (!hasSide) continue;
    // 기준점 포함 여부: "2.5" 문자열이 텍스트에 있는지
    if (txt.includes(lineStr)) {
      // 부킹 라인 제외 ("부킹" 포함 버튼은 스킬립 용 버튼이 아님)
      if (txt.includes('부킹')) continue;
      targetBtn = btn;
      break;
    }
  }

  if (!targetBtn) {
    return { clicked: false, reason: 'not_found' };
  }

  // 이미 selected 상태면 클릭하지 않음 (토글 해제 방지)
  const isAlreadySelected = targetBtn.className.split(' ').some(c => c.startsWith('selected-'));
  if (isAlreadySelected) {
    return { clicked: false, reason: 'already_correct' };
  }

  targetBtn.click();
  return { clicked: true, line, side };
}

// ─── BTI 기준점 변경 감지 및 피나클 슬립 동기화 ────────────────────
// 반환값: 'synced' | 'already_correct' | 'stop' | 'error'
async function syncPinnacleToLine(pinTab, btiSlip) {
  if (!btiSlip || btiSlip.marketKind !== 'ou' || btiSlip.line == null) return 'error';
  const bOu = normOuSide(btiSlip.side);
  const pinSide = bOu === 'u' ? 'o' : 'u';
  const pinSideKr = pinSide === 'u' ? '언더' : '오버';
  const result = await execInTab(pinTab, pinnacleClickLineFn, [btiSlip.line, pinSide]);
  if (!result) return 'error';
  if (result.clicked) {
    addLog(`🔄 피나클 기준점 동기화: ${pinSideKr} ${btiSlip.line}으로 변경`, 'info');
    return 'synced';
  }
  if (result.reason === 'already_correct') return 'already_correct';
  if (result.reason === 'not_found') {
    addLog(`🛑 피나클에 ${pinSideKr} ${btiSlip.line} 없음 → 봇 정지`, 'error');
    return 'stop';
  }
  return 'error';
}

// ─── 피나클 슬립 읽기 함수 (mervani99.com iframe에 주입) ─────────────
// ─── 피나클 슬립 읽기 함수 (pinnacle.com 직접 탭에 주입) ─────────────
// 실제 DOM 구조: 선택된 버튼에 "selected-" 클래스 추가 + 오른쪽 슬립 패널
function pinnacleReadSlipFn() {
  function pinTeamsMatch(a, b) {
    const na = (a || '').replace(/\s/g, '').toLowerCase();
    const nb = (b || '').replace(/\s/g, '').toLowerCase();
    if (!na || !nb) return false;
    return na === nb || na.includes(nb) || nb.includes(na);
  }

  // 피나클 슬립 패널 전체 텍스트 → 팀명/선택팀 추출
  // 예: "라이브토론토 블루제이스 - 샌디에이고 파드리스머니 라인 – 게임 – MLB샌디에이고 파드리스 1.763"
  function parsePinSlipCard(full) {
    let raw = String(full || '').split(/최대\s*베팅/)[0].replace(/\s+/g, ' ').trim();
    raw = raw.replace(/\d+\.\d{2,4}\s*$/, '').trim();
    raw = raw.replace(/^라이브\s*/i, '');

    const marketRe = /(?:머니\s*라인|money\s*line|moneyline|핸디캡|handicap|오버\s*\/\s*언더|over\s*\/\s*under)/i;
    const parts = raw.split(marketRe);
    const eventPart = (parts[0] || '').trim();
    const afterMarket = parts.slice(1).join(' ').trim();

    let awayTeam = '';
    let homeTeam = '';
    const em = eventPart.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (em) {
      awayTeam = em[1].trim();
      homeTeam = em[2].trim();
    }

    let selectedTeam = '';
    const tail = afterMarket
      .replace(/[–—-]\s*게임\s*[–—-]?/gi, ' ')
      .replace(/\b(MLB|NFL|NBA|NHL|KBO|NPB|EPL|UCL)\b/gi, ' ')
      .replace(/[–—-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    for (const team of [homeTeam, awayTeam]) {
      if (team && tail && pinTeamsMatch(tail, team)) {
        selectedTeam = team;
        break;
      }
    }
    if (!selectedTeam && tail.length >= 2 && tail.length <= 40 && !/머니|money|핸디|오버|언더/i.test(tail)) {
      selectedTeam = tail;
    }

    let side = 'home';
    if (selectedTeam && awayTeam && pinTeamsMatch(selectedTeam, awayTeam)) side = 'away';
    else if (selectedTeam && homeTeam && pinTeamsMatch(selectedTeam, homeTeam)) side = 'home';

    return {
      awayTeam,
      homeTeam,
      selectedTeam,
      side,
      eventText: awayTeam && homeTeam ? `${awayTeam} vs ${homeTeam}` : eventPart
    };
  }

  // ── 슬립 패널 우선 탐색 (오른쪽 베팅 슬립 패널) ──
  // 피나클 라이브: 오른쪽 패널에 선택된 종목 표시 (class에 BetSlip, betslip, slip 포함)
  const slipPanelSelectors = [
    '[class*="BetSlipStyled"]',
    '[class*="betslip"]',
    '[class*="BetSlip"]',
    '[class*="slip-panel"]',
    '[class*="SlipPanel"]',
    '[class*="bet-slip"]',
    '[class*="betSlip"]',
    '[data-testid*="betslip"]',
    '[data-testid*="BetSlip"]'
  ];
  for (const sel of slipPanelSelectors) {
    const panels = document.querySelectorAll(sel);
    for (const panel of panels) {
      if (!panel.offsetParent) continue; // 숨겨진 패널 제외
      const panelText = panel.textContent || '';
      if (panelText.length < 5 || panelText.length > 5000) continue;
      // 배당 추출: 소수점 3자리 숫자 (1.xxx ~ 9.xxx)
      const oddsNums = (panelText.match(/\b([1-9]\d*\.\d{2,4})\b/g) || [])
        .map(parseFloat)
        .filter(n => n > 1.01 && n < 50);
      if (!oddsNums.length) continue;
      const odds = oddsNums[oddsNums.length - 1];
      // 마켓 타입 판별
      function _detectType(t) {
        const tl = t.toLowerCase();
        if (tl.includes('머니 라인') || tl.includes('money line') || tl.includes('moneyline') || tl.includes('승패')) return 'ml';
        if (tl.includes('핸디캡') || tl.includes('handicap')) return 'ah';
        if (tl.includes('오버') || tl.includes('언더') || /\bover\b|\bunder\b/i.test(tl)) return 'ou';
        return 'ml';
      }
      function _detectPeriod(t) {
        const tl = t.toLowerCase();
        if (tl.includes('전반전') || tl.includes('1st half')) return '1h';
        if (tl.includes('후반전') || tl.includes('2nd half')) return '2h';
        return 'ft';
      }
      function _detectSide(t, type) {
        const tl = t.toLowerCase();
        if (type === 'ou') return (tl.includes('언더') || /\bunder\b/.test(tl)) ? 'u' : 'o';
        if (tl.includes('무승부') || /\bdraw\b/.test(tl)) return 'draw';
        if (tl.includes('어웨이') || /\baway\b/.test(tl)) return 'away';
        return 'home';
      }
      function _detectLine(t) {
        const m = t.match(/(?:오버|언더|over|under)[\s]*([+-]?[\d]+\.?[\d]*)/i);
        if (m) return parseFloat(m[1]);
        const m2 = t.match(/([+-]\d+\.?\d*)/);
        if (m2) return parseFloat(m2[1]);
        return null;
      }
      const type = _detectType(panelText);
      const period = _detectPeriod(panelText);
      let side = _detectSide(panelText, type);
      const line = _detectLine(panelText);
      const parsed = parsePinSlipCard(panelText);
      if (parsed.selectedTeam) {
        side = parsed.side || side;
      }
      const marketKey = type === 'ml' ? `${period}_ml_${side}` :
                        type === 'ah' ? `${period}_ah_${side}_${line}` :
                        `${period}_ou_${side}_${line}`;
      return {
        odds, marketKind: type, period, side, line, marketKey,
        selectionText: parsed.selectedTeam || panelText.substring(0, 80),
        selectedTeam: parsed.selectedTeam,
        homeTeam: parsed.homeTeam,
        awayTeam: parsed.awayTeam,
        eventText: parsed.eventText
      };
    }
  }

  function detectPeriod(text) {
    const t = text.toLowerCase();
    if (t.includes('전반전') || t.includes('1st half') || t.includes('halftime') || t.includes('half time')) return '1h';
    if (t.includes('후반전') || t.includes('2nd half')) return '2h';
    if (/[23]세트|[23]rd set|[23]nd set/i.test(t)) return 'set';
    // 지도/맵 N 판별 (이스포츠 DOTA2, CS2 등)
    const mapM = t.match(/(?:지도|map|game)\s*(\d+)/i);
    if (mapM) return 'map' + mapM[1];
    return 'ft';
  }
  function detectType(text) {
    const t = text.toLowerCase();
    if (t.includes('머니 라인') || t.includes('money line') || t.includes('moneyline')) return 'ml';
    if (t.includes('핸디캡') || t.includes('handicap') || t.includes('아시안')) return 'ah';
    if (t.includes('오버') || t.includes('언더') || t.includes('over/under') ||
        /\bover\b|\bunder\b/i.test(t)) return 'ou';
    if (/총\s*득점|total\s*goals|total\s*points|합계\s*\d/.test(t)) return 'ou';
    return 'ml';
  }
  function detectSide(text, type) {
    const t = text.toLowerCase();
    if (type === 'ou') return (t.includes('언더') || /\bunder\b/.test(t)) ? 'u' : 'o';
    if (type === 'ah') return (t.includes('어웨이') || /\baway\b/.test(t)) ? 'a' : 'h';
    if (t.includes('무승부') || /\bdraw\b/.test(t)) return 'draw';
    if (t.includes('어웨이') || /\baway\b/.test(t)) return 'away';
    return 'home';
  }
  function detectLine(text) {
    const m = text.match(/(?:오버|언더|over|under)[\s]*([+-]?[\d]+\.?[\d]*)/i);
    if (m) return parseFloat(m[1]);
    const m2 = text.match(/([+-]\d+\.?\d*)/);
    if (m2) return parseFloat(m2[1]);
    return null;
  }

  // ── 방식 1: 선택된 배당 버튼 (selected- 클래스) ──
  const allBtns = document.querySelectorAll('button[class*="market-btn"]');
  const selectedBtns = Array.from(allBtns).filter(btn =>
    btn.className.split(' ').some(c => c.startsWith('selected-')) && !btn.disabled
  );

  if (selectedBtns.length > 0) {
    const btn = selectedBtns[0];
    const btnText = btn.textContent || '';

    // 배당 추출: 피나클 버튼 텍스트 구조 "언더 7.51.943" = "마켓명 기준점배당"
    // 기준점: 0.5 단위 (0.5, 1.0, 1.5 ... 7.5, 8.0 등) — 소수점 1자리
    // 배당: 소수점 3자리 (1.943, 2.220 등)
    // 피나클 버튼 텍스트: "오버 8.51.840" — 기준점(8.5)와 배당(1.840)이 공백 없이 연결됨
    // 전략: 버튼 텍스트를 숫자 단위로 분리한 후 배당 추출
    let odds = null;
    const cleanBtnText = btnText.replace(/Odds\s+Decreased/gi,'').replace(/Odds\s+Increased/gi,'').replace(/Market\s+Offline/gi,'');
    // 숫자 단위 분리: 숫자와 숫자 사이에 공백 삽입
    // "오버 8.51.840" → "오버 8.5 1.840"
    // "오버 81.471" → "오버 8 1.471" (정수 기준점 + 소수 배당)
    let spaced = cleanBtnText.replace(/(\d+\.\d+)(\d+\.\d+)/g, '$1 $2');
    // 정수(기준점) + 소수(배당) 분리: 예) "81.471" → "8 1.471"
    // 패턴: 정수 뒤에 바로 1.xxx 형태 배당이 붙은 경우
    spaced = spaced.replace(/(\d+)(1\.\d{3,4})/g, '$1 $2');
    spaced = spaced.replace(/(\d+)(2\.\d{3,4})/g, '$1 $2');
    spaced = spaced.replace(/(\d+)(3\.\d{3,4})/g, '$1 $2');
    spaced = spaced.replace(/(\d+)(4\.\d{3,4})/g, '$1 $2');
    // 모든 숫자 추출
    const allNums = (spaced.match(/\b\d+\.\d+\b/g) || []).map(parseFloat);
    // 기준점 판별: 소수점이 0 또는 5 (즉 0.5 단위)
    const isLine = n => { const dec = Math.round((n % 1) * 100); return dec % 50 === 0; };
    // 배당 후보: 기준점 아닌 것 중 1.01 초과
    const oddsNums = allNums.filter(n => n > 1.01 && !isLine(n));
    if (oddsNums.length > 0) {
      odds = oddsNums[oddsNums.length - 1];
    }
    // 모두 기준점 형태면 (ML 배당 2.00 등) 기준점 제외 없이 추출
    if (!odds) {
      const anyOdds = allNums.filter(n => n > 1.01 && n < 50);
      if (anyOdds.length > 0) odds = anyOdds[anyOdds.length - 1];
    }
    if (!odds) return null;

    // 버튼 텍스트에서 노이즈 제거
    const cleanText = btnText
      .replace(/Odds\s+Decreased/gi, '')
      .replace(/Odds\s+Increased/gi, '')
      .replace(/Market\s+Offline/gi, '')
      .trim();

    // ── 마켓명 추출: 상위 컨테이너 최대 12단계 탐색 ──
    // 피나클 메인/목록 페이지와 경기 상세 페이지 모두 지원
    let marketText = cleanText;
    let foundMarketLabel = '';
    let el = btn.parentElement;
    for (let i = 0; i < 12; i++) {
      if (!el) break;
      const cls = el.className || '';
      const txt = el.textContent || '';
      // 마켓 레이블 div 직접 탐색 (class에 'label' 또는 'title' 포함)
      const labelEl = el.querySelector('[class*="label-"], [class*="title-"], [class*="market-title"], [class*="marketTitle"]');
      if (labelEl) {
        const lt = labelEl.textContent.trim();
        if (lt.includes('오버/언더') || lt.includes('Over/Under') ||
            lt.includes('핸디캡') || lt.includes('Handicap') ||
            lt.includes('머니 라인') || lt.includes('Money Line') ||
            lt.includes('총계') || lt.includes('Total')) {
          foundMarketLabel = lt;
          marketText = lt + ' ' + cleanText;
          break;
        }
      }
      // 컨테이너 텍스트에서 마켓명 키워드 탐색
      if (txt.includes('오버/언더') || txt.includes('Over/Under') ||
          txt.includes('핸디캡') || txt.includes('Handicap') ||
          txt.includes('머니 라인') || txt.includes('Money Line') ||
          txt.includes('총계') || txt.includes('Total Goals') || txt.includes('Total Points')) {
        // 너무 큰 컨테이너(전체 페이지 텍스트) 제외: 텍스트 길이 제한
        if (txt.length < 500) {
          marketText = txt + ' ' + cleanText;
          break;
        }
        // 큰 컨테이너면 직접 자식 텍스트만 추출
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3 || (n.nodeType === 1 && (n.className||'').includes('label')))
          .map(n => n.textContent || '').join(' ');
        if (directText.trim()) { marketText = directText + ' ' + cleanText; break; }
      }
      el = el.parentElement;
    }

    // ── 마켓명 미발견 시: 버튼 텍스트에서 직접 판별 ──
    // 피나클 버튼 텍스트 예시:
    //   OU: "오버 5.51.910" / "언더 5.51.970" / "Over 5.5 1.910"
    //   AH: "+1.51.850" / "-1.51.970" / "홈팀 +1.5 1.850"
    //   ML: "1.970" (숫자만, 팀명 없음)
    if (!foundMarketLabel) {
      const rawClean = cleanText.replace(/\s+/g, ' ');
      if (/(?:오버|언더|over|under)/i.test(rawClean)) {
        marketText = '오버/언더 ' + rawClean;
      } else if (/[+-]\d+\.?\d*/.test(rawClean)) {
        marketText = '핸디캡 ' + rawClean;
      }
      // 숫자만 있으면 ML (기본값 유지)
    }

    const period = detectPeriod(marketText);
    const type = detectType(marketText);
    let side = detectSide(cleanText, type);
    const line = detectLine(cleanText);
    let selectedTeam = '';
    let homeTeam = '';
    let awayTeam = '';
    let eventText = '';

    // ── ML side 판별: moneyline 컨테이너 내 버튼 순서 기준 ──
    // 피나클 ML: class에 'moneyline' 포함한 컨테이너, 버튼 순서 첫번째=away, 마지막=home
    // 버튼 텍스트에 팀명만 있고 home/away 키워드가 없으므로 버튼 순서 + 행 라벨로 판별
    if (type === 'ml') {
      let foundSide = null;
      let mlContainer = btn.parentElement;
      for (let i = 0; i < 10; i++) {
        if (!mlContainer) break;
        const cls = (mlContainer.className || '').toLowerCase();
        if (cls.includes('moneyline') || cls.includes('money-line')) {
          const mlBtns = Array.from(mlContainer.querySelectorAll('button[class*="market-btn"]'))
            .filter(b => !(b.textContent||'').includes('무승부') && !/draw/i.test(b.textContent||''));
          if (mlBtns.length >= 2) {
            const btnIdx = mlBtns.indexOf(btn);
            if (btnIdx === 0) foundSide = 'away';
            else if (btnIdx === mlBtns.length - 1) foundSide = 'home';
            else foundSide = 'draw';

            const extractRowLabel = (targetBtn) => {
              let row = targetBtn.parentElement;
              for (let j = 0; j < 4 && row; j++) {
                let txt = (row.textContent || '').trim();
                txt = txt.replace(targetBtn.textContent || '', ' ')
                  .replace(/Odds\s+Decreased|Odds\s+Increased|Market\s+Offline/gi, ' ')
                  .replace(/\b\d+\.\d{2,4}\b/g, ' ')
                  .replace(/[+\-]?\d+\.\d+/g, ' ')
                  .replace(/머니\s*라인|money\s*line|핸디캡|handicap|오버\/언더|over\/under|총계|total|무승부|draw|홈|어웨이|home|away/gi, ' ')
                  .replace(/\s+/g, ' ')
                  .trim();
                if (txt && txt.length >= 2 && txt.length <= 40 && /[a-z가-힣]/i.test(txt)) return txt;
                row = row.parentElement;
              }
              return '';
            };

            const firstTeam = extractRowLabel(mlBtns[0]);
            const lastTeam = extractRowLabel(mlBtns[mlBtns.length - 1]);
            if (firstTeam && lastTeam && !sameTeamName(firstTeam, lastTeam)) {
              awayTeam = firstTeam;
              homeTeam = lastTeam;
              eventText = `${homeTeam} vs ${awayTeam}`;
              selectedTeam = btnIdx === 0 ? awayTeam : btnIdx === mlBtns.length - 1 ? homeTeam : '';
            }
          }
          break;
        }
        mlContainer = mlContainer.parentElement;
      }
      if (!foundSide) {
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const ariaNum = ariaLabel.match(/([+-]?\d+)\s*$/);
        if (ariaNum) foundSide = parseInt(ariaNum[1]) > 0 ? 'away' : 'home';
      }
      if (!foundSide) {
        const btnLow = (btn.textContent || '').toLowerCase();
        if (btnLow.includes('어웨이') || /\baway\b/.test(btnLow)) foundSide = 'away';
        else if (btnLow.includes('홈') || /\bhome\b/.test(btnLow)) foundSide = 'home';
      }
      if (foundSide) side = foundSide;
      if (!selectedTeam) {
        if (side === 'home' && homeTeam) selectedTeam = homeTeam;
        if (side === 'away' && awayTeam) selectedTeam = awayTeam;
      }
    }

    const marketKey = type === 'ml' ? `${period}_ml_${side}` :
                      type === 'ah' ? `${period}_ah_${side}_${line}` :
                      `${period}_ou_${side}_${line}`;
    return { odds, marketKind: type, period, side, line, marketKey, selectionText: cleanText, selectedTeam, homeTeam, awayTeam, eventText };
  }

  // ── 방식 2: 오른쪽 슬립 패널 확장 탐색 (BetSlipStyled, betslip, slip 포함 요소) ──
  const slipSelectors2 = [
    '[class*="BetSlipStyled"]',
    '[class*="betslip"]',
    '[class*="BetSlip"]',
    '[class*="slip"]',
    '[class*="Slip"]',
    '.BetslipComponent',
    '#betslipContainer'
  ];
  for (const sel of slipSelectors2) {
    const slips = document.querySelectorAll(sel);
    for (const slip of slips) {
      if (!slip.offsetParent) continue;
      const full = slip.innerText || slip.textContent || '';
      if (full.length < 5 || full.length > 5000) continue;
      let odds = null;
      // 소수점 2~4자리 배당 숫자 탐색 (1.01~50 범위)
      for (const sp of slip.querySelectorAll('span, div')) {
        const t = sp.textContent.trim();
        if (/^\d+\.\d{2,4}$/.test(t)) { const n = parseFloat(t); if (n > 1.01 && n < 50) { odds = n; break; } }
      }
      if (!odds) {
        // 전체 텍스트에서 배당 숫자 추출
        const nums = (full.match(/\b(\d+\.\d{2,4})\b/g) || []).map(parseFloat).filter(n => n > 1.01 && n < 50);
        if (nums.length) odds = nums[nums.length - 1];
      }
      if (!odds) continue;
      const cutIdx = full.indexOf('최대 베팅');
      const cardText = cutIdx > 0 ? full.substring(0, cutIdx) : full.substring(0, 300);
      const period = detectPeriod(cardText);
      const type = detectType(cardText);
      let side = detectSide(cardText, type);
      const line = detectLine(cardText);
      const parsed = parsePinSlipCard(cardText);
      if (parsed.selectedTeam) {
        side = parsed.side || side;
      }
      const marketKey = type === 'ml' ? `${period}_ml_${side}` :
                        type === 'ah' ? `${period}_ah_${side}_${line}` :
                        `${period}_ou_${side}_${line}`;
      return {
        odds, marketKind: type, period, side, line, marketKey,
        selectionText: parsed.selectedTeam || cardText.substring(0, 80),
        selectedTeam: parsed.selectedTeam,
        homeTeam: parsed.homeTeam,
        awayTeam: parsed.awayTeam,
        eventText: parsed.eventText
      };
    }
  }

  return null;
}

// 피나클 베팅 실행 - 완전 동기 방식 (executeScript Promise 직렬화 문제 해결)
// setTimeout 폴링으로 대기 구현, async/await 사용 안 함
function pinnaclePlaceBetFn(amount) {
  // 동기 함수: 금액 입력 후 즉시 버튼 클릭 (executeScript는 동기 반환값만 직렬화 가능)
  try {
    // 1. 금액 입력 input 탐색
    function findStakeInput() {
      // stake/wager 클래스 우선
      const priority = document.querySelector(
        'input[class*="InputWager"], input[class*="stake"], input[class*="Stake"], ' +
        'input[class*="wager"], input[class*="Wager"], input[name="stake"]'
      );
      if (priority && priority.offsetParent !== null) return priority;
      // 화면에 보이는 모든 input 탐색 (검색창 제외)
      const all = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
      for (const inp of all) {
        if (inp.offsetParent === null) continue;
        const cls = (inp.className || '').toLowerCase();
        const ph = (inp.placeholder || '').toLowerCase();
        if (cls.includes('search') || ph.includes('검색') || ph.includes('search')) continue;
        return inp;
      }
      return null;
    }

    const stakeInput = findStakeInput();
    if (stakeInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(stakeInput, String(amount));
      stakeInput.dispatchEvent(new Event('input', { bubbles: true }));
      stakeInput.dispatchEvent(new Event('change', { bubbles: true }));
      stakeInput.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    // 2. 베팅 버튼 탐색 (동기)
    function findBetBtn() {
      const allBtns = Array.from(document.querySelectorAll('button'));
      // 활성화된 버튼만
      const activeBtns = allBtns.filter(b => !b.disabled && !b.hasAttribute('disabled') &&
        !(b.className || '').includes('disabled'));

      // 1순위: fullWidth + 베팅/확인/수락 텍스트
      for (const b of activeBtns) {
        const t = b.textContent.trim();
        const cls = b.className || '';
        if (cls.includes('fullWidth') &&
            (t.includes('베팅') || t.includes('확인') || t.includes('수락') ||
             t.includes('Place') || t.includes('Bet') || t.includes('Accept'))) {
          return b;
        }
      }
      // 2순위: fullWidth 클래스 (텍스트 무관)
      for (const b of activeBtns) {
        if ((b.className || '').includes('fullWidth') && b.textContent.trim().length > 0) {
          return b;
        }
      }
      // 3순위: 싱글베팅/수락/Place Bet 텍스트
      for (const b of activeBtns) {
        const t = b.textContent.trim();
        if (t.includes('싱글 베팅') || t.includes('수락') || t.includes('베팅 확인') ||
            t.includes('Place Bet') || t.includes('Accept')) {
          return b;
        }
      }
      // 4순위: button- 클래스에 베팅/확인 텍스트
      for (const b of activeBtns) {
        const t = b.textContent.trim();
        const cls = b.className || '';
        if (cls.includes('button-') && (t.includes('베팅') || t.includes('확인') || t.includes('싱글'))) {
          return b;
        }
      }
      return null;
    }

    // 금액 입력 후 800ms 폴링으로 버튼 탐색 (주입 시점에는 이미 실행 중)
    // 동기 실행이라 실제 대기는 없지만 입력 이벤트 발사 후 즉시 버튼 클릭
    const betBtn = findBetBtn();
    if (!betBtn) {
      const debugBtns = Array.from(document.querySelectorAll('button')).slice(0, 8)
        .map(b => `"${b.textContent.trim().substring(0,20)}"[${(b.className||'').substring(0,30)}]`).join(' | ');
      const debugInputs = Array.from(document.querySelectorAll('input')).slice(0, 5)
        .map(i => `name=${i.name} ph=${(i.placeholder||'').substring(0,15)} cls=${(i.className||'').substring(0,20)}`).join(' | ');
      return { success: false, reason: `베팅버튼없음 | btns: ${debugBtns} | inputs: ${debugInputs}` };
    }
    betBtn.click();
    return { success: true };
  } catch(e) { return { success: false, reason: e.message }; }
}

// ─── BTI 슬립 읽기 함수 (탭에 주입) ─────────────────────────────────
// 실제 DOM 구조 (진단 결과 기반):
// 슬립 카드 내부에 배당 span이 이미 존재:
//   cls="betslip_fe_UpdateNotificationSecondary_updateNotification..." txt="2.52"
// title[0]: "중신 브라더스 +5.5" (선택명+기준점)
// title[1]: "+5.5" (기준점만)
// title[2]: "[7:1] 라이브 핸디캡 라이브 베팅" (마켓명)
// title[3]: "웨이취엔 드래곤스 vs 중신 브라더스" (이벤트명)
function btiReadSlipFn() {
  function parseOddsLocal(txt) {
    const t = String(txt || '').trim();
    const n = parseFloat(t);
    if (!n || n <= 1.01 || n >= 100) return null;
    if (!/^\d+(\.\d{1,4})?$/.test(t)) return null;
    return n;
  }
  function parseTeamsLocal(text) {
    const raw = String(text || '').trim();
    if (!raw) return { homeTeam: '', awayTeam: '' };
    const parts = raw.split(/\s+vs\s+|\s+VS\s+|\s+v\s+/i).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) return { homeTeam: parts[0], awayTeam: parts[1] };
    return { homeTeam: '', awayTeam: '' };
  }

  // ── 1. 슬립 카드 탐색 ──
  let betCards = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
  let realCards = Array.from(betCards).filter(el =>
    !el.className.includes('wrapper') &&
    !el.className.includes('counter') &&
    !el.className.includes('bageGroup') &&
    !el.className.includes('badge') &&
    !el.className.includes('PlaceBet') &&
    !el.className.includes('Tab')
  );
  // 폴백: 더 넓은 셀렉터로 슬립 카드 탐색
  if (!realCards.length) {
    const fallbackSelectors = [
      '[class*="BetSlip"]',
      '[class*="betslip"]',
      '[class*="bet-slip"]',
      '[class*="betCard"]',
      '[class*="BetCard"]',
      '[class*="ticket"]',
      '[class*="Ticket"]',
      '[class*="slip"]'
    ];
    for (const sel of fallbackSelectors) {
      const els = Array.from(document.querySelectorAll(sel)).filter(el => {
        if (!el.offsetParent) return false;
        const txt = el.textContent || '';
        // 슬립에 유효한 내용이 있는지 (배당 숫자 + 팀명)
        return txt.length > 10 && txt.length < 3000 && /\d+\.\d{2,4}/.test(txt);
      });
      if (els.length) { realCards = els; break; }
    }
  }
  if (!realCards.length) return null;
  const card = realCards[0];

  // ── 2. 슬립 title 파싱 ──
  // title[0]: "중신 브라더스 +5.5" (선택명+기준점)
  // title[1]: "+5.5" (기준점만, 숫자만 있는 경우)
  // title[2]: 마켓명
  // title[3]: 이벤트명
  const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
  const titles = Array.from(titleEls).map(el => el.textContent.trim());

  const selectionText = titles[0] || '';

  // 마켓명: 라이브/핸디캡/승패/오버언더 포함된 title
  let mktText = '';
  for (const t of titles) {
    if (t.includes('핸디캡') || t.includes('승패') || t.includes('오버') || t.includes('언더') ||
        t.includes('handicap') || t.includes('money line') || t.includes('over') || t.includes('under') ||
        t.includes('라이브 베팅') || t.includes('라이브 승패') || t.includes('라이브 핸디')) {
      mktText = t; break;
    }
  }

  // 이벤트명: "팀A vs 팀B" 형태
  let eventText = '';
  for (const t of titles) {
    if (t.includes(' vs ') || t.includes(' VS ')) { eventText = t; break; }
  }
  if (!eventText) {
    const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
    if (eventEl) eventText = eventEl.textContent.trim();
  }

  // 기준점: title[1]이 순수 숫자/기준점이면 사용, 아니면 selectionText에서 추출
  let slipLine = null;
  if (titles[1] && /^[+-]?\d+\.?\d*$/.test(titles[1].trim())) {
    slipLine = parseFloat(titles[1].trim());
  } else {
    const lm = selectionText.match(/([+-]\d+\.?\d*)\s*$/);
    if (lm) slipLine = parseFloat(lm[1]);
  }

  // 팀명: selectionText에서 기준점 제거
  let teamName = selectionText;
  if (slipLine !== null) {
    teamName = selectionText.replace(/\s*[+-]\d+\.?\d*\s*$/, '').trim();
  }

  const allText = selectionText + ' ' + mktText + ' ' + eventText;

  // ── 3. 마켓 타입/period 판별 ──
  // 중요: mktText(실제 마켓명)를 우선 판별하고, mktText에서 판별 안 되면 selectionText 포함 allText로 판별
  // selectionText에 포함된 기준점 숫자(+1.5 등)로 오판하는 버그 방지
  function detectType(text) {
    const t = text.toLowerCase();
    if (t.includes('머니 라인') || t.includes('money line') || t.includes('moneyline') || t.includes('승패')) return 'ml';
    if (t.includes('핸디캡') || t.includes('handicap') || t.includes('아시안')) return 'ah';
    if (t.includes('오버') || t.includes('언더') || t.includes('over') || t.includes('under') || t.includes('총계')) return 'ou';
    return 'ml';
  }
  // mktText 우선 판별 (실제 마켓명 기준)
  let mktType;
  if (mktText) {
    mktType = detectType(mktText);
  } else {
    mktType = detectType(allText);
  }
  function detectPeriod(text) {
    const t = text.toLowerCase();
    if (t.includes('전반전') || t.includes('1st half') || t.includes('1h') || t.includes('halftime')) return '1h';
    if (t.includes('후반전') || t.includes('2nd half') || t.includes('2h')) return '2h';
    if (/[23]세트|[23]rd set|[23]nd set/i.test(t)) return 'set';
    // 맵/지도 N 판별 (BTI: '머니 라인 - 맵 2', '맵 3' 등)
    const mapM = t.match(/(?:맵|map|game|\uc9c0\ub3c4)\s*(\d+)/i);
    if (mapM) return 'map' + mapM[1];
    return 'ft';
  }
  function detectSide(text, type, mSide, lineVal) {
    if (mSide) return mSide;
    const t = text.toLowerCase();
    if (type === 'ou') return (t.includes('언더') || t.includes('under')) ? 'u' : 'o';
    if (type === 'ah') {
      // BTI AH: 어웨이/away 키워드 우선, 없으면 기준점 부호로 판별
      // 기준점 음수(-) = 홈팀 핸디, 양수(+) = 어웨이 핸디
      if (t.includes('어웨이') || t.includes('away')) return 'a';
      if (t.includes('홈') || t.includes('home')) return 'h';
      if (lineVal !== null && lineVal !== undefined) {
        return lineVal < 0 ? 'h' : 'a';
      }
      return 'h';
    }
    if (t.includes('무승부') || t.includes('draw')) return 'draw';
    if (t.includes('어웨이') || t.includes('away')) return 'away';
    return 'home';
  }

  const period = detectPeriod(allText);

  // ── 4. 배당 읽기 ──
  // 우선순위:
  // 1) UpdateNotification span (배당 변경 알림 - 현재 배당)
  // 2) 슬립 카드 내 모든 span에서 배당 숫자 탐색
  // 3) 배당판 버튼에서 팀명+기준점 매칭으로 배당 읽기
  let odds = 0;
  let matchedSide = null;

  // 방법 1: UpdateNotification span
  const updateSpans = card.querySelectorAll('[class*="UpdateNotification"]');
  for (const sp of updateSpans) {
    const n = parseOddsLocal(sp.textContent);
    if (n) { odds = n; break; }
  }

  // 방법 2: 슬립 카드 내 모든 span에서 배당 숫자 탐색
  if (!odds) {
    const allSpans = card.querySelectorAll('span');
    for (const sp of allSpans) {
      const n = parseOddsLocal(sp.textContent);
      if (n) { odds = n; break; }
    }
  }

  // 방법 2b: @ 1.8 형태 (BTI 슬립 푸터)
  if (!odds) {
    const atM = card.textContent.match(/@\s*(\d+(?:\.\d{1,4})?)/);
    if (atM) {
      const n = parseOddsLocal(atM[1]);
      if (n) odds = n;
    }
  }

  // 방법 3: 배당판 버튼에서 팀명+기준점 매칭
  if (!odds) {
    const lineStr = slipLine !== null ? String(Math.abs(slipLine)) : null;
    const teamClean = teamName.replace(/\s+/g, '').toLowerCase();

    // 배당판 버튼 탐색 (master_fe_Selections_selection 우선, 없으면 모든 버튼)
    let btns = Array.from(document.querySelectorAll('[class*="master_fe_Selections_selection"]'));
    if (!btns.length) btns = Array.from(document.querySelectorAll('button'));

    for (const btn of btns) {
      const btnRaw = btn.textContent;
      const btnText = btnRaw.replace(/\s+/g, '').toLowerCase();

      // 팀명 포함 여부 확인 (팀명이 비어있으면 스킵)
      if (teamClean.length > 1 && !btnText.includes(teamClean)) continue;

      // 기준점 일치 확인
      if (lineStr) {
        const ptsEl = btn.querySelector('[class*="points"], [class*="pts"], [class*="handicap"]');
        const ptsText = ptsEl ? ptsEl.textContent.trim() : '';
        if (!btnText.includes(lineStr) && !ptsText.includes(lineStr)) continue;
      }

      // 배당 숫자 추출: 버튼 텍스트 끝에서 소수점 배당
      const oddsMatch = btnText.match(/(\d+(?:\.\d{1,4})?)$/);
      if (!oddsMatch) continue;
      const btnOdds = parseOddsLocal(oddsMatch[1]);
      if (!btnOdds) continue;

      odds = btnOdds;
      break;
    }
  }

  // OU 마켓 side 감지
  const ouMatch = selectionText.match(/(오버|언더|over|under)\s*([\d]+\.?[\d]*)/i);
  if (ouMatch) {
    matchedSide = (ouMatch[1].toLowerCase().includes('언더') || ouMatch[1].toLowerCase() === 'under') ? 'u' : 'o';
    slipLine = parseFloat(ouMatch[2]);
  }

  // ML side 판별: 배당판 버튼 순서 기반 (슬립에 어웨이/홈 키워드 없을 때)
  // BTI 유로피안뷰: MoneyLineSelection_line 컨테이너 첫번째=home, 마지막=away
  if (mktType === 'ml' && !matchedSide) {
    const selLow = selectionText.toLowerCase();
    if (!selLow.includes('어웨이') && !selLow.includes('away') &&
        !selLow.includes('홈') && !selLow.includes('home') &&
        !selLow.includes('무승부') && !selLow.includes('draw')) {
      // 팀명으로만 되어있음: 배당판 버튼 순서로 판별
      const teamCleanLow = teamName.replace(/\s+/g, '').toLowerCase();
      // 유로피안뷰 MoneyLineSelection
      const mlBtns = Array.from(document.querySelectorAll('[class*="MoneyLineSelection_line"]'));
      if (mlBtns.length >= 2) {
        const matchedBtn = mlBtns.find(b => {
          const bt = (b.textContent||'').replace(/\s+/g,'').toLowerCase();
          return teamCleanLow.length > 1 && bt.includes(teamCleanLow);
        });
        if (matchedBtn) {
          const idx = mlBtns.indexOf(matchedBtn);
          if (idx === 0) matchedSide = 'home';
          else if (idx === mlBtns.length - 1) matchedSide = 'away';
        }
      }
      // 아시안뷰 master_fe_Selections_selection
      if (!matchedSide) {
        const asiaBtns = Array.from(document.querySelectorAll('[class*="master_fe_Selections_selection"]'))
          .filter(b => b.querySelector('[class*="Selections_odds"]'));
        if (asiaBtns.length >= 2) {
          const matchedBtn = asiaBtns.find(b => {
            const bt = (b.textContent||'').replace(/\s+/g,'').toLowerCase();
            return teamCleanLow.length > 1 && bt.includes(teamCleanLow);
          });
          if (matchedBtn) {
            const idx = asiaBtns.indexOf(matchedBtn);
            if (idx === 0) matchedSide = 'home';
            else if (idx === asiaBtns.length - 1) matchedSide = 'away';
          }
        }
      }
    }
  }

  const side = detectSide(selectionText, mktType, matchedSide, slipLine);
  const line = slipLine;
  const marketKey = mktType === 'ml'
    ? `${period}_ml_${side}`
    : mktType === 'ah'
    ? `${period}_ah_${side}_${line}`
    : `${period}_ou_${side}_${line}`;

  const parsedTeams = parseTeamsLocal(eventText);
  if (!odds || odds <= 1) return null;
  return {
    odds,
    marketKind: mktType,
    period,
    side,
    line,
    marketKey,
    mktText,
    selectionText,
    selectedTeam: teamName,
    eventText,
    homeTeam: parsedTeams.homeTeam,
    awayTeam: parsedTeams.awayTeam
  };
}

// ─── BTI 베팅 실행 함수 (탭에 주입) ─────────────────────────────────
// targetLine, lineTolerance, targetOdds: 기준점/배당 변경 방어용
// 완전 동기 방식 (executeScript Promise 직렬화 문제 해결)
function btiPlaceBetFn(amount, targetLine, lineTolerance, targetOdds) {
  try {
    // ── 1. 기준점 검증 (베팅 전 슬립 선택명 확인) ──
    if (targetLine !== undefined && targetLine !== null && lineTolerance !== undefined) {
      const betCards = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
      const realCards = Array.from(betCards).filter(el =>
        !el.className.includes('wrapper') && !el.className.includes('counter') &&
        !el.className.includes('bageGroup') && !el.className.includes('badge') &&
        !el.className.includes('PlaceBet') && !el.className.includes('Tab')
      );
      if (realCards.length > 0) {
        const card = realCards[0];
        let selectionText = '';
        const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
        for (const el of titleEls) {
          const t = el.textContent.trim();
          if (t && t !== '라이브' && t.length > 1 && t.length < 50) { selectionText = t; break; }
        }
        if (selectionText) {
          // 부호 포함 라인 추출: "-1.5", "+2.5", "1.5" 모두 처리
          const lineMatch = selectionText.match(/([+-]?[\d]+\.?[\d]*)(?:\s*\/\s*[+-]?[\d]+\.?[\d]*)?$/);
          if (lineMatch) {
            let actualLine = parseFloat(lineMatch[1]);
            // 쿼터 라인 (예: "-1/1.5") 평균 처리
            const quarterM = selectionText.match(/([+-]?[\d]+\.?[\d]*)\s*\/\s*([+-]?[\d]+\.?[\d]*)$/);
            if (quarterM) {
              const sign = quarterM[1].startsWith('-') ? -1 : 1;
              actualLine = sign * (Math.abs(parseFloat(quarterM[1])) + Math.abs(parseFloat(quarterM[2]))) / 2;
            }
            const diff = Math.abs(actualLine - targetLine);
            if (diff > lineTolerance) {
              return { success: false, reason: `⚠️ 기준점 변경: 목표=${targetLine}, 실제=${actualLine}("${selectionText}") → 취소`, lineChanged: true };
            }
          }
        }
      }
    }

    // ── 2. 배당 변경 방어: 슬립 현재 배당이 targetOdds와 다르면 취소 ──
    if (targetOdds && targetOdds > 1) {
      const betCards2 = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
      const realCards2 = Array.from(betCards2).filter(el =>
        !el.className.includes('wrapper') && !el.className.includes('counter') &&
        !el.className.includes('bageGroup') && !el.className.includes('badge') &&
        !el.className.includes('PlaceBet') && !el.className.includes('Tab')
      );
      if (realCards2.length > 0) {
        const card2 = realCards2[0];
        // UpdateNotification 제외한 실제 슬립 배당 읽기
        let currentOdds = 0;
        const allSpans2 = card2.querySelectorAll('span');
        for (const sp of allSpans2) {
          if ((sp.className || '').includes('UpdateNotification')) continue; // 배당변경 알림 제외
          const txt = sp.textContent.trim();
          const n = parseFloat(txt);
          if (n > 1.01 && n < 100 && /^\d+\.\d{2,4}$/.test(txt)) { currentOdds = n; break; }
        }
        if (currentOdds > 1 && Math.abs(currentOdds - targetOdds) > 0.05) {
          return { success: false, reason: `⚠️ 배당 변경: 목표=${targetOdds}, 슬립현재=${currentOdds} → 취소`, oddsChanged: true };
        }
      }
    }

    // ── 3. 금액 입력 ──
    const input = document.getElementById('counter')
      || document.querySelector('input[class*="CounterSecondary_input"], input[placeholder="베팅금"]');
    if (!input) return { success: false, reason: '금액 입력 필드 없음 (input#counter)' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(amount));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // ── 4. 베팅 버튼 탐색 ──
    const allBtns = Array.from(document.querySelectorAll('button')).filter(
      b => !b.disabled && !b.hasAttribute('disabled') && !(b.className || '').includes('disabled')
    );
    let betBtn = null;
    // 1순위: sportsbook-Button + 베팅하기
    for (const btn of allBtns) {
      if ((btn.className || '').includes('sportsbook-Button') && btn.textContent.trim().includes('베팅하기')) {
        betBtn = btn; break;
      }
    }
    // 2순위: PlaceBetBlock 클래스
    if (!betBtn) {
      for (const btn of allBtns) {
        if ((btn.className || '').includes('PlaceBetBlock') && !(btn.className || '').includes('clearAll')) {
          betBtn = btn; break;
        }
      }
    }
    // 3순위: 베팅하기 텍스트
    if (!betBtn) {
      for (const btn of allBtns) {
        const t = btn.textContent.trim();
        if (t === '베팅하기' || t === 'Place Bet' || t === 'Bet Now') { betBtn = btn; break; }
      }
    }
    // 4순위: 베팅 텍스트 포함 (전체/리그/clearAll 제외)
    if (!betBtn) {
      for (const btn of allBtns) {
        const t = btn.textContent.trim();
        const cls = btn.className || '';
        if (t.includes('전체') || t.includes('리그') || t.includes('정리') || cls.includes('clearAll')) continue;
        if (t.includes('베팅') || t.includes('확인')) { betBtn = btn; break; }
      }
    }
    if (!betBtn) {
      const debugBtns = allBtns.slice(0,6).map(b => `"${b.textContent.trim().substring(0,20)}"[${(b.className||'').substring(0,25)}]`).join(' | ');
      return { success: false, reason: `베팅버튼없음 | btns: ${debugBtns}` };
    }
    betBtn.click();
    return { success: true };
  } catch(e) { return { success: false, reason: e.message }; }
}

// ─── scripting.executeScript 래퍼 ────────────────────────────────────
function execInTab(tabInfo, fn, args = []) {
  const tabId = tabInfo.id || tabInfo;
  const frameId = tabInfo.frameId !== undefined ? tabInfo.frameId : 0;
  return new Promise(resolve => {
    chrome.scripting.executeScript(
      { target: { tabId, frameIds: [frameId] }, func: fn, args, world: 'MAIN' },
      results => {
        if (chrome.runtime.lastError || !results || !results[0]) {
          resolve(null);
        } else {
          resolve(results[0].result);
        }
      }
    );
  });
}

function execAsyncInTab(tabInfo, fn, args = []) {
  const tabId = tabInfo.id || tabInfo;
  const frameId = tabInfo.frameId !== undefined ? tabInfo.frameId : 0;
  return new Promise(resolve => {
    chrome.scripting.executeScript(
      { target: { tabId, frameIds: [frameId] }, func: fn, args, world: 'MAIN' },
      results => {
        if (chrome.runtime.lastError || !results || !results[0]) {
          resolve({ ok: false, error: chrome.runtime.lastError?.message || 'inject 실패(frameId=' + frameId + ')' });
          return;
        }
        resolve(results[0].result);
      }
    );
  });
}

// BTI 슬립 배당 파싱 (1.8 / 1.80 / 2.525)
function btiSlipOddsFromTextInject(txt) {
  const t = String(txt || '').trim();
  const n = parseFloat(t);
  if (!n || n <= 1.01 || n >= 100) return 0;
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return 0;
  return n;
}

// BTI iframe 프로브 — 베팅카트(#counter)가 있는 프레임 찾기
function probeBtiBetFrameInject() {
  const slip = document.querySelector('[class*="betslip_fe_BetSecondary_bet"]');
  const realSlip = slip && !String(slip.className || '').includes('wrapper');
  const input = document.getElementById('counter')
    || document.querySelector('input[class*="CounterSecondary_input"], input[placeholder="베팅금"]');
  const betBtn = Array.from(document.querySelectorAll('button')).find((b) =>
    !b.disabled && (b.className || '').includes('sportsbook-Button') && b.textContent.includes('베팅하기'));
  return { hasSlip: !!realSlip, hasInput: !!input, hasBtn: !!betBtn, href: location.href };
}

async function resolveBtiBetTab(btiTab) {
  if (!btiTab?.id) return btiTab;
  if (btiTab.frameId !== undefined && btiTab.frameId !== 0) {
    const direct = await execInTab(btiTab, probeBtiBetFrameInject);
    if (direct?.hasSlip && direct?.hasInput) return btiTab;
  }
  const frames = await getAllFrames(btiTab.id);
  const ordered = [...frames].sort((a, b) => (a.frameId === 0 ? 1 : 0) - (b.frameId === 0 ? 1 : 0));
  for (const frame of ordered) {
    const probe = await execInTab({ id: btiTab.id, frameId: frame.frameId }, probeBtiBetFrameInject);
    if (probe?.hasSlip && probe?.hasInput) {
      return { id: btiTab.id, frameId: frame.frameId, url: frame.url || btiTab.url };
    }
  }
  return btiTab;
}

function btiSlipStabilizeInject(targetOdds) {
  return new Promise((resolve) => {
    const MAX_WAIT = 5000;
    const CHECK_INTERVAL = 80;
    let elapsed = 0;
    function checkReady() {
      const hasUpdateNotif = !!document.querySelector('[class*="UpdateNotification"]');
      const allBtns = Array.from(document.querySelectorAll('button'));
      const betBtn = allBtns.find((b) =>
        !b.disabled && (
          ((b.className || '').includes('sportsbook-Button') && b.textContent.trim().includes('베팅하기')) ||
          ((b.className || '').includes('PlaceBetBlock') && !(b.className || '').includes('clearAll'))
        )
      );
      let curOdds = 0;
      const cards = Array.from(document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]'))
        .filter((el) => !el.className.includes('wrapper') && !el.className.includes('counter') &&
          !el.className.includes('badge') && !el.className.includes('PlaceBet') && !el.className.includes('Tab'));
      if (cards.length > 0) {
        const atM = cards[0].textContent.match(/@\s*(\d+(?:\.\d{1,4})?)/);
        if (atM) curOdds = btiSlipOddsFromTextInject(atM[1]);
        if (!curOdds) {
          for (const sp of cards[0].querySelectorAll('span')) {
            if ((sp.className || '').includes('UpdateNotification')) continue;
            const n = btiSlipOddsFromTextInject(sp.textContent);
            if (n) { curOdds = n; break; }
          }
        }
      }
      const oddsOk = !targetOdds || curOdds === 0 || Math.abs(curOdds - targetOdds) <= 0.06;
      if (betBtn && !hasUpdateNotif && oddsOk) {
        resolve({ ready: true, curOdds, elapsed, frame: location.href });
        return;
      }
      elapsed += CHECK_INTERVAL;
      if (elapsed >= MAX_WAIT) {
        resolve({
          ready: false,
          reason: `타임아웃: UpdateNotif=${hasUpdateNotif}, betBtn=${!!betBtn}, curOdds=${curOdds}, target=${targetOdds}`,
          curOdds, elapsed
        });
        return;
      }
      setTimeout(checkReady, CHECK_INTERVAL);
    }
    checkReady();
  });
}

function btiClickBetBtnInject() {
  return new Promise((resolve) => {
    const MAX_WAIT = 4000;
    const INTERVAL = 100;
    let elapsed = 0;
    function tryClick() {
      try {
        const allBtns = Array.from(document.querySelectorAll('button'));
        let betBtn = null;
        for (const btn of allBtns) {
          if (btn.disabled) continue;
          if ((btn.className || '').includes('sportsbook-Button') && btn.textContent.trim().includes('베팅하기')) {
            betBtn = btn; break;
          }
        }
        if (!betBtn) {
          for (const btn of allBtns) {
            if (btn.disabled) continue;
            if ((btn.className || '').includes('PlaceBetBlock') && !(btn.className || '').includes('clearAll')) {
              betBtn = btn; break;
            }
          }
        }
        if (!betBtn) {
          for (const btn of allBtns) {
            if (btn.disabled) continue;
            const t = btn.textContent.trim();
            if (t === '베팅하기' || t === 'Place Bet' || t === 'Bet Now') { betBtn = btn; break; }
          }
        }
        if (betBtn) {
          betBtn.click();
          resolve({ success: true, btnText: betBtn.textContent.trim().substring(0, 30), elapsed });
          return;
        }
        elapsed += INTERVAL;
        if (elapsed >= MAX_WAIT) {
          const debugBtns = allBtns.filter((b) => b.offsetParent).slice(0, 8)
            .map((b) => `"${b.textContent.trim().substring(0, 20)}"[dis:${b.disabled}]`).join(' | ');
          resolve({ success: false, reason: `베팅버튼없음 | ${debugBtns}` });
          return;
        }
        setTimeout(tryClick, INTERVAL);
      } catch (e) {
        resolve({ success: false, reason: e.message });
      }
    }
    tryClick();
  });
}

function btiConfirmBetInject() {
  return new Promise((resolve) => {
    const MAX_WAIT = 5000;
    const INTERVAL = 150;
    let elapsed = 0;
    function slipRemaining() {
      return Array.from(document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]'))
        .filter((el) => !el.className.includes('wrapper') && !el.className.includes('counter') &&
          !el.className.includes('badge') && !el.className.includes('PlaceBet') && !el.className.includes('Tab')).length;
    }
    function findConfirm() {
      try {
        const allBtns = Array.from(document.querySelectorAll('button'));
        let confirmBtn = null;
        for (const b of allBtns) {
          if (b.disabled) continue;
          const t = b.textContent.trim();
          if (t === '승인' || t === '확인' || t === 'OK' || t === 'Confirm' ||
              t === '베팅 승인' || t === '베팅확인' || t === 'Accept' ||
              t === '베팅 확인' || t === 'Approve') {
            confirmBtn = b; break;
          }
        }
        if (!confirmBtn) {
          const modals = document.querySelectorAll('[class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"], [class*="overlay"], [class*="Overlay"]');
          for (const modal of modals) {
            for (const b of modal.querySelectorAll('button')) {
              if (b.disabled) continue;
              const t = b.textContent.trim();
              if (t.includes('승인') || t.includes('확인') || t.includes('Confirm') || t.includes('Accept')) {
                confirmBtn = b; break;
              }
            }
            if (confirmBtn) break;
          }
        }
        if (confirmBtn) {
          confirmBtn.click();
          setTimeout(() => {
            const left = slipRemaining();
            const okMsg = document.body.innerText.match(/베팅.*(완료|성공|접수)|Bet.*(accepted|placed)/i);
            resolve({
              confirmed: left === 0 || !!okMsg,
              btnText: confirmBtn.textContent.trim().substring(0, 20),
              elapsed,
              slipLeft: left
            });
          }, 400);
          return;
        }
        if (slipRemaining() === 0) {
          resolve({ confirmed: true, btnText: '슬립비움', elapsed });
          return;
        }
        elapsed += INTERVAL;
        if (elapsed >= MAX_WAIT) {
          const left = slipRemaining();
          const okMsg = document.body.innerText.match(/베팅.*(완료|성공|접수)|Bet.*(accepted|placed)/i);
          if (left === 0 || okMsg) {
            resolve({ confirmed: true, btnText: '슬립비움/메시지', elapsed, slipLeft: left });
          } else {
            resolve({ confirmed: false, reason: `승인버튼없음+슬립${left}건`, elapsed, slipLeft: left });
          }
          return;
        }
        setTimeout(findConfirm, INTERVAL);
      } catch (e) {
        resolve({ confirmed: false, reason: e.message });
      }
    }
    findConfirm();
  });
}

async function placeBtiBetViaMessage(btiTab, amount, bSlip) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      btiTab.id,
      {
        type: 'PLACE_BET',
        amount,
        targetLine: bSlip?.line,
        lineTolerance,
        targetOdds: bSlip?.odds
      },
      { frameId: btiTab.frameId || 0 },
      (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, reason: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { success: false, reason: '응답 없음' });
      }
    );
  });
}

// ─── 수익률 계산 ─────────────────────────────────────────────────────
function calcProfit(oddsA, oddsB) {
  const inv = 1 / oddsA + 1 / oddsB;
  return (1 / inv - 1) * 100;
}

// ─── 마켓 키 → 사람이 읽기 좋은 레이블 ──────────────────────────────
function marketKeyToLabel(key) {
  if (!key) return '알 수 없음';
  const parts = key.split('_');
  const periodRaw = parts[0];
  let period;
  if (periodRaw === '1h') period = '전반전';
  else if (periodRaw === '2h') period = '후반전';
  else if (periodRaw && periodRaw.startsWith('map')) period = '지도 ' + periodRaw.slice(3);
  else period = '풀타임';
  const type = parts[1] === 'ml' ? '승패' : parts[1] === 'ah' ? '핸디캡' : '오버/언더';
  const side = parts[2] === 'home' ? '홈' : parts[2] === 'away' ? '어웨이' : parts[2] === 'draw' ? '무승부' : parts[2] === 'h' ? '홈팀' : parts[2] === 'a' ? '어웨이팀' : parts[2] === 'o' ? '오버' : parts[2] === 'u' ? '언더' : parts[2];
  const line = parts[3] ? ` ${parts[3]}` : '';
  return `${period} ${type} ${side}${line}`;
}

// ─── 로그 ─────────────────────────────────────────────────────────────
const MAX_LOG = 100;

function addLog(text, cls = 'log') {
  const entry = { time: new Date().toLocaleTimeString(), text, cls };
  // UI에 추가
  const logEl = document.getElementById('log');
  if (logEl) {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = `[${entry.time}] ${text}`;
    logEl.insertBefore(div, logEl.firstChild);
    while (logEl.children.length > MAX_LOG) logEl.removeChild(logEl.lastChild);
  }
  // storage에 저장
  chrome.storage.local.get(['arbLogs'], result => {
    const logs = result.arbLogs || [];
    logs.unshift(entry);
    if (logs.length > MAX_LOG) logs.length = MAX_LOG;
    chrome.storage.local.set({ arbLogs: logs });
  });
}

function renderSavedLogs() {
  chrome.storage.local.get(['arbLogs'], result => {
    const logs = result.arbLogs || [];
    const logEl = document.getElementById('log');
    if (!logEl || !logs.length) return;
    logEl.innerHTML = '';
    logs.forEach(entry => {
      const div = document.createElement('div');
      div.className = entry.cls || 'log';
      div.textContent = `[${entry.time}] ${entry.text}`;
      logEl.appendChild(div);
    });
  });
}

// ─── UI 업데이트 ──────────────────────────────────────────────────────
function updateUI(pSlip, bSlip, profit) {
  const pOddsEl = document.getElementById('pOdds');
  const bOddsEl = document.getElementById('bOdds');
  const profitEl = document.getElementById('profit');
  const statusEl = document.getElementById('status');
  if (pOddsEl) pOddsEl.textContent = (pSlip && pSlip.odds > 1) ? pSlip.odds.toFixed(3) : '-';
  if (bOddsEl) bOddsEl.textContent = (bSlip && bSlip.odds > 1) ? bSlip.odds.toFixed(3) : '-';
  // 마켓 레이블 표시
  const pMktEl = document.getElementById('pMarket');
  const bMktEl = document.getElementById('bMarket');
  if (pMktEl) pMktEl.textContent = pSlip && pSlip.marketKey ? marketKeyToLabel(pSlip.marketKey) : '-';
  if (bMktEl) bMktEl.textContent = bSlip && bSlip.marketKey ? marketKeyToLabel(bSlip.marketKey) : '-';
  if (profitEl) {
    profitEl.textContent = profit !== null ? profit.toFixed(2) + '%' : '-';
    profitEl.className = 'pct' + (profit !== null && profit >= MIN_PROFIT_PCT ? ' profit-positive' : ' profit-neutral');
  }
  if (statusEl) {
    const span = statusEl.querySelector('span');
    if (betInProgress) {
      statusEl.className = 'status-row status-betting';
      if (span) span.textContent = '베팅 진행 중...';
    } else if (botRunning) {
      statusEl.className = 'status-row status-running';
      if (span) span.textContent = '모니터링 중';
    } else {
      statusEl.className = 'status-row';
      if (span) span.textContent = '정지';
    }
  }

  // ── 베팅 금액 계산 표시 업데이트 ──
  updateBetCalc(pSlip, bSlip);
}

// 반대편 금액 계산 표시
function updateBetCalc(pSlip, bSlip) {
  const calcAnchorName = document.getElementById('calcAnchorName');
  const calcAnchorAmount = document.getElementById('calcAnchorAmount');
  const calcOppName = document.getElementById('calcOppName');
  const calcOppAmount = document.getElementById('calcOppAmount');
  const calcNote = document.getElementById('calcNote');
  if (!calcAnchorName) return;

  // 현재 anchorSite에 따라 레이블 설정
  const siteNames = { pin: '피나클', bti: 'BTI', sbo: 'SBOBET' };
  const anchorName = siteNames[anchorSite] || '피나클';

  // 상대방 사이트 이름
  let oppName = '상대방';
  // 현재 활성 상대방 파악
  const isSboMode = anchorSite === 'sbo';
  if (anchorSite === 'pin') {
    // 피나클 기준 → 상대방은 SBO 또는 BTI
    oppName = 'BTI/SBO';
  } else if (anchorSite === 'sbo') {
    oppName = '피나클';
  } else {
    oppName = '피나클';
  }

  calcAnchorName.textContent = anchorName;
  calcOppName.textContent = oppName;

  if (!pSlip || !bSlip || !pSlip.odds || !bSlip.odds) {
    calcAnchorAmount.textContent = '-';
    calcOppAmount.textContent = '-';
    if (calcNote) calcNote.textContent = '슬립에 배당을 담으면 자동 계산됩니다';
    return;
  }

  const pOdds = pSlip.odds, bOdds = bSlip.odds;
  const opponentSource = anchorSite === 'sbo' ? 'sbobet' : 'bti'; // 계산용 (실제 탭과 무관)

  try {
    const { pinBet, oppBet, oppBetDisplay, oppUnit } = calcBetAmounts(pOdds, bOdds, opponentSource);

    if (anchorSite === 'pin') {
      // 피나클 기준
      const anchorAmt = `${minBetAmount.toLocaleString()}원`;
      const oppAmt = oppUnit === 'USDT'
        ? `${oppBetDisplay.toLocaleString()} USDT`
        : `${oppBet.toLocaleString()}원`;
      calcAnchorAmount.textContent = anchorAmt;
      calcOppAmount.textContent = oppAmt;
    } else if (anchorSite === 'sbo') {
      // SBO 기준: minBetAmount는 USDT
      const anchorAmt = `${minBetAmount.toLocaleString()} USDT`;
      calcAnchorAmount.textContent = anchorAmt;
      calcOppAmount.textContent = `${pinBet.toLocaleString()}원`;
    } else {
      // BTI 기준
      calcAnchorAmount.textContent = `${minBetAmount.toLocaleString()}원`;
      calcOppAmount.textContent = `${pinBet.toLocaleString()}원`;
    }

    if (calcNote) calcNote.textContent = `피나클 ${pOdds} × SBO/BTI ${bOdds} 기준`;
  } catch(e) {
    calcAnchorAmount.textContent = '-';
    calcOppAmount.textContent = '-';
  }
}

// ─── 메인 polling 루프 ────────────────────────────────────────────────
// sbobet 슬립 읽기 - executeScript MAIN world에 인라인으로 직접 주입 (sendMessage 방식 제거)
function sbobetReadSlipFn() {
  function detectPeriod(text) {
    const t = text.toLowerCase();
    if (t.includes('1h') || t.includes('first half') || t.includes('\uc804\ubc18')) return '1h';
    if (t.includes('2h') || t.includes('second half') || t.includes('\ud6c4\ubc18')) return '2h';
    return 'ft';
  }
  function detectType(headerText) {
    const t = headerText.toLowerCase();
    if (t.includes('over') || t.includes('under') || t.includes('o/u') ||
        t.includes('\uc624\ubc84') || t.includes('\uc5b8\ub354') || t.includes('\ub4dd\uc810') || t.includes('total')) return 'ou';
    if (t.includes('\uc544\uc2dc\uc544') || t.includes('asian') || t.includes('handicap') ||
        t.includes('hdp') || t.includes('\ud578\ub514')) return 'ah';
    if (t.includes('money') || t.includes('\uba38\ub2c8') || t.includes('\uc2b9\ud328') ||
        t.includes('win/lose') || t.includes('1x2')) return 'ml';
    return 'ml';
  }
  function detectSide(optionText, headerText, marketType) {
    const t = (optionText + ' ' + headerText).toLowerCase();
    if (marketType === 'ou') return (t.includes('under') || t.includes('\uc5b8\ub354')) ? 'u' : 'o';
    if (marketType === 'ah') return (t.includes('away') || t.includes('\uc5b4\uc6e8\uc774')) ? 'a' : 'h';
    if (t.includes('draw') || t.includes('\ubb34\uc2b9\ubd80')) return 'draw';
    if (t.includes('away') || t.includes('\uc5b4\uc6e8\uc774')) return 'away';
    return 'home';
  }
  function detectLine(optionText, marketType) {
    if (marketType === 'ml') return null;
    const atPattern = optionText.match(/([+-]?\d+\.\d+)@/);
    if (atPattern) {
      const n = parseFloat(atPattern[1]);
      if (!isNaN(n) && n > -20 && n < 20) return n;
    }
    const oddsPoints = document.querySelectorAll('.oddsPoint, [class*="oddsPoint"]');
    for (const el of oddsPoints) {
      const t = el.textContent.trim();
      const n = parseFloat(t);
      if (!isNaN(n) && n > -20 && n < 20) return n;
    }
    const m = optionText.match(/([+-]\d+\.?\d*)/);
    if (m) return parseFloat(m[1]);
    return null;
  }
  const ticketContainer = document.querySelector('.ticketContainer, [class*="ticketContainer"]');
  if (!ticketContainer) return null;
  const headerTitle = ticketContainer.querySelector('.ticket_header_title, [class*="ticket_header_title"]');
  const headerText = headerTitle ? headerTitle.textContent.trim() : '';
  const ticketOption = ticketContainer.querySelector('.ticket_option, [class*="ticket_option"]');
  const optionText = ticketOption ? ticketOption.textContent.trim() : '';
  let odds = null;
  if (optionText) {
    const cleanText = optionText.replace(/\ub77c\uc774\ube0c|Live|LIVE/g, '').trim();
    const lastAtIdx = cleanText.lastIndexOf('@');
    if (lastAtIdx !== -1) {
      const afterAt = cleanText.substring(lastAtIdx + 1);
      const numsInAt = afterAt.match(/\d+\.\d{2,4}/g) || [];
      for (let i = numsInAt.length - 1; i >= 0; i--) {
        const n = parseFloat(numsInAt[i]);
        if (n > 1.01 && n < 20) { odds = n; break; }
      }
    }
    if (!odds) {
      const allNums = cleanText.match(/\d+\.\d{2,4}/g) || [];
      for (let i = allNums.length - 1; i >= 0; i--) {
        const n = parseFloat(allNums[i]);
        if (n > 1.01 && n < 20) { odds = n; break; }
      }
    }
  }
  if (!odds) {
    const oddsValueEls = ticketContainer.querySelectorAll('.oddsValue, [class*="oddsValue"]');
    for (const el of oddsValueEls) {
      const t = el.textContent.trim();
      const n = parseFloat(t);
      if (n > 1.01 && n < 50 && /^\d+\.\d{2,4}$/.test(t)) { odds = n; break; }
    }
  }
  if (!odds) {
    const allOddsValue = document.querySelectorAll('.oddsValue, [class*="oddsValue"]');
    for (const el of allOddsValue) {
      const parent = el.closest('[class*="selected"], [class*="active"], [class*="chosen"]');
      if (!parent) continue;
      const t = el.textContent.trim();
      const n = parseFloat(t);
      if (n > 1.01 && n < 50 && /^\d+\.\d{2,4}$/.test(t)) { odds = n; break; }
    }
  }
  if (!odds) return null;
  const period = detectPeriod(headerText + ' ' + optionText);
  const type = detectType(headerText);
  const side = detectSide(optionText, headerText, type);
  const line = detectLine(optionText, type);
  const marketKey = type === 'ml' ? `${period}_ml_${side}` :
                    type === 'ah' ? `${period}_ah_${side}_${line || 0}` :
                    `${period}_ou_${side}_${line || 0}`;
  return { odds, marketKind: type, period, side, line, marketKey,
           selectionText: optionText.substring(0, 100), headerText: headerText.substring(0, 60) };
}

async function pollLoop() {
  if (!botRunning || betInProgress) return;
  const { pinTab, pinSlipTab, btiTab, sboTab } = await findTabs();
  if (!pinTab || !pinSlipTab) { updateUI(null, null, null); return; }
  // SBOBET 탭 정보를 window에 저장 (sendMessage용)
  if (sboTab) { window._sboTabId = sboTab.id; window._sboFrameId = sboTab.frameId || 0; }
  // BTI 또는 SBOBET 중 하나라도 있으면 진행
  if (!btiTab && !sboTab) { updateUI(null, null, null); return; }

  // 슬립 읽기: MutationObserver 캐시 우선, 없으면 execInTab 직접 읽기
  const _cachedPin = cachedPinSlip;
  const _cachedBti = cachedBtiSlip;
  const _cachedSbo = cachedSboSlip;
  cachedPinSlip = null;
  cachedBtiSlip = null;
  cachedSboSlip = null;

  // 활성 상대방 탭 결정: SBOBET 우선, 없으면 BTI
  const activeOpponentTab = sboTab || btiTab;
  const activeOpponentSource = sboTab ? 'sbobet' : 'bti';
  const activeOpponentReadFn = sboTab ? sbobetReadSlipFn : btiReadSlipFn;
  const _cachedOpponent = sboTab ? _cachedSbo : _cachedBti;

  const [pSlip, bSlip] = await Promise.all([
    _cachedPin ? Promise.resolve(_cachedPin) : execInTab(pinSlipTab, pinnacleReadSlipFn),
    _cachedOpponent ? Promise.resolve(_cachedOpponent) : (
      sboTab
        ? execInTab(activeOpponentTab, activeOpponentReadFn)
        : readBtiSlipFromFrame(activeOpponentTab.id, activeOpponentTab.frameId ?? 0)
    )
  ]);

  // BTI 기준점 변경 감지 (오버/언더 마켓일 때만)
  if (bSlip && bSlip.marketKind === 'ou' && bSlip.line != null) {
    const bOu = normOuSide(bSlip.side);
    const btiLineKey = `${bOu}_${bSlip.line}`;
    if (btiLineKey !== lastBtiLineKey) {
      lastBtiLineKey = btiLineKey;
      addLog(`BTI 기준점 변경 감지: ${bOu === 'u' ? '언더' : '오버'} ${bSlip.line} → 피나클 동기화 시도`, 'info');
      // 배당판 클릭은 pinTab (배당판 iframe), 슬립 재읽기는 pinSlipTab
      const syncResult = await syncPinnacleToLine(pinTab, bSlip);
      if (syncResult === 'stop') {
        stopBot();
        addLog('봇 자동 정지 (기준점 불일치)', 'error');
        return;
      }
      await new Promise(r => setTimeout(r, 200));
      const pSlipNew = await execInTab(pinSlipTab, pinnacleReadSlipFn);
      if (pSlipNew) { updateUI(pSlipNew, bSlip, calcProfit(pSlipNew.odds, bSlip.odds)); return; }
    }
  }

  if (!pSlip || !bSlip) { updateUI(pSlip, bSlip, null); return; }

  // ── MAX_ODDS 필터: 한쪽 배당이 10.0 초과면 오매칭으로 차단 ──────────
  if (pSlip.odds > 10.0 || bSlip.odds > 10.0) {
    const maxKey = `maxodds_${pSlip.odds}_${bSlip.odds}`;
    if (maxKey !== lastOddsKey) {
      lastOddsKey = maxKey;
      addLog(`⚠️ 비정상 배당 감지 — 피나클: ${pSlip.odds} / BTI: ${bSlip.odds} (한쪽이 10.0 초과, 오매칭 가능성)`, 'warn');
    }
    updateUI(pSlip, bSlip, null);
    return;
  }

  // ── 마켓 종목 일치 여부 확인 ──────────────────────────────────────
  // 수동 설정 모드: 슬립 마켓을 수동 설정으로 덮어쓰기
  if (manualMarket) {
    pSlip.marketKind = manualMarket.type;
    pSlip.period = manualMarket.period;
    pSlip.side = manualMarket.side;
    bSlip.marketKind = manualMarket.type;
    bSlip.period = manualMarket.period;
    bSlip.side = manualMarket.side;
  }

  // 마켓 종목 일치 여부 확인 (허용 오차 적용)
  if (!marketsMatch(pSlip, bSlip)) {
    const msg = explainMarketMismatch(pSlip, bSlip);
    if (msg !== lastOddsKey) {
      lastOddsKey = msg;
      addLog(`⚠️ ${msg}`, 'warn');
    }
    updateUI(pSlip, bSlip, null);
    return;
  }

  let profit = calcProfit(pSlip.odds, bSlip.odds);
  updateUI(pSlip, bSlip, profit);

  const oddsKey = `${pSlip.odds}_${bSlip.odds}`;
  if (oddsKey !== lastOddsKey) {
    lastOddsKey = oddsKey;
    const pLabel = pSlip.marketKey ? marketKeyToLabel(pSlip.marketKey) : '';
    const cls = profit >= MIN_PROFIT_PCT ? 'success' : profit >= 0 ? 'info' : 'log';
    addLog(`[${pLabel}] 피나클 ${pSlip.odds} / BTI ${bSlip.odds} → ${profit.toFixed(2)}%`, cls);

    // BTI 배당 변경 시 피나클 배당 재조회 (피나클 슬립 재클릭)
    // 수익률이 음수이고 BTI 배당이 이전 BTI 배당과 다를 때
    if (profit < 0 && bSlip.marketKind === 'ou' && bSlip.line) {
      // 피나클 배당판에서 현재 배당 재클릭 (syncPinnacleToLine 사용)
      const syncResult = await syncPinnacleToLine(pinTab, bSlip);
      if (syncResult === 'synced' || syncResult === 'already_correct') {
        await new Promise(r => setTimeout(r, 200));
        const pSlipRefreshed = await execInTab(pinSlipTab, pinnacleReadSlipFn);
        if (pSlipRefreshed && pSlipRefreshed.odds !== pSlip.odds) {
          const newProfit = calcProfit(pSlipRefreshed.odds, bSlip.odds);
          addLog(`피나클 배당 재조회: ${pSlip.odds} → ${pSlipRefreshed.odds} / 수익률 ${newProfit.toFixed(2)}%`, 'info');
          updateUI(pSlipRefreshed, bSlip, newProfit);
          profit = newProfit;
          pSlip = pSlipRefreshed;
        }
      }
    }
  }

  if (profit >= MIN_PROFIT_PCT) {
    addLog(`🎯 양방 발견! 수익률 ${profit.toFixed(2)}%`, 'success');
    betInProgress = true;
    await executeBets(pinSlipTab, activeOpponentTab, pSlip, bSlip, profit, activeOpponentSource);
  }
}

// ─── SBOBET 베팅 함수 - executeScript MAIN world에 인라인으로 직접 주입 (sendMessage 방식 제거) ───
// SBOBET 베팅: 완전 동기 함수 (executeScript MAIN world 직렬화 가능)
// popup.js에서 execAsyncInTab으로 탭에 주입됨
function sbobetPlaceBetFn(amount) {
  try {
    const intAmount = Math.floor(amount);
    // 금액 input 탐색
    const stakeSelectors = [
      'input.input-stake',
      'input[class*="input-stake"]',
      'input[placeholder="판돈"]',
      'input[placeholder*="stake"]',
      'input[placeholder*="금액"]',
      'input[placeholder*="베팅"]',
    ];
    let stakeInput = null;
    for (const sel of stakeSelectors) {
      const inp = document.querySelector(sel);
      if (inp && inp.offsetParent !== null) { stakeInput = inp; break; }
    }
    if (!stakeInput) {
      const allInputs = document.querySelectorAll('input');
      for (const inp of allInputs) {
        if (inp.type === 'checkbox' || inp.type === 'hidden' || inp.type === 'radio') continue;
        if (inp.offsetParent !== null) { stakeInput = inp; break; }
      }
    }
    if (!stakeInput) return { step: 'input', success: false, reason: '금액 input 없음 (input.input-stake 못 찾음)' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(stakeInput, String(intAmount));
    stakeInput.dispatchEvent(new Event('input', { bubbles: true }));
    stakeInput.dispatchEvent(new Event('change', { bubbles: true }));
    stakeInput.dispatchEvent(new Event('blur', { bubbles: true }));
    return { step: 'input_done', success: true };
  } catch(e) { return { step: 'input', success: false, reason: e.message }; }
}

// SBOBET 베팅 버튼 클릭 (2단계, 금액 입력 후 1초 대기 후 호출)
function sbobetClickBetBtn() {
  try {
    function isBtnDisabled(b) {
      return b.hasAttribute('disabled') || (b.getAttribute('class') || '').includes('disabled');
    }
    let betBtn = null;
    // 1순위: id=placeBet
    const placeBetEl = document.querySelector('button#placeBet');
    if (placeBetEl && !isBtnDisabled(placeBetEl)) betBtn = placeBetEl;
    // 2순위: 베팅하기 텍스트
    if (!betBtn) {
      const allBtns = document.querySelectorAll('button');
      for (const b of allBtns) {
        if (isBtnDisabled(b)) continue;
        const t = (b.textContent || '').trim();
        if (t === '베팅하기' || t === 'Bet Now' || t === 'Place Bet' || t === 'Confirm') { betBtn = b; break; }
      }
    }
    // 3순위: btn-block
    if (!betBtn) {
      const blockBtns = document.querySelectorAll('button.btn-block, button[class*="btn-block"]');
      for (const b of blockBtns) {
        if (isBtnDisabled(b)) continue;
        const t = (b.textContent || '').trim();
        const cls = b.getAttribute('class') || '';
        if (t.includes('전체') || t.includes('리그') || t.includes('결과') || t.includes('팔레이')) continue;
        if (cls.includes('navbarSportList') || cls.includes('myBets')) continue;
        betBtn = b; break;
      }
    }
    if (!betBtn) {
      const debugBtns = Array.from(document.querySelectorAll('button')).slice(0, 5)
        .map(b => `"${(b.textContent||'').trim().substring(0,20)}"[id=${b.id}]`).join(', ');
      return { success: false, reason: `베팅 버튼 없음 | btns: ${debugBtns}` };
    }
    betBtn.click();
    return { success: true };
  } catch(e) { return { success: false, reason: e.message }; }
}

// ─── 베팅 금액 계산 (anchorSite 기준) ────────────────────────────────
function calcBetAmounts(pOdds, bOdds, opponentSource) {
  // anchorSite: 'pin' | 'bti' | 'sbo'
  // minBetAmount: anchorSite의 베팅 금액 (SBO면 USDT, 나머지는 KRW)
  const isSboOpponent = opponentSource === 'sbobet';

  let pinBet, oppBet; // KRW 기준

  if (anchorSite === 'pin') {
    // 피나클 기준: minBetAmount는 피나클 KRW
    pinBet = Math.round(minBetAmount);
    // 반대편 금액: 피나클배당/반대배당 * 피나클금액 (등배당 원칙)
    oppBet = Math.round(pinBet * pOdds / bOdds);
  } else if (anchorSite === 'sbo' && isSboOpponent) {
    // SBO 기준: minBetAmount는 USDT → KRW 환산
    const sboKrw = Math.round(minBetAmount * usdtRate);
    oppBet = sboKrw;
    pinBet = Math.round(sboKrw * bOdds / pOdds);
  } else {
    // BTI 기준: minBetAmount는 BTI KRW
    oppBet = Math.round(minBetAmount);
    pinBet = Math.round(oppBet * bOdds / pOdds);
  }

  // SBO 베팅 시 USDT 환산
  let oppBetDisplay = oppBet;
  let oppUnit = 'KRW';
  if (isSboOpponent) {
    oppBetDisplay = Math.floor(oppBet / usdtRate); // USDT (정수)
    oppUnit = 'USDT';
    oppBet = oppBetDisplay; // 실제 입력값은 USDT 정수
  }

  return { pinBet, oppBet, oppBetDisplay, oppUnit };
}

// ─── 베팅 실행 ────────────────────────────────────────────────────────
async function executeBets(pinSlipTab, opponentTab, pSlip, bSlip, profit, opponentSource) {
  try {
    const pOdds = pSlip.odds, bOdds = bSlip.odds;
    const { pinBet, oppBet, oppBetDisplay, oppUnit } = calcBetAmounts(pOdds, bOdds, opponentSource);
    const oppName = opponentSource === 'sbobet' ? 'SBOBET' : 'BTI';
    let btiTab = opponentSource !== 'sbobet' ? await resolveBtiBetTab(opponentTab) : opponentTab;

    addLog(`베팅 시작: 피나클 ${pinBet.toLocaleString()}원 (${pOdds}) / ${oppName} ${oppBetDisplay.toLocaleString()}${oppUnit} (${bOdds})`, 'info');

    if (opponentSource !== 'sbobet') {
      const probe = await execInTab(btiTab, probeBtiBetFrameInject);
      addLog(`BTI 베팅 프레임: frame=${btiTab.frameId} slip=${probe?.hasSlip} input=${probe?.hasInput} btn=${probe?.hasBtn}`, 'info');
      if (!probe?.hasSlip || !probe?.hasInput) {
        addLog('❌ BTI 베팅카트/금액입력 없음 — pbc00 BTI iframe 확인 후 재시도', 'error');
        betInProgress = false;
        return;
      }
      const btiReady = await execAsyncInTab(btiTab, btiSlipStabilizeInject, [bOdds]);
      if (!btiReady?.ready) {
        addLog(`⚠️ BTI 슬립 안정화 실패: ${btiReady?.reason || btiReady?.error || '응답 없음'} → 베팅 취소`, 'warn');
        betInProgress = false;
        return;
      }
      addLog(`BTI 슬립 준비 완료 (${btiReady.elapsed}ms, 배당=${btiReady.curOdds})`, 'info');
    }

    // 피나클 먼저 - 2단계: 금액입력 후 1초 대기 후 버튼 클릭 (버튼 활성화 대기)
    // 1단계: 금액 입력
    const pinStep1 = await execAsyncInTab(pinSlipTab, function(amt) {
      try {
        function findStakeInput() {
          // 1순위: placeholder로 정확히 찾기 (피나클 슬립 금액 입력 칸)
          const byPlaceholder = document.querySelector(
            'input[placeholder="베팅 금액"], input[placeholder="Wager"], input[placeholder="Stake"], ' +
            'input[placeholder="Enter stake"], input[placeholder="금액"]'
          );
          if (byPlaceholder && byPlaceholder.offsetParent !== null) return byPlaceholder;
          // 2순위: 클래스명으로 찾기
          const byClass = document.querySelector(
            'input[class*="InputWager"], input[class*="stake"], input[class*="Stake"], ' +
            'input[class*="wager"], input[class*="Wager"], input[name="stake"]'
          );
          if (byClass && byClass.offsetParent !== null) return byClass;
          // 3순위: 검색창 제외하고 visible text/number input 중 첫 번째
          const all = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
          for (const inp of all) {
            if (inp.offsetParent === null) continue;
            const cls = (inp.className || '').toLowerCase();
            const ph = (inp.placeholder || '').toLowerCase();
            const id = (inp.id || '').toLowerCase();
            if (cls.includes('search') || ph.includes('검색') || ph.includes('search') || id.includes('search')) continue;
            return inp;
          }
          return null;
        }
        const stakeInput = findStakeInput();
        if (!stakeInput) return { ok: false, reason: '금액 input 없음' };

        // 1단계: input 포커스 + 기존 값 완전 초기화
        stakeInput.focus();
        stakeInput.click();
        // React nativeInputValueSetter로 빈 값 설정
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(stakeInput, '');
        stakeInput.dispatchEvent(new Event('input', { bubbles: true }));
        stakeInput.select();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);

        // 2단계: 최종 값 직접 설정 (React 상태 업데이트)
        const amtStr = String(Math.round(amt));
        nativeSetter.call(stakeInput, amtStr);
        stakeInput.dispatchEvent(new Event('input', { bubbles: true }));
        stakeInput.dispatchEvent(new Event('change', { bubbles: true }));

        // 3단계: 키보드 이벤트로 React 재확인
        stakeInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
        stakeInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
        stakeInput.dispatchEvent(new Event('blur', { bubbles: true }));
        // 포커스 재설정으로 React 강제 업데이트
        stakeInput.focus();
        stakeInput.dispatchEvent(new Event('input', { bubbles: true }));

        return { ok: true, foundInput: `ph:${stakeInput.placeholder}`, inputVal: stakeInput.value };
      } catch(e) { return { ok: false, reason: e.message }; }
    }, [pinBet]);
    if (!pinStep1 || !pinStep1.ok) {
      addLog(`❌ 피나클 금액 입력 실패: ${pinStep1?.reason || '응답 없음'}`, 'error');
      betInProgress = false; return;
    }
    addLog(`피나클 금액 입력 완료 [input: ${pinStep1.foundInput || '?'}], 버튼 활성화 대기...`, 'info');

    // 2단계: 베팅 버튼 활성화 폴링 후 클릭 (최대 3초)
    const pinResult = await execAsyncInTab(pinSlipTab, function() {
      return new Promise(resolve => {
        const MAX_WAIT = 3000;
        const INTERVAL = 100;
        let elapsed = 0;
        function findAndClick() {
          try {
            const allBtns = Array.from(document.querySelectorAll('button'));
            let betBtn = null;

            // 1순위: fullWidth + 베팅/확인/싱글 텍스트 포함 (비활성화 포함)
            for (const b of allBtns) {
              const t = b.textContent.trim();
              const cls = b.className || '';
              if (cls.includes('fullWidth') &&
                  (t.includes('베팅') || t.includes('확인') || t.includes('싱글') || t.includes('신청') ||
                   t.includes('Place') || t.includes('Bet') || t.includes('Accept') || t.includes('Confirm'))) {
                betBtn = b; break;
              }
            }
            // 2순위: 활성화된 fullWidth 버튼
            if (!betBtn) {
              for (const b of allBtns) {
                if (!b.disabled && (b.className || '').includes('fullWidth') && b.textContent.trim().length > 2) {
                  betBtn = b; break;
                }
              }
            }
            // 3순위: 싱글 베팅 확인 텍스트 포함 (비활성화도 클릭 시도)
            if (!betBtn) {
              for (const b of allBtns) {
                const t = b.textContent.trim();
                if (t.includes('싱글 베팅') || t.includes('베팅 신청') || t.includes('베팅 확인') || t.includes('Place Bet')) {
                  betBtn = b; break;
                }
              }
            }
            // 4순위: 활성화된 버튼 중 베팅 관련 텍스트 (fullWidth 없이)
            if (!betBtn) {
              for (const b of allBtns) {
                if (b.disabled) continue;
                const t = b.textContent.trim();
                const cls = b.className || '';
                if (!cls.includes('market-btn') && !cls.includes('showAll') && !cls.includes('button-l') &&
                    (t.includes('베팅') || t.includes('확인') || t.includes('신청') || t.includes('Bet') || t.includes('Place') || t.includes('Accept'))) {
                  betBtn = b; break;
                }
              }
            }

            if (betBtn && !betBtn.disabled) {
              betBtn.click();
              resolve({ success: true, btnText: betBtn.textContent.trim().substring(0,30), elapsed });
              return;
            }
            // 비활성화된 버튼이라도 있으면 대기 계속
            elapsed += INTERVAL;
            if (elapsed >= MAX_WAIT) {
              const debugBtns = allBtns.filter(b=>b.offsetParent!==null).slice(0,10)
                .map(b => `"${b.textContent.trim().substring(0,20)}"[dis:${b.disabled}][${(b.className||'').substring(0,30)}]`).join(' | ');
              resolve({ success: false, reason: `버튼없음 | ${debugBtns}` });
              return;
            }
            setTimeout(findAndClick, INTERVAL);
          } catch(e) { resolve({ success: false, reason: e.message }); }
        }
        findAndClick();
      });
    }, []);
    if (!pinResult || !pinResult.success) {
      addLog(`❌ 피나클 베팅 실패: ${pinResult?.reason || '응답 없음'} → ${oppName} 취소}`, 'error');
      betInProgress = false; return;
    }
    addLog(`피나클 버튼 클릭 완료 ["${pinResult.btnText||'?'}"] → 베팅 확정 확인 중...`, 'info');
    // ── 피나클 베팅 확정 확인 (최대 4초 폴링) ──
    // 성공: 슬립이 비워지거나 "베팅 완료/성공" 메시지 출현
    // 실패: 슬립에 여전히 배당 버튼 존재(배당 변경 거부) or 오류 메시지 출현
    const pinConfirm = await execAsyncInTab(pinSlipTab, function() {
      return new Promise(resolve => {
        // 1차 확인: 300ms 후
        setTimeout(function() {
          const selBtns = Array.from(document.querySelectorAll('button[class*="market-btn"]'))
            .filter(b => b.className.split(' ').some(c => c.startsWith('selected-')));
          const errMsg = document.body.innerText.match(/배당.*변경|Odds.*Changed|Odds.*changed|거부|Rejected|rejected/);
          // 2차 버튼 (슬립 열기 버튼 클릭 후 실제 확인 버튼)
          const betBtns = Array.from(document.querySelectorAll('button')).filter(b => {
            if (b.disabled) return false;
            const t = b.textContent.trim();
            const cls = b.className || '';
            return cls.includes('fullWidth') &&
              (t.includes('베팅') || t.includes('확인') || t.includes('싱글') || t.includes('신청') ||
               t.includes('Place') || t.includes('Bet') || t.includes('Accept') || t.includes('Confirm'));
          });
          if (betBtns.length > 0) {
            betBtns[0].click(); // 2차 버튼 클릭
            // 2차 클릭 후 300ms 더 대기
            setTimeout(function() {
              const sel2 = Array.from(document.querySelectorAll('button[class*="market-btn"]'))
                .filter(b => b.className.split(' ').some(c => c.startsWith('selected-')));
              const err2 = document.body.innerText.match(/배당.*변경|Odds.*Changed|Odds.*changed|거부|Rejected|rejected/);
              if (err2) resolve({ confirmed: false, reason: '배당 변경/거부: ' + err2[0] });
              else if (sel2.length === 0) resolve({ confirmed: true, msg: '슬립초기화' });
              else resolve({ confirmed: true, msg: '2차클릭완료(슬립잔존)' }); // 슬립 잔존해도 진행
            }, 300);
            return;
          }
          if (errMsg) resolve({ confirmed: false, reason: '배당 변경/거부: ' + errMsg[0] });
          else if (selBtns.length === 0) resolve({ confirmed: true, msg: '슬립초기화' });
          else resolve({ confirmed: true, msg: '베팅진행(슬립잔존)' }); // 오류 없으면 진행
        }, 300);
      });
    }, []);
    if (!pinConfirm || !pinConfirm.confirmed) {
      addLog(`❌ 피나클 베팅 미확정: ${pinConfirm?.reason || '응답 없음'} → ${oppName} 베팅 취소`, 'error');
      betInProgress = false; return;
    }
    addLog(`✅ 피나클 베팅 확정 (${pinConfirm.msg})`, 'success');

    // 상대방 베팅
    let oppResult;
    if (opponentSource === 'sbobet') {
      const sboStep1 = await execAsyncInTab(opponentTab, sbobetPlaceBetFn, [oppBet]);
      if (!sboStep1 || !sboStep1.success) {
        addLog(`❌ SBOBET 금액 입력 실패: ${sboStep1?.reason || '응답 없음'}`, 'error');
        betInProgress = false; return;
      }
      addLog('SBOBET 금액 입력 완료, 버튼 활성화 대기...', 'info');
      await new Promise(r => setTimeout(r, 1000));
      oppResult = await execAsyncInTab(opponentTab, sbobetClickBetBtn, []);
    } else {
      // 피나클 베팅 후 BTI 슬립 재확인 (배당변경/버튼비활성 대응)
      btiTab = await resolveBtiBetTab(opponentTab);
      addLog(`피나클 완료 → BTI 재확인 (frame=${btiTab.frameId})`, 'info');
      const btiReady2 = await execAsyncInTab(btiTab, btiSlipStabilizeInject, [bOdds]);
      if (!btiReady2?.ready) {
        addLog(`❌ 피나클 후 BTI 슬립 불안정: ${btiReady2?.reason || btiReady2?.error || '?'} — BTI만 미체결`, 'error');
        betInProgress = false;
        return;
      }

      // 1) content script PLACE_BET 시도
      oppResult = await placeBtiBetViaMessage(btiTab, oppBet, bSlip);
      if (!oppResult?.success) {
        addLog(`BTI content script 베팅 실패: ${oppResult?.reason || '?'} → inject 폴백`, 'warn');
        const btiStep1 = await execAsyncInTab(btiTab, function(amt, tLine, tol, tOdds) {
          try {
            if (tLine !== undefined && tLine !== null && tol !== undefined) {
              const cards = Array.from(document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]'))
                .filter((el) => !el.className.includes('wrapper') && !el.className.includes('counter') &&
                  !el.className.includes('badge') && !el.className.includes('PlaceBet') && !el.className.includes('Tab'));
              if (cards.length > 0) {
                let selText = '';
                for (const el of cards[0].querySelectorAll('[class*="betInformation__title"]')) {
                  const t = el.textContent.trim();
                  if (t && t !== '라이브' && t.length > 1 && t.length < 50) { selText = t; break; }
                }
                const lm = selText.match(/([+-]?[\d]+\.?[\d]*)(?:\s*\/\s*[+-]?[\d]+\.?[\d]*)?$/);
                if (lm) {
                  let actualLine = parseFloat(lm[1]);
                  const qM = selText.match(/([+-]?[\d]+\.?[\d]*)\s*\/\s*([+-]?[\d]+\.?[\d]*)$/);
                  if (qM) {
                    const sign = qM[1].startsWith('-') ? -1 : 1;
                    actualLine = sign * (Math.abs(parseFloat(qM[1])) + Math.abs(parseFloat(qM[2]))) / 2;
                  }
                  if (Math.abs(actualLine - tLine) > tol) {
                    return { ok: false, reason: `기준점 변경: 목표=${tLine}, 실제=${actualLine}`, lineChanged: true };
                  }
                }
              }
            }
            if (tOdds && tOdds > 1) {
              const cards2 = Array.from(document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]'))
                .filter((el) => !el.className.includes('wrapper') && !el.className.includes('counter') &&
                  !el.className.includes('badge') && !el.className.includes('PlaceBet') && !el.className.includes('Tab'));
              if (cards2.length > 0) {
                let curOdds = 0;
                const atM = cards2[0].textContent.match(/@\s*(\d+(?:\.\d{1,4})?)/);
                if (atM) curOdds = parseFloat(atM[1]);
                if (!curOdds) {
                  for (const sp of cards2[0].querySelectorAll('span')) {
                    if ((sp.className || '').includes('UpdateNotification')) continue;
                    const n = parseFloat(sp.textContent.trim());
                    if (n > 1.01 && n < 100 && /^\d+(\.\d{1,4})?$/.test(sp.textContent.trim())) { curOdds = n; break; }
                  }
                }
                if (curOdds > 1 && Math.abs(curOdds - tOdds) > 0.06) {
                  return { ok: false, reason: `배당 변경: 목표=${tOdds}, 현재=${curOdds}`, oddsChanged: true };
                }
              }
            }
            const input = document.getElementById('counter')
              || document.querySelector('input[class*="CounterSecondary_input"], input[placeholder="베팅금"]')
              || document.querySelector('input[class*="counter"]');
            if (!input) return { ok: false, reason: '금액 input 없음' };
            input.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, String(amt));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          } catch (e) { return { ok: false, reason: e.message }; }
        }, [oppBet, bSlip.line, lineTolerance, bSlip.odds]);

        if (!btiStep1?.ok) {
          addLog(`❌ BTI 사전검증/금액입력 실패: ${btiStep1?.reason || btiStep1?.error || '응답 없음'}`, 'error');
          betInProgress = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 800));
        oppResult = await execAsyncInTab(btiTab, btiClickBetBtnInject, []);
        if (oppResult?.success) {
          const btiConfirm = await execAsyncInTab(btiTab, btiConfirmBetInject, []);
          if (btiConfirm?.confirmed) {
            addLog(`✅ BTI 승인 완료 ["${btiConfirm.btnText}"]`, 'success');
            oppResult = { success: true };
          } else {
            addLog(`❌ BTI 승인 실패: ${btiConfirm?.reason || '?'} (슬립잔존=${btiConfirm?.slipLeft})`, 'error');
            oppResult = { success: false, reason: btiConfirm?.reason || '승인 실패' };
          }
        }
      } else {
        addLog(`✅ BTI content script 베팅 성공${oppResult.btnText ? ` ["${oppResult.btnText}"]` : ''}`, 'success');
      }
    }
    if (!oppResult || !oppResult.success) {
      addLog(`❌ ${oppName} 베팅 실패: ${oppResult?.reason || '응답 없음'}`, 'error');
    } else {
      addLog(`✅ ${oppName} 베팅 성공`, 'success');
      addLog(`🏁 양방 완료! 예상 수익률 ${profit.toFixed(2)}%`, 'success');
    }

    stopBot();
    addLog('봇 자동 종료 (베팅 완료)', 'info');
  } catch(e) {
    addLog(`베팅 오류: ${e.message}`, 'error');
    betInProgress = false;
  }
}

// ─── 자동 서치 UI ────────────────────────────────────────────────────
function renderSearchResult(msg) {
  const { opportunities, stats } = msg;
  // 통계 표시
  const statsEl = document.getElementById('searchStats');
  if (statsEl && stats) {
    const sboInfo = stats.hasSboToken
      ? ` │ SBO: 축구 ${stats.sboSoccer||0}/야구 ${stats.sboBaseball||0}/농구 ${stats.sboBasketball||0}`
      : ' │ SBO: 토큰없음';
    statsEl.textContent = `피나클: 축구 ${stats.pinSoccer||0}/야구 ${stats.pinBaseball||0}/농구 ${stats.pinBasketball||0} │ BTI: ${stats.btiTotal||0}${sboInfo} │ 매칭: ${stats.matched||0}`;
  }
  const oppList = document.getElementById('oppList');
  const oppCount = document.getElementById('oppCount');
  if (!oppList) return;

  const minProfit = parseFloat(document.getElementById('minProfit')?.value || '0');
  const filtered = (opportunities || []).filter(o => parseFloat(o.profit) >= minProfit);

  if (oppCount) oppCount.textContent = filtered.length + '개';

  if (filtered.length === 0) {
    oppList.innerHTML = '<div style="text-align:center; color:#555; padding:20px; font-size:12px;">양방 기회 없음</div>';
    return;
  }

  oppList.innerHTML = filtered.map((opp, idx) => {
    const profit = parseFloat(opp.profit);
    const profitCls = profit >= 5 ? 'style="color:#4ade80"' : profit >= 0 ? 'style="color:#fbbf24"' : 'style="color:#f87171"';
    return `<div class="opp-item" data-idx="${idx}" onclick="selectOpp(${idx})">
      <span class="opp-profit ${profit < 1 ? 'zero' : ''}">${profit.toFixed(2)}%</span>
      <div class="opp-teams">${opp.home} vs ${opp.away}</div>
      <div class="opp-detail">
        <span class="opp-badge">${opp.sport}</span>
        <span class="opp-badge">${opp.market}</span>
        피나클 ${opp.pinSide} ${opp.pinOdds?.toFixed(3)} │ ${opp.opponent||'BTI'} ${opp.btiSide} ${opp.btiOdds?.toFixed(3)}
      </div>
      <div class="opp-detail" style="margin-top:2px; color:#555;">${opp.league || ''}</div>
    </div>`;
  }).join('');

  // 전역 저장
  window._lastOpportunities = filtered;
}

// 프리매치 서치 결과 렌더
function renderPrematchResult(msg) {
  const { opportunities, stats } = msg;

  // 통계 표시
  const statsEl = document.getElementById('pmSearchStats');
  if (statsEl && stats) {
    if (stats.error) {
      statsEl.textContent = '⚠️ ' + stats.error;
    } else {
      let line = `피나클: 축구 ${stats.pinSoccer||0}/야구 ${stats.pinBaseball||0}/농구 ${stats.pinBasketball||0}/이스포츠 ${stats.pinEsports||0}/테니스 ${stats.pinTennis||0} │ BTI: ${stats.btiTotal||0} │ 매칭: ${stats.matched||0}`;
      if ((stats.btiTotal || 0) === 0 && stats.btiApiOrigin) {
        line += ` │ origin: ${stats.btiApiOrigin}`;
      }
      statsEl.textContent = line;
    }
  }

  const oppList = document.getElementById('pmOppList');
  const oppCount = document.getElementById('pmOppCount');
  if (!oppList) return;

  const minProfit = parseFloat(document.getElementById('pmMinProfit')?.value || '0');
  const filtered = (opportunities || []).filter(o => parseFloat(o.profit) >= minProfit);

  if (oppCount) oppCount.textContent = filtered.length + '개';

  if (filtered.length === 0) {
    oppList.innerHTML = '<div style="text-align:center; color:#555; padding:20px; font-size:12px;">양방 기회 없음</div>';
    return;
  }

  oppList.innerHTML = filtered.map((opp, idx) => {
    const profit = parseFloat(opp.profit);
    const profitColor = profit >= 5 ? '#4ade80' : profit >= 2 ? '#fbbf24' : '#f87171';

    // 시작 시간 포맷
    let timeStr = '';
    if (opp.startTime) {
      const d = new Date(opp.startTime);
      timeStr = d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    // 피나클 side 표시
    const pinSideLabel = opp.pinSide === 'home' ? `홈(${opp.home})` : `원정(${opp.away})`;
    const btiSideLabel = (opp.btiSide === 'H' || opp.btiSide === 'Home') ? `홈(${opp.home})` : `원정(${opp.away})`;

    return `<div class="opp-item" style="cursor:default;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size:11px; font-weight:bold; color:#eee;">${opp.home} vs ${opp.away}</div>
        <div style="font-size:13px; font-weight:bold; color:${profitColor};">${profit.toFixed(2)}%</div>
      </div>
      <div style="display:flex; gap:6px; margin-top:3px; align-items:center;">
        <span class="opp-badge">${opp.sport}</span>
        <span class="opp-badge">${opp.market}</span>
        ${timeStr ? `<span style="font-size:9px; color:#666;">⏰ ${timeStr}</span>` : ''}
      </div>
      <div style="font-size:10px; color:#888; margin-top:3px;">${opp.league || ''}</div>
      <div style="display:flex; gap:8px; margin-top:4px; font-size:11px;">
        <div style="flex:1; background:#0a1628; border-radius:4px; padding:4px 6px;">
          <div style="color:#60a5fa; font-size:9px; margin-bottom:2px;">피나클</div>
          <div style="color:#eee;">${pinSideLabel}</div>
          <div style="color:#4ade80; font-weight:bold;">${opp.pinOdds?.toFixed(3)}</div>
        </div>
        <div style="flex:1; background:#0a1628; border-radius:4px; padding:4px 6px;">
          <div style="color:#34d399; font-size:9px; margin-bottom:2px;">BTI</div>
          <div style="color:#eee;">${btiSideLabel}</div>
          <div style="color:#4ade80; font-weight:bold;">${opp.btiOdds?.toFixed(3)}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  // 전역 저장
  window._lastPrematchOpportunities = filtered;
}

function selectOpp(idx) {
  if (!window._lastOpportunities) return;
  selectedOpp = window._lastOpportunities[idx];
  document.querySelectorAll('.opp-item').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });
  const sec = document.getElementById('selectedOppSection');
  const info = document.getElementById('selectedOppInfo');
  if (sec) sec.style.display = 'block';
  if (info) {
    info.innerHTML = `<b>${selectedOpp.sport} ${selectedOpp.market}</b> │ ${selectedOpp.home} vs ${selectedOpp.away}<br>
    피나클 ${selectedOpp.pinSide} <b>${selectedOpp.pinOdds?.toFixed(3)}</b> │ ${selectedOpp.opponent||'BTI'} ${selectedOpp.btiSide} <b>${selectedOpp.btiOdds?.toFixed(3)}</b><br>
    예상 수익률: <b style="color:#4ade80">${selectedOpp.profit}%</b>`;
  }
}

// ─── 봇 시작/정지 ────────────────────────────────────────────────────
function readSettings() {
  const minBetInput = document.getElementById('minBet');
  if (minBetInput) {
    const v = parseFloat(minBetInput.value);
    if (!isNaN(v) && v > 0) minBetAmount = v;
  }
  const tolInput = document.getElementById('lineTolerance');
  if (tolInput) { const t = parseFloat(tolInput.value); if (!isNaN(t) && t >= 0) lineTolerance = t; }
  const usdtRateInput = document.getElementById('usdtRate');
  if (usdtRateInput) { const r = parseFloat(usdtRateInput.value); if (!isNaN(r) && r > 0) usdtRate = r; }
  const autoDetect = document.getElementById('autoDetect');
  if (autoDetect && !autoDetect.checked) {
    manualMarket = {
      period: document.getElementById('mktPeriod').value,
      type: document.getElementById('mktType').value,
      side: document.getElementById('mktSide').value
    };
  } else {
    manualMarket = null;
  }
  chrome.storage.local.set({
    arbSettings: {
      minBet: minBetAmount,
      lineTolerance,
      anchorSite,
      usdtRate,
      autoDetect: autoDetect ? autoDetect.checked : true,
      mktPeriod: document.getElementById('mktPeriod')?.value,
      mktType: document.getElementById('mktType')?.value,
      mktSide: document.getElementById('mktSide')?.value
    }
  });
}

function startBot() {
  readSettings();
  botRunning = true; betInProgress = false; lastOddsKey = null; lastBtiLineKey = null;
  const mktInfo = manualMarket ? ` | 마켓: ${manualMarket.period} ${manualMarket.type} ${manualMarket.side}` : ' | 자동 감지';
  addLog(`봇 시작 (최소 베팅: ${minBetAmount.toLocaleString()}원, 허용오차: ±${lineTolerance}${mktInfo})`, 'info');

  // BTI 베팅카트 자동 금액 지우기 (최소베팅금액 자동입력 제거)
  findTabs().then(({ btiTab }) => {
    if (!btiTab) return;
    execAsyncInTab(btiTab, function() {
      try {
        const input = document.getElementById('counter')
          || document.querySelector('input[class*="CounterSecondary_input"], input[class*="counter__input"], input[placeholder="베팅금"]');
        if (!input) return { ok: false, reason: 'input 없음' };
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      } catch(e) { return { ok: false, reason: e.message }; }
    }, []).then(res => {
      if (res && res.ok) addLog('BTI 베팅카트 금액 자동 제거 완료', 'info');
    }).catch(() => {});
  }).catch(() => {});

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollLoop, POLL_INTERVAL_MS);
  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled = false;
  updateUI(null, null, null);
}

function stopBot() {
  botRunning = false; betInProgress = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const s = document.getElementById('startBtn'), e = document.getElementById('stopBtn');
  if (s) s.disabled = false;
  if (e) e.disabled = true;
  updateUI(null, null, null);
}

// ─── 초기화 ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // 탭 전환
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // 마켓 사이드 옵션 업데이트
  function updateSideOptions() {
    const type = document.getElementById('mktType').value;
    const sel = document.getElementById('mktSide');
    const cur = sel.value;
    sel.innerHTML = '';
    let opts = [];
    if (type === 'ml') opts = [['home','홈'],['away','어웨이'],['draw','무승부']];
    else if (type === 'ah') opts = [['h','홈팀 핸디'],['a','어웨이팀 핸디']];
    else if (type === 'ou') opts = [['o','오버'],['u','언더']];
    opts.forEach(([v,t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (v === cur) o.selected = true;
      sel.appendChild(o);
    });
  }
  document.getElementById('mktType').addEventListener('change', updateSideOptions);
  updateSideOptions();

  // 자동 감지 토글
  function toggleManualMkt() {
    const auto = document.getElementById('autoDetect').checked;
    const manual = document.getElementById('mktManual');
    manual.style.opacity = auto ? '0.35' : '1';
    manual.querySelectorAll('select').forEach(s => s.disabled = auto);
  }
  document.getElementById('autoDetect').addEventListener('change', toggleManualMkt);
  toggleManualMkt();

  // 슬립 비교 탭 봇
  document.getElementById('startBtn').addEventListener('click', startBot);
  document.getElementById('stopBtn').addEventListener('click', () => { stopBot(); addLog('봇 수동 정지', 'info'); });

  // 자동 서치 탭
  const startSearchBtn = document.getElementById('startSearchBtn');
  const stopSearchBtn = document.getElementById('stopSearchBtn');
  if (startSearchBtn) startSearchBtn.addEventListener('click', () => {
    searchRunning = true;
    startSearchBtn.disabled = true;
    stopSearchBtn.disabled = false;
    const searchModeEl = document.getElementById('searchMode');
    const searchModeVal = searchModeEl ? searchModeEl.value : 'bti';
    const modeLabel = {'bti':'피나클+BTI','sbo':'피나클+SBO','both':'BTI+SBO 전체'}[searchModeVal] || searchModeVal;
    addLog(`자동 서치 시작... (모드: ${modeLabel})`, 'info');
    chrome.runtime.sendMessage({ type: 'START_SEARCH', mode: searchModeVal }, (resp) => {
      if (resp && resp.ok && resp.result) {
        renderSearchResult({ type: 'SEARCH_RESULT', ...resp.result });
        const s = resp.result.stats || {};
        const pinTotal = (s.pinSoccer||0)+(s.pinBaseball||0)+(s.pinBasketball||0);
        if (s.btiTabFound === false && (searchModeVal === 'bti' || searchModeVal === 'both')) {
          addLog('⚠️ BTI 탭 미발견 - pbc00.com을 먼저 열어주세요', 'warn');
        }
        addLog(`서치 완료: 피나클 ${pinTotal}경기 / BTI ${s.btiTotal||0}경기 / 매칭 ${s.matched||0}개`, 'success');
      } else if (resp && !resp.ok) {
        addLog('서치 오류: ' + (resp.error || '알 수 없음'), 'error');
      }
    });
  });
  if (stopSearchBtn) stopSearchBtn.addEventListener('click', () => {
    searchRunning = false;
    startSearchBtn.disabled = false;
    stopSearchBtn.disabled = true;
    addLog('서치 정지', 'info');
    chrome.runtime.sendMessage({ type: 'STOP_SEARCH' });
  });

  // 베팅 실행 버튼 (선택된 기회)
  // 프리매치 서치 버튼
  const startPrematchBtn = document.getElementById('startPrematchBtn');
  const stopPrematchBtn = document.getElementById('stopPrematchBtn');
  if (startPrematchBtn) startPrematchBtn.addEventListener('click', () => {
    startPrematchBtn.disabled = true;
    stopPrematchBtn.disabled = false;
    addLog('프리매치 서치 시작... (pinnacle.com + pbc00.com 탭이 열려있어야 합니다)', 'info');
    const pmStatsEl = document.getElementById('pmSearchStats');
    if (pmStatsEl) pmStatsEl.textContent = '피나클 + BTI 수집 중... (수십 초 소요)';
    chrome.runtime.sendMessage({ type: 'START_PREMATCH_SEARCH' }, (resp) => {
      if (resp && resp.ok && resp.result) {
        renderPrematchResult({ type: 'PREMATCH_SEARCH_RESULT', ...resp.result });
        const s = resp.result.stats || {};
        if (s.btiTabFound === false) {
          addLog('⚠️ BTI 탭 미발견 - pbc00.com을 먼저 열어주세요', 'warn');
          startPrematchBtn.disabled = false;
          stopPrematchBtn.disabled = true;
        } else if (s.pinTabFound === false) {
          addLog('⚠️ pinnacle.com 탭 없음 — 영문 팀명으로 진행', 'warn');
          addLog(`프리매치 서치 완료: 피나클 ${s.pinTotal||0}경기 / BTI ${s.btiTotal||0}경기 / 매칭 ${s.matched||0}개`, 'success');
        } else {
          addLog(`프리매치 서치 완료: 피나클 ${s.pinTotal||0}경기 / BTI ${s.btiTotal||0}경기 / 매칭 ${s.matched||0}개`, 'success');
          if ((s.btiTotal || 0) === 0) {
            addLog(`⚠️ BTI 0건 — pbc00 로그인+BTI화면(gamecode=19) 열고 새로고침`, 'warn');
            if (s.btiApiOrigin) addLog(`BTI API origin: ${s.btiApiOrigin}`, 'info');
            if (s.btiFetchErrors?.length) addLog(`BTI 오류: ${s.btiFetchErrors[0]}`, 'error');
            addLog('→ 팝업 하단 [BTI 진단] 버튼으로 확인', 'info');
          }
        }
      } else if (resp && !resp.ok) {
        addLog('프리매치 서치 오류: ' + (resp.error || '알 수 없음'), 'error');
        startPrematchBtn.disabled = false;
        stopPrematchBtn.disabled = true;
      }
    });
  });
  if (stopPrematchBtn) stopPrematchBtn.addEventListener('click', () => {
    startPrematchBtn.disabled = false;
    stopPrematchBtn.disabled = true;
    addLog('프리매치 서치 정지', 'info');
    chrome.runtime.sendMessage({ type: 'STOP_PREMATCH_SEARCH' });
  });

  const betSelectedBtn = document.getElementById('betSelectedBtn');
  if (betSelectedBtn) betSelectedBtn.addEventListener('click', async () => {
    if (!selectedOpp) { addLog('기회를 먼저 선택하세요', 'warn'); return; }
    if (betInProgress) { addLog('이미 베팅 진행 중', 'warn'); return; }

    const opp = selectedOpp;
    const oppName = opp.opponent || 'BTI';
    addLog(`🎯 서치 베팅 시작: ${opp.sport} ${opp.market} | ${opp.home} vs ${opp.away}`, 'success');
    addLog(`피나클 ${opp.pinSide} ${opp.pinOdds?.toFixed(3)} / ${oppName} ${opp.btiSide} ${opp.btiOdds?.toFixed(3)} → ${opp.profit}%`, 'info');

    // 탭 찾기
    const { pinSlipTab, btiTab, sboTab } = await findTabs();
    if (!pinSlipTab) { addLog('❌ 피나클 슬립 탭 없음', 'error'); return; }
    const opponentTab = opp.opponent === 'SBO' ? sboTab : btiTab;
    if (!opponentTab) { addLog(`❌ ${oppName} 탭 없음`, 'error'); return; }

    // 현재 슬립 배당 확인 (베팅 직전 재검증)
    const [pSlipNow, bSlipNow] = await Promise.all([
      execInTab(pinSlipTab, pinnacleReadSlipFn),
      execInTab(opponentTab, opp.opponent === 'SBO' ? sbobetReadSlipFn : btiReadSlipFn)
    ]);

    if (!pSlipNow || !bSlipNow) {
      addLog('❌ 슬립 재확인 실패 - 슬립에 배당을 먼저 담아주세요', 'error');
      return;
    }

    // 배당 변경 여부 확인 (0.05 초과 차이 시 취소)
    const pinOddsDiff = Math.abs(pSlipNow.odds - opp.pinOdds);
    const btiOddsDiff = Math.abs(bSlipNow.odds - opp.btiOdds);
    if (pinOddsDiff > 0.05 || btiOddsDiff > 0.05) {
      addLog(`⚠️ 배당 변경 감지 → 취소 (피나클: ${opp.pinOdds}→${pSlipNow.odds}, ${oppName}: ${opp.btiOdds}→${bSlipNow.odds})`, 'warn');
      return;
    }

    const profit = calcProfit(pSlipNow.odds, bSlipNow.odds);
    if (profit < MIN_PROFIT_PCT) {
      addLog(`⚠️ 수익률 부족 (${profit.toFixed(2)}% < ${MIN_PROFIT_PCT}%) → 취소`, 'warn');
      return;
    }

    betInProgress = true;
    const opponentSource = opp.opponent === 'SBO' ? 'sbobet' : 'bti';
    await executeBets(pinSlipTab, opponentTab, pSlipNow, bSlipNow, profit, opponentSource);
  });
  const clearBtn = document.getElementById('clearLogBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    chrome.storage.local.remove('arbLogs');
    const logEl = document.getElementById('log');
    if (logEl) logEl.innerHTML = '';
  });
  document.getElementById('stopBtn').disabled = true;
  updateUI(null, null, null);
  // 저장된 설정 복원
  chrome.storage.local.get(['arbSettings'], result => {
    const s = result.arbSettings;
    if (!s) return;
    if (s.minBet) document.getElementById('minBet').value = s.minBet;
    if (s.usdtRate) { usdtRate = s.usdtRate; const el = document.getElementById('usdtRate'); if(el) el.value = s.usdtRate; }
    if (s.anchorSite) { anchorSite = s.anchorSite; updateSiteSelectUI(); }
    if (s.lineTolerance !== undefined) document.getElementById('lineTolerance').value = s.lineTolerance;
    const autoEl = document.getElementById('autoDetect');
    if (autoEl && s.autoDetect !== undefined) {
      autoEl.checked = s.autoDetect;
      if (typeof toggleManualMkt === 'function') toggleManualMkt();
    }
    if (s.mktPeriod) document.getElementById('mktPeriod').value = s.mktPeriod;
    if (s.mktType) {
      document.getElementById('mktType').value = s.mktType;
      if (typeof updateSideOptions === 'function') updateSideOptions();
    }
    if (s.mktSide) document.getElementById('mktSide').value = s.mktSide;
  });
  // 독립 창 열기 버튼
  const openWinBtn = document.getElementById('openWindowBtn');
  if (openWinBtn) {
    openWinBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_WINDOW' });
    });
  }
  // 저장된 로그 복원
  renderSavedLogs();

  // PIN 진단 버튼
  const diagPinBtn = document.getElementById('diagPinBtn');
  if (diagPinBtn) diagPinBtn.addEventListener('click', async () => {
    addLog('PIN 진단 시작...', 'info');
    const { pinTab } = await findTabs();
    if (!pinTab) { addLog('❌ 피나클 탭 미발견', 'error'); return; }
    addLog(`PIN 탭: id=${pinTab.id} frameId=${pinTab.frameId}`, 'info');
    const result = await execInTab(pinTab, function() {
      const out = [];
      out.push(`url:${location.href.substring(0,80)}`);
      // 1. 모든 input 탐색 (visible 여부 포함)
      const inputs = document.querySelectorAll('input');
      out.push(`input수:${inputs.length}`);
      Array.from(inputs).slice(0,10).forEach((inp,i) => {
        const visible = inp.offsetParent !== null ? 'visible' : 'hidden';
        out.push(`  input[${i}]:name="${inp.name}" ph="${(inp.placeholder||'').substring(0,20)}" cls="${inp.className.substring(0,50)}" [${visible}]`);
      });
      // 2. fullWidth 클래스 버튼 탐색 (피나클 베팅 확인 버튼)
      const allBtns = Array.from(document.querySelectorAll('button'));
      const fullWidthBtns = allBtns.filter(b => b.className.includes('fullWidth'));
      out.push(`fullWidth버튼:${fullWidthBtns.length}`);
      fullWidthBtns.slice(0,5).forEach((b,i) => {
        out.push(`  fw[${i}]:cls="${b.className.substring(0,60)}" txt="${b.textContent.trim().substring(0,40)}" disabled=${b.disabled}`);
      });
      // 3. 베팅/확인/수락 텍스트 버튼
      const confirmBtns = allBtns.filter(b => {
        const t = b.textContent.trim();
        return t.includes('베팅') || t.includes('확인') || t.includes('수락') || t.includes('Place') || t.includes('Bet') || t.includes('Accept');
      });
      out.push(`베팅버튼:${confirmBtns.length}`);
      confirmBtns.slice(0,8).forEach((b,i) => {
        out.push(`  bet[${i}]:cls="${b.className.substring(0,60)}" txt="${b.textContent.trim().substring(0,40)}" disabled=${b.disabled}`);
      });
      // 4. 오버/언더 텍스트 포함 버튼 (배당판)
      const ouBtns = allBtns.filter(b => {
        const t = b.textContent.trim();
        return (t.includes('오버') || t.includes('언더') || t.toLowerCase().includes('over') || t.toLowerCase().includes('under')) && t.length < 30;
      });
      out.push(`OU버튼:${ouBtns.length}`);
      ouBtns.slice(0,5).forEach((b,i) => {
        out.push(`  ou[${i}]:cls="${b.className.substring(0,50)}" txt="${b.textContent.trim().substring(0,30)}"`);
      });
      // 5. selected 클래스 버튼 (슬립에 담긴 배당)
      const selectedBtns = allBtns.filter(b => b.className.split(' ').some(c => c.startsWith('selected-')));
      out.push(`selected버튼:${selectedBtns.length}`);
      selectedBtns.slice(0,3).forEach((b,i) => {
        out.push(`  sel[${i}]:cls="${b.className.substring(0,60)}" txt="${b.textContent.trim().substring(0,40)}"`);
      });
      // 6. data-testid 속성 있는 요소 (bet/slip/stake)
      const testIdEls = Array.from(document.querySelectorAll('[data-testid]')).filter(el => {
        const dt = el.getAttribute('data-testid') || '';
        return dt.toLowerCase().includes('bet') || dt.toLowerCase().includes('slip') || dt.toLowerCase().includes('stake');
      });
      out.push(`testid-bet요소:${testIdEls.length}`);
      testIdEls.slice(0,5).forEach((el,i) => {
        out.push(`  tid[${i}]:testid="${el.getAttribute('data-testid')}" tag=${el.tagName} txt="${el.textContent.trim().substring(0,30)}"`);
      });
      return out.join('\n');
    });
    if (!result) { addLog('❌ PIN inject 실패', 'error'); return; }
    result.split('\n').forEach(line => addLog(line, 'info'));
  });

  // BTI 진단 버튼 — iframe/API/DOM 전체 점검
  const diagBtn = document.getElementById('diagBtiBtn');
  if (diagBtn) diagBtn.addEventListener('click', async () => {
    addLog('BTI 서치 진단 시작...', 'info');
    chrome.runtime.sendMessage({ type: 'DIAG_BTI_SEARCH' }, (resp) => {
      if (!resp || !resp.ok) {
        addLog('❌ ' + (resp?.error || '진단 실패'), 'error');
        return;
      }
      addLog(`탭: ${(resp.tabUrl || '').substring(0, 70)}`, 'info');
      addLog(`API origin: ${resp.apiOrigin}`, 'info');
      addLog(`iframe ${resp.frameCount}개 / src샘플: ${(resp.iframeSrcs || []).join(' | ').substring(0, 120)}`, 'info');
      if (resp.apiTest?.ok) {
        addLog(`✅ 라이브 API OK — ${resp.apiTest.count}건`, 'success');
      } else {
        addLog(`❌ 라이브 API 실패: ${resp.apiTest?.error || '?'}`, 'error');
      }
      if (resp.prematchTest?.ok) {
        addLog(`✅ 프리매치 API OK — 축구 ${resp.prematchTest.count}건`, 'success');
      } else {
        addLog(`❌ 프리매치 API 실패: ${resp.prematchTest?.error || '?'}`, 'error');
      }
      addLog(`DOM 폴백 경기: ${resp.domEventCount}건`, resp.domEventCount ? 'success' : 'warn');
      (resp.framePings || []).forEach((p) => {
        addLog(`frame ${p.frameId}: btn=${p.buttonCount} top=${p.isTop} ${(p.href || p.url || '').substring(0, 50)}`, 'info');
      });
      if (!resp.apiTest?.ok && !resp.domEventCount) {
        addLog('→ pbc00 로그인 후 BTI 배당 화면(gamecode=19)을 열고 새로고침하세요', 'warn');
      }
    });
  });

  // SBO 진단 버튼
  const diagSboBtn = document.getElementById('diagSboBtn');
  if (diagSboBtn) diagSboBtn.addEventListener('click', async () => {
    addLog('SBO 진단 시작...', 'info');
    const { sboTab } = await findTabs();
    if (!sboTab) { addLog('❌ SBOBET 탭 미발견 (wg88ss.com 탭 + zzllrrcc33.com iframe 필요)', 'error'); return; }
    addLog(`SBO 탭: id=${sboTab.id} frameId=${sboTab.frameId} url=${sboTab.url ? sboTab.url.substring(0,60) : '?'}`, 'info');
    // DOM 구조 진단 (MAIN world - execInTab)
    window._sboTabId = sboTab.id; window._sboFrameId = sboTab.frameId || 0;
    const result = await execInTab(sboTab, function() {
      const out = [];
      out.push(`url:${location.href.substring(0,80)}`);
      const inputs = Array.from(document.querySelectorAll('input'));
      out.push(`input수:${inputs.length}`);
      inputs.slice(0,10).forEach((inp,i) => {
        const visible = inp.offsetParent !== null ? 'visible' : 'hidden';
        out.push(`  input[${i}]:id="${inp.id}" ph="${(inp.placeholder||'').substring(0,20)}" cls="${(inp.getAttribute('class')||'').substring(0,50)}" [${visible}]`);
      });
      const allBtns = Array.from(document.querySelectorAll('button, input[type=submit]'));
      out.push(`버튼수:${allBtns.length}`);
      allBtns.slice(0,15).forEach((b,i) => {
        const t = (b.textContent || b.value || '').trim().substring(0,30);
        out.push(`  btn[${i}]:txt="${t}" id="${b.id}" cls="${(b.getAttribute('class')||'').substring(0,50)}"`);
      });
      const slipEls = Array.from(document.querySelectorAll('[class*="ticket"],[class*="stake"]'));
      out.push(`슬립요소:${slipEls.length}`);
      slipEls.slice(0,8).forEach((el,i) => {
        out.push(`  slip[${i}]:tag=${el.tagName} id="${el.id}" cls="${(el.getAttribute('class')||'').substring(0,60)}" txt="${el.textContent.trim().substring(0,30)}"`);
      });
      const allEls = Array.from(document.querySelectorAll('span, td, div'));
      const oddsEls = allEls.filter(el => {
        const t = el.textContent.trim();
        return /^\d+\.\d{2,3}$/.test(t) && parseFloat(t) > 1.01 && parseFloat(t) < 30 && el.children.length === 0;
      });
      out.push(`배당요소:${oddsEls.length}`);
      oddsEls.slice(0,8).forEach((el,i) => {
        out.push(`  odds[${i}]:tag=${el.tagName} txt="${el.textContent.trim()}" cls="${(el.getAttribute('class')||'').substring(0,50)}"`);
      });
      // content script 주입 여부 - MAIN world에서는 항상 undefined (정상)
      out.push(`[MAIN world에서 content script 함수 직접 접근 불가 - sendMessage로 확인]`);
      return out.join('\n');
    });
    if (result) result.split('\n').forEach(line => addLog(line, 'info'));
    // executeScript MAIN world 방식으로 슬립 읽기 테스트 (sendMessage 방식 제거)
    addLog('--- executeScript(MAIN world) 방식으로 슬립 읽기 테스트 ---', 'info');
    const slipResult = await execInTab(sboTab, sbobetReadSlipFn);
    if (slipResult === null || slipResult === undefined) {
      addLog('슬립읽기결과: null (슬립 비어있거나 ticketContainer 없음)', 'warn');
    } else {
      addLog(`✅ MAIN world 슬립 읽기 성공!`, 'success');
      addLog(`슬립읽기결과: ${JSON.stringify(slipResult)}`, 'info');
    }
  });

  // ── 봇 시작 전 슬립 미리보기 (2초마다) ──
  async function previewSlip() {
    if (botRunning) return;
    const { pinSlipTab, btiTab, sboTab } = await findTabs();
    const opponentTab = sboTab || btiTab;
    if (!pinSlipTab && !opponentTab) return;
    if (sboTab) { window._sboTabId = sboTab.id; window._sboFrameId = sboTab.frameId || 0; }

    const opponentReadFn = sboTab ? sbobetReadSlipFn : btiReadSlipFn;
    let pSlip = cachedPinSlip;
    let bSlip = sboTab ? cachedSboSlip : cachedBtiSlip;

    if (!pSlip && pinSlipTab) {
      pSlip = await execInTab(pinSlipTab, pinnacleReadSlipFn);
    }
    if (!bSlip && opponentTab) {
      if (!sboTab) {
        bSlip = await readBtiSlipFromFrame(opponentTab.id, opponentTab.frameId ?? 0);
      } else {
        bSlip = await execInTab(opponentTab, opponentReadFn);
      }
    }

    const profit = (pSlip && bSlip && pSlip.odds > 1 && bSlip.odds > 1)
      ? calcProfit(pSlip.odds, bSlip.odds) : null;
    updateUI(pSlip, bSlip, profit);
  }
  setInterval(previewSlip, 500);
  previewSlip();

  // API 진단 버튼 (background.js를 통해 CORS 우회)
  const diagApiBtn = document.getElementById('diagApiBtn');
  if (diagApiBtn) diagApiBtn.addEventListener('click', async () => {
    addLog('API 진단 시작...', 'info');

    // 피나클 API - background에서 fetch
    const pinResp = await new Promise(resolve =>
      chrome.runtime.sendMessage({
        type: 'FETCH_PIN_API',
        url: 'https://api.arcadia.pinnacle.com/0.1/sports/29/markets/highlighted/straight?primaryOnly=false'
      }, resolve)
    );
    addLog('=== 피나클 API ===', 'info');
    if (pinResp && pinResp.ok) {
      const data = pinResp.data;
      addLog('isArray: ' + Array.isArray(data), 'info');
      if (Array.isArray(data)) {
        addLog('count: ' + data.length, 'info');
        if (data[0]) addLog('keys[0]: ' + Object.keys(data[0]).join(', '), 'info');
        if (data[0]) addLog('sample[0]: ' + JSON.stringify(data[0]).substring(0, 500), 'info');
        // matchupId로 팀명 조회
        const firstMatchupId = data[0] && data[0].matchupId;
        if (firstMatchupId) {
          const matchupResp = await new Promise(resolve =>
            chrome.runtime.sendMessage({
              type: 'FETCH_PIN_API',
              url: `https://api.arcadia.pinnacle.com/0.1/matchups/${firstMatchupId}`
            }, resolve)
          );
          addLog('=== matchup 샘플 (id=' + firstMatchupId + ') ===', 'info');
          if (matchupResp && matchupResp.ok) {
            addLog('matchup keys: ' + Object.keys(matchupResp.data).join(', '), 'info');
            addLog('matchup: ' + JSON.stringify(matchupResp.data).substring(0, 600), 'info');
          } else {
            addLog('matchup 오류: ' + (matchupResp ? matchupResp.error : '없음'), 'error');
            // 대안: matchups 배치 API
            const batchResp = await new Promise(resolve =>
              chrome.runtime.sendMessage({
                type: 'FETCH_PIN_API',
                url: `https://api.arcadia.pinnacle.com/0.1/matchups?ids=${firstMatchupId}`
              }, resolve)
            );
            if (batchResp && batchResp.ok) {
              addLog('batch matchup: ' + JSON.stringify(batchResp.data).substring(0, 600), 'info');
            }
          }
        }
      } else if (data && typeof data === 'object') {
        addLog('keys: ' + Object.keys(data).join(', '), 'info');
        addLog('sample: ' + JSON.stringify(data).substring(0, 500), 'info');
      }
    } else {
      addLog('피나클 API 오류: ' + (pinResp ? pinResp.error : '응답없음'), 'error');
    }

    // 피나클 스포츠 목록
    const sportsResp = await new Promise(resolve =>
      chrome.runtime.sendMessage({
        type: 'FETCH_PIN_API',
        url: 'https://api.arcadia.pinnacle.com/0.1/sports?hasStraightSpecials=false&hasParlay=false'
      }, resolve)
    );
    addLog('=== 피나클 스포츠 목록 ===', 'info');
    if (sportsResp && sportsResp.ok) {
      const sports = sportsResp.data;
      if (Array.isArray(sports)) {
        sports.slice(0, 10).forEach(s => addLog(`sport: id=${s.id} name=${s.name} live=${s.matchupCount}`, 'info'));
      } else {
        addLog(JSON.stringify(sports).substring(0, 300), 'info');
      }
    } else {
      addLog('스포츠목록 오류: ' + (sportsResp ? sportsResp.error : '응답없음'), 'error');
    }

    // BTI API — pbc00 iframe 경유
    const btiResp = await new Promise(resolve =>
      chrome.runtime.sendMessage({
        type: 'FETCH_BTI_API',
        path: '/api/sportscenter/inplay/markets?language=KO&marketTypes=ML0%2CHC0%2COU0&minimumOdds=1.1&draft=false'
      }, resolve)
    );
    addLog('=== BTI API ===', 'info');
    if (btiResp && btiResp.ok) {
      const data = btiResp.data;
      addLog('isArray: ' + Array.isArray(data), 'info');
      if (Array.isArray(data)) {
        addLog('count: ' + data.length, 'info');
        if (data[0]) addLog('keys[0]: ' + Object.keys(data[0]).join(', '), 'info');
        if (data[0]) addLog('sample[0]: ' + JSON.stringify(data[0]).substring(0, 600), 'info');
      } else if (data && typeof data === 'object') {
        addLog('keys: ' + Object.keys(data).join(', '), 'info');
        addLog('sample: ' + JSON.stringify(data).substring(0, 600), 'info');
      }
    } else {
      addLog('BTI API 오류: ' + (btiResp ? btiResp.error : '응답없음'), 'error');
    }
  });

  // 팀명 진단 버튼 - 피나클/BTI 실제 팀명 샘플 비교
  const diagTeamBtn = document.getElementById('diagTeamBtn');
  if (diagTeamBtn) diagTeamBtn.addEventListener('click', async () => {
    addLog('=== 팀명 진단 시작 ===', 'info');
    chrome.runtime.sendMessage({ type: 'DIAG_TEAM_NAMES' }, (resp) => {
      if (!resp) { addLog('팀명 진단 응답 없음', 'error'); return; }
      if (resp.error) { addLog('오류: ' + resp.error, 'error'); return; }
      addLog(`--- 피나클 팀명 [영문, background API] (${resp.pinCount}개 중 앞 10개) ---`, 'info');
      (resp.pinSamples || []).forEach((s, i) => addLog(`PIN_EN[${i}]: ${s}`, 'info'));
      addLog(`--- 피나클 팀명 [탭 content script 경유] (10개) ---`, 'info');
      (resp.pinKoSamples || []).forEach((s, i) => addLog(`PIN_KO[${i}]: ${s}`, 'info'));
      addLog(`--- BTI 팀명 샘플 (${resp.btiCount}개 중 앞 10개) ---`, 'info');
      (resp.btiSamples || []).forEach((s, i) => addLog(`BTI[${i}]: ${s}`, 'info'));
      if (resp.matchSamples && resp.matchSamples.length > 0) {
        addLog(`--- 매칭 성공 (${resp.matchSamples.length}개) ---`, 'success');
        resp.matchSamples.forEach((s, i) => addLog(`MATCH[${i}]: ${s}`, 'success'));
      } else {
        addLog('⚠️ 매칭 0개 - PIN_EN vs BTI 팀명 언어 불일치 확인', 'warn');
        addLog('팁: PIN_KO와 BTI 팀명이 동일한 언어인지 확인하세요', 'warn');
      }
    });
  });

  // ── 사이트 선택 버튼 핸들러 ──
  ['siteSelectPin', 'siteSelectBti', 'siteSelectSbo'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      anchorSite = btn.dataset.site;
      updateSiteSelectUI();
      readSettings();
      // 금액 레이블 및 단위 업데이트
      updateBetCalc(null, null);
    });
  });

  // ── minBet / usdtRate 입력 변경 시 즉시 계산 업데이트 ──
  const minBetEl = document.getElementById('minBet');
  const usdtRateEl = document.getElementById('usdtRate');
  if (minBetEl) minBetEl.addEventListener('input', () => {
    const v = parseFloat(minBetEl.value);
    if (!isNaN(v) && v > 0) { minBetAmount = v; updateBetCalc(null, null); }
  });
  if (usdtRateEl) usdtRateEl.addEventListener('input', () => {
    const r = parseFloat(usdtRateEl.value);
    if (!isNaN(r) && r > 0) { usdtRate = r; updateBetCalc(null, null); }
  });

  // 초기 UI 상태 설정
  updateSiteSelectUI();

  // SBO 토큰 상태 확인 - findTabs로 SBO 탭 찾아서 직접 토큰 요청
  async function checkSboTokenStatus() {
    const statusEl = document.getElementById('sboTokenStatus');
    if (!statusEl) return;
    // 1) background.js에 저장된 토큰 먼저 확인
    chrome.runtime.sendMessage({ type: 'GET_SBO_TOKEN_STATUS' }, async (bgResp) => {
      if (bgResp && bgResp.hasToken) {
        statusEl.textContent = '✅ SBO 토큰: 연결됨';
        statusEl.style.color = '#4ade80';
        return;
      }
      // 2) SBO 탭 찾아서 execInTab으로 URL에서 토큰 직접 추출 (sendMessage 방식 제거)
      try {
        const { sboTab } = await findTabs();
        if (!sboTab) {
          statusEl.textContent = '⚠️ SBO 탭 없음 → wg88ss.com SBOBET 페이지를 먼저 열어주세요';
          statusEl.style.color = '#fbbf24';
          return;
        }
        window._sboTabId = sboTab.id;
        window._sboFrameId = sboTab.frameId || 0;
        // execInTab으로 MAIN world에서 URL 파라미터에서 token 직접 추출
        const tokenInfo = await execInTab(sboTab, function() {
          const urlParams = new URLSearchParams(window.location.search);
          const tokenFromUrl = urlParams.get('token');
          if (tokenFromUrl) {
            const apiBase = 'https://queennew-prod.' + location.hostname.split('.').slice(-2).join('.');
            return { token: tokenFromUrl, apiBase, hostname: location.hostname };
          }
          // 스크립트 태그에서 토큰 추출 시도
          try {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
              const t = s.textContent || '';
              const m = t.match(/["']token["']\s*:\s*["']([A-Za-z0-9+/=%.]+)["']/);
              if (m && m[1].length > 20) {
                const apiBase = 'https://queennew-prod.' + location.hostname.split('.').slice(-2).join('.');
                return { token: decodeURIComponent(m[1]), apiBase, hostname: location.hostname };
              }
            }
          } catch(e) {}
          return null;
        });
        if (!tokenInfo || !tokenInfo.token) {
          statusEl.textContent = '⚠️ SBO 토큰 추출 실패 → wg88ss.com SBOBET 페이지에서 로그인 후 실행하세요';
          statusEl.style.color = '#f87171';
          return;
        }
        // 토큰 background.js에 등록
        chrome.runtime.sendMessage({ type: 'SBOBET_TOKEN', token: tokenInfo.token, apiBase: tokenInfo.apiBase, hostname: tokenInfo.hostname });
        statusEl.textContent = '✅ SBO 토큰: 연결됨 (' + (tokenInfo.hostname || '') + ')';
        statusEl.style.color = '#4ade80';
      } catch(e) {
        statusEl.textContent = '⚠️ SBO 탭 탐색 오류: ' + e.message;
        statusEl.style.color = '#f87171';
      }
    });
  }
  checkSboTokenStatus();
  setInterval(checkSboTokenStatus, 5000);

  // 경기 집중 모니터링 버튼
  const startFocusBtn = document.getElementById('startFocusBtn');
  const stopFocusBtn = document.getElementById('stopFocusBtn');
  if (startFocusBtn) startFocusBtn.addEventListener('click', () => startFocusMatch());
  if (stopFocusBtn) stopFocusBtn.addEventListener('click', () => {
    stopFocusMatch();
    addLog('경기 집중 모니터링 정지', 'info');
  });

  // 미러 모드 토글 버튼
  const autoMirrorToggle = document.getElementById('autoMirrorToggle');
  if (autoMirrorToggle) {
    autoMirrorToggle.addEventListener('click', () => {
      autoMirrorEnabled = !autoMirrorEnabled;
      autoMirrorLastKey = '';
      if (autoMirrorEnabled) {
        autoMirrorToggle.textContent = '🔄 미러 ON';
        autoMirrorToggle.style.background = '#059669';
        addLog('미러 모드 ON: 피나클 클릭 시 BTI 자동 반대편 담기', 'info');
      } else {
        autoMirrorToggle.textContent = '🔄 미러 OFF';
        autoMirrorToggle.style.background = '#6b7280';
        addLog('미러 모드 OFF', 'info');
      }
    });
  }
});

// ── 사이트 선택 UI 업데이트 함수 (DOMContentLoaded 밖에서도 호출 가능) ──
function updateSiteSelectUI() {
  const btns = {
    pin: document.getElementById('siteSelectPin'),
    bti: document.getElementById('siteSelectBti'),
    sbo: document.getElementById('siteSelectSbo')
  };
  const activeClasses = { pin: 'active', bti: 'bti-active', sbo: 'sbo-active' };

  Object.keys(btns).forEach(site => {
    const btn = btns[site];
    if (!btn) return;
    btn.className = 'bet-site-btn' + (site === anchorSite ? ' ' + activeClasses[site] : '');
  });

  // 금액 레이블 및 단위 업데이트
  const labelEl = document.getElementById('betAmountLabel');
  const unitEl = document.getElementById('betAmountUnit');
  const minBetEl = document.getElementById('minBet');
  if (anchorSite === 'pin') {
    if (labelEl) labelEl.textContent = '피나클 베팅금';
    if (unitEl) unitEl.textContent = '원 (KRW)';
    if (minBetEl) minBetEl.step = '1000';
    if (minBetEl && parseFloat(minBetEl.value) < 1000) minBetEl.value = '12000';
  } else if (anchorSite === 'bti') {
    if (labelEl) labelEl.textContent = 'BTI 베팅금';
    if (unitEl) unitEl.textContent = '원 (KRW)';
    if (minBetEl) minBetEl.step = '1000';
    if (minBetEl && parseFloat(minBetEl.value) < 1000) minBetEl.value = '12000';
  } else if (anchorSite === 'sbo') {
    if (labelEl) labelEl.textContent = 'SBOBET 베팅금';
    if (unitEl) unitEl.textContent = 'USDT (정수)';
    if (minBetEl) minBetEl.step = '1';
    if (minBetEl && parseFloat(minBetEl.value) > 1000) minBetEl.value = '10';
  }
}


// ═══════════════════════════════════════════════════════════════════
// 경기 집중 모니터링 기능
// 피나클 + BTI 탭에 동일 경기를 열어두면 전 마켓(ML/AH/OU 0.5단위)을
// 1초마다 스캔하여 양방 기회 발견 시 자동 베팅
// ═══════════════════════════════════════════════════════════════════

let focusRunning = false;
let focusTimer = null;
let focusBetInProgress = false;
let focusLastLogKey = '';
let autoMirrorEnabled = false;  // 피나클 클릭 시 BTI 자동 반대편 담기
let autoMirrorLastKey = '';     // 중복 클릭 방지

// 피나클 클릭 시 BTI 자동 반대편 담기 함수
async function autoMirrorToBti(pinSlip) {
  if (!pinSlip || !pinSlip.marketKey) return;
  if (pinSlip.marketKey === autoMirrorLastKey) return;
  autoMirrorLastKey = pinSlip.marketKey;

  const oppKey = getOppositeMarketKey(pinSlip.marketKey);
  if (!oppKey) return;

  const { btiTab, sboTab } = await findTabs();
  const opponentTab = btiTab || sboTab;
  if (!opponentTab) return;

  // BTI 탭에서 반대 마켓 버튼 클릭
  const result = await execInTab(opponentTab, function(targetKey) {
    let btns = Array.from(document.querySelectorAll('[class*="master_fe_Selections_selection"]'));
    if (!btns.length) btns = Array.from(document.querySelectorAll('[class*="selection_"]'));
    for (const btn of btns) {
      if (btn.disabled || btn.hasAttribute('disabled')) continue;
      const btnText = (btn.textContent || '').trim();
      if (!btnText) continue;
      const oddsMatch = btnText.match(/(\d+\.\d{2,4})(?:\s*)$/);
      if (!oddsMatch) continue;
      const odds = parseFloat(oddsMatch[1]);
      if (odds <= 1.01 || odds > 50) continue;
      // 마켓 타입 감지
      function dt(t){t=t.toLowerCase();if(t.includes('승패')||t.includes('머니 라인')||t.includes('money line'))return 'ml';if(t.includes('핸디캡')||t.includes('handicap'))return 'ah';if(t.includes('오버')||t.includes('언더')||t.includes('over')||t.includes('under'))return 'ou';return null;}
      function dp(t){t=t.toLowerCase();if(t.includes('전반전')||t.includes('1st half'))return '1h';if(t.includes('후반전')||t.includes('2nd half'))return '2h';return 'ft';}
      let mktTxt=btnText; let el=btn.parentElement;
      for(let i=0;i<8;i++){if(!el)break;const txt=(el.textContent||'').substring(0,300);if(txt.includes('핸디캡')||txt.includes('승패')||txt.includes('오버')||txt.includes('언더')||txt.includes('handicap')||txt.includes('money line')||txt.includes('over')||txt.includes('under')){mktTxt=txt+' '+btnText;break;}el=el.parentElement;}
      const period=dp(mktTxt); const type=dt(mktTxt); if(!type)continue;
      let line=null;
      const ouM=btnText.match(/(?:오버|언더|over|under)[\s]*([+-]?[\d]+\.?[\d]*)/i);if(ouM)line=parseFloat(ouM[1]);
      if(line===null){const m2=btnText.match(/([+-]\d+\.?\d*)/);if(m2)line=parseFloat(m2[1]);}
      const ct=btnText.toLowerCase();
      let side='home';
      if(type==='ou')side=(ct.includes('언더')||/\bunder\b/.test(ct))?'u':'o';
      else if(type==='ah')side=(ct.includes('어웨이')||/\baway\b/.test(ct))?'a':'h';
      else{if(ct.includes('어웨이')||/\baway\b/.test(ct))side='away';else side='home';}
      const mk=type==='ml'?`${period}_ml_${side}`:type==='ah'?`${period}_ah_${side}_${line}`:`${period}_ou_${side}_${line}`;
      if(mk===targetKey){btn.click();return{clicked:true,marketKey:mk,odds};}
    }
    return {clicked:false};
  }, [oppKey]);

  if (result && result.clicked) {
    addLog(`미러: 피나클 ${pinSlip.marketKey} 클릭 → BTI ${oppKey} 자동 담기 (${result.odds})`, 'info');
  }
}

// ─── 피나클 전 마켓 배당 읽기 함수 (탭에 주입) ─────────────────────
function pinnacleReadAllMarketsFn(teamFilter) {
  try {
    const results = [];
    const teamLow = teamFilter ? teamFilter.toLowerCase() : null;

    function detectPeriod(text) {
      const t = text.toLowerCase();
      if (t.includes('전반전') || t.includes('1st half') || t.includes('halftime')) return '1h';
      if (t.includes('후반전') || t.includes('2nd half')) return '2h';
      if (/[23]세트|[23]rd set/i.test(t)) return 'set';
      const mapM = t.match(/(?:지도|map|game)\s*(\d+)/i);
      if (mapM) return 'map' + mapM[1];
      // '경기'/match/series 키워드는 ft(전체 경기/시리즈 승자)로 처리
      if (t.includes('경기') || t.includes('match') || t.includes('series')) return 'ft';
      return 'ft';
    }
    function detectType(text) {
      const t = text.toLowerCase();
      if (t.includes('머니 라인') || t.includes('money line') || t.includes('moneyline')) return 'ml';
      if (t.includes('핸디캡') || t.includes('handicap') || t.includes('아시안')) return 'ah';
      if (t.includes('오버') || t.includes('언더') || t.includes('over/under') || /\bover\b|\bunder\b/i.test(t)) return 'ou';
      if (/총\s*득점|total\s*goals|total\s*points/.test(t)) return 'ou';
      return null;
    }
    function detectLine(text) {
      const m = text.match(/(?:오버|언더|over|under)[\s]*([+-]?[\d]+\.?[\d]*)/i);
      if (m) return parseFloat(m[1]);
      const m2 = text.match(/([+-]\d+\.?\d*)/);
      if (m2) return parseFloat(m2[1]);
      return null;
    }

    // 모든 market-btn 버튼 스캔
    const allBtns = Array.from(document.querySelectorAll('button[class*="market-btn"]'));

    for (const btn of allBtns) {
      if (btn.disabled) continue;
      const btnText = (btn.textContent || '').trim();
      if (!btnText || btnText.includes('Market Offline')) continue;

      // 팀명 필터: matchup-market-groups 컨테이너에서 팀명 확인
      if (teamLow) {
        let matchFound = false;
        let elCheck = btn.parentElement;
        for (let i = 0; i < 15 && elCheck; i++) {
          const cls = elCheck.className || '';
          if (cls.includes('matchup-market-groups') || cls.includes('matchup-') || cls.includes('game-row') || cls.includes('event-row')) {
            const containerText = (elCheck.textContent || '').toLowerCase();
            if (containerText.includes(teamLow)) { matchFound = true; }
            break;
          }
          elCheck = elCheck.parentElement;
        }
        // 컨테이너를 못 찾으면 버튼 title 속성으로 확인
        if (!matchFound) {
          const titleAttr = (btn.getAttribute('title') || '').toLowerCase();
          if (titleAttr.includes(teamLow) || btnText.toLowerCase().includes(teamLow)) {
            matchFound = true;
          }
        }
        if (!matchFound) continue;
      }

      // 배당 추출
      let odds = null;
      const priceEl = btn.querySelector('span[class*="price-"]');
      if (priceEl) {
        const n = parseFloat(priceEl.textContent.trim());
        if (n > 1.01 && n < 100) odds = n;
      }
      if (!odds) {
        const nums = btnText.match(/\d+\.\d{2,4}/g);
        if (nums && nums.length > 0) {
          const last = parseFloat(nums[nums.length - 1]);
          if (last > 1.01 && last < 100) odds = last;
        }
      }
      if (!odds) continue;

      // 상위 컨테이너에서 마켓명 추출
      let marketText = btnText;
      let el = btn.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!el) break;
        const txt = el.textContent || '';
        if (txt.includes('오버/언더') || txt.includes('Over/Under') ||
            txt.includes('핸디콡') || txt.includes('Handicap') ||
            txt.includes('머니 라인') || txt.includes('Money Line') ||
            txt.includes('지도') || txt.includes('Map ') || txt.includes('Game ') ||
            /맵\s*\d/.test(txt)) {
          if (txt.length < 500) { marketText = txt.substring(0, 200) + ' ' + btnText; break; }
        }
        el = el.parentElement;
      }

      const cleanText = btnText
        .replace(/Odds\s+Decreased/gi, '')
        .replace(/Odds\s+Increased/gi, '')
        .trim();

      const period = detectPeriod(marketText);
      const type = detectType(marketText);
      if (!type) continue;

      // 피나클: 게임 전용 마켓만 허용 ("\u2013 게임" 포함)
      // 이닝(예: 5이닝, 6이닝), 세트, 팀 총계 제외
      const isGameMarket = marketText.includes('– 게임') || marketText.includes('- 게임') || marketText.includes('\u2013 Game') || marketText.includes('- Game');
      const isInningMarket = /\d+이닝|\d+th inning|\d+st inning|\d+nd inning|\d+rd inning/i.test(marketText);
      const isTeamTotal = marketText.includes('팀 총계') || /team total/i.test(marketText);
      // 게임 마켓이 아니거나 이닝/팀총계면 제외
      if (!isGameMarket || isInningMarket || isTeamTotal) continue;

      const line = detectLine(cleanText);

      // 0.5 단위 필터 (AH, OU)
      if ((type === 'ah' || type === 'ou') && line !== null) {
        const remainder = Math.abs(line) % 0.5;
        if (remainder > 0.05 && remainder < 0.45) continue; // 0.5 단위 아닌 것 제외
      }

      // side 감지
      let side = 'home';
      const ct = cleanText.toLowerCase();
      if (type === 'ou') {
        side = (ct.includes('언더') || /\bunder\b/.test(ct)) ? 'u' : 'o';
      } else if (type === 'ah') {
        // AH: 기준점 부호로 판별 (피나클도 BTI와 동일하게)
        // title 속성에 +1.5 이면 away, -1.5 이면 home
        const titleAttr = btn.getAttribute('title') || '';
        const lineSignMatch = titleAttr.match(/^([+-])/) || cleanText.match(/([+-])\d/);
        if (lineSignMatch) {
          side = lineSignMatch[1] === '+' ? 'a' : 'h';
        } else if (line !== null) {
          side = line > 0 ? 'a' : 'h';
        } else {
          side = 'h';
        }
      } else {
        // ML: 피나클는 첫 번째 버튼이 away팀, 마지막이 home팀
        // (moneyline 컨테이너 기준)
        if (ct.includes('무승부') || /\bdraw\b/.test(ct)) {
          side = 'draw';
        } else {
          let mlContainer = btn.parentElement;
          let foundSide = null;
          for (let i = 0; i < 6 && mlContainer; i++) {
            const cls = mlContainer.className || '';
            // moneyline 클래스가 있는 컨테이너 찾기
            if (cls.includes('moneyline') || cls.includes('money-line')) {
              const mlBtns = Array.from(mlContainer.querySelectorAll('button[class*="market-btn"]'))
                .filter(b => !(b.textContent||'').toLowerCase().includes('무승부') && !/draw/i.test(b.textContent||''));
              if (mlBtns.length >= 2) {
                const idx = mlBtns.indexOf(btn);
                // 피나클 경기 상세 페이지: 첫 번째 = away, 마지막 = home
                if (idx === 0) foundSide = 'away';
                else if (idx === mlBtns.length - 1) foundSide = 'home';
                else foundSide = 'draw';
              }
              break;
            }
            mlContainer = mlContainer.parentElement;
          }
          // moneyline 컨테이너 못 찾으면: aria-label 기반 판별
          if (!foundSide) {
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            // 피나클 aria-label: "머니 라인 222" (양수 = away), "머니 라인 -281" (음수 = home)
            const ariaNum = ariaLabel.match(/([+-]?\d+)\s*$/);
            if (ariaNum) {
              foundSide = parseInt(ariaNum[1]) > 0 ? 'away' : 'home';
            } else {
              foundSide = 'home';
            }
          }
          side = foundSide;
        }
      }

      // 무승부 제외
      if (side === 'draw') continue;

      const marketKey = type === 'ml' ? `${period}_ml_${side}` :
                        type === 'ah' ? `${period}_ah_${side}_${line}` :
                        `${period}_ou_${side}_${line}`;

      results.push({ odds, marketKind: type, period, side, line, marketKey, selectionText: cleanText, isSelected: btn.className.split(' ').some(c => c.startsWith('selected-')) });
    }

    return results;
  } catch(e) { return []; }
}

// ─── BTI 전 마켓 배당 읽기 함수 (탭에 주입) ─────────────────────────
function btiReadAllMarketsFn() {
  try {
    const results = [];
    const seen = new Set();

    function detectPeriod(text) {
      const t = text.toLowerCase();
      if (t.includes('전반전') || t.includes('1st half') || t.includes('1h') || t.includes('halftime')) return '1h';
      if (t.includes('후반전') || t.includes('2nd half') || t.includes('2h')) return '2h';
      if (/[23]세트|[23]rd set/i.test(t)) return 'set';
      const mapM = t.match(/(?:맵|map|game|지도)\s*(\d+)/i);
      if (mapM) return 'map' + mapM[1];
      // '경기' 키워드는 ft(전체 경기/시리즈 승자)로 처리
      // '머니 라인 - 경기' 등 BTI 이스포츠 시리즈 승자 마켓
      if (t.includes('경기') || t.includes('match') || t.includes('series')) return 'ft';
      return 'ft';
    }
    function detectType(text) {
      const t = text.toLowerCase();
      if (t.includes('승패') || t.includes('머니 라인') || t.includes('money line') || t.includes('moneyline') || t.includes('승자')) return 'ml';
      if (t.includes('핸디캡') || t.includes('handicap') || t.includes('아시안')) return 'ah';
      if (t.includes('오버') || t.includes('언더') || t.includes('over') || t.includes('under') || t.includes('총계')) return 'ou';
      return null;
    }

    // ── 아시안뷰 버튼 구조 (master_fe_Selections_selection) ──
    // ── 유로피안뷰 버튼 구조 (eventpage_fe_*Selection_line) ──
    const isEuropean = !!document.querySelector('[class*="eventpage_fe_MoneyLineSelection_line"],[class*="eventpage_fe_HandicapSelection_line"],[class*="eventpage_fe_OverUnderSelection_line"]');

    let allBtns;
    if (isEuropean) {
      // 유로피안뷰: MoneyLine / Handicap / OverUnder 버튼 직접 선택
      allBtns = Array.from(document.querySelectorAll(
        '[class*="eventpage_fe_MoneyLineSelection_line"],[class*="eventpage_fe_HandicapSelection_line"],[class*="eventpage_fe_OverUnderSelection_line"]'
      ));
    } else {
      // 아시안뷰: master_fe_Selections_selection
      allBtns = Array.from(document.querySelectorAll('[class*="master_fe_Selections_selection"]'));
      if (!allBtns.length) allBtns = Array.from(document.querySelectorAll('[class*="selection_"]'));
    }
    if (!allBtns.length) return [];

    // 아시안뷰는 odds span 있는 버튼만 필터
    const btns = isEuropean ? allBtns : allBtns.filter(b => b.querySelector('[class*="master_fe_Selections_odds"],[class*="Selections_odds"]'));

    for (const btn of btns) {
      if (btn.disabled || btn.hasAttribute('disabled')) continue;

      let odds, selText, line = null, mktText = '', btnType = null;

      if (isEuropean) {
        // ── 유로피안뷰 파싱 ──
        const cls = btn.className || '';

        if (cls.includes('MoneyLineSelection')) {
          // 승패: <div class="MoneyLineSelection_value">팀명1.72</div>
          // 배당은 텍스트 마지막 숫자
          const txt = btn.textContent.trim();
          const m = txt.match(/(\d+\.\d{2,4})$/);
          if (!m) continue;
          odds = parseFloat(m[1]);
          selText = txt.replace(m[1], '').trim();
          btnType = 'ml';
        } else if (cls.includes('HandicapSelection')) {
          // 핸디캡: odds span = eventpage_fe_HandicapSelection_odds
          //         nameContainer = eventpage_fe_HandicapSelection_nameContainer
          const oddsEl = btn.querySelector('[class*="HandicapSelection_odds"]');
          const nameEl = btn.querySelector('[class*="HandicapSelection_nameContainer"]');
          if (!oddsEl) continue;
          odds = parseFloat(oddsEl.textContent.trim());
          const nameTxt = nameEl ? nameEl.textContent.trim() : btn.textContent.trim();
          // 기준점: nameContainer 텍스트에서 마지막 숫자 추출 (예: "휴스턴 애스트로스 -3.5")
          const ptM = nameTxt.match(/([+-]?\d+\.?\d*)$/);
          if (ptM) line = parseFloat(ptM[1]);
          // 쿼터 라인 처리 (예: "-0.5/1")
          const ptM2 = nameTxt.match(/([+-]?\d+\/\d+\.?\d*)$/);
          if (ptM2) {
            const raw = ptM2[1];
            const sign = raw.startsWith('-') ? -1 : 1;
            const parts = raw.replace(/[+-]/g,'').split('/');
            line = sign * parts.reduce((a,b)=>a+parseFloat(b),0)/parts.length;
          }
          selText = nameTxt;
          btnType = 'ah';
        } else if (cls.includes('OverUnderSelection')) {
          // 오버언더: odds span = eventpage_fe_OverUnderSelection_odds
          //           namePoints span = eventpage_fe_OverUnderSelection_namePoints
          const oddsEl = btn.querySelector('[class*="OverUnderSelection_odds"]');
          const nameEl = btn.querySelector('[class*="OverUnderSelection_namePoints"]');
          if (!oddsEl) continue;
          odds = parseFloat(oddsEl.textContent.trim());
          const nameTxt = nameEl ? nameEl.textContent.trim() : btn.textContent.trim();
          // 기준점: 오버/언더 뒤 숫자 (예: "오버 4.5")
          const ptM = nameTxt.match(/(?:오버|언더|over|under)[\s]*([+-]?[\d]+\.?[\d]*)/i);
          if (ptM) line = parseFloat(ptM[1]);
          selText = nameTxt;
          btnType = 'ou';
        } else {
          continue;
        }

        // 마켓명: 상위 eventpage_fe_Markets_expanded 에서 첫 텍스트
        let el = btn.parentElement;
        for (let i = 0; i < 8 && el; i++) {
          if ((el.className||'').includes('Markets_expanded') || (el.className||'').includes('Markets_container')) {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const texts = [];
            let node;
            while ((node = walker.nextNode()) && texts.length < 3) {
              const t = node.textContent.trim();
              if (t && t.length > 1 && !/^\d+\.\d+$/.test(t) && !t.includes('일시적')) texts.push(t);
            }
            mktText = texts.join(' ');
            break;
          }
          el = el.parentElement;
        }
      } else {
        // ── 아시안뷰 파싱 ──
        const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"],[class*="Selections_odds"]');
        if (!oddsEl) continue;
        odds = parseFloat(oddsEl.textContent.trim());

        const nameEl = btn.querySelector('[class*="selectionNameLine"],[class*="SelectionName"]');
        selText = nameEl ? nameEl.textContent.trim() : (btn.textContent||'').trim();

        const ptsEl = btn.querySelector('[class*="master_fe_Selections_points"],[class*="Selections_points"]');
        if (ptsEl) {
          const ptsText = ptsEl.textContent.trim();
          if (ptsText.includes('/')) {
            const parts = ptsText.replace(/[+-]/g,'').split('/');
            const avg = parts.reduce((a,b)=>a+parseFloat(b),0)/parts.length;
            const sign = ptsText.trim().startsWith('-') ? -1 : 1;
            line = sign * avg;
          } else {
            const parsed = parseFloat(ptsText);
            if (!isNaN(parsed)) line = parsed;
          }
        }
        if (line === null) {
          const ouM = selText.match(/(?:오버|언더|over|under)[\s]*([+-]?[\d]+\.?[\d]*)/i);
          if (ouM) line = parseFloat(ouM[1]);
        }
        if (line === null) {
          const m2 = selText.match(/([+-]\d+\.?\d*)/);
          if (m2) line = parseFloat(m2[1]);
        }

        let el = btn.parentElement;
        for (let i = 0; i < 8 && el; i++) {
          if ((el.className||'').includes('Markets_container') || (el.className||'').includes('Market_')) {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const texts = [];
            let node;
            while ((node = walker.nextNode()) && texts.length < 3) {
              const t = node.textContent.trim();
              if (t && t.length > 1 && !/^\d+\.\d+$/.test(t)) texts.push(t);
            }
            mktText = texts.join(' ');
            break;
          }
          el = el.parentElement;
        }
      }

      if (!odds || odds <= 1.01 || odds > 50) continue;

      // BTI 마켓 필터: 승패/핸디콡/오버언더 관련 마켓만 허용 (아시안뷰만 적용)
      // 제외: 정확한 스코어, 양팀 모두 득점, 코너킹, 카드 등
      if (!isEuropean && mktText) {
        const mktLow = mktText.toLowerCase();
        // 허용: 승패/핸디콡/오버언더 + 머니 라인/경기 승자 마켓
        const isAllowedMarket =
          mktLow.includes('승패') || mktLow.includes('핸디콡') ||
          mktLow.includes('오버') || mktLow.includes('언더') ||
          mktLow.includes('머니 라인') || mktLow.includes('money line') ||
          mktLow.includes('moneyline') || mktLow.includes('handicap') ||
          mktLow.includes('over') || mktLow.includes('under') ||
          mktLow.includes('아시안') || mktLow.includes('asian');
        // 제외: 정확한 스코어, 양팀 모두, 코너킹, 카드, 다음 등
        // '승자'는 '지도 N - 승자' 마켓에 포함되므로 제외 목록에서 제거
        const isExcludedMarket =
          mktLow.includes('정확한 스코어') ||
          mktLow.includes('양팀 모두') || mktLow.includes('코너킹') ||
          mktLow.includes('카드') || mktLow.includes('다음 등') ||
          mktLow.includes('correct score') || mktLow.includes('both teams') ||
          mktLow.includes('팀 오버') || mktLow.includes('team over');
        if (!isAllowedMarket || isExcludedMarket) continue;
      }

      // 5. 경기 컨테이너에서 period 추출
      let periodText = mktText;
      let el2 = btn.parentElement;
      for (let i = 0; i < 10 && el2; i++) {
        if ((el2.className||'').includes('Event_match') || (el2.className||'').includes('EventCard') || (el2.className||'').includes('eventpage_fe_Markets_container')) {
          periodText = (el2.textContent||'').substring(0, 200);
          break;
        }
        el2 = el2.parentElement;
      }

      const period = detectPeriod(periodText);

      // 마켓 타입 판별: 유로피안뷰는 btnType 우선, 아니면 선택명/마켓명 기준
      let type;
      if (btnType) {
        type = btnType;
      } else {
        const selLow = selText.toLowerCase();
        if (selLow.includes('오버') || selLow.includes('언더') || /\bover\b|\bunder\b/.test(selLow)) {
          type = 'ou';
        } else if (mktText) {
          type = detectType(mktText);
        } else {
          type = detectType(selText);
        }
      }
      if (!type) continue;

      // 0.5 단위 필터
      if ((type === 'ah' || type === 'ou') && line !== null) {
        const remainder = Math.abs(line) % 0.5;
        if (remainder > 0.05 && remainder < 0.45) continue;
      }

      // side 감지
      const ct = selText.toLowerCase();
      let side;
      if (type === 'ou') {
        side = (ct.includes('언더') || /\bunder\b/.test(ct)) ? 'u' : 'o';
      } else if (type === 'ah') {
        // BTI는 홈/어웨이 텍스트 없음 — 기준점 부호로 판별: 음수(-) = 홈, 양수(+) = 어웨이
        if (line !== null) {
          side = line < 0 ? 'h' : 'a';
        } else {
          // 기준점 없으면 어웨이 키워드로 판별
          side = (ct.includes('어웨이') || /\baway\b/.test(ct)) ? 'a' : 'h';
        }
      } else {
        // ML: 버튼 순서로 판별 (1번째 = home, 마지막 = away)
        if (ct.includes('무승부') || /\bdraw\b/.test(ct)) {
          side = 'draw';
        } else {
          // 같은 마켓 컨테이너에서 ML 버튼 목록 추출
          let mlContainer = btn.parentElement;
          let foundSide = null;
          for (let i = 0; i < 8 && mlContainer; i++) {
            // 유로피안뷰: MoneyLine_markets 컨테이너 안의 MoneyLineSelection 버튼들
            const mlBtns = Array.from(mlContainer.querySelectorAll(
              '[class*="MoneyLineSelection_line"]'
            ));
            if (mlBtns.length >= 2) {
              const idx = mlBtns.indexOf(btn);
              if (idx === 0) foundSide = 'home';
              else if (idx === mlBtns.length - 1) foundSide = 'away';
              else foundSide = 'draw'; // 무승부
              break;
            }
            // 아시안뷰: master_fe_Selections_selection 버튼들 (승패 컨테이너)
            const asiaBtns = Array.from(mlContainer.querySelectorAll('[class*="master_fe_Selections_selection"]'))
              .filter(b => b.querySelector('[class*="Selections_odds"]'));
            if (asiaBtns.length >= 2) {
              const idx = asiaBtns.indexOf(btn);
              if (idx === 0) foundSide = 'home';
              else if (idx === asiaBtns.length - 1) foundSide = 'away';
              else foundSide = 'draw';
              break;
            }
            mlContainer = mlContainer.parentElement;
          }
          side = foundSide || 'home';
        }
      }
      if (side === 'draw') continue;

      const marketKey = type === 'ml' ? `${period}_ml_${side}` :
                        type === 'ah' ? `${period}_ah_${side}_${line}` :
                        `${period}_ou_${side}_${line}`;

      // 중복 제거 (marketKey 기준)
      if (seen.has(marketKey)) continue;
      seen.add(marketKey);

      results.push({ odds, marketKind: type, period, side, line, marketKey, selectionText: selText.substring(0, 80), btn });
    }

    return results;
  } catch(e) { return []; }
}

// ─── 반대 마켓 키 계산 ────────────────────────────────────────────
function getOppositeMarketKey(marketKey) {
  // ft_ou_o_8.5 → ft_ou_u_8.5
  // ft_ou_u_8.5 → ft_ou_o_8.5
  // ft_ah_h_-1.5 → ft_ah_a_1.5
  // ft_ah_a_1.5 → ft_ah_h_-1.5
  // ft_ml_home → ft_ml_away
  // ft_ml_away → ft_ml_home
  const parts = marketKey.split('_');
  if (parts.length < 3) return null;
  const [period, type, side, ...rest] = parts;
  if (type === 'ou') {
    const oppSide = side === 'o' ? 'u' : 'o';
    return [period, type, oppSide, ...rest].join('_');
  }
  if (type === 'ah') {
    const oppSide = side === 'h' ? 'a' : 'h';
    const line = rest[0] ? parseFloat(rest[0]) : null;
    const oppLine = line !== null ? -line : null;
    return oppLine !== null ? `${period}_ah_${oppSide}_${oppLine}` : null;
  }
  if (type === 'ml') {
    const oppSide = side === 'home' ? 'away' : (side === 'away' ? 'home' : null);
    return oppSide ? `${period}_ml_${oppSide}` : null;
  }
  return null;
}

// ─── 경기 집중 모니터링 루프 ─────────────────────────────────────────
async function focusMatchLoop() {
  if (!focusRunning || focusBetInProgress) return;

  const { pinTab, pinSlipTab, btiTab, sboTab } = await findTabs();
  const opponentTab = btiTab || sboTab;
  const opponentSource = btiTab ? 'bti' : (sboTab ? 'sbobet' : null);

  if (!pinTab || !opponentTab) {
    const focusLogKey = 'no_tabs';
    if (focusLastLogKey !== focusLogKey) {
      focusLastLogKey = focusLogKey;
      addLog('⚠️ 경기 집중: 피나클 또는 BTI 탭을 열어주세요', 'warn');
    }
    if (focusRunning) focusTimer = setTimeout(focusMatchLoop, 1000);
    return;
  }

  // 피나클 전 마켓 읽기 (팀명 필터 함께 주입)
  const cfg = focusTeamConfig;
  const pinMarketsRaw = await execInTab(pinTab, pinnacleReadAllMarketsFn, [cfg.pinTeam || null]);
  // BTI 전 마켓 읽기
  const btiMarketsRaw = await execInTab(opponentTab, btiReadAllMarketsFn);

  // 마켓 타입 필터
  const pinMarkets = (pinMarketsRaw || []).filter(m => {
    if (m.marketKind === 'ml' && !cfg.mktMl) return false;
    if (m.marketKind === 'ah' && !cfg.mktAh) return false;
    if (m.marketKind === 'ou' && !cfg.mktOu) return false;
    return true;
  });
  const btiMarkets = (btiMarketsRaw || []).filter(m => {
    if (m.marketKind === 'ml' && !cfg.mktMl) return false;
    if (m.marketKind === 'ah' && !cfg.mktAh) return false;
    if (m.marketKind === 'ou' && !cfg.mktOu) return false;
    return true;
  });

  // 팀명 확인: 피나클 탭에서 팀명 확인 (페이지 텍스트 기반)
  if (cfg.pinTeam) {
    const pinPageText = await execInTab(pinTab, function() {
      return (document.body.textContent || '').toLowerCase().substring(0, 5000);
    }, []);
    if (pinPageText && !pinPageText.includes(cfg.pinTeam)) {
      const logKey = `pin_team_not_found_${cfg.pinTeam}`;
      if (focusLastLogKey !== logKey) {
        focusLastLogKey = logKey;
        const statusEl = document.getElementById('focusScanStatus');
        if (statusEl) statusEl.textContent = `피나클 탭에 "${cfg.pinTeam}" 경기 없음 — 해당 경기 페이지를 열어주세요`;
        addLog(`⚠️ 피나클 탭에 "${cfg.pinTeam}" 경기가 없습니다`, 'warn');
      }
      if (focusRunning) focusTimer = setTimeout(focusMatchLoop, 1500);
      return;
    }
  }
  if (cfg.btiTeam) {
    const btiPageText = await execInTab(opponentTab, function() {
      return (document.body.textContent || '').toLowerCase().substring(0, 5000);
    }, []);
    if (btiPageText && !btiPageText.includes(cfg.btiTeam)) {
      const logKey = `bti_team_not_found_${cfg.btiTeam}`;
      if (focusLastLogKey !== logKey) {
        focusLastLogKey = logKey;
        const statusEl = document.getElementById('focusScanStatus');
        if (statusEl) statusEl.textContent = `BTI 탭에 "${cfg.btiTeam}" 경기 없음 — 해당 경기 페이지를 열어주세요`;
        addLog(`⚠️ BTI 탭에 "${cfg.btiTeam}" 경기가 없습니다`, 'warn');
      }
      if (focusRunning) focusTimer = setTimeout(focusMatchLoop, 1500);
      return;
    }
  }

  if (!pinMarkets.length || !btiMarkets.length) {
    const logKey = `empty_${pinMarkets.length}_${btiMarkets.length}`;
    if (focusLastLogKey !== logKey) {
      focusLastLogKey = logKey;
      const statusEl = document.getElementById('focusScanStatus');
      if (statusEl) statusEl.textContent = `스캔 중... 피나클 ${pinMarkets.length}개 / BTI ${btiMarkets.length}개 마켓`;
      addLog(`집중 서치: 피나클 ${pinMarkets.length}개 / BTI ${btiMarkets.length}개 마켓`, 'info');
    }
    if (focusRunning) focusTimer = setTimeout(focusMatchLoop, 1000);
    return;
  }

  // BTI 마켓을 marketKey로 인덱싱
  const btiMap = {};
  for (const m of btiMarkets) {
    if (!btiMap[m.marketKey]) btiMap[m.marketKey] = m;
  }

  // 양방 기회 탐색: 같은 side끼리 매칭 (home↔home, away↔away, 기준점 동일)
  // 피나클 홈 (마지막 버튼) ↔ BTI 홈 (첫 번째 버튼) 매칭
  const opportunities = [];
  const allMatchedMarkets = [];

  for (const pin of pinMarkets) {
    // 같은 marketKey로 BTI에서 직접 찾기 (같은 side + 같은 기준점)
    const bti = btiMap[pin.marketKey];
    if (!bti) continue;

    const profit = calcProfit(pin.odds, bti.odds);
    allMatchedMarkets.push({ pin, bti, profit, oppKey: pin.marketKey });
    if (profit >= MIN_PROFIT_PCT) {
      opportunities.push({ pin, bti, profit, oppKey: pin.marketKey });
    }
  }

  // 실시간 서치 목록 테이블 업데이트
  const liveTableEl = document.getElementById('focusLiveTable');
  const liveRowsEl = document.getElementById('focusLiveRows');
  const liveCountEl = document.getElementById('focusLiveCount');
  if (liveTableEl && liveRowsEl) {
    liveTableEl.style.display = allMatchedMarkets.length > 0 ? 'block' : 'none';
    if (liveCountEl) liveCountEl.textContent = `${allMatchedMarkets.length}개 매칭`;

    // 수익률 내림차순 정렬
    allMatchedMarkets.sort((a, b) => b.profit - a.profit);

    liveRowsEl.innerHTML = allMatchedMarkets.map(m => {
      const isArb = m.profit >= MIN_PROFIT_PCT;
      const rowColor = isArb ? '#052e16' : 'transparent';
      const profitColor = m.profit >= MIN_PROFIT_PCT ? '#4ade80' : m.profit >= 0 ? '#fbbf24' : '#f87171';
      const profitSign = m.profit >= 0 ? '+' : '';

      // 마켓 타입 표시명
      let mktLabel = m.pin.marketKey;
      const k = m.pin.marketKey;
      if (k.includes('_ml_')) mktLabel = k.includes('_home') ? '승패 홈' : '승패 어';
      else if (k.includes('_ah_')) {
        const lineVal = m.pin.line !== null ? m.pin.line : '';
        mktLabel = `핸디 ${lineVal > 0 ? '+' : ''}${lineVal}`;
      } else if (k.includes('_ou_')) {
        const lineVal = m.pin.line !== null ? m.pin.line : '';
        mktLabel = k.includes('_o_') ? `오버 ${lineVal}` : `언더 ${lineVal}`;
      }
      // period 표시
      if (k.startsWith('1h_')) mktLabel = '[전반] ' + mktLabel;

      return `<tr style="background:${rowColor}; border-bottom:1px solid #0f2040;">
        <td style="padding:3px 6px; color:#ccc;">${mktLabel}</td>
        <td style="padding:3px 6px; text-align:center; color:#60a5fa;">${m.pin.odds.toFixed(2)}</td>
        <td style="padding:3px 6px; text-align:center; color:#34d399;">${m.bti.odds.toFixed(2)}</td>
        <td style="padding:3px 6px; text-align:center; color:${profitColor}; font-weight:bold;">${profitSign}${m.profit.toFixed(2)}%</td>
      </tr>`;
    }).join('');
  }

  // 스캔 상태 UI 업데이트
  const oppName2 = opponentSource === 'bti' ? 'BTI' : 'SBO';
  const statusEl = document.getElementById('focusScanStatus');
  if (statusEl) {
    statusEl.textContent = `스캔 중: 피나클 ${pinMarkets.length}개 / ${oppName2} ${btiMarkets.length}개 | 매칭 ${allMatchedMarkets.length}개 | 양방 ${opportunities.length}개`;
    statusEl.style.color = opportunities.length > 0 ? '#4ade80' : allMatchedMarkets.length > 0 ? '#fbbf24' : '#888';
  }
  const scanKey = `${pinMarkets.length}_${btiMarkets.length}_${opportunities.length}`;
  if (focusLastLogKey !== scanKey) {
    focusLastLogKey = scanKey;
    const oppName = opponentSource === 'bti' ? 'BTI' : 'SBO';
    addLog(`집중 서치: 피나클 ${pinMarkets.length}개 / ${oppName} ${btiMarkets.length}개 / 매칭 ${allMatchedMarkets.length}개 / 양방 ${opportunities.length}개`, 'info');
  }

  // 양방 기회 발견 시 자동 베팅
  if (opportunities.length > 0) {
    // 수익률 가장 높은 기회 선택
    opportunities.sort((a, b) => b.profit - a.profit);
    const best = opportunities[0];
    const oppName = opponentSource === 'bti' ? 'BTI' : 'SBO';

    addLog(`🎯 경기 집중 양방 발견! 수익률 ${best.profit.toFixed(2)}%`, 'success');
    addLog(`[${best.pin.marketKey}] 피나클 ${best.pin.odds} / ${oppName} ${best.bti.odds}`, 'info');

    focusBetInProgress = true;

    // 피나클 탭에서 해당 마켓 버튼 클릭 (슬립에 담기)
    const pinClickResult = await execInTab(pinTab, function(targetKey) {
      const allBtns = Array.from(document.querySelectorAll('button[class*="market-btn"]'));
      for (const btn of allBtns) {
        if (btn.disabled) continue;
        const btnText = (btn.textContent || '').trim();
        if (!btnText || btnText.includes('Market Offline')) continue;
        // 이미 선택된 버튼이면 스킵
        if (btn.className.split(' ').some(c => c.startsWith('selected-'))) continue;
        // 배당 추출
        let odds = null;
        const priceEl = btn.querySelector('span[class*="price-"]');
        if (priceEl) { const n = parseFloat(priceEl.textContent.trim()); if (n > 1.01 && n < 100) odds = n; }
        if (!odds) { const nums = btnText.match(/\d+\.\d{2,4}/g); if (nums) { const last = parseFloat(nums[nums.length-1]); if (last > 1.01 && last < 100) odds = last; } }
        if (!odds) continue;
        // marketKey 계산
        function detectPeriod2(t) { t=t.toLowerCase(); if(t.includes('전반전')||t.includes('1st half'))return '1h'; if(t.includes('후반전')||t.includes('2nd half'))return '2h'; return 'ft'; }
        function detectType2(t) { t=t.toLowerCase(); if(t.includes('머니 라인')||t.includes('money line'))return 'ml'; if(t.includes('핸디캡')||t.includes('handicap'))return 'ah'; if(t.includes('오버')||t.includes('언더')||t.includes('over')||t.includes('under'))return 'ou'; return null; }
        let marketText = btnText; let el2 = btn.parentElement;
        for (let i=0;i<8;i++) { if(!el2)break; const txt=el2.textContent||''; if(txt.includes('오버/언더')||txt.includes('핸디캡')||txt.includes('머니 라인')||txt.includes('Over/Under')||txt.includes('Handicap')||txt.includes('Money Line')){marketText=txt.substring(0,200)+' '+btnText;break;} el2=el2.parentElement; }
        const period2=detectPeriod2(marketText); const type2=detectType2(marketText); if(!type2)continue;
        const ct2=btnText.toLowerCase();
        let side2='home';
        if(type2==='ou') side2=(ct2.includes('언더')||/\bunder\b/.test(ct2))?'u':'o';
        else if(type2==='ah') side2=(ct2.includes('어웨이')||/\baway\b/.test(ct2))?'a':'h';
        else { if(ct2.includes('어웨이')||/\baway\b/.test(ct2)) side2='away'; else side2='home'; }
        let line2=null;
        const m1=btnText.match(/(?:오버|언더|over|under)[\s]*([+-]?[\d]+\.?[\d]*)/i); if(m1)line2=parseFloat(m1[1]);
        if(line2===null){const m2=btnText.match(/([+-]\d+\.?\d*)/);if(m2)line2=parseFloat(m2[1]);}
        const mk2=type2==='ml'?`${period2}_ml_${side2}`:type2==='ah'?`${period2}_ah_${side2}_${line2}`:`${period2}_ou_${side2}_${line2}`;
        if(mk2===targetKey){ btn.click(); return {clicked:true,marketKey:mk2,odds}; }
      }
      return {clicked:false};
    }, [best.pin.marketKey]);

    if (!pinClickResult || !pinClickResult.clicked) {
      addLog(`⚠️ 피나클 마켓 버튼 클릭 실패 (${best.pin.marketKey}) - 슬립에 직접 담아주세요`, 'warn');
      focusBetInProgress = false;
      if (focusRunning) focusTimer = setTimeout(focusMatchLoop, 1000);
      return;
    }
    addLog(`✅ 피나클 마켓 클릭: ${best.pin.marketKey} (${best.pin.odds})`, 'info');
    await new Promise(r => setTimeout(r, 500));

    // BTI 탭에서 해당 마켓 버튼 클릭 (슬립에 담기)
    const btiClickResult = await execInTab(opponentTab, function(targetKey) {
      let btns = Array.from(document.querySelectorAll('[class*="master_fe_Selections_selection"]'));
      if (!btns.length) btns = Array.from(document.querySelectorAll('[class*="selection_"]'));
      for (const btn of btns) {
        if (btn.disabled || btn.hasAttribute('disabled')) continue;
        const btnText = (btn.textContent || '').trim();
        if (!btnText) continue;
        const oddsMatch = btnText.match(/(\d+\.\d{2,4})(?:\s*)$/);
        if (!oddsMatch) continue;
        const odds = parseFloat(oddsMatch[1]);
        if (odds <= 1.01 || odds > 50) continue;
        // marketKey 계산
        function detectPeriod3(t){t=t.toLowerCase();if(t.includes('전반전')||t.includes('1st half'))return '1h';if(t.includes('후반전')||t.includes('2nd half'))return '2h';return 'ft';}
        function detectType3(t){t=t.toLowerCase();if(t.includes('승패')||t.includes('머니 라인')||t.includes('money line'))return 'ml';if(t.includes('핸디캡')||t.includes('handicap'))return 'ah';if(t.includes('오버')||t.includes('언더')||t.includes('over')||t.includes('under'))return 'ou';return null;}
        let marketText2=btnText; let el3=btn.parentElement;
        for(let i=0;i<8;i++){if(!el3)break;const txt=(el3.textContent||'').substring(0,300);if(txt.includes('핸디캡')||txt.includes('승패')||txt.includes('오버')||txt.includes('언더')||txt.includes('handicap')||txt.includes('money line')||txt.includes('over')||txt.includes('under')){marketText2=txt+' '+btnText;break;}el3=el3.parentElement;}
        const period3=detectPeriod3(marketText2); const type3=detectType3(marketText2); if(!type3)continue;
        let line3=null;
        const ouM=btnText.match(/(?:오버|언더|over|under)[\s]*([+-]?[\d]+\.?[\d]*)/i);if(ouM)line3=parseFloat(ouM[1]);
        if(line3===null){const ptsEl=btn.querySelector('[class*="points"],[class*="pts"]');if(ptsEl)line3=parseFloat(ptsEl.textContent.trim());}
        if(line3===null){const m3=btnText.match(/([+-]\d+\.?\d*)/);if(m3)line3=parseFloat(m3[1]);}
        const ct3=btnText.toLowerCase();
        let side3='home';
        if(type3==='ou')side3=(ct3.includes('언더')||/\bunder\b/.test(ct3))?'u':'o';
        else if(type3==='ah')side3=(ct3.includes('어웨이')||/\baway\b/.test(ct3))?'a':'h';
        else{if(ct3.includes('어웨이')||/\baway\b/.test(ct3))side3='away';else side3='home';}
        const mk3=type3==='ml'?`${period3}_ml_${side3}`:type3==='ah'?`${period3}_ah_${side3}_${line3}`:`${period3}_ou_${side3}_${line3}`;
        if(mk3===targetKey){btn.click();return{clicked:true,marketKey:mk3,odds};}
      }
      return {clicked:false};
    }, [best.bti.marketKey]);

    if (!btiClickResult || !btiClickResult.clicked) {
      addLog(`⚠️ BTI 마켓 버튼 클릭 실패 (${best.bti.marketKey}) - 슬립에 직접 담아주세요`, 'warn');
      focusBetInProgress = false;
      if (focusRunning) focusTimer = setTimeout(focusMatchLoop, 1000);
      return;
    }
    addLog(`✅ BTI 마켓 클릭: ${best.bti.marketKey} (${best.bti.odds})`, 'info');
    await new Promise(r => setTimeout(r, 800));

    // 슬립 재확인 후 베팅 실행
    const [pSlipNow, bSlipNow] = await Promise.all([
      execInTab(pinSlipTab, pinnacleReadSlipFn),
      execInTab(opponentTab, btiReadSlipFn)
    ]);

    if (!pSlipNow || !bSlipNow) {
      addLog('⚠️ 슬립 재확인 실패 - 베팅 취소', 'warn');
      focusBetInProgress = false;
      if (focusRunning) focusTimer = setTimeout(focusMatchLoop, 2000);
      return;
    }

    const finalProfit = calcProfit(pSlipNow.odds, bSlipNow.odds);
    if (finalProfit < MIN_PROFIT_PCT) {
      addLog(`⚠️ 슬립 재확인 수익률 부족: ${finalProfit.toFixed(2)}% → 취소`, 'warn');
      focusBetInProgress = false;
      if (focusRunning) focusTimer = setTimeout(focusMatchLoop, 1000);
      return;
    }

    addLog(`🎯 최종 수익률 확인: ${finalProfit.toFixed(2)}% → 베팅 실행`, 'success');
    await executeBets(pinSlipTab, opponentTab, pSlipNow, bSlipNow, finalProfit, opponentSource);
    focusBetInProgress = false;
    // 베팅 완료 후 자동 정지
    stopFocusMatch();
    return;
  }

  if (focusRunning) focusTimer = setTimeout(focusMatchLoop, 1000);
}

// ─── 경기 집중 모니터링 시작/정지 ────────────────────────────────────
// 팀명 기반 집중 서치 설정
let focusTeamConfig = { pinTeam: '', btiTeam: '', mktMl: true, mktAh: true, mktOu: true };

function startFocusMatch() {
  if (focusRunning) return;

  // 팀명 입력값 읽기
  const pinTeamEl = document.getElementById('focusPinTeam');
  const btiTeamEl = document.getElementById('focusBtiTeam');
  const mktMlEl = document.getElementById('focusMktMl');
  const mktAhEl = document.getElementById('focusMktAh');
  const mktOuEl = document.getElementById('focusMktOu');

  const pinTeam = (pinTeamEl ? pinTeamEl.value.trim() : '').toLowerCase();
  const btiTeam = (btiTeamEl ? btiTeamEl.value.trim() : '').toLowerCase();
  const mktMl = mktMlEl ? mktMlEl.checked : true;
  const mktAh = mktAhEl ? mktAhEl.checked : true;
  const mktOu = mktOuEl ? mktOuEl.checked : true;

  if (!pinTeam && !btiTeam) {
    addLog('⚠️ 피나클 또는 BTI 팀명을 입력해주세요', 'warn');
    return;
  }
  if (!mktMl && !mktAh && !mktOu) {
    addLog('⚠️ 서치할 마켓을 하나 이상 체크해주세요', 'warn');
    return;
  }

  focusTeamConfig = { pinTeam, btiTeam, mktMl, mktAh, mktOu };
  focusRunning = true;
  focusBetInProgress = false;
  focusLastLogKey = '';

  const startBtn = document.getElementById('startFocusBtn');
  const stopBtn = document.getElementById('stopFocusBtn');
  if (startBtn) startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;

  const mktLabel = [mktMl?'승패':'', mktAh?'핸디캡':'', mktOu?'언오버':''].filter(Boolean).join('/');
  addLog(`🎯 집중 서치 시작 | 피나클: "${pinTeam||'전체'}" / BTI: "${btiTeam||'전체'}" | 마켓: ${mktLabel}`, 'success');
  focusMatchLoop();
}

function stopFocusMatch() {
  focusRunning = false;
  if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
  const startBtn = document.getElementById('startFocusBtn');
  const stopBtn = document.getElementById('stopFocusBtn');
  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
  const statusEl = document.getElementById('focusScanStatus');
  if (statusEl) { statusEl.textContent = '정지됨'; statusEl.style.color = '#666'; }
  // 실시간 테이블 초기화
  const liveTableEl = document.getElementById('focusLiveTable');
  const liveRowsEl = document.getElementById('focusLiveRows');
  const liveCountEl = document.getElementById('focusLiveCount');
  if (liveTableEl) liveTableEl.style.display = 'none';
  if (liveRowsEl) liveRowsEl.innerHTML = '';
  if (liveCountEl) liveCountEl.textContent = '0개 매칭';
}
