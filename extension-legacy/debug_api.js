// debug_api.js - 피나클/BTI API 응답 구조 진단
// 팝업 로그에 API 응답 샘플 출력

async function diagnosePinnacleApi() {
  const log = [];
  try {
    // 피나클 라이브 스포츠 목록
    const sportsRes = await fetch('https://api.arcadia.pinnacle.com/0.1/sports?hasStraightSpecials=false&hasParlay=false', {
      credentials: 'include'
    });
    const sports = await sportsRes.json();
    log.push('=== 피나클 스포츠 목록 ===');
    if (Array.isArray(sports)) {
      sports.slice(0, 10).forEach(s => log.push(`sport: id=${s.id} name=${s.name} liveCount=${s.matchupCount}`));
    } else {
      log.push(JSON.stringify(sports).slice(0, 300));
    }

    // 피나클 라이브 경기 (축구=29, 야구=3, 농구=4)
    for (const [name, id] of [['축구', 29], ['야구', 3], ['농구', 4]]) {
      const res = await fetch(`https://api.arcadia.pinnacle.com/0.1/sports/${id}/markets/highlighted/straight?primaryOnly=false`, {
        credentials: 'include'
      });
      const data = await res.json();
      log.push(`\n=== 피나클 ${name}(${id}) highlighted ===`);
      log.push(JSON.stringify(data).slice(0, 500));
    }
  } catch(e) {
    log.push('피나클 API 오류: ' + e.message);
  }
  return log.join('\n');
}

async function diagnoseBtiApi() {
  const log = [];
  try {
    const url = 'https://prod188.bti-sports.io/api/sportscenter/carousels/featured-matches/markets?language=KO&customerLevel=0&selectedOptionId=0&marketTypes=ML587%2CHC0%2COU0%2CML0%2CHC39%2COU39%2CML39&marketTypesBySports=%7B%221%22%3A%5B%22HC0%22%2C%22OU0%22%2C%22ML0%22%2C%22HC39%22%2C%22OU39%22%2C%22ML39%22%5D%2C%226%22%3A%5B%22ML0%22%2C%22OU0%22%2C%22HC0%22%5D%2C%2259%22%3A%5B%22ML587%22%2C%22ML0%22%2C%22OU0%22%2C%22HC0%22%5D%2C%22default%22%3A%5B%22HC0%22%2C%22OU0%22%2C%22ML0%22%5D%7D&minimumOdds=1.1&draft=false';
    const res = await fetch(url, { credentials: 'include' });
    const data = await res.json();
    log.push('=== BTI API 응답 구조 ===');
    log.push('keys: ' + Object.keys(data).join(', '));
    // 첫 번째 경기 샘플
    const sample = JSON.stringify(data).slice(0, 1000);
    log.push(sample);
  } catch(e) {
    log.push('BTI API 오류: ' + e.message);
  }
  return log.join('\n');
}
