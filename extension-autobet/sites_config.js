// 텐텐뱃 (x10x10s) + 멀티 leg2 (BC.Game, Stake.com)
const SITE_CONFIG = {
  WRAPPER_HOSTS: ['x10x10s.com'],
  BCGAME_HOSTS: ['bc.game'],
  STAKE_HOSTS: ['stake.com'],
  BTI_GAMECODES: ['19', '20', '21', '22', '23'],
  BTI_HOST_HINTS: [
    'bti-sports.io', 'bti-sports.com', 'live8588.com', 'fxf774.com',
    'sptpub.com', 'sptsportscdn.com', 'biahosted.com', 'cocoesports.com'
  ],
  BTI_INJECTABLE_HOSTS: [
    'bti-sports.com', 'bti-sports.io', 'x10x10s.com', 'live8588.com', 'fxf774.com',
    'sptpub.com', 'sptsportscdn.com', 'biahosted.com', 'cocoesports.com'
  ],
  LEG1_LABEL: '텐텐뱃',
  LEG1_SHORT: '텐텐',
  LEG2_SITES: {
    bcgame: { label: 'BC.Game', short: 'BC', hosts: ['bc.game'] },
    stake: { label: 'Stake.com', short: 'Stake', hosts: ['stake.com'] }
  }
};

function leg1Label() {
  return SITE_CONFIG.LEG1_LABEL || '텐텐뱃';
}

function leg1ShortLabel() {
  return SITE_CONFIG.LEG1_SHORT || '텐텐';
}

function leg2SiteMeta(pref) {
  return SITE_CONFIG.LEG2_SITES[pref] || SITE_CONFIG.LEG2_SITES.bcgame;
}

function leg2Label() {
  return leg2SiteMeta('bcgame').label;
}

function leg2ShortLabel() {
  return leg2SiteMeta('bcgame').short;
}

function leg2PrefLabel(pref) {
  return leg2SiteMeta(pref || 'bcgame').label;
}

function leg2PrefShort(pref) {
  return leg2SiteMeta(pref || 'bcgame').short;
}

function formatStrikeFailLine(btiRes, polyRes, leg2Pref) {
  const leg2 = leg2PrefLabel(leg2Pref || 'bcgame');
  const left = btiRes?.reason || btiRes?.btnText || '실패';
  const right = polyRes?.reason || polyRes?.method || polyRes?.btnText || '실패';
  return `✗ ${leg1Label()}: ${left} · ${leg2}: ${right}`;
}

function hostMatches(url, hosts) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return hosts.some((host) => h === host || h.endsWith('.' + host));
  } catch (_) {
    return hosts.some((host) => url.includes(host));
  }
}

function isWrapperUrl(url) {
  if (!url) return false;
  return SITE_CONFIG.WRAPPER_HOSTS.some((h) => url.includes(h));
}

function isBcGameUrl(url) {
  return hostMatches(url, SITE_CONFIG.BCGAME_HOSTS);
}

function isStakeUrl(url) {
  return hostMatches(url, SITE_CONFIG.STAKE_HOSTS);
}

function isBcGameSportsUrl(url) {
  if (!isBcGameUrl(url)) return false;
  try {
    return /\/sports\//i.test(new URL(url).pathname);
  } catch (_) {
    return /\/sports\//i.test(String(url || ''));
  }
}

function isStakeSportsUrl(url) {
  if (!isStakeUrl(url)) return false;
  try {
    return /\/sports/i.test(new URL(url).pathname);
  } catch (_) {
    return /\/sports/i.test(String(url || ''));
  }
}

function isLeg2Url(url) {
  return isBcGameUrl(url) || isStakeUrl(url);
}

function isLeg2SportsUrl(url) {
  return isBcGameSportsUrl(url) || isStakeSportsUrl(url);
}

function isLeg2EventUrl(url) {
  if (!url) return false;
  if (isLeg2SportsUrl(url)) return true;
  return /\/event\//i.test(url) || /\/predictions\/event\//i.test(url);
}

function leg2SiteKey(url) {
  if (isBcGameUrl(url)) return 'bcgame';
  if (isStakeUrl(url)) return 'stake';
  return '';
}

