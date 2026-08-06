export const X10_TAB_PATTERNS = [
  '*://*.x10x10s.com/*',
  '*://*.bti-sports.com/*',
  '*://*.bti-sports.io/*',
  '*://*.live8588.com/*',
  '*://*.fxf774.com/*',
  '*://*.pbc00.com/*',
  '*://*.v210x10b.com/*',
  '*://*.y10x103.com/*',
  '*://*.v210x10g.com/*',
  '*://*.z10x104.com/*',
  '*://*.sptpub.com/*',
  '*://*.sptsportscdn.com/*',
  '*://*.biahosted.com/*',
];

export const BC_TAB_PATTERNS = [
  '*://bc.game/*',
  '*://*.bc.game/*',
  '*://*.betby.com/*',
  '*://*.sptpub.com/*',
  '*://*.sptsportscdn.com/*',
  '*://*.cocoesports.com/*',
  '*://*.biahosted.com/*',
];

export const ALL_SITE_PATTERNS = [...new Set([...X10_TAB_PATTERNS, ...BC_TAB_PATTERNS])];

export function isX10Url(url: string): boolean {
  return /x10x10s|bti-sports|live8588|fxf774|pbc00|v210x10b|y10x103|v210x10g|z10x104|sptpub|sptsportscdn|biahosted/i.test(
    url
  );
}

export function isBcUrl(url: string): boolean {
  return /bc\.game|betby\.com|cocoesports/i.test(url);
}
