// SBOBET Content Script (sports-sbomaind-play.zzllrrcc33.com iframe)
// 실제 DOM 구조 (진단 결과 기반):
// ─ 슬립 컨테이너: div.ticketContainer > div.ticket.live > div.ticket_header / div.ticket_detail / div.ticket_option
// ─ 마켓 타입: div.ticket_header_title (예: "야구 - 머니 라인", "축구 - 아시아 1X2")
// ─ 팀명: div.ticket_detail (예: "Tohoku Rakuten Golden Eagles -")
// ─ 선택 내용: div.ticket_option (예: "Chiba Lotte Marines1.31라이브")
//   → ticket_option 텍스트에 배당값이 붙어있음: "팀명{배당}라이브" 패턴
// ─ 배당판 배당: div.oddsValue (실제 배당값)
// ─ 배당판 기준점: div.oddsPoint (핸디캡/오버언더 기준점 - 배당 아님!)
// ─ 금액 입력: input.input-stake (placeholder="판돈")
// ─ 베팅 버튼: button#placeBet.btn.btn-color.btn-block (텍스트: "베팅하기")

// ─── 슬립 읽기 함수 ──────────────────────────────────────────────────
function readSbobetSlip() {
  function detectPeriod(text) {
    const t = text.toLowerCase();
    if (t.includes('1h') || t.includes('first half') || t.includes('전반')) return '1h';
    if (t.includes('2h') || t.includes('second half') || t.includes('후반')) return '2h';
    return 'ft';
  }
  function detectType(headerText) {
    const t = headerText.toLowerCase();
    // 오버/언더 먼저 체크
    if (t.includes('over') || t.includes('under') || t.includes('o/u') ||
        t.includes('오버') || t.includes('언더') || t.includes('득점') || t.includes('total')) return 'ou';
    // 아시안 핸디캡: '아시아 1x2', '아시아', 'asian', 'handicap', 'hdp', '핸디'
    if (t.includes('아시아') || t.includes('asian') || t.includes('handicap') ||
        t.includes('hdp') || t.includes('핸디')) return 'ah';
    // 순수 승패: '머니라인', '머니 라인', '승패', 'money line', 'win/lose'
    if (t.includes('money') || t.includes('머니') || t.includes('승패') ||
        t.includes('win/lose') || t.includes('1x2')) return 'ml';
    return 'ml';
  }
  function detectSide(optionText, headerText, marketType) {
    const t = (optionText + ' ' + headerText).toLowerCase();
    if (marketType === 'ou') return (t.includes('under') || t.includes('언더')) ? 'u' : 'o';
    if (marketType === 'ah') return (t.includes('away') || t.includes('어웨이')) ? 'a' : 'h';
    if (t.includes('draw') || t.includes('무승부')) return 'draw';
    if (t.includes('away') || t.includes('어웨이')) return 'away';
    return 'home';
  }
  function detectLine(optionText, marketType) {
    if (marketType === 'ml') return null;
    // 패턴 1: "e-폴란드0.50@0:2@1.70라이브" → 첫 번째 소수 숫자가 기준점
    // @기호 앞의 첫 번째 소수 숫자 추출
    const atPattern = optionText.match(/([+-]?\d+\.\d+)@/);
    if (atPattern) {
      const n = parseFloat(atPattern[1]);
      if (!isNaN(n) && n > -20 && n < 20) return n;
    }
    // 패턴 2: oddsPoint div에서 기준점 가져오기
    const oddsPoints = document.querySelectorAll('.oddsPoint, [class*="oddsPoint"]');
    for (const el of oddsPoints) {
      const t = el.textContent.trim();
      const n = parseFloat(t);
      if (!isNaN(n) && n > -20 && n < 20) return n;
    }
    // 패턴 3: 부호있는 숫자
    const m = optionText.match(/([+-]\d+\.?\d*)/);
    if (m) return parseFloat(m[1]);
    return null;
  }

  // ── 슬립 컨테이너 탐색 ──
  const ticketContainer = document.querySelector('.ticketContainer, [class*="ticketContainer"]');
  if (!ticketContainer) return null;

  // ── 마켓 타입 추출 ──
  const headerTitle = ticketContainer.querySelector('.ticket_header_title, [class*="ticket_header_title"]');
  const headerText = headerTitle ? headerTitle.textContent.trim() : '';

  // ── 선택 내용 추출 ──
  const ticketOption = ticketContainer.querySelector('.ticket_option, [class*="ticket_option"]');
  const optionText = ticketOption ? ticketOption.textContent.trim() : '';

  // ── 배당 추출 ──
  // 방법 1: ticket_option 텍스트에서 배당 추출
  // 패턴: "Chiba Lotte Marines1.31라이브" → 1.31이 배당
  // 패턴: "팀명2.40라이브" → 2.40이 배당
  // 패턴: "Over 2.5 1.81라이브" → 1.81이 배당
  let odds = null;

  if (optionText) {
    // 텍스트 정규화: 라이브/Live/LIVE 제거
    const cleanText = optionText.replace(/라이브|Live|LIVE/g, '').trim();

    // 패턴 1: 마지막 @ 뒤에서 배당 추출
    // "오버5.00@3:0@2.041.99" → 마지막 @ 이후 "2.041.99" → 소수들 추출 → 마지막 유효 배당
    const lastAtIdx = cleanText.lastIndexOf('@');
    if (lastAtIdx !== -1) {
      const afterAt = cleanText.substring(lastAtIdx + 1);
      // afterAt에서 모든 소수 추출 (예: "2.041.99" → ["2.04", "1.99"])
      const numsInAt = afterAt.match(/\d+\.\d{2,4}/g) || [];
      // 뒤에서부터 배당 범위(1.01~20) 탐색
      for (let i = numsInAt.length - 1; i >= 0; i--) {
        const n = parseFloat(numsInAt[i]);
        if (n > 1.01 && n < 20) { odds = n; break; }
      }
    }

    // 패턴 2: 텍스트 끝에서 역방향으로 배당 범위(1.01~20) 숫자 탐색
    if (!odds) {
      const allNums = cleanText.match(/\d+\.\d{2,4}/g) || [];
      for (let i = allNums.length - 1; i >= 0; i--) {
        const n = parseFloat(allNums[i]);
        if (n > 1.01 && n < 20) { odds = n; break; }
      }
    }
  }

  // 방법 2: 슬립 컨테이너 내 oddsValue div 탐색
  // (ticket_option 내부에 있을 수 있음)
  if (!odds) {
    const oddsValueEls = ticketContainer.querySelectorAll('.oddsValue, [class*="oddsValue"]');
    for (const el of oddsValueEls) {
      const t = el.textContent.trim();
      const n = parseFloat(t);
      if (n > 1.01 && n < 50 && /^\d+\.\d{2,4}$/.test(t)) {
        odds = n; break;
      }
    }
  }

  // 방법 3: 전체 페이지 oddsValue div 중 슬립에 담긴 배당 탐색
  // 슬립에 담긴 배당은 selected/active 상태일 가능성 높음
  if (!odds) {
    const allOddsValue = document.querySelectorAll('.oddsValue, [class*="oddsValue"]');
    // selected 클래스 있는 것 우선
    for (const el of allOddsValue) {
      const parent = el.closest('[class*="selected"], [class*="active"], [class*="chosen"]');
      if (!parent) continue;
      const t = el.textContent.trim();
      const n = parseFloat(t);
      if (n > 1.01 && n < 50 && /^\d+\.\d{2,4}$/.test(t)) {
        odds = n; break;
      }
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

  return {
    odds,
    marketKind: type,
    period,
    side,
    line,
    marketKey,
    selectionText: optionText.substring(0, 100),
    headerText: headerText.substring(0, 60)
  };
}

// ─── 베팅 실행 함수 ──────────────────────────────────────────────────
async function placeSbobetBet(amount) {
  try {
    // ── 금액 입력 input 탐색 ──
    // 실제: input.input-stake (placeholder="판돈")
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

    // fallback: visible number/text input 중 checkbox 아닌 것
    if (!stakeInput) {
      const allInputs = document.querySelectorAll('input');
      for (const inp of allInputs) {
        if (inp.type === 'checkbox' || inp.type === 'hidden' || inp.type === 'radio') continue;
        if (inp.offsetParent !== null) { stakeInput = inp; break; }
      }
    }

    if (!stakeInput) {
      return { success: false, reason: '금액 입력 input 없음 (input.input-stake 못 찾음)' };
    }

    // SBOBET은 정수만 허용
    const intAmount = Math.floor(amount);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(stakeInput, String(intAmount));
    stakeInput.dispatchEvent(new Event('input', { bubbles: true }));
    stakeInput.dispatchEvent(new Event('change', { bubbles: true }));
    stakeInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));

    // ── 베팅 확인 버튼 탐색 ──
    // 실제: button#placeBet.btn.btn-color.btn-block (텍스트: "베팅하기")
    let betBtn = null;

    // SBOBET은 HTML disabled 속성이 아닌 CSS 클래스 'disabled'로 비활성화
    // 따라서 :not([disabled]) 대신 클래스로 확인
    function isBtnDisabled(b) {
      return b.hasAttribute('disabled') || (b.getAttribute('class') || '').includes('disabled');
    }

    // 1순위: id="placeBet" (disabled 클래스 없는 것 우선, 있어도 로딩 완료 후 재시도)
    const placeBetEl = document.querySelector('button#placeBet');
    if (placeBetEl && !isBtnDisabled(placeBetEl)) {
      betBtn = placeBetEl;
    } else if (placeBetEl) {
      // 로딩 중인 경우 최대 3초 대기
      addLog && addLog('SBO: placeBet 버튼 로딩 중 대기...', 'info');
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!isBtnDisabled(placeBetEl)) { betBtn = placeBetEl; break; }
      }
    }

    // 2순위: "베팅하기" 텍스트 버튼 (disabled 아닌 것)
    if (!betBtn) {
      const allBtns = document.querySelectorAll('button');
      for (const b of allBtns) {
        if (isBtnDisabled(b)) continue;
        const t = (b.textContent || '').trim();
        if (t === '베팅하기' || t === 'Bet Now' || t === 'Place Bet' || t === 'Confirm') {
          betBtn = b; break;
        }
      }
    }

    // 3순위: btn-block 클래스 (네비게이션 버튼 제외, disabled 아닌 것)
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
    await new Promise(r => setTimeout(r, 1500));

    // 베팅 성공 여부 확인
    const slipGone = !document.querySelector('.ticketContainer, [class*="ticketContainer"]');
    const successEl = document.querySelector('[class*="success"], [class*="accepted"], [class*="confirmed"]');
    if (successEl || slipGone) return { success: true };

    const errEl = document.querySelector('[class*="error"], [class*="Error"], [class*="rejected"]');
    if (errEl) return { success: false, reason: `베팅 거부: ${errEl.textContent.trim().substring(0, 80)}` };

    return { success: true };
  } catch(e) {
    return { success: false, reason: e.message };
  }
}

