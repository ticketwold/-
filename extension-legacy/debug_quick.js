// 빠른 진단 - 슬립 선택명 + 매칭 버튼 확인
const cards = Array.from(document.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"]')).filter(el =>
  !el.className.includes('wrapper') && !el.className.includes('counter') &&
  !el.className.includes('bageGroup') && !el.className.includes('badge') &&
  !el.className.includes('PlaceBet') && !el.className.includes('Tab')
);
console.log('슬립 카드:', cards.length);
if (cards[0]) {
  const titles = cards[0].querySelectorAll('[class*="betInformation__title"]');
  titles.forEach((t,i) => console.log(`  title[${i}]: "${t.textContent.trim()}"`));
}

// 배당판 버튼 중 LG 트윈스 포함
const btns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');
console.log('배당판 버튼 총:', btns.length);
Array.from(btns).filter(b => b.textContent.includes('LG')).forEach((b,i) => {
  const o = b.querySelector('[class*="master_fe_Selections_odds"]');
  const p = b.querySelector('[class*="master_fe_Selections_points"], [class*="selectionNameLine"]');
  console.log(`  LG버튼[${i}]: text="${b.textContent.substring(0,40)}" | odds="${o?.textContent}" | points="${p?.textContent}"`);
});
