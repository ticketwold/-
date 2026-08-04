import { DEFAULT_SETTINGS, type UserSettings } from '@core/types';
import { loadSettings, saveSettings } from '@core/storage';

const form = document.getElementById('form') as HTMLFormElement;
const saved = document.getElementById('saved')!;

async function load(): Promise<void> {
  const s = await loadSettings();
  (document.getElementById('minProfit') as HTMLInputElement).value = String(s.minProfitPercent);
  (document.getElementById('debounceMs') as HTMLInputElement).value = String(s.debounceMs);
  (document.getElementById('notifications') as HTMLInputElement).checked = s.notificationsEnabled;
  (document.getElementById('sound') as HTMLInputElement).checked = s.soundEnabled;
  (document.getElementById('diagnostic') as HTMLInputElement).checked = s.diagnosticMode;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings: UserSettings = {
    ...DEFAULT_SETTINGS,
    minProfitPercent: parseFloat((document.getElementById('minProfit') as HTMLInputElement).value) || 1,
    debounceMs: parseInt((document.getElementById('debounceMs') as HTMLInputElement).value, 10) || 300,
    notificationsEnabled: (document.getElementById('notifications') as HTMLInputElement).checked,
    soundEnabled: (document.getElementById('sound') as HTMLInputElement).checked,
    diagnosticMode: (document.getElementById('diagnostic') as HTMLInputElement).checked,
  };
  await saveSettings(settings);
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 2000);
});

load();
