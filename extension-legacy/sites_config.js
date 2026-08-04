// 텐텐뱃 (x10x10s) + BC.Game 전용 설정
const SITE_CONFIG = {
  WRAPPER_HOSTS: ['x10x10s.com'],
  BCGAME_HOSTS: ['bc.game'],
  BTI_GAMECODES: ['19', '20', '21', '22', '23'],
  BTI_HOST_HINTS: ['bti-sports.io', 'bti-sports.com', 'live8588.com', 'fxf774.com'],
  BTI_INJECTABLE_HOSTS: ['bti-sports.com', 'bti-sports.io', 'x10x10s.com', 'live8588.com', 'fxf774.com']
};

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

function isBcSportsUrl(url) {
  if (!isBcGameUrl(url)) return false;
  return /\/sports\//i.test(url || '');
}

function isBcPredictionsUrl(url) {
  if (!isBcGameUrl(url)) return false;
  return /\/predictions\//i.test(url || '');
}

function bcSiteLabel() {
  return 'BC.Game';
}

function bcSiteShort() {
  return 'BC';
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

function scoreBcTab(url, activeTabId, tabId) {
  if (!isBcGameUrl(url)) return -1;
  let score = 10;
  if (isBcSportsUrl(url)) score += 30;
  if (isBcPredictionsUrl(url)) score += 20;
  if (tabId === activeTabId) score += 15;
  return score;
}
