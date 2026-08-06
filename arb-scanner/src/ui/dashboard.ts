import type { ArbitrageOpportunity, RuntimeState } from '@core/types';
import { loadSettings, saveSettings } from '@core/storage';
import { BC_TAB_PATTERNS, X10_TAB_PATTERNS } from '@core/site-patterns';

type LocalState = {
  runtime?: RuntimeState;
  usdtKrw?: number;
  updatedAt?: number;
  lastOpportunities?: ArbitrageOpportunity[];
};

function toast(msg: string, ok = true): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = ok ? 'toast ok' : 'toast err';
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

function sendBg<T>(msg: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res as T);
    });
  });
}

function renderSlip(el: HTMLElement, slip: RuntimeState['x10Slip'], label: string): void {
  if (!slip?.odds) {
    el.innerHTML = `<span class="muted">${label} — 슬립 없음</span><small>배팅카트에 선택 후 [새로고침] 클릭</small>`;
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

async function renderTabStatus(): Promise<void> {
  const el = document.getElementById('tab-status');
  if (!el) return;
  const x10 = await chrome.tabs.query({ url: X10_TAB_PATTERNS });
  const bc = await chrome.tabs.query({ url: BC_TAB_PATTERNS });
  el.textContent = `x10 ${x10.length}탭 · BC ${bc.length}탭`;
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
    profitEl.className =
      rt?.profitPercent != null && rt.profitPercent >= settings.minProfitPercent ? 'value good' : 'value';
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
  await renderTabStatus();
}

export function wireDashboard(): void {
  document.getElementById('refresh-btn')?.addEventListener('click', async () => {
    toast('배당 스캔 중…');
    try {
      await sendBg<{ ok: boolean }>({ type: 'REFRESH' });
      await refreshDashboard();
      toast('스캔 완료');
    } catch (e) {
      toast(String(e), false);
    }
  });

  document.getElementById('x10-krw')?.addEventListener('change', async () => {
    const settings = await loadSettings();
    settings.x10BetKrw =
      parseInt((document.getElementById('x10-krw') as HTMLInputElement).value, 10) || 100000;
    await saveSettings(settings);
    try {
      await sendBg({ type: 'SYNC_STAKE' });
      toast('금액 동기화 요청');
      await refreshDashboard();
    } catch (e) {
      toast(String(e), false);
    }
  });

  document.getElementById('sync-btn')?.addEventListener('click', async () => {
    try {
      const res = await sendBg<{ ok: boolean; runtime?: RuntimeState; collected?: { x10?: unknown; bc?: unknown } }>({ type: 'SYNC_STAKE' });
      if (!res?.runtime?.x10Slip?.odds) {
        toast('x10 슬립 없음 — 배팅카트 확인', false);
      } else if (!res?.runtime?.bcSlip?.odds) {
        toast('BC 슬립 없음 — 배팅카트 확인', false);
      } else if (res.runtime.leg2Usdt) {
        toast(`BC ${res.runtime.leg2Usdt.toFixed(2)} USDT 설정 완료`);
      } else {
        toast('BC 금액 입력 실패 — BC 탭 확인', false);
      }
      await refreshDashboard();
    } catch (e) {
      toast(String(e), false);
    }
  });

  document.getElementById('arm-btn')?.addEventListener('click', async () => {
    const data = (await chrome.storage.local.get('runtime')) as LocalState;
    const armed = !data.runtime?.armed;
    try {
      await sendBg({ type: 'ARM', armed });
      toast(armed ? '자동배팅 ON' : '자동배팅 OFF');
      await refreshDashboard();
    } catch (e) {
      toast(String(e), false);
    }
  });

  document.getElementById('strike-btn')?.addEventListener('click', async () => {
    try {
      const res = await sendBg<{ ok: boolean; reason?: string; result?: unknown }>({
        type: 'MANUAL_STRIKE',
      });
      if (res?.ok) toast('베팅 명령 전송');
      else toast(res?.reason === 'no-leg2-amount' ? '슬립·금액 먼저 확인' : '베팅 실패', false);
    } catch (e) {
      toast(String(e), false);
    }
  });

  document.getElementById('diag-btn')?.addEventListener('click', async () => {
    const tabs = [
      ...(await chrome.tabs.query({ url: X10_TAB_PATTERNS })),
      ...(await chrome.tabs.query({ url: BC_TAB_PATTERNS })),
    ];
    if (!tabs.length) {
      toast('x10/BC 탭을 먼저 열어주세요', false);
      return;
    }
    for (const tab of tabs.slice(0, 4)) {
      if (!tab.id) continue;
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
    }
    toast(`진단 실행 (${tabs.length}탭) — F12 콘솔 확인`);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.runtime || changes.updatedAt)) {
      refreshDashboard();
    }
  });

  refreshDashboard();
  sendBg({ type: 'REFRESH' }).catch(() => {});
  setInterval(refreshDashboard, 1000);
}
