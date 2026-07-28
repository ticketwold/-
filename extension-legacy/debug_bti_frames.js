// BTI 전체 iframe 목록 확인
console.log('=== BTI iframe 목록 ===');
const iframes = document.querySelectorAll('iframe');
console.log(`총 ${iframes.length}개`);
iframes.forEach((f, i) => {
  console.log(`[${i}] src="${f.src.substring(0,100)}" | class="${f.className.substring(0,50)}" | id="${f.id}"`);
});

// top 컨텍스트에서 실행 시 pbc00.com 내 모든 iframe
console.log('\n=== document.URL ===');
console.log(document.URL);
