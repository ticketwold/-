import { createLogger } from '@core/logger';
import { globalOddsHistory } from '@core/odds-history';
import { scanArbitrage } from '@core/arb-calculator';
import { loadSettings } from '@core/storage';
import type { ArbitrageOpportunity, ContentMessage, OddsQuote } from '@core/types';

const log = createLogger('sw');

const quotesBySite: Record<'x10' | 'bcgame', OddsQuote[]> = { x10: [], bcgame: [] };
let lastNotifyAt = 0;

function playAlertSound(): void {
  try {
    const ctx = new OffscreenCanvas(1, 1);
    void ctx;
    chrome.notifications?.create?.(`arb-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      title: 'Arb Scanner',
      message: '양방 기회 감지',
    });
  } catch (e) {
    log.catch('sound', e);
  }
}

async function checkArbitrage(): Promise<ArbitrageOpportunity[]> {
  const settings = await loadSettings();
  const opps = scanArbitrage(quotesBySite.x10, quotesBySite.bcgame, settings);
  if (opps.length && settings.notificationsEnabled) {
    const now = Date.now();
    if (now - lastNotifyAt > 5000) {
      lastNotifyAt = now;
      const top = opps[0]!;
      chrome.notifications.create(`arb-opp-${now}`, {
        type: 'basic',
        iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        title: `양방 ${top.profitPercent.toFixed(2)}%`,
        message: `${top.eventName}\nx10 ${top.legX10.odds} / BC ${top.legBc.odds}`,
      });
      if (settings.soundEnabled) playAlertSound();
    }
  }
  return opps;
}

chrome.runtime.onMessage.addListener((msg: ContentMessage, _sender, sendResponse) => {
  try {
    if (msg.type === 'ODDS_BATCH') {
      quotesBySite[msg.siteId] = msg.quotes;
      globalOddsHistory.pushMany(msg.quotes);
      checkArbitrage().then((opps) => {
        chrome.storage.local.set({
          lastQuotes: quotesBySite,
          lastOpportunities: opps,
          historySize: globalOddsHistory.size(),
          updatedAt: Date.now(),
        });
      });
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'DIAGNOSTIC') {
      chrome.storage.local.set({ lastDiagnostic: msg.payload });
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true, quotes: quotesBySite });
      return true;
    }
  } catch (e) {
    log.catch('message', e);
    sendResponse({ ok: false });
  }
  return false;
});

log.info('service worker started');
