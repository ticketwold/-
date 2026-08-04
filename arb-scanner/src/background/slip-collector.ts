import type { SlipState } from '@core/types';
import { loadSettings } from '@core/storage';
import { findSiteTab } from './tab-bridge';
import { injectContentIntoTab } from './injector';

function scoreFrameUrl(url: string): number {
  if (/sportscenter\/betslip|widgets-x/i.test(url)) return 100;
  if (/betby|sptpub|biahosted|cocoesports/i.test(url)) return 90;
  if (/bti-sports/i.test(url)) return 80;
  if (/x10x10s/i.test(url)) return 20;
  if (/bc\.game/i.test(url)) return 10;
  return 0;
}

export async function readBestSlipFromTab(
  site: 'x10' | 'bcgame'
): Promise<SlipState | null> {
  const settings = await loadSettings();
  const tabId = site === 'x10' ? settings.x10TabId : settings.bcTabId;
  const tab = await findSiteTab(site, tabId);
  if (!tab?.id) return null;

  await injectContentIntoTab(tab.id);

  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
  const list = frames?.length ? [...frames] : [{ frameId: 0, url: tab.url || '', tabId: tab.id }];

  list.sort((a, b) => scoreFrameUrl(b.url || '') - scoreFrameUrl(a.url || ''));

  let best: { slip: SlipState; score: number } | null = null;

  for (const frame of list) {
    try {
      const res = (await chrome.tabs.sendMessage(
        tab.id,
        { type: 'READ_SLIP' },
        { frameId: frame.frameId }
      )) as { slip?: SlipState | null };
      const slip = res?.slip;
      if (!slip?.odds || slip.odds <= 1.01) continue;
      const score = scoreFrameUrl(frame.url || '') + (slip.stake ? 15 : 0) + slip.odds;
      if (!best || score > best.score) best = { slip, score };
    } catch {
      /* no handler in frame */
    }
  }

  if (best) return best.slip;

  // executeScript fallback — call page global
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const w = globalThis as { __arbScannerSlip?: () => SlipState | null };
        return w.__arbScannerSlip?.() ?? null;
      },
    });
    for (const r of results) {
      const slip = r.result as SlipState | null;
      if (slip?.odds && slip.odds > 1.01) return slip;
    }
  } catch {
    /* ignore */
  }

  return null;
}

export async function collectAllSlips(): Promise<{
  x10: SlipState | null;
  bc: SlipState | null;
}> {
  const [x10, bc] = await Promise.all([
    readBestSlipFromTab('x10'),
    readBestSlipFromTab('bcgame'),
  ]);
  return { x10, bc };
}