// ─── SBOBET 토큰 추출 ──────────────────────────────────────────────
function extractSbobetToken() {
  // URL 파라미터에서 token 추출
  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');
  if (tokenFromUrl) return tokenFromUrl;

  // window.__APOLLO_STATE__ 또는 전역 변수에서 추출
  try {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const t = s.textContent || '';
      const m = t.match(/["']token["']\s*:\s*["']([A-Za-z0-9+/=%.]+)["']/);
      if (m && m[1].length > 20) return decodeURIComponent(m[1]);
    }
  } catch(e) {}
  return null;
}

// 토큰 추출 후 background.js에 등록
function registerSbobetToken() {
  const token = extractSbobetToken();
  const apiBase = 'https://queennew-prod.' + location.hostname.split('.').slice(-2).join('.');
  if (token) {
    try {
      chrome.runtime.sendMessage({
        type: 'SBOBET_TOKEN',
        token,
        apiBase,
        hostname: location.hostname
      });
    } catch(e) {}
  }
}

// 페이지 로드 시 토큰 등록
try { registerSbobetToken(); } catch(e) {}
setTimeout(() => { try { registerSbobetToken(); } catch(e) {} }, 2000);

// ─── popup 메시지 수신 ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SBOBET_GET_TOKEN') {
    const token = extractSbobetToken();
    const apiBase = 'https://queennew-prod.' + location.hostname.split('.').slice(-2).join('.');
    sendResponse({ token, apiBase, hostname: location.hostname });
    return true;
  }
  if (msg.type === 'SBOBET_READ_SLIP' || msg.type === 'READ_SLIP') {
    sendResponse(readSbobetSlip());
    return true;
  }
  if (msg.type === 'SBOBET_PLACE_BET' || msg.type === 'PLACE_BET') {
    placeSbobetBet(msg.amount).then(sendResponse);
    return true;
  }
});

// ─── MutationObserver: 슬립 변경 감지 → popup에 알림 ────────────────
let _lastSbobetSlipKey = null;
let _sbobetObserverTimer = null;

function _sbobetNotify() {
  const slip = readSbobetSlip();
  if (!slip) return;
  const key = `${slip.odds}_${slip.marketKey}_${slip.selectionText}`;
  if (key === _lastSbobetSlipKey) return;
  _lastSbobetSlipKey = key;
  try {
    chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: 'sbobet', slip });
  } catch(e) {}
}

const _sbobetObserver = new MutationObserver(() => {
  if (_sbobetObserverTimer) clearTimeout(_sbobetObserverTimer);
  _sbobetObserverTimer = setTimeout(_sbobetNotify, 200);
});
_sbobetObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
