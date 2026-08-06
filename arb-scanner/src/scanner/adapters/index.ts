import type { SiteId } from '@core/types';
import type { SiteAdapter } from './base-adapter';
import { X10Adapter } from './x10-adapter';
import { BcGameAdapter } from './bcgame-adapter';

const x10 = new X10Adapter();
const bc = new BcGameAdapter();

export function getAdapter(siteId: SiteId): SiteAdapter {
  return siteId === 'x10' ? x10 : bc;
}

export function detectSiteId(href = location.href): SiteId | null {
  try {
    const h = new URL(href).hostname.toLowerCase();
    if (
      /x10x10s|bti-sports|live8588|fxf774|pbc00|sptpub|sptsportscdn|biahosted|v210x10b|y10x103|v210x10g|z10x104|streambridge\.feedconstruct/i.test(
        h
      )
    ) {
      return 'x10';
    }
    if (/bc\.game|betby\.com|sptpub|cocoesports/i.test(h)) return 'bcgame';
  } catch {
    /* ignore */
  }
  return null;
}
