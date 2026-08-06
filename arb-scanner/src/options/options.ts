import { DEFAULT_SETTINGS, type UserSettings } from '@core/types';
import { loadSettings, saveSettings } from '@core/storage';

const form = document.getElementById('form') as HTMLFormElement;
const saved = document.getElementById('saved')!;

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load(): Promise<void> {
  const s = await loadSettings();
  $('minProfit').value = String(s.minProfitPercent);
  $('x10BetKrw').value = String(s.x10BetKrw);
  $('manualUsdtKrw').value = String(s.manualUsdtKrw);
  $('debounceMs').value = String(s.debounceMs);
  $('telegramToken').value = s.telegramBotToken;
  $('telegramChatId').value = s.telegramChatId;
  $('discordWebhook').value = s.discordWebhookUrl;
  $('stakeSync').checked = s.stakeSyncEnabled;
  $('autoBet').checked = s.autoBetEnabled;
  $('autoBithumb').checked = s.autoBithumbRate;
  $('notifications').checked = s.notificationsEnabled;
  $('sound').checked = s.soundEnabled;
  $('telegramEnabled').checked = s.telegramEnabled;
  $('discordEnabled').checked = s.discordEnabled;
  $('diagnostic').checked = s.diagnosticMode;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings: UserSettings = {
    ...DEFAULT_SETTINGS,
    minProfitPercent: parseFloat($('minProfit').value) || 1,
    x10BetKrw: parseInt($('x10BetKrw').value, 10) || 100000,
    manualUsdtKrw: parseFloat($('manualUsdtKrw').value) || 1400,
    debounceMs: parseInt($('debounceMs').value, 10) || 300,
    telegramBotToken: $('telegramToken').value.trim(),
    telegramChatId: $('telegramChatId').value.trim(),
    discordWebhookUrl: $('discordWebhook').value.trim(),
    stakeSyncEnabled: $('stakeSync').checked,
    autoBetEnabled: $('autoBet').checked,
    autoBithumbRate: $('autoBithumb').checked,
    notificationsEnabled: $('notifications').checked,
    soundEnabled: $('sound').checked,
    telegramEnabled: $('telegramEnabled').checked,
    discordEnabled: $('discordEnabled').checked,
    diagnosticMode: $('diagnostic').checked,
  };
  await saveSettings(settings);
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 2000);
});

load();
