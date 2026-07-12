// 피나클 content script (v2.18)
// 실제 DOM 구조 기반:
//   배당 버튼: button[class*="market-btn"]
//   선택된 버튼: button[class*="selected-"] (슬립에 담긴 버튼)
//   배당 숫자: span[class*="price-"] (버튼 내부)
//   수락 버튼: button[class*="button-"][class*="fullWidth-"] (베팅 확인)
//   금액 입력: input (페이지 내 유일한 입력 필드)

function readPinnacleSlip() {
  function detectPeriod(text) {
    const t = text.toLowerCase();
    if (t.includes('전반전') || t.includes('1st half') || t.includes('halftime') || t.includes('half time')) return '1h';
    if (t.includes('후반전') || t.includes('2nd half')) return '2h';
    if (/[23]세트|[23]rd set|[23]nd set/i.test(t)) return 'set';
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
    // "오버 16.5" / "언더 16.5" / "Over 16.5" / "Under 16.5"
    const m = text.match(/(?:오버|언더|over|under)[\s]*([+-]?[\d]+\.?[\d]*)/i);
    if (m) return parseFloat(m[1]);
    // 핸디캡: "+1.5" / "-1.5"
    const m2 = text.match(/([+-]\d+\.?\d*)/);
    if (m2) return parseFloat(m2[1]);
    // 숫자만: "7.5" (이닝 등)
    const m3 = text.match(/\b(\d+\.?\d*)\b/);
    if (m3) return parseFloat(m3[1]);
    return null;
  }

  // ── 선택된 배당 버튼 탐색 ──
  // 피나클은 슬립 DOM이 별도로 없고, 클릭된 버튼에 "selected-" 클래스가 붙음
  const allBtns = document.querySelectorAll('button[class*="market-btn"]');
  const selectedBtns = Array.from(allBtns).filter(btn =>
    btn.className.includes('selected-') && !btn.disabled
  );

  if (!selectedBtns.length) return null;

  const btn = selectedBtns[0];
  const btnText = btn.textContent || '';

  // 배당 추출: span[class*="price-"] 또는 버튼 텍스트 마지막 숫자
  let odds = null;
  const priceEl = btn.querySelector('span[class*="price-"]');
  if (priceEl) {
    const n = parseFloat(priceEl.textContent.trim());
    if (n > 1.01 && n < 100) odds = n;
  }
  if (!odds) {
    // 버튼 텍스트에서 마지막 소수 추출 ("Odds Decreased오버 16.51.877" → 1.877)
    const nums = btnText.match(/\d+\.\d{2,4}/g);
    if (nums && nums.length > 0) {
      const last = parseFloat(nums[nums.length - 1]);
      if (last > 1.01 && last < 100) odds = last;
    }
  }
  if (!odds) return null;

  // 마켓명/기준점 추출: 버튼 텍스트에서 "Odds Decreased" / "Odds Increased" 제거 후 파싱
  const cleanText = btnText
    .replace(/Odds\s+Decreased/gi, '')
    .replace(/Odds\s+Increased/gi, '')
    .replace(/Market\s+Offline/gi, '')
    .trim();

  // 상위 컨테이너에서 마켓명 추출 (오버/언더, 핸디캡, 머니라인 등)
  let marketText = cleanText;
  // 버튼 상위 3단계에서 마켓명 div 탐색
  let el = btn.parentElement;
  for (let i = 0; i < 5; i++) {
    if (!el) break;
    const txt = el.textContent || '';
    if (txt.includes('오버/언더') || txt.includes('Over/Under') ||
        txt.includes('핸디캡') || txt.includes('Handicap') ||
        txt.includes('머니 라인') || txt.includes('Money Line')) {
      marketText = txt + ' ' + cleanText;
      break;
    }
    el = el.parentElement;
  }

  const period = detectPeriod(marketText);
  const type = detectType(marketText);
  const side = detectSide(cleanText, type);
  const line = detectLine(cleanText);
  const marketKey = type === 'ml' ? `${period}_ml_${side}` :
                    type === 'ah' ? `${period}_ah_${side}_${line}` :
                    `${period}_ou_${side}_${line}`;

  return { odds, marketKind: type, period, side, line, marketKey, selectionText: cleanText };
}

