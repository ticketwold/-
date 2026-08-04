import type { RuntimeState } from '@core/types';
import { loadSettings, saveSettings } from '@core/storage';

type LocalState = {
  runtime?: RuntimeState;
  usdtKrw?: number;
  updatedAt?: number;
};

function renderSlip(
  el: HTMLElement,
  slip: RuntimeState['x10Slip'],
  label: string
): void {
  if (!slip?.odds) {
    el.textContent = `${label} — 슬립 없음`;
    return;
  }
  el.textContent = `${slip.selection} @ ${slip.odds.toFixed(2)} | ${slip.eventName.slice(0, 40)}`;
}

async function refresh(): Promise<void> {
  const data = (await chrome.storage.local.get([
    'runtime',
    'usdtKrw',
    'updatedAt',
  ])) as LocalState;
  const rt = data.runtime;
  const settings = await loadSettings();

  document.getElementById('profit')!.textContent =
    rt?.profitPercent != null ? `${rt.profitPercent.toFixed(2)}%` : '—';
  document.getElementById('rate')!.textContent = String(data.usdtKrw ?? rt?.usdtKrw ?? '—');
  document.getElementById('bc-usdt')!.textContent =
    rt?.leg2Usdt != null ? rt.leg2Usdt.toFixed(2) : '—';

  const x10Input = document.getElementById('x10-krw') as HTMLInputElement;
  if (document.activeElement !== x10Input) {
    x10Input.value = String(settings.x10BetKrw);
  }

  renderSlip(document.getElementById('x10-slip')!, rt?.x10Slip ?? null, 'x10');
  renderSlip(document.getElementById('bc-slip')!, rt?.bcSlip ?? null, 'BC');

  const armBtn = document.getElementById('arm-btn')!;
  const armed = !!rt?.armed;
  armBtn.textContent = armed ? '자동배팅 ON' : '자동배팅 OFF';
  armBtn.className = armed ? 'arm-on' : 'arm-off';

  const age = data.updatedAt ? Math.round((Date.now() - data.updatedAt) / 1000) : -1;
  document.getElementById('status')!.textContent = age >= 0 ? `${age}s` : '대기';
}

document.getElementById('x10-krw')?.addEventListener('change', async () => {
  const settings = await loadSettings();
  settings.x10BetKrw = parseInt((document.getElementById('x10-krw') as HTMLInputElement).value, 10) || 100000;
  await saveSettings(settings);
  chrome.runtime.sendMessage({ type: 'SYNC_STAKE' });
});

document.getElementById('sync-btn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SYNC_STAKE' });
});

document.getElementById('arm-btn')?.addEventListener('click', async () => {
  const data = (await chrome.storage.local.get('runtime')) as LocalState;
  const armed = !data.runtime?.armed;
  chrome.runtime.sendMessage({ type: 'ARM', armed });
  setTimeout(refresh, 200);
});

document.getElementById('strike-btn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'MANUAL_STRIKE' });
});

document.getElementById('diag-btn')?.addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => (globalThis as { __arbScannerDiag?: () => void }).__arbScannerDiag?.(),
  });
});

refresh();
setInterval(refresh, 1000);
