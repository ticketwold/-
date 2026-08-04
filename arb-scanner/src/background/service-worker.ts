import { createLogger } from '@core/logger';
import { globalOddsHistory } from '@core/odds-history';
import { scanArbitrage } from '@core/arb-calculator';
import { loadSettings, saveSettings } from '@core/storage';
import { fetchBithumbUsdtKrw, getUsdtKrwRate } from '@core/bithumb';
import { notifyOpportunity } from '@core/notifier';
import type { ContentMessage, PopupMessage, RuntimeState } from '@core/types';
import { createRuntimeState, processSlipUpdate } from './auto-bet';

const log = createLogger('sw');

const quotesBySite = { x10: [] as import('@core/types').OddsQuote[], bcgame: [] as import('@core/types').OddsQuote[] };
const slips = { x10: null as import('@core/types').SlipState | null, bcgame: null as import('@core/types').SlipState | null };
let runtime: RuntimeState = createRuntimeState();
let lastNotifyAt = 0;

const ctx = { quotesBySite, slips, runtime };

async function refreshRate(): Promise<void> {
  const settings = await loadSettings();
  if (settings.autoBithumbRate) {
    await fetchBithumbUsdtKrw();
  }
  const rate = await getUsdtKrwRate(settings.manualUsdtKrw);
  runtime.usdtKrw = rate.krw;
  await chrome.storage.local.set({ usdtKrw: rate.krw, usdtRateSource: rate.source });
}

chrome.alarms.create('bithumb-rate', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'bithumb-rate') refreshRate();
});
refreshRate();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'ODDS_BATCH') {
        const m = msg as ContentMessage & { type: 'ODDS_BATCH' };
        quotesBySite[m.siteId] = m.quotes;
        globalOddsHistory.pushMany(m.quotes);
        const settings = await loadSettings();
        const opps = scanArbitrage(quotesBySite.x10, quotesBySite.bcgame, settings);
        runtime.lastOpportunities = opps;
        await persist();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'SLIP_UPDATE') {
        const m = msg as ContentMessage & { type: 'SLIP_UPDATE' };
        runtime = await processSlipUpdate(ctx, m.siteId, m.slip);
        ctx.runtime = runtime;

        const settings = await loadSettings();
        if (runtime.profitPercent !== null && runtime.profitPercent >= settings.minProfitPercent) {
          const now = Date.now();
          if (settings.notificationsEnabled && now - lastNotifyAt > 5000) {
            lastNotifyAt = now;
            chrome.notifications.create(`arb-${now}`, {
              type: 'basic',
              iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
              title: `양방 ${runtime.profitPercent.toFixed(2)}%`,
              message: `x10 ${m.slip.odds} | BC ${runtime.bcSlip?.odds ?? '-'}`,
              silent: !settings.soundEnabled,
            });
            const top = runtime.lastOpportunities[0];
            if (top && (settings.telegramEnabled || settings.discordEnabled)) {
              const bcUsdt = runtime.leg2Usdt ?? 0;
              await notifyOpportunity(top, settings, settings.x10BetKrw, bcUsdt);
            }
          }
        }
        await persist();
        sendResponse({ ok: true, runtime });
        return;
      }

      if (msg.type === 'X10_STAKE_CHANGED') {
        const settings = await loadSettings();
        const stake = parseInt(String(msg.stake || '0').replace(/,/g, ''), 10);
        if (stake > 0) {
          settings.x10BetKrw = stake;
          await saveSettings(settings);
        }
        if (settings.stakeSyncEnabled && runtime.x10Slip && runtime.bcSlip) {
          runtime = await processSlipUpdate(ctx, 'x10', runtime.x10Slip);
        }
        await persist();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'ARM') {
        const arm = msg as PopupMessage & { type: 'ARM' };
        runtime.armed = !!arm.armed;
        await persist();
        sendResponse({ ok: true, armed: runtime.armed });
        return;
      }

      if (msg.type === 'MANUAL_STRIKE') {
        const settings = await loadSettings();
        const bcUsdt = runtime.leg2Usdt ?? 0;
        if (bcUsdt > 0) {
          const { strikeBoth } = await import('./tab-bridge');
          const result = await strikeBoth(settings, bcUsdt);
          sendResponse({ ok: true, result });
        } else {
          sendResponse({ ok: false, reason: 'no-leg2-amount' });
        }
        return;
      }

      if (msg.type === 'SYNC_STAKE') {
        const settings = await loadSettings();
        if (runtime.x10Slip && runtime.bcSlip) {
          runtime = await processSlipUpdate(ctx, 'x10', runtime.x10Slip);
        }
        await persist();
        sendResponse({ ok: true, runtime });
        return;
      }

      if (msg.type === 'PING') {
        sendResponse({ ok: true, runtime, quotes: quotesBySite });
        return;
      }
    } catch (e) {
      log.catch('message', e);
      sendResponse({ ok: false });
    }
  })();
  return true;
});

async function persist(): Promise<void> {
  await chrome.storage.local.set({
    runtime,
    lastQuotes: quotesBySite,
    lastOpportunities: runtime.lastOpportunities,
    historySize: globalOddsHistory.size(),
    updatedAt: Date.now(),
  });
}

log.info('service worker started');
