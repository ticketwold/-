import { createLogger } from './logger';

const log = createLogger('bithumb');

export type UsdtRate = {
  krw: number;
  source: 'bithumb' | 'manual' | 'cache';
  updatedAt: number;
};

const CACHE_KEY = 'usdt_krw_rate';
const BITHUMB_TICKER = 'https://api.bithumb.com/public/ticker/USDT_KRW';

/** 빗썸 USDT/KRW 시세 */
export async function fetchBithumbUsdtKrw(): Promise<UsdtRate | null> {
  try {
    const res = await fetch(BITHUMB_TICKER, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { status?: string; data?: { closing_price?: string } };
    const price = parseFloat(json?.data?.closing_price || '0');
    if (!price || price < 1000 || price > 3000) throw new Error(`invalid price ${price}`);
    const rate: UsdtRate = { krw: price, source: 'bithumb', updatedAt: Date.now() };
    await chrome.storage.local.set({ [CACHE_KEY]: rate });
    log.info(`USDT/KRW ${price}`);
    return rate;
  } catch (e) {
    log.catch('fetch', e);
    return null;
  }
}

export async function getUsdtKrwRate(manualFallback = 1400): Promise<UsdtRate> {
  const data = await chrome.storage.local.get(CACHE_KEY);
  const cached = data[CACHE_KEY] as UsdtRate | undefined;
  if (cached?.krw && Date.now() - cached.updatedAt < 60_000) return cached;

  const live = await fetchBithumbUsdtKrw();
  if (live) return live;

  if (cached?.krw) return { ...cached, source: 'cache' };
  return { krw: manualFallback, source: 'manual', updatedAt: Date.now() };
}
