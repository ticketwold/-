// 텐텐뱃 (x10x10s) + Polymarket / BC.Game 전용 설정
const SITE_CONFIG = {
  WRAPPER_HOSTS: ['x10x10s.com'],
  POLYMARKET_HOSTS: ['polymarket.com'],
  BCGAME_HOSTS: ['bc.game'],
  BTI_GAMECODES: ['19', '20', '21', '22', '23'],
  BTI_HOST_HINTS: ['bti-sports.io', 'bti-sports.com', 'live8588.com', 'fxf774.com'],
  BTI_INJECTABLE_HOSTS: ['bti-sports.com', 'bti-sports.io', 'x10x10s.com', 'live8588.com', 'fxf774.com'],
  GAMMA_API: 'https://gamma-api.polymarket.com',
  GAMMA_SPORTS_TAG: '100639',
  LEG1_LABEL: '텐텐뱃',
  LEG1_SHORT: '텐텐'
};

function leg1Label() {
  return SITE_CONFIG.LEG1_LABEL || '텐텐뱃';
}

function leg1ShortLabel() {
  return SITE_CONFIG.LEG1_SHORT || '텐텐';
}

function formatStrikeFailLine(btiRes, polyRes, leg2Pref) {
  const leg2 = leg2PrefLabel(leg2Pref || 'auto');
  const left = btiRes?.reason || btiRes?.btnText || '실패';
  const right = polyRes?.reason || polyRes?.method || polyRes?.btnText || '실패';
  return `✗ ${leg1Label()}: ${left} · ${leg2}: ${right}`;
}

function isWrapperUrl(url) {
  if (!url) return false;
  return SITE_CONFIG.WRAPPER_HOSTS.some((h) => url.includes(h));
}

function isPolymarketUrl(url) {
  if (!url) return false;
  return SITE_CONFIG.POLYMARKET_HOSTS.some((h) => url.includes(h));
}

function isBcGameUrl(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'bc.game' || h.endsWith('.bc.game');
  } catch (_) {
    return SITE_CONFIG.BCGAME_HOSTS.some((h) => url.includes(h));
  }
}

function isLeg2PredictionUrl(url) {
  return isPolymarketUrl(url) || isBcGameUrl(url);
}

function isLeg2EventUrl(url) {
  if (!url) return false;
  return /\/event\//i.test(url) || /\/predictions\/event\//i.test(url);
}

function leg2SiteKey(url) {
  if (isBcGameUrl(url)) return 'bcgame';
  if (isPolymarketUrl(url)) return 'polymarket';
  return '';
}

function leg2SiteLabel(url) {
  const key = leg2SiteKey(url);
  if (key === 'bcgame') return 'BC.Game';
  if (key === 'polymarket') return 'Polymarket';
  return '예측';
}

function leg2SiteShort(url) {
  const key = leg2SiteKey(url);
  if (key === 'bcgame') return 'BC';
  if (key === 'polymarket') return '폴리';
  return '예측';
}

function leg2PrefLabel(pref) {
  if (pref === 'polymarket') return 'Polymarket';
  if (pref === 'bcgame') return 'BC.Game';
  return '자동';
}

function urlMatchesLeg2Pref(url, pref) {
  if (!url) return false;
  if (pref === 'polymarket') return isPolymarketUrl(url);
  if (pref === 'bcgame') return isBcGameUrl(url);
  return isLeg2PredictionUrl(url);
}

function scoreLeg2Tab(url, activeId, tabId, pref) {
  if (!urlMatchesLeg2Pref(url, pref)) return -1;
  let score = 0;
  if (isLeg2EventUrl(url)) score += 30;
  if (pref === 'bcgame' || isBcGameUrl(url)) {
    if (/\/predictions\/event\//i.test(url)) score += 35;
    else if (/\/predictions/i.test(url)) score += 25;
    else score += 8;
  } else if (/predictions/i.test(url)) score += 5;
  if (pref === 'polymarket' && isPolymarketUrl(url)) score += 10;
  if (tabId === activeId) score += 15;
  return score;
}

function getWrapperGamecode(url) {
  const m = String(url || '').match(/(?:[?&#]|^)gamecode=(\d+)/i);
  return m ? m[1] : null;
}

function isWrapperBtiUrl(url) {
  if (!isWrapperUrl(url)) return false;
  const gc = getWrapperGamecode(url);
  if (gc) return SITE_CONFIG.BTI_GAMECODES.includes(gc);
  return false;
}

function scoreWrapperBtiTab(url) {
  if (!isWrapperUrl(url)) return 0;
  const gc = getWrapperGamecode(url);
  if (gc && SITE_CONFIG.BTI_GAMECODES.includes(gc)) return 10;
  return 1;
}

function isInjectableBtiUrl(url) {
  if (!url || url === 'about:blank') return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return SITE_CONFIG.BTI_INJECTABLE_HOSTS.some((s) => h === s || h.endsWith('.' + s));
  } catch (_) {
    return false;
  }
}

function scoreBtiFrameUrl(url) {
  if (!url) return 0;
  let score = 0;
  for (const h of SITE_CONFIG.BTI_HOST_HINTS) {
    if (url.includes(h)) score += 50;
  }
  if (/\/sports/i.test(url)) score += 30;
  if (/sportsbook|bti|master_fe/i.test(url)) score += 15;
  if (/gamecode=/.test(url)) score += 10;
  if (isWrapperUrl(url)) score += 5;
  return score;
}