// ── 피나클 베팅 실행 ──
async function placePinnacleBet(amount) {
  try {
    // 금액 입력: 페이지 내 텍스트 input (검색창 제외)
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    const stakeInput = inputs.find(inp =>
      !inp.className.includes('search') && !inp.placeholder.includes('검색') &&
      inp.offsetParent !== null  // 화면에 보이는 input
    );

    if (!stakeInput) {
      // 금액 입력 필드가 없으면 "수락" 버튼만 클릭 (이미 금액이 설정된 경우)
      const acceptBtn = document.querySelector('button[class*="fullWidth-"]:not([disabled])');
      if (acceptBtn && (acceptBtn.textContent.includes('수락') || acceptBtn.textContent.includes('베팅') || acceptBtn.textContent.includes('확인'))) {
        acceptBtn.click();
        await new Promise(r => setTimeout(r, 1500));
        return { success: true };
      }
      return { success: false, reason: '금액 입력 필드 없음' };
    }

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(stakeInput, String(amount));
    stakeInput.dispatchEvent(new Event('input', { bubbles: true }));
    stakeInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));

    // 베팅 버튼: "수락" 또는 "베팅 확인" 버튼
    const allBtns = document.querySelectorAll('button:not([disabled])');
    let betBtn = null;
    for (const b of allBtns) {
      const t = b.textContent.trim();
      const cls = b.className;
      if ((t.includes('수락') || t.includes('베팅 확인') || t.includes('확인') || t.includes('Place Bet')) &&
          cls.includes('fullWidth-')) {
        betBtn = b; break;
      }
    }
    // fallback: fullWidth 버튼 중 첫 번째
    if (!betBtn) {
      for (const b of allBtns) {
        if (b.className.includes('fullWidth-') && b.textContent.trim().length > 0) {
          betBtn = b; break;
        }
      }
    }
    if (!betBtn) return { success: false, reason: '베팅 버튼 없음 (수락/베팅확인)' };
    betBtn.click();
    await new Promise(r => setTimeout(r, 1500));
    return { success: true };
  } catch(e) {
    return { success: false, reason: e.message };
  }
}

// popup의 요청에 응답
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, href: location.href, version: '2.19' });
    return false;
  }
  if (msg.type === 'READ_SLIP') {
    sendResponse({ slip: readPinnacleSlip() });
    return false;
  }
  if (msg.type === 'PLACE_BET') {
    placePinnacleBet(msg.amount).then(result => sendResponse(result));
    return true;
  }
  if (msg.type === 'FETCH_PREMATCH') {
    // 피나클 탭 컨텍스트에서 페이지 전용 API 키 추출 후 한국어 팀명 수집
    fetchPinPrematchKo(msg.sportId, msg.leagueIds).then(result => sendResponse(result));
    return true;
  }
});

