// BTI 배당판 버튼 구조 진단 - 슬립 선택명과 배당판 버튼 연결 확인
console.log('=== BTI 배당판 버튼 구조 진단 ===');

// 1. 배당판 버튼 전체 탐색
const allBtns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');
console.log(`\n[1] master_fe_Selections_selection 버튼: ${allBtns.length}개`);
allBtns.forEach((btn, i) => {
  if (i >= 20) return;
  const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
  const nameEl = btn.querySelector('[class*="master_fe_Selections_selectionNameLine"], [class*="selectionNameLine"]');
  const spanEmpty = btn.querySelector('span:not([class])');
  console.log(`  [${i}] text="${btn.textContent.substring(0,40)}" | odds="${oddsEl?.textContent}" | name="${nameEl?.textContent}" | emptySpan="${spanEmpty?.textContent}"`);
});

// 2. 슬립에서 선택명 추출
const betCards = document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]');
const realCards = Array.from(betCards).filter(el =>
  !el.className.includes('wrapper') && !el.className.includes('counter') &&
  !el.className.includes('bageGroup') && !el.className.includes('badge') &&
  !el.className.includes('PlaceBet') && !el.className.includes('Tab')
);
if (realCards.length > 0) {
  const card = realCards[0];
  const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
  console.log('\n[2] 슬립 선택명들:');
  titleEls.forEach((el, i) => {
    console.log(`  [${i}] "${el.textContent.trim()}" (class: ${el.className.substring(0,50)})`);
  });
  
  // 3. 슬립 선택명으로 배당판 버튼 매칭 시도
  const selectionName = titleEls[0]?.textContent.trim(); // "삼성 라이온스"
  if (selectionName) {
    console.log(`\n[3] "${selectionName}" 으로 배당판 버튼 탐색:`);
    allBtns.forEach((btn, i) => {
      const txt = btn.textContent;
      if (txt.includes(selectionName) || selectionName.includes(txt.replace(/\d+\.\d+/g,'').trim())) {
        const oddsEl = btn.querySelector('[class*="odds"]');
        console.log(`  매칭: [${i}] text="${txt.substring(0,50)}" | odds="${oddsEl?.textContent}"`);
      }
    });
  }
}

// 4. 경기 컨테이너 구조 확인 (팀명 + 배당 버튼 연결)
console.log('\n[4] 경기 컨테이너(master_fe_Event_match) 구조:');
const matchEls = document.querySelectorAll('[class*="master_fe_Event_match"]');
console.log(`  총 ${matchEls.length}개`);
if (matchEls.length > 0) {
  const match = matchEls[0];
  // 팀명 span (빈 클래스)
  const teamSpans = Array.from(match.querySelectorAll('span')).filter(s => s.className === '' && s.textContent.trim().length > 1);
  console.log(`  팀명 span: ${teamSpans.map(s => '"'+s.textContent.trim()+'"').join(', ')}`);
  // 배당 버튼
  const btns = match.querySelectorAll('button[class*="master_fe_Selections_selection"]');
  console.log(`  배당 버튼: ${btns.length}개`);
  btns.forEach((btn, i) => {
    const oddsEl = btn.querySelector('[class*="odds"]');
    const nameEl = btn.querySelector('[class*="selectionNameLine"]');
    console.log(`    [${i}] odds="${oddsEl?.textContent}" | name="${nameEl?.textContent}" | text="${btn.textContent.substring(0,30)}"`);
  });
}

console.log('\n=== 진단 완료 ===');
