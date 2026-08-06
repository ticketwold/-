// 빗썸 USDT/KRW 시세
const BITHUMB_TICKER = 'https://api.bithumb.com/public/ticker/USDT_KRW';
const CACHE_KEY = 'usdt_krw_rate';
const CACHE_MS = 60_000;

async function fetchBithumbUsdtKrw() {
  try {
    const res = await fetch(BITHUMB_TICKER, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const price = parseFloat(json?.data?.closing_price || '0');
    if (!price || price < 1000 || price > 3000) throw new Error(`invalid ${price}`);
    const rate = { krw: price, source: 'bithumb', updatedAt: Date.now() };
    await chrome.storage.local.set({ [CACHE_KEY]: rate });
    return rate;
  } catch (e) {
    console.warn('[bithumb]', e.message);
    return null;
  }
}

async function getUsdtKrwRate(manualFallback = 1400) {
  try {
    const data = await chrome.storage.local.get(CACHE_KEY);
    const cached = data[CACHE_KEY];
    if (cached?.krw && Date.now() - cached.updatedAt < CACHE_MS) return cached;
  } catch (_) {}

  const live = await fetchBithumbUsdtKrw();
  if (live) return live;

  try {
    const data = await chrome.storage.local.get(CACHE_KEY);
    if (data[CACHE_KEY]?.krw) return { ...data[CACHE_KEY], source: 'cache' };
  } catch (_) {}

  return { krw: manualFallback, source: 'manual', updatedAt: Date.now() };
}
