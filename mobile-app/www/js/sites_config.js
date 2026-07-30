// 텐텐뱃 (x10x10s) + Polymarket 전용 설정
const SITE_CONFIG = {
  WRAPPER_HOSTS: ['x10x10s.com'],
  POLYMARKET_HOSTS: ['polymarket.com'],
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
