// 피나클 슬립 진단 스크립트
// pinnacle.com 탭 콘솔에서 실행 (슬립에 배당 담은 상태)
(function() {
  console.log('=== 피나클 슬립 DOM 진단 시작 ===');

  // 1. 슬립 관련 컨테이너 탐색
  const selectors = [
    '[data-testid="betslip"]',
    '[data-testid*="BetSlip"]',
    '[data-testid*="betslip"]',
    '[class*="BetSlipStyled"]',
    '[class*="betslip"]:not([class*="betslip_fe"])',
    '#betslipContainer',
    '.BetslipComponent',
    '[class*="BetSlip"]',
    '[class*="Betslip"]',
  ];

  selectors.forEach(sel => {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      console.log(`✅ [${sel}] → ${els.length}개`);
      console.log(`   텍스트: "${els[0].textContent.trim().substring(0, 100)}"`);
      console.log(`   클래스: "${els[0].className.substring(0, 120)}"`);
    }
  });

  // 2. 배당 숫자 span 탐색
  console.log('\n=== 배당 숫자 span 탐색 ===');
  let oddsFound = 0;
  for (const sp of document.querySelectorAll('span')) {
    const t = sp.textContent.trim();
    if (/^\d+\.\d{2,4}$/.test(t)) {
      const n = parseFloat(t);
      if (n > 1.01 && n < 100) {
        oddsFound++;
        if (oddsFound <= 8) {
          console.log(`  배당: "${t}" | 클래스: "${sp.className.substring(0,80)}" | 부모클래스: "${sp.parentElement?.className?.substring(0,60)}"`);
        }
      }
    }
  }
  console.log(`  총 배당 span: ${oddsFound}개`);

  // 3. data-testid 속성 있는 요소 탐색
  console.log('\n=== data-testid 요소 탐색 ===');
  const testIdEls = document.querySelectorAll('[data-testid]');
  const betRelated = Array.from(testIdEls).filter(el => {
    const dt = el.getAttribute('data-testid') || '';
    return dt.toLowerCase().includes('bet') || dt.toLowerCase().includes('slip') ||
           dt.toLowerCase().includes('stake') || dt.toLowerCase().includes('wager') ||
           dt.toLowerCase().includes('odds') || dt.toLowerCase().includes('price');
  });
  betRelated.slice(0, 15).forEach(el => {
    console.log(`  data-testid="${el.getAttribute('data-testid')}" | 태그=${el.tagName} | 텍스트="${el.textContent.trim().substring(0,50)}"`);
  });

  // 4. input 필드 탐색
  console.log('\n=== input 필드 탐색 ===');
  document.querySelectorAll('input').forEach(inp => {
    const dt = inp.getAttribute('data-testid') || '';
    const cls = inp.className;
    const name = inp.name;
    const ph = inp.placeholder;
    if (dt || cls.includes('stake') || cls.includes('wager') || cls.includes('Wager') ||
        name === 'stake' || ph.includes('베팅') || ph.includes('금액') || ph.includes('stake')) {
      console.log(`  input: data-testid="${dt}" name="${name}" placeholder="${ph}" class="${cls.substring(0,80)}"`);
    }
  });

  // 5. 베팅 버튼 탐색
  console.log('\n=== 베팅 버튼 탐색 ===');
  let btnCount = 0;
  for (const btn of document.querySelectorAll('button')) {
    const txt = btn.textContent.trim();
    const cls = btn.className;
    const dt = btn.getAttribute('data-testid') || '';
    if (txt.includes('베팅') || txt.includes('확인') || txt.includes('Place') ||
        dt.includes('place') || dt.includes('bet') || cls.includes('place') || cls.includes('Place')) {
      btnCount++;
      if (btnCount <= 8) {
        console.log(`  버튼: "${txt.substring(0,40)}" | data-testid="${dt}" | class="${cls.substring(0,80)}" | disabled=${btn.disabled}`);
      }
    }
  }

  console.log('\n=== 진단 완료 ===');
})();
