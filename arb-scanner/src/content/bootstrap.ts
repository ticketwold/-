import { detectSiteId } from '@scanner/adapters';
import { ScannerEngine } from '@scanner/engine';
import { createLogger } from '@core/logger';
import type { ContentMessage } from '@core/types';
import { getSetting } from '@core/storage';

const log = createLogger('content');

declare global {
  interface Window {
    __arbScannerDiag?: () => ReturnType<ScannerEngine['runDiagnostic']>;
    __arbScannerQuotes?: () => ReturnType<ScannerEngine['getLastQuotes']>;
  }
}

async function main(): Promise<void> {
  const siteId = detectSiteId(location.href);
  if (!siteId) {
    log.debug('unsupported frame', location.href);
    return;
  }

  const debounceMs = await getSetting('debounceMs');
  const diagnostic = await getSetting('diagnosticMode');

  const engine = new ScannerEngine({
    siteId,
    debounceMs,
    diagnostic,
    onScan: (result) => {
      if (!result.quotes.length) return;
      const msg: ContentMessage = {
        type: 'ODDS_BATCH',
        siteId,
        quotes: result.quotes,
        frameUrl: result.ctx.href,
      };
      try {
        chrome.runtime.sendMessage(msg);
      } catch (e) {
        log.catch('sendMessage', e);
      }
    },
  });

  const stop = engine.start();
  window.__arbScannerDiag = () => engine.logDiagnostic();
  window.__arbScannerQuotes = () => engine.getLastQuotes();

  log.info(`boot ${siteId} ${window === window.top ? 'top' : 'iframe'} ${location.href.slice(0, 90)}`);

  const runDiag = () => engine.logDiagnostic();
  runDiag();
  setTimeout(runDiag, 3000);

  window.addEventListener('unload', stop);
}

main().catch((e) => log.catch('bootstrap', e));
