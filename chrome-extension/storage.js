/** @typedef {import('./profit_engine.js').OddsOnlyMetrics} OddsOnlyMetrics */

export const DEFAULT_SETTINGS = {
  target_profit_pct: 0.5,
  bti_stake_krw: 10000,
  stake_sync_enabled: true,
  auto_watch_enabled: false,
  live_execution_enabled: false,
  stabilize_seconds: 3.0,
  stable_count_required: 3,
  round_unit_krw: 100,
  round_unit_usdt: 0.1,
  fx_max_stale_seconds: 30,
  fx_refresh_seconds: 2,
};

const SETTINGS_KEY = "arb_settings";
const STATE_KEY = "arb_runtime_state";

export async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function loadRuntimeState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || {};
}

export async function saveRuntimeState(patch) {
  const current = await loadRuntimeState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}
