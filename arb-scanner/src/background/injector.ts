import { createLogger } from '@core/logger';
import { ALL_SITE_PATTERNS, isBcUrl, isX10Url } from '@core/site-patterns';

const log = createLogger('inject');

export async function injectContentIntoTab(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
    return true;
  } catch (e) {
    log.debug(`inject tab ${tabId}`, String(e));
    return false;
  }
}

export async function ensureSiteScripts(): Promise<{ x10: number; bc: number }> {
  let x10 = 0;
  let bc = 0;
  const seen = new Set<number>();

  for (const pattern of ALL_SITE_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      if (!tab.id || seen.has(tab.id)) continue;
      seen.add(tab.id);
      const ok = await injectContentIntoTab(tab.id);
      if (!ok) continue;
      const url = tab.url || '';
      if (isX10Url(url)) x10++;
      if (isBcUrl(url)) bc++;
    }
  }
  return { x10, bc };
}

export async function probeAllSiteTabs(): Promise<void> {
  const seen = new Set<number>();
  for (const pattern of ALL_SITE_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      if (!tab.id || seen.has(tab.id)) continue;
      seen.add(tab.id);
      await injectContentIntoTab(tab.id);
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
      const targets = frames?.length ? frames : [{ frameId: 0 }];
      for (const frame of targets) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'PROBE' }, { frameId: frame.frameId });
        } catch {
          /* no handler */
        }
      }
    }
  }
}
