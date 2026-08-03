import { AutoBetConfig, DEFAULT_CONFIG, LogEntry, STORAGE_KEYS } from '../types';

export async function loadConfig(): Promise<AutoBetConfig> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.config);
  const stored = data[STORAGE_KEYS.config] as Partial<AutoBetConfig> | undefined;
  return { ...DEFAULT_CONFIG, ...stored };
}

export async function saveConfig(patch: Partial<AutoBetConfig>): Promise<AutoBetConfig> {
  const current = await loadConfig();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: next });
  return next;
}

export async function appendLog(entry: LogEntry): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.log);
  const list = Array.isArray(data[STORAGE_KEYS.log])
    ? (data[STORAGE_KEYS.log] as LogEntry[])
    : [];
  list.unshift(entry);
  if (list.length > 50) list.length = 50;
  await chrome.storage.local.set({ [STORAGE_KEYS.log]: list });
}

export async function readRecentLogs(limit = 15): Promise<LogEntry[]> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.log);
  const list = Array.isArray(data[STORAGE_KEYS.log])
    ? (data[STORAGE_KEYS.log] as LogEntry[])
    : [];
  return list.slice(0, limit);
}
