// BTI content script v2.20
// 실제 DOM 구조 (진단 결과 기준):
// ─ 슬립 카드: [class*="betslip_fe_BetSecondary_bet"] (wrapper/counter/badge 제외)
//     선택명: [class*="betInformation__title"][0] → "삼성 라이온스" (팀명 또는 "언더 16")
//     마켓명: [class*="betInformation__title"][1] → "[7:5] 라이브 승패 라이브 베팅"
//     이벤트: [class*="betInformation__eventName"] → "NC 다이노스 vs 삼성 라이온스"
//     배당: 슬립 카드 안에 배당 숫자 없음 → 배당판 버튼에서 읽어야 함
// ─ 배당판 버튼: button.master_fe_Selections_selection
//     텍스트: "삼성 라이온스-1.51.90" (팀명+기준점+배당 붙어있음)
//     배당 span: [class*="master_fe_Selections_odds"] → "1.90"
//     기준점 span: [class*="master_fe_Selections_points"] 또는 [class*="selectionNameLine"]
//     팀명 span: span:not([class]) 또는 빈 클래스 span
// ─ 금액 입력: input#counter (class: betslip_fe_CounterSecondary_input)
// ─ 베팅 버튼: button.sportsbook-Button (텍스트: "베팅하기")

function readBtiSlip() {
  // ── 1. 슬립 카드 탐색 ──
  const betCards = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
  const realCards = Array.from(betCards).filter(el =>
    !el.className.includes('wrapper') &&
    !el.className.includes('counter') &&
    !el.className.includes('bageGroup') &&
    !el.className.includes('badge') &&
    !el.className.includes('PlaceBet') &&
    !el.className.includes('Tab')
  );
  if (!realCards.length) return null;
  const card = realCards[0];

  // ── 2. 슬립에서 선택명/마켓명/이벤트명 추출 ──
  const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
  // [0]: 선택명 ("삼성 라이온스" 또는 "언더 16")
  // [1]: 마켓명 ("[7:5] 라이브 승패 라이브 베팅")
  const selectionText = titleEls[0] ? titleEls[0].textContent.trim() : '';
  const marketTitleText = titleEls[1] ? titleEls[1].textContent.trim() : '';

  const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
  const eventText = eventEl ? eventEl.textContent.trim() : '';

  const mktEl = card.querySelector('[class*="betInformation__marketName"]');
  const mktText = mktEl ? mktEl.textContent.trim() : marketTitleText;

  const allText = selectionText + ' ' + mktText + ' ' + marketTitleText;

  // ── 3. 배당판 버튼에서 배당 읽기 ──
  // 슬립 선택명으로 배당판 버튼 매칭
  let odds = null;
  let matchedLine = null;
  let matchedSide = null;

  const allBtns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');

  if (selectionText) {
    // 슬립 선택명에서 팀명과 기준점 분리
    // 예: "LG 트윈스 +5.5" → teamName="LG 트윈스", slipLine=+5.5
    // 예: "언더 16" → ouMatch
    // 예: "삼성 라이온스" → teamName="삼성 라이온스", slipLine=null
    const slipLineMatch = selectionText.match(/([+-]\d+\.?\d*)\s*$/);
    const slipLine = slipLineMatch ? parseFloat(slipLineMatch[1]) : null;
    const teamName = slipLine !== null
      ? selectionText.replace(slipLineMatch[0], '').trim()
      : selectionText;

    // 방식 A: points span 기준점 + 팀명으로 버튼 매칭
    // 예: slipLine=+5.5, teamName="LG 트윈스" → points="LG 트윈스+5.5" 버튼 탐색
    if (slipLine !== null) {
      for (const btn of allBtns) {
        const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
        if (!oddsEl) continue;
        const btnOdds = parseFloat(oddsEl.textContent.trim());
        if (!btnOdds || btnOdds <= 1.01 || btnOdds >= 100) continue;

        const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
        if (!pointsEl) continue;
        const pointsText = pointsEl.textContent.trim();

        // points span에 팀명 + 기준점 포함 여부 확인
        // 예: pointsText="LG 트윈스+5.5" 또는 "LG 트윈스 +5.5"
        const pointsLineMatch = pointsText.match(/([+-]\d+\.?\d*)\s*$/);
        if (!pointsLineMatch) continue;
        const pointsLine = parseFloat(pointsLineMatch[1]);

        if (Math.abs(pointsLine - slipLine) < 0.01) {
          // 팀명도 포함되는지 확인 (공백 무시)
          const pointsClean = pointsText.replace(/\s+/g, '').toLowerCase();
          const teamClean = teamName.replace(/\s+/g, '').toLowerCase();
          if (pointsClean.includes(teamClean) || teamClean.length < 2) {
            odds = btnOdds;
            matchedLine = pointsLine;
            break;
          }
        }
      }
    }

    // 방식 A-2: 버튼 텍스트에 선택명 포함 여부로 매칭 (기준점 없는 경우)
    // 마켓 타입(ML/AH/OU)에 맞는 버튼 우선 선택
    // 예: selectionText="삼성 라이온스", 마켓="승패" → points에 기준점 없는 ML 버튼 우선
    if (!odds) {
      // 슬립 마켓명으로 타입 미리 판별
      const slipMktType = (function() {
        const t = allText.toLowerCase();
        if (t.includes('머니 라인') || t.includes('money line') || t.includes('moneyline') || t.includes('승패')) return 'ml';
        if (t.includes('핸디캡') || t.includes('handicap') || t.includes('아시안')) return 'ah';
        if (t.includes('오버') || t.includes('언더') || t.includes('over') || t.includes('under') || t.includes('총계')) return 'ou';
        return 'ml';
      })();

      const candidates = [];
      for (const btn of allBtns) {
        const btnText = btn.textContent || '';
        const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
        if (!oddsEl) continue;
        const btnOdds = parseFloat(oddsEl.textContent.trim());
        if (!btnOdds || btnOdds <= 1.01 || btnOdds >= 100) continue;

        const btnTextClean = btnText.replace(/\s+/g, '');
        const selClean = selectionText.replace(/\s+/g, '');

        if (btnTextClean.includes(selClean) || selClean.includes(btnTextClean.replace(/[\d.]+$/,''))) {
          const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
          const pointsText = pointsEl ? pointsEl.textContent.trim() : '';
          // ML 버튼: points span에 기준점(+/-)이 없고 팀명만 있음
          const hasHandicap = /[+-]\d/.test(pointsText);
          const isOuBtn = btnText.includes('오버') || btnText.includes('언더') || btnText.toLowerCase().includes('over') || btnText.toLowerCase().includes('under');
          candidates.push({ btn, btnOdds, pointsText, hasHandicap, isOuBtn });
        }
      }

      // 마켓 타입에 맞는 후보 우선 선택
      let chosen = null;
      if (slipMktType === 'ml') {
        // ML: 핸디캡 없고 OU 아닌 버튼 우선
        chosen = candidates.find(c => !c.hasHandicap && !c.isOuBtn)
               || candidates.find(c => !c.isOuBtn)
               || candidates[0];
      } else if (slipMktType === 'ah') {
        // AH: 핸디캡 있는 버튼 우선
        chosen = candidates.find(c => c.hasHandicap)
               || candidates[0];
      } else {
        chosen = candidates[0];
      }

      if (chosen) {
        odds = chosen.btnOdds;
        const pointsEl = chosen.btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
        if (pointsEl) {
          const pm = pointsEl.textContent.trim().match(/([+-]?\d+\.?\d*)/);
          if (pm) matchedLine = parseFloat(pm[1]);
        }
        if (matchedLine === null) {
          const lineM = chosen.btn.textContent.match(/([+-]?\d+\.?\d*)(?=\s*\d+\.\d{2,4})/);
          if (lineM) matchedLine = parseFloat(lineM[1]);
        }
        if (chosen.btn.textContent.includes('언더') || chosen.btn.textContent.toLowerCase().includes('under')) matchedSide = 'u';
        else if (chosen.btn.textContent.includes('오버') || chosen.btn.textContent.toLowerCase().includes('over')) matchedSide = 'o';
      }
    }

    // 방식 B: OU 마켓 - "언더 16" 같은 선택명에서 기준점+side 추출 후 버튼 탐색
    if (!odds) {
      const ouMatch = selectionText.match(/(오버|언더|over|under)\s*([\d]+\.?[\d]*)/i);
      if (ouMatch) {
        const targetSide = (ouMatch[1].toLowerCase().includes('언더') || ouMatch[1].toLowerCase() === 'under') ? 'u' : 'o';
        const targetLine = parseFloat(ouMatch[2]);
        for (const btn of allBtns) {
          const btnText = btn.textContent || '';
          const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
          if (!oddsEl) continue;
          const btnOdds = parseFloat(oddsEl.textContent.trim());
          if (!btnOdds || btnOdds <= 1.01 || btnOdds >= 100) continue;

          const btnSide = (btnText.includes('언더') || btnText.toLowerCase().includes('under')) ? 'u' : 'o';
          if (btnSide !== targetSide) continue;

          // 기준점 확인
          const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
          let btnLine = null;
          if (pointsEl) {
            const pm = pointsEl.textContent.trim().match(/(\d+\.?\d*)/);
            if (pm) btnLine = parseFloat(pm[1]);
          }
          if (btnLine === null) {
            // 버튼 텍스트에서 기준점 추출 ("언더161.88" → 16)
            const lm = btnText.replace(/언더|오버|under|over/gi, '').match(/(\d+\.?\d*)/);
            if (lm) btnLine = parseFloat(lm[1]);
          }
          if (btnLine !== null && Math.abs(btnLine - targetLine) < 0.01) {
            odds = btnOdds;
            matchedLine = btnLine;
            matchedSide = targetSide;
            break;
          }
        }
      }
    }

    // 방식 C: 핸디캡 - "+1.5", "-1.5" 등
    if (!odds) {
      const ahMatch = selectionText.match(/([+-]\d+\.?\d*)/);
      if (ahMatch) {
        const targetLine = parseFloat(ahMatch[1]);
        for (const btn of allBtns) {
          const btnText = btn.textContent || '';
          const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
          if (!oddsEl) continue;
          const btnOdds = parseFloat(oddsEl.textContent.trim());
          if (!btnOdds || btnOdds <= 1.01 || btnOdds >= 100) continue;

          const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
          let btnLine = null;
          if (pointsEl) {
            const pm = pointsEl.textContent.trim().match(/([+-]?\d+\.?\d*)/);
            if (pm) btnLine = parseFloat(pm[1]);
          }
          if (btnLine === null) {
            const lm = btnText.match(/([+-]\d+\.?\d*)/);
            if (lm) btnLine = parseFloat(lm[1]);
          }
          if (btnLine !== null && Math.abs(btnLine - targetLine) < 0.01) {
            odds = btnOdds;
            matchedLine = btnLine;
            break;
          }
        }
      }
    }
  }

  // 배당을 못 찾아도 기준점/마켓 정보는 반환
  if (!odds) odds = 0;

  // ── 4. 마켓 타입/period/side/line 판별 ──
  function detectPeriod(text) {
    const t = text.toLowerCase();
    if (t.includes('전반전') || t.includes('1st half') || t.includes('halftime')) return '1h';
    if (t.includes('후반전') || t.includes('2nd half')) return '2h';
    if (/[23]세트|[23]rd set|[23]nd set/i.test(t)) return 'set';
    return 'ft';
  }
  function detectType(text) {
    const t = text.toLowerCase();
    if (t.includes('머니 라인') || t.includes('money line') || t.includes('moneyline') || t.includes('승패')) return 'ml';
    if (t.includes('핸디캡') || t.includes('handicap') || t.includes('아시안')) return 'ah';
    if (t.includes('오버') || t.includes('언더') || t.includes('over') || t.includes('under') || t.includes('총계')) return 'ou';
    return 'ml';
  }
  function detectSide(text, type) {
    const t = text.toLowerCase();
    if (type === 'ou') {
      if (matchedSide) return matchedSide;
      return (t.includes('언더') || t.includes('under')) ? 'u' : 'o';
    }
    if (type === 'ah') return (t.includes('어웨이') || t.includes('away')) ? 'a' : 'h';
    if (t.includes('무승부') || t.includes('draw')) return 'draw';
    if (t.includes('어웨이') || t.includes('away')) return 'away';
    return 'home';
  }
  function detectLine(text) {
    if (matchedLine !== null) return matchedLine;
    const m = text.match(/(?:오버|언더|over|under)[\s]*([\d]+\.?[\d]*)/i);
    if (m) return parseFloat(m[1]);
    const m2 = text.match(/([+-]\d+\.?\d*)/);
    if (m2) return parseFloat(m2[1]);
    const m3 = text.match(/([\d]+\.[\d]+)/);
    if (m3) return parseFloat(m3[1]);
    return null;
  }

  const period = detectPeriod(allText);
  // mktText(실제 마켓명) 우선 판별 — selectionText의 +1.5 등 기준점 숫자로 오판하는 버그 방지
  const type = mktText ? detectType(mktText) : detectType(allText);
  const side = detectSide(selectionText || allText, type);
  const line = detectLine(selectionText || allText);
  const marketKey = type === 'ml'
    ? `${period}_ml_${side}`
    : type === 'ah'
    ? `${period}_ah_${side}_${line}`
    : `${period}_ou_${side}_${line}`;

  // URL에서 이벤트 ID 추출
  const urlMatch = location.href.match(/\/(\d{10,20})(?:\/|$|\?|#)/);
  const eventId = urlMatch ? urlMatch[1] : null;

  return {
    odds,
    eventId,
    marketKind: type,
    period,
    side,
    line,
    marketKey,
    mktText,
    selectionText,  // "언더 16", "삼성 라이온스" 등 실제 선택명 (기준점 검증용)
    eventText       // "KIA 타이거즈 vs SSG 랜더스"
  };
}

// ── BTI 기준점 검증 ──
function validateBtiLine(targetLine, tolerance) {
  const slip = readBtiSlip();
  if (!slip) return { valid: false, reason: '슬립 없음' };
  if (slip.line === null) return { valid: false, reason: '기준점 파싱 실패' };
  const diff = Math.abs(slip.line - targetLine);
  if (diff > tolerance) {
    return {
      valid: false,
      reason: `기준점 불일치: 목표=${targetLine}, 실제=${slip.line}("${slip.selectionText}"), 차이=${diff.toFixed(2)}`,
      actualLine: slip.line,
      selectionText: slip.selectionText
    };
  }
  return { valid: true, actualLine: slip.line, selectionText: slip.selectionText };
}

// ── BTI 베팅 실행 ──
async function placeBtiBet(amount, targetLine, lineTolerance) {
  try {
    // ── 기준점 검증 (위치 변경 버그 방어) ──
    if (targetLine !== undefined && lineTolerance !== undefined) {
      const validation = validateBtiLine(targetLine, lineTolerance);
      if (!validation.valid) {
        return {
          success: false,
          reason: `⚠️ ${validation.reason} → 베팅 취소`,
          lineChanged: true
        };
      }
    }

    const betCards = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
    const realCards = Array.from(betCards).filter(el =>
      !el.className.includes('wrapper') &&
      !el.className.includes('counter') &&
      !el.className.includes('bageGroup') &&
      !el.className.includes('badge') &&
      !el.className.includes('PlaceBet') &&
      !el.className.includes('Tab')
    );
    if (!realCards.length) return { success: false, reason: '슬립 카드 없음' };

    // 금액 입력 필드
    const input = document.getElementById('counter')
      || document.querySelector('input[class*="CounterSecondary_input"], input[class*="counter__input"]');
    if (!input) return { success: false, reason: '금액 입력 필드 없음' };

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, String(amount));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await new Promise(r => setTimeout(r, 800));

    // 베팅 버튼 탐색
    const allBtns = document.querySelectorAll('button:not([disabled])');
    let betBtn = null;

    for (const btn of allBtns) {
      if (btn.className.includes('sportsbook-Button') && btn.textContent.trim().includes('베팅하기')) {
        betBtn = btn; break;
      }
    }
    if (!betBtn) {
      for (const btn of allBtns) {
        if (btn.className.includes('PlaceBetBlock') && !btn.className.includes('clearAll')) {
          betBtn = btn; break;
        }
      }
    }
    if (!betBtn) {
      for (const btn of allBtns) {
        const txt = btn.textContent.trim();
        if ((txt.includes('베팅하기') || txt.includes('베팅 확인')) &&
            !txt.includes('슬립') && !txt.includes('내 베팅') && !txt.includes('로그인')) {
          betBtn = btn; break;
        }
      }
    }

    if (!betBtn) return { success: false, reason: '베팅 버튼 없음 (금액 미입력 또는 최소금액 미달?)' };

    betBtn.click();
    await new Promise(r => setTimeout(r, 1500));
    return { success: true };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

// ── 배당판 스캔 (API 실패 시 DOM 폴백) ──

function parseSelectionButton(btn) {
  if (!btn) return null;
  const rawText = (btn.textContent || '').trim();
  const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
  if (!oddsEl) return null;
  const odds = parseFloat(oddsEl.textContent.trim());
  if (!odds || odds <= 1.01 || odds >= 100) return null;

  const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
  const pointsText = pointsEl ? pointsEl.textContent.trim() : '';

  let line = null;
  const lineMatch = (pointsText || rawText).match(/([+-]\d+\.?\d*)/);
  if (lineMatch) line = parseFloat(lineMatch[1]);
  else {
    const ouLine = rawText.replace(/오버|언더|over|under/gi, '').match(/(\d+\.?\d*)/);
    if (ouLine) line = parseFloat(ouLine[1]);
  }

  let label = pointsText || rawText.replace(String(odds), '').trim();
  label = label.replace(/[+-]?\d+\.?\d*$/, '').trim();

  return { odds, line, pointsText, label, rawText, element: btn };
}

function findEventNameNearButton(btn) {
  let el = btn.parentElement;
  for (let depth = 0; depth < 15 && el; depth++) {
    const selectors = [
      '[class*="eventName"]', '[class*="EventName"]',
      '[class*="competitor"]', '[class*="participants"]', '[class*="matchName"]'
    ];
    for (const sel of selectors) {
      const found = el.querySelector(sel);
      if (found) {
        const t = found.textContent.trim();
        if (t.includes('vs') || t.includes('VS') || t.includes(' @ ')) return t;
      }
    }
    const text = (el.textContent || '').trim();
    const vm = text.match(/([^\n]{2,50})\s+(?:vs|VS|v\.|@)\s+([^\n]{2,50})/);
    if (vm && text.length < 200) return `${vm[1].trim()} vs ${vm[2].trim()}`;
    el = el.parentElement;
  }
  return '';
}

function parseEventTeams(eventText) {
  if (!eventText) return { home: '', away: '' };
  for (const sep of [' vs ', ' VS ', ' v ', ' @ ']) {
    if (eventText.includes(sep)) {
      const [home, away] = eventText.split(sep, 2);
      return { home: home.trim(), away: away.trim() };
    }
  }
  return { home: eventText, away: '' };
}

function detectMarketType(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('머니 라인') || t.includes('money line') || t.includes('moneyline') || t.includes('승패')) return 'ml';
  if (t.includes('핸디캡') || t.includes('handicap') || t.includes('아시안')) return 'ah';
  if (t.includes('오버') || t.includes('언더') || t.includes('over') || t.includes('under') || t.includes('총계')) return 'ou';
  return 'ml';
}

function detectBoardSide(text, marketKind) {
  const t = (text || '').toLowerCase();
  if (marketKind === 'ou') return (t.includes('언더') || t.includes('under')) ? 'u' : 'o';
  if (marketKind === 'ah') return (t.includes('어웨이') || t.includes('away')) ? 'a' : 'h';
  if (t.includes('무승부') || t.includes('draw')) return 'draw';
  if (t.includes('어웨이') || t.includes('away')) return 'away';
  return 'home';
}

function scrapeBoardSelections() {
  const btns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');
  const byEvent = new Map();

  btns.forEach((btn, idx) => {
    const parsed = parseSelectionButton(btn);
    if (!parsed) return;

    const eventText = findEventNameNearButton(btn);
    const eventKey = eventText || `unknown_${idx}`;
    const { home, away } = parseEventTeams(eventText);

    const marketContainer = btn.closest('[class*="market"], [class*="Market"], [class*="selections"]');
    const marketText = marketContainer
      ? (marketContainer.querySelector('[class*="marketName"], [class*="MarketName"]')?.textContent || '').trim()
      : '';

    const marketKind = detectMarketType(marketText || parsed.rawText);
    const side = detectBoardSide(parsed.label || parsed.rawText, marketKind);

    const entry = {
      eventText, homeTeam: home, awayTeam: away,
      selectionText: parsed.label || parsed.rawText,
      marketText, marketKind, side, line: parsed.line, odds: parsed.odds,
      pointsText: parsed.pointsText,
      eventId: (location.href.match(/\/(\d{10,20})/) || [])[1] || null
    };

    if (!byEvent.has(eventKey)) byEvent.set(eventKey, []);
    byEvent.get(eventKey).push(entry);
  });

  const events = [];
  for (const [eventText, selections] of byEvent) {
    const { home, away } = parseEventTeams(eventText);
    events.push({
      eventText, homeTeam: home, awayTeam: away, selections,
      moneyline: selections.filter((s) => s.marketKind === 'ml'),
      handicap: selections.filter((s) => s.marketKind === 'ah'),
      totals: selections.filter((s) => s.marketKind === 'ou')
    });
  }

  return {
    ok: events.length > 0 || btns.length > 0,
    frameUrl: location.href,
    isTop: window === window.top,
    buttonCount: btns.length,
    eventCount: events.length,
    events
  };
}

function normalizeQuery(q) {
  return (q || '').replace(/\s+/g, '').toLowerCase();
}

function searchBtiOdds(query) {
  const board = scrapeBoardSelections();
  const q = normalizeQuery(query);
  if (!q) return { ...board, query, hits: board.events, hitCount: board.eventCount };

  const hits = board.events.filter((ev) => {
    const blob = normalizeQuery(`${ev.homeTeam} ${ev.awayTeam} ${ev.eventText}`);
    return blob.includes(q)
      || normalizeQuery(ev.homeTeam).includes(q)
      || normalizeQuery(ev.awayTeam).includes(q);
  });

  return { ...board, query, hits, hitCount: hits.length, slip: readBtiSlip() };
}

// popup / background 요청에 응답
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'READ_SLIP') {
    sendResponse({ slip: readBtiSlip() });
    return false;
  }
  if (msg.type === 'PLACE_BET') {
    placeBtiBet(msg.amount, msg.targetLine, msg.lineTolerance)
      .then(result => sendResponse(result));
    return true;
  }
  if (msg.type === 'VALIDATE_LINE') {
    sendResponse(validateBtiLine(msg.targetLine, msg.tolerance));
    return false;
  }
  if (msg.type === 'FETCH_BTI_JSON') {
    fetch(msg.url, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'SEARCH_ODDS' || msg.type === 'BTI_SEARCH') {
    sendResponse(searchBtiOdds(msg.query || msg.team || msg.q || ''));
    return false;
  }
  if (msg.type === 'SCRAPE_BOARD') {
    sendResponse(scrapeBoardSelections());
    return false;
  }
  if (msg.type === 'PING') {
    sendResponse({
      ok: true,
      version: '2.21',
      href: location.href,
      isTop: window === window.top,
      buttonCount: document.querySelectorAll('button[class*="master_fe_Selections_selection"]').length,
      hasSlip: !!readBtiSlip()
    });
    return false;
  }
});

// ── MutationObserver: BTI 배당/슬립 변화 즉시 감지 ──
(function startBtiObserver() {
  let lastOddsKey = '';
  let debounceTimer = null;

  function checkAndNotify() {
    const slip = readBtiSlip();
    if (!slip) return;
    const key = `${slip.odds}_${slip.marketKey}_${slip.selectionText}`;
    if (key === lastOddsKey) return;
    lastOddsKey = key;
    try {
      chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: 'bti', slip });
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

console.log('[BTI봇] content script 로드됨 (v2.20)');
