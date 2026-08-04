import type { ArbitrageOpportunity, OddsQuote } from '@core/types';

type StorageState = {
  lastQuotes?: { x10: OddsQuote[]; bcgame: OddsQuote[] };
  lastOpportunities?: ArbitrageOpportunity[];
  updatedAt?: number;
};

function renderQuotes(list: OddsQuote[]): string {
  if (!list?.length) return '<li>데이터 없음 — 사이트 탭을 열고 슬립/보드를 확인하세요</li>';
  return list
    .slice(0, 8)
    .map(
      (q) =>
        `<li><strong>${q.odds.toFixed(2)}</strong> ${q.selection} — ${q.eventName.slice(0, 40)} <em>(${q.source})</em></li>`
    )
    .join('');
}

function renderOpps(opps: ArbitrageOpportunity[]): string {
  if (!opps?.length) return '<li>양방 없음</li>';
  return opps
    .map(
      (o) =>
        `<li class="positive">${o.profitPercent.toFixed(2)}% — ${o.eventName.slice(0, 36)} (x10 ${o.legX10.odds} / BC ${o.legBc.odds})</li>`
    )
    .join('');
}

async function refresh(): Promise<void> {
  const data = (await chrome.storage.local.get([
    'lastQuotes',
    'lastOpportunities',
    'updatedAt',
  ])) as StorageState;

  const x10 = data.lastQuotes?.x10 ?? [];
  const bc = data.lastQuotes?.bcgame ?? [];
  const opps = data.lastOpportunities ?? [];

  document.getElementById('x10-list')!.innerHTML = renderQuotes(x10);
  document.getElementById('bc-list')!.innerHTML = renderQuotes(bc);
  document.getElementById('opp-list')!.innerHTML = renderOpps(opps);

  const age = data.updatedAt ? Math.round((Date.now() - data.updatedAt) / 1000) : -1;
  document.getElementById('status')!.textContent =
    age >= 0 ? `${age}s 전 갱신` : '대기 중';
}

document.getElementById('diag-btn')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, () => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id!, allFrames: true },
      func: () => {
        (globalThis as { __arbScannerDiag?: () => void }).__arbScannerDiag?.();
      },
    });
  });
});

refresh();
setInterval(refresh, 2000);
