import { detectSiteId } from '@scanner/adapters';
import { ScannerEngine } from '@scanner/engine';
import { createLogger } from '@core/logger';
import type { ContentMessage, SlipState } from '@core/types';
import { getSetting } from '@core/storage';
import { readSlipForSite } from './actions';
import { installActionHandler } from './message-handler';

const log = createLogger('content');

declare global {
  interface Window {
    __arbScannerDiag?: () => ReturnType<ScannerEngine['runDiagnostic']>;
    __arbScannerQuotes?: () => ReturnType<ScannerEngine['getLastQuotes']>;
  }
}

function slipFromQuotes(siteId: 'x10' | 'bcgame'): SlipState | null {
  return readSlipForSite(siteId);
}

function emitSlip(siteId: 'x10' | 'bcgame'): void {
  const slip = slipFromQuotes(siteId);
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
    onScan: () => emitSlip(siteId),
  });

  const stop = engine.start();
  window.__arbScannerDiag = () => engine.logDiagnostic();
  window.__arbScannerQuotes = () => engine.getLastQuotes();

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
  });
}

main().catch((e) => log.catch('bootstrap', e));
