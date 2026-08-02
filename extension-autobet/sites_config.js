// 텐텐뱃 (x10x10s) + BC.Game 전용 설정
const SITE_CONFIG = {
  WRAPPER_HOSTS: ['x10x10s.com'],
  BCGAME_HOSTS: ['bc.game'],
  BTI_GAMECODES: ['19', '20', '21', '22', '23'],
  BTI_HOST_HINTS: ['bti-sports.io', 'bti-sports.com', 'live8588.com', 'fxf774.com'],
  BTI_INJECTABLE_HOSTS: ['bti-sports.com', 'bti-sports.io', 'x10x10s.com', 'live8588.com', 'fxf774.com'],
  LEG1_LABEL: '텐텐뱃',
  LEG1_SHORT: '텐텐',
  LEG2_LABEL: 'BC.Game',
  LEG2_SHORT: 'BC'
};

function leg1Label() {
  return SITE_CONFIG.LEG1_LABEL || '텐텐뱃';
}

function leg1ShortLabel() {
  return SITE_CONFIG.LEG1_SHORT || '텐텐';
}

function leg2Label() {
  return SITE_CONFIG.LEG2_LABEL || 'BC.Game';
}

function leg2ShortLabel() {
  return SITE_CONFIG.LEG2_SHORT || 'BC';
}

function formatStrikeFailLine(btiRes, polyRes, leg2Pref) {
  const leg2 = leg2PrefLabel(leg2Pref || 'bcgame');
  const left = btiRes?.reason || btiRes?.btnText || '실패';
  const right = polyRes?.reason || polyRes?.method || polyRes?.btnText || '실패';
  return `✗ ${leg1Label()}: ${left} · ${leg2}: ${right}`;
}

function isWrapperUrl(url) {
  if (!url) return false;
  return SITE_CONFIG.WRAPPER_HOSTS.some((h) => url.includes(h));
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

function isBcGameSportsUrl(url) {
  if (!isBcGameUrl(url)) return false;
  try {
    return /\/sports\//i.test(new URL(url).pathname);
  } catch (_) {
    return /\/sports\//i.test(String(url || ''));
  }
}

function isLeg2Url(url) {
  return isBcGameUrl(url);
}

function isLeg2EventUrl(url) {
  if (!url) return false;
  if (isBcGameSportsUrl(url)) return true;
  return /\/event\//i.test(url) || /\/predictions\/event\//i.test(url);
}

function leg2SiteKey(url) {
  if (isBcGameUrl(url)) return 'bcgame';
  return '';
}

function leg2SiteLabel(url) {
  if (leg2SiteKey(url) === 'bcgame') return 'BC.Game';
  return 'BC.Game';
}

function leg2SiteShort(url) {
  if (leg2SiteKey(url) === 'bcgame') return 'BC';
  return 'BC';
}

function leg2PrefLabel(pref) {
  if (pref === 'bcgame' || pref === 'auto') return 'BC.Game';
  return 'BC.Game';
}

function urlMatchesLeg2Pref(url, pref) {
  if (!url) return false;
  return isBcGameUrl(url);
}

function scoreLeg2Tab(url, activeId, tabId, pref) {
  if (!urlMatchesLeg2Pref(url, pref)) return -1;
  let score = 0;
  if (isLeg2EventUrl(url)) score += 30;
  if (isBcGameSportsUrl(url)) {
    if (/\/sports\/[^/]+\/[^/]+\/[^/]+-/i.test(url)) score += 45;
    else if (/\/sports\/[^/]+\/[^/]+\//i.test(url)) score += 38;
    else score += 32;
  } else if (/\/predictions\/event\//i.test(url)) score += 28;
  else if (/\/predictions/i.test(url)) score += 18;
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

function scoreBcLeg2FrameUrl(url, tabUrl) {
  if (!url) return 0;
  let score = scoreBtiFrameUrl(url);
  if (/bti-sports\.(io|com)/i.test(url)) score += 90;
  if (/betby|sptpub|sportradar|invisiblesport/i.test(url)) score += 70;
  if (/sportsbook|master_fe|Selections_selection/i.test(url)) score += 40;
  if (tabUrl && isBcGameSportsUrl(tabUrl) && score > 0) score += 25;
  if (isBcGameUrl(url) && /\/sports/i.test(url || '')) score += 15;
  return score;
}

function orderBcSportsReadFrameIds(tabId, tabUrl) {
  return orderBcLeg2FrameIds(tabId, tabUrl).then((ids) => {
    if (!isBcGameSportsUrl(tabUrl)) return ids;
    return [0, ...ids.filter((id) => id !== 0)];
  });
}
