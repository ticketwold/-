const API_URL = "https://api.bithumb.com/v1/ticker?markets=KRW-USDT";
const MIN_RATE = 500;
const MAX_RATE = 5000;

/** @type {{ rate: number|null, status: string, updated_at: number, age_seconds: number, error: string }} */
export const fxSnapshot = {
  rate: null,
  status: "LOADING",
  updated_at: 0,
  age_seconds: 0,
  error: "",
};

let refreshTimer = null;

function parseRate(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data || [];
  for (const row of rows) {
    const market = row.market || row.symbol || "";
    if (market !== "KRW-USDT") continue;
    const price = Number(row.trade_price ?? row.closing_price ?? row.price);
    if (Number.isFinite(price) && price >= MIN_RATE && price <= MAX_RATE) return price;
  }
  return null;
}

function updateStatus(now) {
  if (!fxSnapshot.rate || !fxSnapshot.updated_at) {
    fxSnapshot.status = fxSnapshot.error ? "ERROR" : "LOADING";
    fxSnapshot.age_seconds = 0;
    return;
  }
  fxSnapshot.age_seconds = (now - fxSnapshot.updated_at) / 1000;
  if (fxSnapshot.age_seconds <= 5) fxSnapshot.status = "LIVE";
  else if (fxSnapshot.age_seconds <= 30) fxSnapshot.status = "DELAYED";
  else fxSnapshot.status = "STALE";
}

export function isFxUsable(maxStaleSeconds = 30) {
  updateStatus(Date.now());
  return fxSnapshot.rate != null && fxSnapshot.updated_at > 0 && fxSnapshot.age_seconds <= maxStaleSeconds;
}

export function resolveFxRate(settings) {
  if (isFxUsable(settings.fx_max_stale_seconds)) return fxSnapshot.rate;
  if (settings.usdt_rate > 0) return settings.usdt_rate;
  return fxSnapshot.rate;
}

export async function refreshFx() {
  const now = Date.now();
  try {
    const resp = await fetch(API_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const rate = parseRate(data);
    if (!rate) throw new Error("invalid-rate");
    fxSnapshot.rate = rate;
    fxSnapshot.updated_at = now;
    fxSnapshot.error = "";
  } catch (err) {
    fxSnapshot.error = String(err.message || err);
    if (!fxSnapshot.rate) fxSnapshot.status = "ERROR";
  }
  updateStatus(now);
  return { ...fxSnapshot };
}

export function startFxPolling(intervalSec = 2) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshFx();
  refreshTimer = setInterval(refreshFx, intervalSec * 1000);
}

export function stopFxPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
