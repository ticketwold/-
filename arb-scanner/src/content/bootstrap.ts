import { detectSiteId } from '@scanner/adapters';
import { ScannerEngine } from '@scanner/engine';
import { createLogger } from '@core/logger';
import type { ContentMessage, OddsQuote, SlipState } from '@core/types';
import { getSetting } from '@core/storage';
import { readSlipForSite } from './actions';
import { installActionHandler } from './message-handler';

const log = createLogger('content');

declare global {
  interface Window {
    __arbScannerDiag?: () => ReturnType<ScannerEngine['runDiagnostic']>;
    __arbScannerQuotes?: () => ReturnType<ScannerEngine['getLastQuotes']>;
    __arbScannerSlip?: () => SlipState | null;
  }
}

let engineRef: ScannerEngine | null = null;

function bestSlipQuote(quotes: OddsQuote[]): OddsQuote | null {
  const slips = quotes.filter((q) => q.source === 'slip' && q.odds > 1.01);
  if (!slips.length) return null;
  return slips.reduce((a, b) => (b.confidence >= a.confidence ? b : a));
}

function resolveSlip(siteId: 'x10' | 'bcgame', quotes: OddsQuote[]): SlipState | null {
  const fromDom = readSlipForSite(siteId);
  const best = bestSlipQuote(quotes);
  if (best && (!fromDom || best.confidence >= 0.85)) {
    return {
      odds: best.odds,
      selection: best.selection,
      eventName: best.eventName,
      stake: fromDom?.stake ?? 0,
      source: 'slip',
      updatedAt: Date.now(),
    };
  }
  return fromDom;
}

function emitSlip(siteId: 'x10' | 'bcgame', quotes: OddsQuote[] = []): void {
  const slip = resolveSlip(siteId, quotes.length ? quotes : engineRef?.getLastQuotes() ?? []);
  if (!slip?.odds || slip.odds <= 1.01) return;
  const msg: ContentMessage = { type: 'SLIP_UPDATE', siteId, slip };
  try {
    chrome.runtime.sendMessage(msg);
  } catch {
    /* invalidated */
  }
}

async function main(): Promise<void> {
  const siteId = detectSiteId(location.href);
  if (!siteId) return;

  installActionHandler();

  const debounceMs = await getSetting('debounceMs');
  const diagnostic = await getSetting('diagnosticMode');

  const engine = new ScannerEngine({
    siteId,
    debounceMs,
    diagnostic,
    onScan: ({ quotes }) => emitSlip(siteId, quotes),
  });

  engineRef = engine;
  const stop = engine.start();
  window.__arbScannerDiag = () => engine.logDiagnostic();
  window.__arbScannerQuotes = () => engine.getLastQuotes();
  window.__arbScannerSlip = () => resolveSlip(siteId, engine.getLastQuotes());

  emitSlip(siteId);
  const slipPoll = setInterval(() => emitSlip(siteId), 500);

  document.addEventListener(
    'input',
    (e) => {
      const t = e.target as HTMLElement;
      if (t?.matches?.('input#counter, input[placeholder*="베팅"], input[placeholder*="stake"]')) {
        emitSlip(siteId);
        if (siteId === 'x10') {
          chrome.runtime.sendMessage({ type: 'X10_STAKE_CHANGED', stake: (t as HTMLInputElement).value });
        }
      }
    },
    true
  );

  log.info(`boot ${siteId} ${window === window.top ? 'top' : 'iframe'}`);
  engine.logDiagnostic();

  window.addEventListener('unload', () => {
    clearInterval(slipPoll);
    stop();
    engineRef = null;
  });
}

main().catch((e) => log.catch('bootstrap', e));
