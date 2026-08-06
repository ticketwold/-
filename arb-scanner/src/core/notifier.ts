import { createLogger } from './logger';
import type { ArbitrageOpportunity } from './types';

const log = createLogger('notify');

export type WebhookSettings = {
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
  telegramEnabled: boolean;
  discordEnabled: boolean;
};

export async function sendTelegram(
  token: string,
  chatId: string,
  text: string
): Promise<boolean> {
  if (!token || !chatId) return false;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return res.ok;
  } catch (e) {
    log.catch('telegram', e);
    return false;
  }
}

export async function sendDiscord(webhookUrl: string, content: string): Promise<boolean> {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return res.ok;
  } catch (e) {
    log.catch('discord', e);
    return false;
  }
}

export function formatOppMessage(opp: ArbitrageOpportunity, x10Krw: number, bcUsdt: number): string {
  return [
    `<b>양방 ${opp.profitPercent.toFixed(2)}%</b>`,
    opp.eventName,
    `x10 ${opp.legX10.odds} @ ${x10Krw.toLocaleString()}원`,
    `BC ${opp.legBc.odds} @ ${bcUsdt} USDT`,
  ].join('\n');
}

export async function notifyOpportunity(
  opp: ArbitrageOpportunity,
  hooks: WebhookSettings,
  x10Krw: number,
  bcUsdt: number
): Promise<void> {
  const msg = formatOppMessage(opp, x10Krw, bcUsdt).replace(/<[^>]+>/g, '');
  const html = formatOppMessage(opp, x10Krw, bcUsdt);

  if (hooks.telegramEnabled) await sendTelegram(hooks.telegramBotToken, hooks.telegramChatId, html);
  if (hooks.discordEnabled) await sendDiscord(hooks.discordWebhookUrl, msg);
}