// 피나클 페이지 전용 API 키 추출 (여러 방법 시도)
function getPinPageApiKey() {
  if (window.__PIN_API_KEY) return window.__PIN_API_KEY;
  // 스크립트 태그에서 API 키 패턴 찾기
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const m = s.textContent.match(/["']X-Api-Key["']\s*:\s*["']([A-Za-z0-9]{20,})["']/);
    if (m) { window.__PIN_API_KEY = m[1]; return m[1]; }
    // 다른 패턴: apiKey: '...'
    const m2 = s.textContent.match(/apiKey\s*[:=]\s*["']([A-Za-z0-9]{20,})["']/);
    if (m2) { window.__PIN_API_KEY = m2[1]; return m2[1]; }
  }
  return null;
}

// 피나클 탭에서 credentials:include로 프리매치 수집
// 피나클 한국어 세션 쿠키를 활용하여 한국어 팀명 반환 시도
async function fetchPinPrematchKo(sportId, leagueIds) {
  try {
    // 방법 1: 피나클 페이지 전용 API 키 (캐시된 것 우선)
    let apiKey = window.__PIN_API_KEY;

    // 방법 2: 페이지에서 키 추출 시도
    if (!apiKey) apiKey = getPinPageApiKey();

    // 방법 3: fetch 인터셉터 설치 후 키 대기
    if (!apiKey) {
      installPinApiKeyInterceptor();
      // 피나클 페이지가 API를 호출하도록 잠시 대기
      await new Promise(r => setTimeout(r, 800));
      apiKey = window.__PIN_API_KEY;
    }

    // 방법 4: 알려진 피나클 페이지 전용 키 사용 (credentials:include로 세션 활용)
    // 이 키는 피나클 탭 컨텍스트에서만 유효
    const PAGE_KEY = 'AI9lc7vjxbF2W9JnS9OJN6VJ7eRLlKuM';
    if (!apiKey) apiKey = PAGE_KEY;

    const url = `https://api.arcadia.pinnacle.com/0.1/sports/${sportId}/matchups?isLive=false&withSpecials=false`;

    // credentials:include로 피나클 세션 쿠키 활용 → 한국어 팀명 반환 가능성
    let res = await fetch(url, {
      headers: {
        'X-Api-Key': apiKey,
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Accept': 'application/json'
      },
      credentials: 'include'
    });

    // 403이면 캐시된 키로 재시도
    if (!res.ok && apiKey !== PAGE_KEY) {
      res = await fetch(url, {
        headers: {
          'X-Api-Key': PAGE_KEY,
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Accept': 'application/json'
        },
        credentials: 'include'
      });
    }

    if (!res.ok) return { ok: false, error: res.status };
    const data = await res.json();
    if (!Array.isArray(data)) return { ok: false, error: '응답 형식 오류', raw: JSON.stringify(data).slice(0, 200) };

    // matchupId → { home, away, league, startTime } 맵
    const byId = {};
    for (const m of data) byId[m.id] = m;

    function getParticipants(mu) {
      const direct = mu.participants;
      if (Array.isArray(direct) && direct.length >= 2 && direct.some((p) => p?.name)) return direct;
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

    const result = {};
    for (const mu of data) {
      if (mu.isLive) continue;
      if (mu.type && mu.type !== 'matchup') continue;
      if (mu.hasMarkets === false) continue;
      const parts = getParticipants(mu);
      if (parts.length < 2) continue;
      const home = parts.find((p) => p.alignment === 'home')?.name || parts[0]?.name || '';
      const away = parts.find((p) => p.alignment === 'away')?.name || parts[1]?.name || '';
      if (!home || !away) continue;
      result[mu.id] = { home, away, league: mu.league?.name || '', startTime: mu.startTime || null };
    }
    return { ok: true, matchups: result, count: Object.keys(result).length };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// 피나클 fetch 인터셉터로 API 키 포획 (페이지가 API 호출 시 자동 캡처)
function installPinApiKeyInterceptor() {
  if (window.__pinInterceptInstalled) return;
  window.__pinInterceptInstalled = true;
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    if (url.includes('arcadia.pinnacle.com') && init?.headers) {
      const headers = init.headers;
      let key = null;
      if (headers instanceof Headers) key = headers.get('X-Api-Key');
      else if (typeof headers === 'object') key = headers['X-Api-Key'] || headers['x-api-key'];
      if (key && key.length > 15) {
        window.__PIN_API_KEY = key;
      }
    }
    return origFetch.call(this, input, init);
  };
  // XHR 인터셉터 (setRequestHeader 오버라이드)
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (name && name.toLowerCase() === 'x-api-key' && value && value.length > 15) {
      window.__PIN_API_KEY = value;
    }
    return origSetHeader.call(this, name, value);
  };
}

// ── MutationObserver: 배당 변화 즉시 감지 ──
(function startPinnacleObserver() {
  let lastOddsKey = '';
  let debounceTimer = null;

  function checkAndNotify() {
    const slip = readPinnacleSlip();
    if (!slip) return;
    const key = `${slip.odds}_${slip.marketKey}`;
    if (key === lastOddsKey) return;
    lastOddsKey = key;
    try {
      chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: 'pinnacle', slip });
    } catch(e) {}
  }

  function scheduleCheck() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkAndNotify, 30);
  }

  const observer = new MutationObserver(scheduleCheck);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  checkAndNotify();
})();

console.log('[피나클봇] content script 로드됨 (v2.19)');
installPinApiKeyInterceptor();
