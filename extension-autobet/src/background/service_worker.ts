import '../engine';
import { formatStrikeFailLine } from '@shared/config/sites';
import { broadcast } from '@shared/messaging/runtime';
import { appendLog, loadConfig, saveConfig } from '@shared/messaging/storage';
import type { AutoBetConfig, LogEntry, RuntimeMessage } from '@shared/types';
import {
  diagnoseBtiExtension,
  findTabs,
  injectAllOpenLeg1Tabs,
  installLeg1ScriptWatcher,
  installRecentWebTabTracker,
  openLeg1Tab,
  openLeg2Tab,
  readSnapshot,
  verifyBtiConnection,
} from '../engine';
import './panel-window';
import { openPanel } from './panel-window';

let armed = false;
let config: AutoBetConfig = {
  minProfit: 1,
  leg2: 'bcgame',
  leg2Synced: false,
  leg2SyncedSite: '',
  btiBetKrw: 10000,
  usdRate: 1400,
  cooldownMs: 0,
  useArbBotBridge: true,
  preSyncAmount: true,
};

function logEntry(text: string, level: LogEntry['level'] = 'info'): void {
  const entry: LogEntry = { time: Date.now(), text, level };
  void appendLog(entry);
  broadcast({ type: 'AUTOBET_LOG', entry });
}

async function hydrateConfig(): Promise<void> {
  config = await loadConfig();
  armed = !!config.armed;
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'AUTOBET_ARM') {
    armed = !!msg.armed;
    void saveConfig({ armed }).then(() => {
      if (armed) logEntry('오토시작', 'info');
      broadcast({ type: 'AUTOBET_ARMED', armed });
      sendResponse({ ok: true, armed });
    });
    return true;
  }

  if (msg.type === 'AUTOBET_GET_STATE') {
    sendResponse({ ok: true, armed, config });
    return false;
  }

  if (msg.type === 'AUTOBET_SET_CONFIG') {
    void saveConfig(msg.config || {}).then((next) => {
      config = next;
      if (msg.config?.armed != null) armed = !!msg.config.armed;
      sendResponse({ ok: true, config });
    });
    return true;
  }

  if (msg.type === 'AUTOBET_STRIKE_RESULT' && msg.result) {
    const r = msg.result;
    if (r.ok) {
      armed = false;
      void saveConfig({ armed: false }).then(() => {
        broadcast({ type: 'AUTOBET_ARMED', armed: false });
      });
      logEntry('✓ 배팅 성공 — 자동 해제', 'ok');
    } else {
      logEntry(
        formatStrikeFailLine(
          r.btiRes as Record<string, unknown>,
          r.polyRes as Record<string, unknown>,
          config.leg2
        ),
        'err'
      );
    }
    return false;
  }

  if (msg.type === 'ODDS_CHANGED' || msg.type === 'BTI_STAKE_CHANGED') {
    broadcast(msg);
    return false;
  }

  if (msg.type === 'READ_SNAPSHOT') {
    readSnapshot(msg.leg2 ?? config.leg2, msg.btiBetKrw ?? config.btiBetKrw, msg.usdRate ?? config.usdRate, msg.opts || {})
      .then((snap) => sendResponse(snap))
      .catch((e: Error) => sendResponse({ ok: false, reason: e?.message || '배당 읽기 실패' }));
    return true;
  }

  if (msg.type === 'VERIFY_BTI') {
    verifyBtiConnection(msg.leg2 || config.leg2)
      .then((res) => sendResponse(res))
      .catch((e: Error) => sendResponse({ ok: false, reason: e?.message || '텐텐뱃 연결확인 실패' }));
    return true;
  }

  if (msg.type === 'DIAGNOSE_BTI') {
    diagnoseBtiExtension(msg.leg2 || config.leg2)
      .then((res) => sendResponse(res))
      .catch((e: Error) => sendResponse({ ok: false, reason: e?.message || '진단 실패' }));
    return true;
  }

  if (msg.type === 'FIND_TABS') {
    findTabs(msg.leg2 || config.leg2)
      .then((found) => sendResponse({ ok: true, ...found }))
      .catch((e: Error) => sendResponse({ ok: false, reason: e?.message || '탭 탐색 실패' }));
    return true;
  }

  if (msg.type === 'OPEN_LEG1_TAB') {
    openLeg1Tab(!!msg.useAlt)
      .then((res) => sendResponse(res))
      .catch((e: Error) => sendResponse({ ok: false, reason: e?.message || '텐텐뱃 탭 열기 실패' }));
    return true;
  }

  if (msg.type === 'OPEN_LEG2_TAB') {
    openLeg2Tab(msg.leg2 || config.leg2)
      .then((res) => sendResponse(res))
      .catch((e: Error) => sendResponse({ ok: false, reason: e?.message || '사이트 탭 열기 실패' }));
    return true;
  }

  if (msg.type === 'OPEN_AUTOBET_PANEL') {
    void openPanel()
      .then((id) => sendResponse({ ok: true, windowId: id }))
      .catch((e: Error) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  installLeg1ScriptWatcher();
  void injectAllOpenLeg1Tabs().catch(() => {});
  void openPanel().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void hydrateConfig().then(() => {
    if (armed) void openPanel().catch(() => {});
  });
});

void hydrateConfig().then(() => {
  console.log('[자동배팅] service worker — 별도 창 패널');
  installLeg1ScriptWatcher();
  void injectAllOpenLeg1Tabs().catch(() => {});
  installRecentWebTabTracker();
  if (armed) void openPanel().catch(() => {});
});