function leg2SiteLabel(url) {
  return leg2PrefLabel(leg2SiteKey(url) || 'bcgame');
}

function leg2SiteShort(url) {
  return leg2PrefShort(leg2SiteKey(url) || 'bcgame');
}

function urlMatchesLeg2Pref(url, pref) {
  if (!url || !pref) return false;
  if (pref === 'bcgame') return isBcGameUrl(url);
  if (pref === 'stake') return isStakeUrl(url);
  return isLeg2Url(url);
}

function scoreLeg2Tab(url, activeId, tabId, pref) {
  if (!urlMatchesLeg2Pref(url, pref)) return -1;
  let score = 0;
  if (isLeg2EventUrl(url)) score += 30;
  if (isBcGameSportsUrl(url)) {
    if (/\/sports\/[^/]+\/[^/]+\/[^/]+-/i.test(url)) score += 45;
    else if (/\/sports\/[^/]+\/[^/]+\//i.test(url)) score += 38;
    else score += 32;
  } else if (isStakeSportsUrl(url)) {
    if (/\/sports\/[^/]+\/[^/]+\/[^/]+/i.test(url)) score += 42;
    else if (/\/sports\/home/i.test(url)) score += 30;
    else score += 28;
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
  if (/doubleclick|googlesyndication|tracker\.html|amazon-ivs|hcaptcha|widgets?\./i.test(url)) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (SITE_CONFIG.BTI_INJECTABLE_HOSTS.some((s) => h === s || h.endsWith('.' + s))) return true;
  } catch (_) {}
  return /master_fe|betslip|sportsbook|bti-sports|Selections_selection|sportscenter/i.test(url || '');
}

function scoreBtiFrameUrl(url) {
  if (!url) return 0;
  if (/doubleclick|googlesyndication|tracker\.html|amazon-ivs|hcaptcha/i.test(url)) return -500;
  let score = 0;
  for (const h of SITE_CONFIG.BTI_HOST_HINTS) {
    if (url.includes(h)) score += 50;
  }
  if (/\/sports/i.test(url)) score += 30;
  if (/sportsbook|bti|master_fe|Selections_selection|betslip_fe/i.test(url)) score += 25;
  if (/sptpub|sptsportscdn|biahosted|cocoesports/i.test(url)) score += 40;
  if (/gamecode=/.test(url)) score += 10;
  if (isWrapperUrl(url)) score += 5;
  return score;
}

function isBcBetbyFrameUrl(url) {
  return /betby|sptpub|biahosted|sptsportscdn|cocoesports|sportradar|invisiblesport|bt-renderer/i.test(url || '');
}

function scoreBcLeg2FrameUrl(url, tabUrl) {
  if (!url) return 0;
  if (/tracker\.html|amazon-ivs|widgets?\.|doubleclick|googlesyndication/i.test(url)) return -200;
  let score = scoreBtiFrameUrl(url);
  if (/bti-sports\.(io|com)/i.test(url)) score += 90;
  if (/betby|sptpub|sportradar|invisiblesport|sptsportscdn|cocoesports/i.test(url)) score += 70;
  if (/sptsportscdn|bt-renderer|renderer/i.test(url)) score += 90;
  if (/renderer|sportsbook|\/bt\/|master_fe|Selections_selection/i.test(url)) score += 50;
  if (tabUrl && isBcGameSportsUrl(tabUrl) && score > 0) score += 25;
  if (isBcGameUrl(url) && /\/sports/i.test(url || '')) score += 15;
  return score;
}

function scoreStakeLeg2FrameUrl(url, tabUrl) {
  if (!url) return 0;
  if (/tracker|doubleclick|googlesyndication|hcaptcha/i.test(url || '')) return -200;
  let score = 0;
  if (/stake\.com/i.test(url || '')) score += 80;
  if (tabUrl && isStakeSportsUrl(tabUrl) && /stake\.com/i.test(url || '')) score += 40;
  return score;
}

function scoreLeg2FrameUrl(url, tabUrl) {
  if (tabUrl && isStakeSportsUrl(tabUrl)) return scoreStakeLeg2FrameUrl(url, tabUrl);
  return scoreBcLeg2FrameUrl(url, tabUrl);
}
