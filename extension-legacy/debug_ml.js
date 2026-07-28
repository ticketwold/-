// BTI ML 슬립 빠른 진단
const cards = Array.from(document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]')).filter(el =>
  !el.className.includes('wrapper') && !el.className.includes('counter') &&
  !el.className.includes('bageGroup') && !el.className.includes('badge') &&
  !el.className.includes('PlaceBet') && !el.className.includes('Tab')
);
console.log('슬립 카드:', cards.length);
if (cards[0]) {
  const titles = cards[0].querySelectorAll('[class*="betInformation__title"]');
  titles.forEach((t,i) => console.log(`  title[${i}]: "${t.textContent.trim()}" | class: "${t.className.substring(0,60)}"`));
}

// 배당판 버튼 중 슬립 선택명 포함 버튼 탐색
const selText = cards[0]?.querySelector('[class*="betInformation__title"]')?.textContent?.trim() || '';
console.log('선택명:', selText);

const btns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');
console.log('배당판 버튼 총:', btns.length);

// 선택명으로 매칭 시도
const selClean = selText.replace(/\s+/g,'').toLowerCase();
let found = 0;
Array.from(btns).forEach((b,i) => {
  const btnClean = b.textContent.replace(/\s+/g,'').toLowerCase();
  const o = b.querySelector('[class*="master_fe_Selections_odds"]');
  const p = b.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
  if (btnClean.includes(selClean) || selClean.includes(btnClean.replace(/[\d.]+$/,''))) {
    console.log(`  매칭[${i}]: text="${b.textContent.substring(0,40)}" | odds="${o?.textContent}" | points="${p?.textContent}"`);
    found++;
  }
});
if (!found) console.log('  매칭 없음 - 첫 10개 버튼:');
Array.from(btns).slice(0,10).forEach((b,i) => {
  if (!found) {
    const o = b.querySelector('[class*="master_fe_Selections_odds"]');
    const p = b.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
    console.log(`  버튼[${i}]: text="${b.textContent.substring(0,40)}" | odds="${o?.textContent}" | points="${p?.textContent}"`);
  }
});
