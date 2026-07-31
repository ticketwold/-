// 텐텐뱃 (x10x10s) + Polymarket / BC.Game 전용 설정
const SITE_CONFIG = {
  WRAPPER_HOSTS: ['x10x10s.com'],
  POLYMARKET_HOSTS: ['polymarket.com'],
  BCGAME_HOSTS: ['bc.game'],
  BTI_GAMECODES: ['19', '20', '21', '22', '23'],
  GAMMA_API: 'https://gamma-api.polymarket.com',
  GAMMA_SPORTS_TAG: '100639'
};

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
