// BTI 슬립 읽기 진단 v2 - btiReadSlipFn과 동일한 로직으로 단계별 확인
console.log('=== BTI 슬립 읽기 진단 v2 ===');

// 1. betslip_fe_BetSecondary_bet 카드 탐색
const betCards = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
console.log(`\n[1] betslip_fe_BetSecondary_bet 요소: ${betCards.length}개`);
betCards.forEach((el, i) => {
  console.log(`  [${i}] class: "${el.className.substring(0,80)}" | text: "${el.textContent.substring(0,60)}"`);
});

// 2. 필터링 후 실제 카드
const realCards = Array.from(betCards).filter(el =>
  !el.className.includes('wrapper') && !el.className.includes('counter') &&
  !el.className.includes('bageGroup') && !el.className.includes('badge') &&
  !el.className.includes('PlaceBet') && !el.className.includes('Tab')
);
console.log(`\n[2] 필터링 후 실제 카드: ${realCards.length}개`);

if (realCards.length > 0) {
  const card = realCards[0];
  console.log(`\n[3] 첫 번째 카드 전체 텍스트:\n"${card.textContent.substring(0,200)}"`);
  
  // 3. betInformation__title 탐색
  const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
  console.log(`\n[4] betInformation__title 요소: ${titleEls.length}개`);
  titleEls.forEach((el, i) => {
    console.log(`  [${i}] class: "${el.className.substring(0,60)}" | text: "${el.textContent.trim()}"`);
  });
  
  // 4. 배당 숫자 span 탐색
  console.log('\n[5] 숫자 span 탐색 (1.01~100):');
  let found = 0;
  card.querySelectorAll('span').forEach(sp => {
    const t = sp.textContent.trim();
    if (/^\d+\.\d{2,4}$/.test(t)) {
      const n = parseFloat(t);
      if (n > 1.01 && n < 100) {
        console.log(`  "${t}" | class: "${sp.className.substring(0,60)}"`);
        found++;
      }
    }
  });
  if (!found) console.log('  없음');
  
  // 5. betInformation__marketName 탐색
  const mktEl = card.querySelector('[class*="betInformation__marketName"]');
  console.log(`\n[6] marketName: "${mktEl ? mktEl.textContent.trim() : '없음'}"`);
  
  // 6. updateNotification 탐색
  const notifEl = card.querySelector('[class*="updateNotification"]');
  console.log(`\n[7] updateNotification: "${notifEl ? notifEl.textContent.trim() : '없음'}"`);
}

// 7. 배당판 버튼에서 현재 선택된 버튼 탐색
console.log('\n[8] 선택된 배당 버튼 탐색 (master_fe_Selections_selection):');
const allSelBtns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');
console.log(`  총 ${allSelBtns.length}개`);
let selectedCount = 0;
allSelBtns.forEach(btn => {
  if (btn.className.includes('selected') || btn.getAttribute('aria-selected') === 'true' ||
      btn.getAttribute('aria-pressed') === 'true') {
    const oddsEl = btn.querySelector('[class*="odds"], [class*="Odds"]');
    const pointsEl = btn.querySelector('[class*="points"], [class*="selectionNameLine"]');
    console.log(`  선택됨: text="${btn.textContent.substring(0,50)}" | odds="${oddsEl?.textContent}" | points="${pointsEl?.textContent}"`);
    selectedCount++;
  }
});
if (!selectedCount) console.log('  선택된 버튼 없음 (aria-selected/aria-pressed/selected 클래스 없음)');

// 8. 슬립 전체 컨테이너 확인
console.log('\n[9] 슬립 컨테이너 확인:');
['[class*="betslip_fe_BetSlip"]', '[class*="master_fe_ViewStyles_betslipIframe"]', '[class*="BetSlip"]'].forEach(sel => {
  const el = document.querySelector(sel);
  if (el) console.log(`  ${sel}: 발견 | text 앞 100자: "${el.textContent.substring(0,100)}"`);
});

console.log('\n=== 진단 완료 ===');
