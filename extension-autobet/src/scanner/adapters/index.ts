import { BCGameScanner } from './bcgame-adapter';
import { X10Scanner } from './x10-adapter';
import type { SiteAdapter, SiteId } from '../types';

const x10 = new X10Scanner();
const bcgame = new BCGameScanner();

export function getAdapter(siteId: SiteId): SiteAdapter | null {
  switch (siteId) {
    case 'x10':
      return x10;
    case 'bcgame':
      return bcgame;
    default:
      return null;
  }
}

export { X10Scanner, BCGameScanner };
