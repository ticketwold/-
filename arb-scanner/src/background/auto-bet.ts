import { createLogger } from '@core/logger';
import { calcProfitPercent } from '@core/calculator';
import { scanArbitrage } from '@core/arb-calculator';
import { getUsdtKrwRate } from '@core/bithumb';
import { notifyOpportunity } from '@core/notifier';
import { loadSettings } from '@core/storage';
import type {
  ArbitrageOpportunity,
  OddsQuote,
  RuntimeState,
  SlipState,
  UserSettings,
} from '@core/types';
import { strikeBoth, syncLeg2Stake } from './tab-bridge';

const log = createLogger('autobet');

export type AutoBetContext = {
  quotesBySite: Record<'x10' | 'bcgame', OddsQuote[]>;
  slips: Record<'x10' | 'bcgame', SlipState | null>;
  runtime: RuntimeState;
};

export function createRuntimeState(): RuntimeState {
  return {
    armed: false,
    x10Slip: null,
    bcSlip: null,
    profitPercent: null,
    leg2Usdt: null,
    usdtKrw: 1400,
    lastOpportunities: [],
    lastStrikeAt: 0,
    lastSyncAt: 0,
  };
}

export async function processSlipUpdate(
  ctx: AutoBetContext,
  siteId: 'x10' | 'bcgame',
  slip: SlipState
): Promise<RuntimeState> {
  ctx.slips[siteId] = slip;
  ctx.runtime.x10Slip = ctx.slips.x10;
  ctx.runtime.bcSlip = ctx.slips.bcgame;

  const settings = await loadSettings();
  const rate = settings.autoBithumbRate
    ? (await getUsdtKrwRate(settings.manualUsdtKrw)).krw
    : settings.manualUsdtKrw;
  ctx.runtime.usdtKrw = rate;

  const x10Odds = ctx.slips.x10?.odds ?? 0;
  const bcOdds = ctx.slips.bcgame?.odds ?? 0;

  if (x10Odds > 1.01 && bcOdds > 1.01) {
    ctx.runtime.profitPercent = calcProfitPercent(x10Odds, bcOdds);

    if (settings.stakeSyncEnabled) {
      const sync = await syncLeg2Stake(settings, x10Odds, bcOdds, rate);
      ctx.runtime.leg2Usdt = sync.bcUsdt;
      ctx.runtime.lastSyncAt = Date.now();
    }

    const opps = scanArbitrage(ctx.quotesBySite.x10, ctx.quotesBySite.bcgame, settings);
    ctx.runtime.lastOpportunities = opps;

    if (ctx.runtime.armed && settings.autoBetEnabled && ctx.runtime.profitPercent !== null) {
      if (ctx.runtime.profitPercent >= settings.minProfitPercent) {
        const top = opps[0];
        if (top && Date.now() - ctx.runtime.lastStrikeAt > 8000) {
          const bcUsdt = ctx.runtime.leg2Usdt ?? 0;
          if (bcUsdt > 0) {
            log.info('auto strike', ctx.runtime.profitPercent);
            ctx.runtime.lastStrikeAt = Date.now();
            await strikeBoth(settings, bcUsdt);
            if (settings.telegramEnabled || settings.discordEnabled) {
              await notifyOpportunity(top, settings, settings.x10BetKrw, bcUsdt);
            }
          }
        }
      }
    }
  }

  return ctx.runtime;
}

export async function notifyIfOpportunity(
  opps: ArbitrageOpportunity[],
  settings: UserSettings,
  x10Krw: number,
  bcUsdt: number
): Promise<void> {
  if (!opps.length) return;
  if (settings.telegramEnabled || settings.discordEnabled) {
    await notifyOpportunity(opps[0]!, settings, x10Krw, bcUsdt);
  }
}
