// 피나클 슬립 정밀 진단 - 슬립 담은 상태에서 top 컨텍스트 실행
(function() {
  console.log('=== 피나클 슬립 정밀 진단 ===');

  // 1. 배당 숫자 span 전체 탐색 (3자리 이상 소수)
  console.log('\n--- 배당 숫자 span ---');
  let found = 0;
  for (const sp of document.querySelectorAll('span, div, p')) {
    const t = sp.textContent.trim();
    if (/^\d\.\d{2,4}$/.test(t) || /^\d{1,2}\.\d{2,4}$/.test(t)) {
      const n = parseFloat(t);
      if (n > 1.01 && n < 100 && sp.children.length === 0) {
        found++;
        if (found <= 10) {
          // 상위 5단계 클래스 출력
          let el = sp; let path = [];
          for (let i = 0; i < 5; i++) {
            if (!el) break;
            path.push(el.className ? el.className.substring(0,40) : el.tagName);
            el = el.parentElement;
          }
          console.log(`  "${t}" → ${path.join(' > ')}`);
        }
      }
    }
  }
  console.log(`  총 ${found}개`);

  // 2. 슬립 관련 클래스명 패턴 탐색
  console.log('\n--- slip/betslip/wager 클래스 요소 ---');
  const patterns = ['slip', 'Slip', 'betslip', 'BetSlip', 'wager', 'Wager', 'stake', 'Stake', 'coupon', 'Coupon', 'cart', 'Cart', 'basket', 'Basket'];
  const seen = new Set();
  for (const el of document.querySelectorAll('*')) {
    const cls = el.className;
    if (typeof cls !== 'string') continue;
    for (const p of patterns) {
      if (cls.includes(p) && !seen.has(cls.substring(0,60))) {
        seen.add(cls.substring(0,60));
        const txt = el.textContent.trim().substring(0,80);
        if (txt) console.log(`  [${p}] ${el.tagName} class="${cls.substring(0,80)}" text="${txt}"`);
        break;
      }
    }
    if (seen.size >= 20) break;
  }

  // 3. 금액 입력 input 탐색
  console.log('\n--- input 필드 전체 ---');
  for (const inp of document.querySelectorAll('input')) {
    console.log(`  input type="${inp.type}" name="${inp.name}" placeholder="${inp.placeholder}" class="${inp.className.substring(0,80)}" value="${inp.value}"`);
  }

  // 4. 베팅/확인 버튼 탐색
  console.log('\n--- 버튼 전체 ---');
  let btnCnt = 0;
  for (const btn of document.querySelectorAll('button')) {
    const t = btn.textContent.trim();
    if (t.length > 0 && t.length < 30) {
      btnCnt++;
      if (btnCnt <= 20) console.log(`  button: "${t}" class="${btn.className.substring(0,80)}" disabled=${btn.disabled}`);
    }
  }

  console.log('\n=== 완료 ===');
})();
