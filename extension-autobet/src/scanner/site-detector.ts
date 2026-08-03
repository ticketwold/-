import type { SiteId } from './types';

const X10_HOSTS = [
  'x10x10s.com',
  'live8588.com',
  'fxf774.com',
  'pbc00.com',
  'v210x10b.com',
  'y10x103.com',
  'v210x10g.com',
  'z10x104.com',
  'bti-sports.com',
  'bti-sports.io',
  'sptpub.com',
  'sptsportscdn.com',
  'biahosted.com',
  'cocoesports.com',
];

const BC_HOSTS = ['bc.game', 'betby.com', 'sptpub.com', 'sptsportscdn.com', 'biahosted.com', 'cocoesports.com'];

function hostFrom(href: string): string {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matchesHost(hostname: string, hosts: string[]): boolean {
  return hosts.some((h) => hostname === h || hostname.endsWith('.' + h));
}

export function detectSiteId(href = location.href): SiteId {
  const h = hostFrom(href);
  if (!h) return 'unknown';
  if (matchesHost(h, X10_HOSTS)) return 'x10';
  if (matchesHost(h, BC_HOSTS)) return 'bcgame';
  return 'unknown';
}

export function detectSiteIdFromContext(href: string, bootstrapSource?: 'bti' | 'bcgame' | 'stake'): SiteId {
  const fromUrl = detectSiteId(href);
  if (fromUrl !== 'unknown') return fromUrl;
  if (bootstrapSource === 'bti') return 'x10';
  if (bootstrapSource === 'bcgame') return 'bcgame';
  return 'unknown';
}

export function isJunkFrameHref(href: string): boolean {
  const u = String(href || '');
  if (!u || u === 'about:blank') return true;
  return /livechatinc|liveplugins|recaptcha|player\.twitch|streambridge\.feedconstruct\.com\/player/i.test(u);
}

export function isBetslipIframeSrc(href: string): boolean {
  return /\/api\/sportscenter\/betslip|widgets-x|bti-sports|sportscenter/i.test(href);
}

export function isInPlayShellHref(href: string): boolean {
  if (!href || isBetslipIframeSrc(href)) return false;
  try {
    const u = new URL(href);
    if (!/x10x10s\.com$/i.test(u.hostname.replace(/^www\./, ''))) return false;
    return /\/in-play\/|\/match\//i.test(u.pathname);
  } catch {
    return /x10x10s\.com.*\/(in-play|match)\//i.test(href);
  }
}
