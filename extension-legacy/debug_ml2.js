// BTI ML(승패) 마켓 전용 진단 v2
// 브라우저 콘솔에서 실행 (BTI iframe 컨텍스트)

(function() {
  console.log('=== BTI ML 진단 시작 ===');

  // 1. 슬립 카드
  const cards = Array.from(document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]')).filter(el =>
    !el.className.includes('wrapper') && !el.className.includes('counter') &&
    !el.className.includes('bageGroup') && !el.className.includes('badge') &&
    !el.className.includes('PlaceBet') && !el.className.includes('Tab')
  );
  console.log('슬립 카드 수:', cards.length);

  if (!cards[0]) { console.log('슬립 없음'); return; }
  const card = cards[0];

  // 2. 슬립 내 모든 텍스트 요소
  const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
  console.log('title 요소 수:', titleEls.length);
  titleEls.forEach((t,i) => {
    console.log(`  title[${i}]: "${t.textContent.trim()}" | class: "${t.className}"`);
  });

  const selectionText = titleEls[0] ? titleEls[0].textContent.trim() : '';
  const marketTitleText = titleEls[1] ? titleEls[1].textContent.trim() : '';
  console.log('선택명:', selectionText);
  console.log('마켓명:', marketTitleText);

  // 3. 배당판 버튼 전체 탐색
  const allBtns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');
  console.log('배당판 버튼 수 (master_fe_Selections_selection):', allBtns.length);

  if (allBtns.length === 0) {
    // 대안 셀렉터 시도
    const alt1 = document.querySelectorAll('button[class*="Selections_selection"]');
    const alt2 = document.querySelectorAll('button[class*="selection"]');
    const alt3 = document.querySelectorAll('[class*="Selections_selection"]');
    console.log('  대안1 (Selections_selection):', alt1.length);
    console.log('  대안2 (selection):', alt2.length);
    console.log('  대안3 (비버튼 Selections_selection):', alt3.length);

    if (alt3.length > 0) {
      console.log('  대안3 첫 5개:');
      Array.from(alt3).slice(0,5).forEach((el,i) => {
        console.log(`    [${i}] tag=${el.tagName} class="${el.className.substring(0,80)}" text="${el.textContent.substring(0,40)}"`);
      });
    }
  }

  // 4. 배당판 버튼 상세 (최대 10개)
  console.log('--- 배당판 버튼 상세 ---');
  Array.from(allBtns).slice(0,10).forEach((btn,i) => {
    const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
    const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
    const allSpans = Array.from(btn.querySelectorAll('span')).map(s => `"${s.textContent.trim()}"`).join(', ');
    console.log(`  버튼[${i}]:`);
    console.log(`    text: "${btn.textContent.substring(0,60)}"`);
    console.log(`    class: "${btn.className.substring(0,80)}"`);
    console.log(`    odds span: "${oddsEl?.textContent}" | class: "${oddsEl?.className}"`);
    console.log(`    points span: "${pointsEl?.textContent}" | class: "${pointsEl?.className}"`);
    console.log(`    모든 span: [${allSpans}]`);
  });

  // 5. 선택명으로 버튼 매칭 시도
  console.log('--- 선택명 매칭 시도 ---');
  const selClean = selectionText.replace(/\s+/g,'').toLowerCase();
  console.log('selClean:', selClean);

  let matchCount = 0;
  Array.from(allBtns).forEach((btn,i) => {
    const btnClean = btn.textContent.replace(/\s+/g,'').toLowerCase();
    if (btnClean.includes(selClean) || selClean.includes(btnClean.replace(/[\d.]+$/,''))) {
      const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
      console.log(`  매칭[${i}]: text="${btn.textContent.substring(0,50)}" odds="${oddsEl?.textContent}"`);
      matchCount++;
    }
  });
  if (!matchCount) console.log('  매칭 없음');

  // 6. 마켓 타입 판별
  const allText = selectionText + ' ' + marketTitleText;
  const t = allText.toLowerCase();
  let mktType = 'ml';
  if (t.includes('머니 라인') || t.includes('money line') || t.includes('moneyline') || t.includes('승패')) mktType = 'ml';
  else if (t.includes('핸디캡') || t.includes('handicap') || t.includes('아시안')) mktType = 'ah';
  else if (t.includes('오버') || t.includes('언더') || t.includes('over') || t.includes('under') || t.includes('총계')) mktType = 'ou';
  console.log('감지된 마켓 타입:', mktType);

  // 7. ML 전용: 핸디캡 없고 OU 아닌 버튼 찾기
  if (mktType === 'ml') {
    console.log('--- ML 전용 탐색 ---');
    Array.from(allBtns).forEach((btn,i) => {
      const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
      const pointsEl = btn.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
      const pointsText = pointsEl ? pointsEl.textContent.trim() : '';
      const hasHandicap = /[+-]\d/.test(pointsText);
      const isOu = btn.textContent.includes('오버') || btn.textContent.includes('언더') ||
                   btn.textContent.toLowerCase().includes('over') || btn.textContent.toLowerCase().includes('under');
      const btnOdds = parseFloat(oddsEl?.textContent || '0');
      if (!hasHandicap && !isOu && btnOdds > 1.01) {
        console.log(`  ML후보[${i}]: text="${btn.textContent.substring(0,50)}" odds="${btnOdds}" points="${pointsText}"`);
      }
    });
  }

  console.log('=== 진단 완료 ===');
})();
