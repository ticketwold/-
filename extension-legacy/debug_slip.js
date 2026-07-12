// 슬립 DOM 진단 스크립트
// 피나클 또는 BTI 슬립이 담긴 탭 콘솔에서 실행
(function() {
  console.log('=== 슬립 DOM 진단 시작 ===');

  // 1. 전체 페이지에서 슬립 관련 컨테이너 탐색
  const selectors = [
    '[class*="BetSlipStyled"]',
    '[class*="betslip"]',
    '[class*="BetSlip"]',
    '[class*="slip"]',
    '#betslipContainer',
    '.BetslipComponent',
    '[class*="betInformation"]',
    '[class*="BetSecondary"]',
    '[class*="SingleBet"]',
    '[class*="BetItem"]',
    '[class*="CardDetail"]',
  ];

  selectors.forEach(sel => {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      console.log(`✅ [${sel}] → ${els.length}개 발견`);
      // 첫 번째 요소 텍스트 미리보기
      const txt = els[0].textContent.trim().substring(0, 80);
      console.log(`   텍스트: "${txt}"`);
      // 클래스명 전체
      console.log(`   클래스: "${els[0].className.substring(0, 100)}"`);
    }
  });

  // 2. 배당 숫자 (1.xx ~ 99.xx) 포함 span 탐색
  console.log('\n=== 배당 숫자 span 탐색 ===');
  const allSpans = document.querySelectorAll('span');
  let oddsFound = 0;
  for (const sp of allSpans) {
    const t = sp.textContent.trim();
    if (/^\d+\.\d{2,4}$/.test(t)) {
      const n = parseFloat(t);
      if (n > 1.01 && n < 100) {
        oddsFound++;
        if (oddsFound <= 5) {
          console.log(`  배당 span: "${t}" | 클래스: "${sp.className.substring(0,80)}" | 부모: "${sp.parentElement?.className?.substring(0,60)}"`);
        }
      }
    }
  }
  console.log(`  총 배당 span: ${oddsFound}개`);

  // 3. input 필드 탐색 (금액 입력)
  console.log('\n=== 금액 입력 input 탐색 ===');
  const inputs = document.querySelectorAll('input');
  inputs.forEach(inp => {
    const cls = inp.className;
    const id = inp.id;
    const name = inp.name;
    const type = inp.type;
    const ph = inp.placeholder;
    if (cls.includes('counter') || cls.includes('stake') || cls.includes('Counter') ||
        id === 'counter' || name === 'stake' || ph.includes('베팅') || ph.includes('금액')) {
      console.log(`  input: id="${id}" name="${name}" type="${type}" placeholder="${ph}" class="${cls.substring(0,80)}"`);
    }
  });

  // 4. 베팅 버튼 탐색
  console.log('\n=== 베팅 버튼 탐색 ===');
  const allBtns = document.querySelectorAll('button');
  let betBtnCount = 0;
  for (const btn of allBtns) {
    const txt = btn.textContent.trim();
    const cls = btn.className;
    if (txt.includes('베팅') || txt.includes('확인') || txt.includes('place') ||
        cls.includes('PlaceBet') || cls.includes('placebet') || cls.includes('sportsbook-Button')) {
      betBtnCount++;
      if (betBtnCount <= 5) {
        console.log(`  버튼: "${txt.substring(0,30)}" | 클래스: "${cls.substring(0,80)}" | disabled: ${btn.disabled}`);
      }
    }
  }

  // 5. 슬립 내 마켓명 텍스트 탐색
  console.log('\n=== 마켓명 텍스트 탐색 ===');
  const mktSelectors = [
    '[class*="marketName"]',
    '[class*="MarketName"]',
    '[class*="market-name"]',
    '[class*="betInformation__marketName"]',
    '[class*="eventName"]',
  ];
  mktSelectors.forEach(sel => {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      console.log(`  [${sel}]: "${els[0].textContent.trim().substring(0,60)}"`);
    }
  });

  console.log('\n=== 진단 완료 ===');
})();
