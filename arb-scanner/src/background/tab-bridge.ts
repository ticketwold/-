import type { UserSettings } from '@core/types';
import { calcLeg2Usdt } from '@core/calculator';
import { createLogger } from '@core/logger';
import { BC_TAB_PATTERNS, X10_TAB_PATTERNS } from '@core/site-patterns';

const log = createLogger('tabs');

export async function findSiteTab(
  site: 'x10' | 'bcgame',
  configuredId: number
): Promise<chrome.tabs.Tab | null> {
  if (configuredId > 0) {
    try {
      return await chrome.tabs.get(configuredId);
    } catch {
      /* tab gone */
    }
  }
  const patterns = site === 'x10' ? X10_TAB_PATTERNS : BC_TAB_PATTERNS;
  for (const p of patterns) {
    const tabs = await chrome.tabs.query({ url: p });
    if (tabs[0]?.id) return tabs[0];
  }
  return null;
}

export async function sendToSiteTab<T extends { ok?: boolean }>(
  site: 'x10' | 'bcgame',
  settings: UserSettings,
  message: object
): Promise<T | null> {
  const tabId = site === 'x10' ? settings.x10TabId : settings.bcTabId;
  const tab = await findSiteTab(site, tabId);
  if (!tab?.id) {
    log.warn(`no tab for ${site}`);
    return null;
  }

  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
  const frameIds = frames?.length ? frames.map((f) => f.frameId) : [0];
  let last: T | null = null;

  for (const frameId of frameIds) {
    try {
      const res = (await chrome.tabs.sendMessage(tab.id, message, { frameId })) as T;
      last = res;
      if (res?.ok) return res;
    } catch {
      /* frame has no handler */
    }
  }

  return last;
}

export async function syncLeg2Stake(
  settings: UserSettings,
  x10Odds: number,
  bcOdds: number,
  usdtKrw: number
): Promise<{ bcUsdt: number; ok: boolean }> {
  const bcUsdt = calcLeg2Usdt(settings.x10BetKrw, x10Odds, bcOdds, usdtKrw);
  if (bcUsdt <= 0) return { bcUsdt: 0, ok: false };

  const res = await sendToSiteTab<{ ok: boolean }>('bcgame', settings, {
    type: 'SET_BC_STAKE',
    amountUsdt: bcUsdt,
  });
  return { bcUsdt, ok: !!res?.ok };
}

export async function strikeBoth(
  settings: UserSettings,
  bcUsdt: number
): Promise<{ x10: unknown; bc: unknown }> {
  const [x10, bc] = await Promise.all([
    sendToSiteTab('x10', settings, { type: 'PLACE_X10_BET', amountKrw: settings.x10BetKrw }),
    sendToSiteTab('bcgame', settings, { type: 'PLACE_BC_BET', amountUsdt: bcUsdt }),
  ]);
  return { x10, bc };
}
