// BTI 경기 상세 페이지 배당 버튼 구조 진단
console.log('=== BTI 경기 상세 페이지 배당 버튼 진단 ===');
console.log('URL:', document.URL);

// 1. 모든 버튼 탐색 (배당 숫자 포함 버튼)
const allBtns = document.querySelectorAll('button');
console.log(`\n[1] 전체 버튼: ${allBtns.length}개`);
let oddsButtons = [];
allBtns.forEach(btn => {
  const txt = btn.textContent.trim();
  // 배당 숫자 포함 버튼 (1.01~100 사이 숫자)
  if (/\d+\.\d{2,4}/.test(txt) && txt.length < 60) {
    const nums = txt.match(/\d+\.\d{2,4}/g);
    if (nums) {
      const n = parseFloat(nums[nums.length-1]);
      if (n > 1.01 && n < 100) {
        oddsButtons.push({btn, txt, odds: n});
      }
    }
  }
});
console.log(`[2] 배당 숫자 포함 버튼: ${oddsButtons.length}개`);
oddsButtons.slice(0,15).forEach((item, i) => {
  console.log(`  [${i}] text="${item.txt.substring(0,50)}" | class="${item.btn.className.substring(0,60)}" | odds=${item.odds}`);
});

// 2. 경기 상세 페이지 마켓 컨테이너 탐색
console.log('\n[3] 마켓 컨테이너 탐색:');
const marketSelectors = [
  '[class*="eventpage_fe_Market"]',
  '[class*="eventpage_fe_HandicapSelection"]',
  '[class*="eventpage_fe_MoneyLine"]',
  '[class*="eventpage_fe_Selection"]',
  '[class*="Market_market"]',
  '[class*="Selection_selection"]'
];
marketSelectors.forEach(sel => {
  const els = document.querySelectorAll(sel);
  if (els.length > 0) {
    console.log(`  ${sel}: ${els.length}개`);
    if (els.length <= 5) {
      els.forEach((el, i) => console.log(`    [${i}] text="${el.textContent.substring(0,60)}" class="${el.className.substring(0,60)}"`));
    }
  }
});

// 3. 슬립 선택명과 배당판 연결 시도
const betCards = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
const realCards = Array.from(betCards).filter(el =>
  !el.className.includes('wrapper') && !el.className.includes('counter') &&
  !el.className.includes('bageGroup') && !el.className.includes('badge') &&
  !el.className.includes('PlaceBet') && !el.className.includes('Tab')
);
if (realCards.length > 0) {
  const card = realCards[0];
  const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
  const selectionName = titleEls[0]?.textContent.trim();
  console.log(`\n[4] 슬립 선택명: "${selectionName}"`);
  
  // 배당 버튼에서 선택명 포함 버튼 탐색
  if (selectionName) {
    console.log(`[5] "${selectionName}" 포함 배당 버튼:`);
    oddsButtons.forEach((item, i) => {
      if (item.txt.includes(selectionName)) {
        console.log(`  [${i}] text="${item.txt.substring(0,50)}" | odds=${item.odds} | class="${item.btn.className.substring(0,60)}"`);
      }
    });
  }
}

// 4. 배당 span 탐색 (eventpage_fe_HandicapSelection_odds 등)
console.log('\n[6] 배당 span 탐색:');
const oddsSpans = document.querySelectorAll('[class*="odds"], [class*="Odds"], [class*="price"]');
console.log(`  총 ${oddsSpans.length}개`);
oddsSpans.forEach((sp, i) => {
  if (i >= 10) return;
  const t = sp.textContent.trim();
  if (/\d+\.\d{2,4}/.test(t)) {
    console.log(`  [${i}] "${t}" | class="${sp.className.substring(0,60)}" | 부모class="${sp.parentElement?.className.substring(0,60)}"`);
  }
});

console.log('\n=== 진단 완료 ===');
