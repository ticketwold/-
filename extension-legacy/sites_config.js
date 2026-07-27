// 사이트 설정 — x10x10s.com (텐텐뱃) + polymarket.com
const SITE_CONFIG = {
  WRAPPER_HOSTS: ['x10x10s.com'],
  POLYMARKET_HOSTS: ['polymarket.com'],
  BTI_GAMECODES: ['19', '20', '21', '22', '23'],
  GAMMA_API: 'https://gamma-api.polymarket.com',
  DEFAULT_SEARCH_MODE: 'poly'
};

function isSiteWrapperUrl(url) {
  if (!url) return false;
  return SITE_CONFIG.WRAPPER_HOSTS.some((h) => url.includes(h));
}

function isPolymarketUrl(url) {
  if (!url) return false;
  return SITE_CONFIG.POLYMARKET_HOSTS.some((h) => url.includes(h));
}

function getWrapperGamecode(url) {
  const m = String(url || '').match(/[?&]gamecode=(\d+)/);
  return m ? m[1] : null;
}

function isWrapperBtiUrl(url) {
  if (!isSiteWrapperUrl(url)) return false;
  const gc = getWrapperGamecode(url);
  if (gc) return SITE_CONFIG.BTI_GAMECODES.includes(gc);
  return false;
}

function scoreWrapperBtiTab(url) {
  if (!isSiteWrapperUrl(url)) return 0;
  const gc = getWrapperGamecode(url);
  if (gc && SITE_CONFIG.BTI_GAMECODES.includes(gc)) return 10;
  return 1;
}

function wrapperLabel(url) {
  if (!url) return '래퍼';
  if (url.includes('x10x10s.com')) return 'x10x10s';
  return '래퍼';
}
