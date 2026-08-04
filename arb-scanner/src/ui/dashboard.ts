import type { ArbitrageOpportunity, RuntimeState } from '@core/types';
import { loadSettings, saveSettings } from '@core/storage';

type LocalState = {
  runtime?: RuntimeState;
  usdtKrw?: number;
  updatedAt?: number;
  lastOpportunities?: ArbitrageOpportunity[];
};

function renderSlip(el: HTMLElement, slip: RuntimeState['x10Slip'], label: string): void {
  if (!slip?.odds) {
    el.innerHTML = `<span class="muted">${label} — 슬립 없음</span><small>사이트 탭에서 배팅카트를 열어주세요</small>`;
    return;
  }
  el.innerHTML = `
    <div class="slip-title">${slip.selection} <strong>@${slip.odds.toFixed(2)}</strong></div>
    <div class="slip-event">${slip.eventName.slice(0, 60) || '—'}</div>
    ${slip.stake ? `<div class="slip-stake">베팅금 ${slip.stake.toLocaleString()}</div>` : ''}
  `;
}

function renderOpportunities(list: ArbitrageOpportunity[]): void {
  const el = document.getElementById('opps');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div class="muted">매칭된 양방 기회 없음</div>';
    return;
  }
  el.innerHTML = list
    .slice(0, 5)
    .map(
      (o) => `
    <div class="opp-row ${o.viable ? 'viable' : ''}">
      <span class="opp-profit">${o.profitPercent.toFixed(2)}%</span>
      <span class="opp-event">${o.eventName.slice(0, 36)}</span>
      <span class="opp-odds">x10 ${o.legX10.odds} · BC ${o.legBc.odds}</span>
    </div>`
    )
    .join('');
}

export async function refreshDashboard(): Promise<void> {
  const data = (await chrome.storage.local.get([
    'runtime',
    'usdtKrw',
    'updatedAt',
    'lastOpportunities',
  ])) as LocalState;
  const rt = data.runtime;
  const settings = await loadSettings();

  const profitEl = document.getElementById('profit');
  if (profitEl) {
    profitEl.textContent = rt?.profitPercent != null ? `${rt.profitPercent.toFixed(2)}%` : '—';
    profitEl.className = rt?.profitPercent != null && rt.profitPercent >= settings.minProfitPercent ? 'good' : '';
  }
  document.getElementById('rate')!.textContent = String(data.usdtKrw ?? rt?.usdtKrw ?? '—');
  document.getElementById('bc-usdt')!.textContent =
    rt?.leg2Usdt != null ? rt.leg2Usdt.toFixed(2) : '—';
  document.getElementById('min-profit')!.textContent = `${settings.minProfitPercent}%`;

  const x10Input = document.getElementById('x10-krw') as HTMLInputElement | null;
  if (x10Input && document.activeElement !== x10Input) {
    x10Input.value = String(settings.x10BetKrw);
  }

  renderSlip(document.getElementById('x10-slip')!, rt?.x10Slip ?? null, 'x10');
  renderSlip(document.getElementById('bc-slip')!, rt?.bcSlip ?? null, 'BC');
  renderOpportunities(rt?.lastOpportunities ?? data.lastOpportunities ?? []);

  const armBtn = document.getElementById('arm-btn')!;
  const armed = !!rt?.armed;
  armBtn.textContent = armed ? '자동배팅 ON' : '자동배팅 OFF';
  armBtn.className = armed ? 'btn arm-on' : 'btn arm-off';

  const age = data.updatedAt ? Math.round((Date.now() - data.updatedAt) / 1000) : -1;
  document.getElementById('status')!.textContent = age >= 0 ? `${age}s 전` : '대기';
}

export function wireDashboard(): void {
  document.getElementById('x10-krw')?.addEventListener('change', async () => {
    const settings = await loadSettings();
    settings.x10BetKrw =
      parseInt((document.getElementById('x10-krw') as HTMLInputElement).value, 10) || 100000;
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
    setTimeout(refreshDashboard, 200);
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
      func: () => {
        const w = globalThis as {
          __arbScannerDiag?: () => void;
          __arbScannerSlip?: () => unknown;
        };
        w.__arbScannerDiag?.();
        console.log('[ArbScanner slip]', w.__arbScannerSlip?.());
      },
    });
  });

  refreshDashboard();
  setInterval(refreshDashboard, 1000);
}
