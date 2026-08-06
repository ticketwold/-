import type { UserSettings } from './types';
import { DEFAULT_SETTINGS } from './types';

const KEY = 'arb_scanner_settings';

export async function loadSettings(): Promise<UserSettings> {
  try {
    const data = await chrome.storage.sync.get(KEY);
    return { ...DEFAULT_SETTINGS, ...(data[KEY] as Partial<UserSettings> | undefined) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.sync.set({ [KEY]: settings });
}

export async function getSetting<K extends keyof UserSettings>(key: K): Promise<UserSettings[K]> {
  const s = await loadSettings();
  return s[key];
}
