import { detectSiteId } from '@scanner/adapters';
import { ScannerEngine } from '@scanner/engine';
import { createLogger } from '@core/logger';
import type { OddsQuote, SlipState } from '@core/types';
import { getSetting } from '@core/storage';
import { installActionHandler } from './message-handler';
import { emitScan, emitSlipOnly, resolveSlip } from './probe';

const log = createLogger('content');

declare global {
  interface Window {
    __arbScannerBoot?: boolean;
    __arbScannerDiag?: () => ReturnType<ScannerEngine['runDiagnostic']>;
    __arbScannerQuotes?: () => ReturnType<ScannerEngine['getLastQuotes']>;
    __arbScannerSlip?: () => SlipState | null;
    __arbScannerProbe?: () => void;
  }
}

let engineRef: ScannerEngine | null = null;

function isJunkFrame(href = location.href): boolean {
  const h = String(href || '');
  return (
    !h ||
    h === 'about:blank' ||
    /recaptcha|google\.com\/recaptcha|hcaptcha|doubleclick|googlesyndication|player\.twitch|facebook\.com\/tr/i.test(
      h
    ) ||
    /livechatinc\.com|livechat\.com|liveplugins/i.test(h) ||
    /accounts-iframe|amazon-ivs|tracker\.html/i.test(h)
  );
}

function runProbe(): void {
  if (!engineRef) return;
  const siteId = detectSiteId(location.href);
  if (!siteId) return;
  const quotes = engineRef.getLastQuotes();
  emitScan(siteId, quotes, location.href);
  emitSlipOnly(siteId, quotes);
}

async function main(): Promise<void> {
  if (window.__arbScannerBoot) return;
  if (isJunkFrame()) return;

  const siteId = detectSiteId(location.href);
  if (!siteId) return;
  window.__arbScannerBoot = true;

  installActionHandler(() => runProbe());

  const debounceMs = await getSetting('debounceMs');
  const diagnostic = await getSetting('diagnosticMode');

  const engine = new ScannerEngine({
    siteId,
    debounceMs,
    diagnostic,
    onScan: ({ quotes }) => emitScan(siteId, quotes, location.href),
  });

  engineRef = engine;
  const stop = engine.start();
  window.__arbScannerDiag = () => engine.logDiagnostic();
  window.__arbScannerQuotes = () => engine.getLastQuotes();
  window.__arbScannerSlip = () => resolveSlip(siteId, engine.getLastQuotes());
  window.__arbScannerProbe = () => runProbe();

  runProbe();
  const slipPoll = setInterval(() => emitSlipOnly(siteId, engine.getLastQuotes()), 400);

  document.addEventListener(
    'input',
    (e) => {
      const t = e.target as HTMLElement;
      if (t?.matches?.('input#counter, input[placeholder*="베팅"], input[placeholder*="stake"]')) {
        runProbe();
        if (siteId === 'x10') {
          chrome.runtime.sendMessage({ type: 'X10_STAKE_CHANGED', stake: (t as HTMLInputElement).value });
        }
      }
    },
    true
  );

  try {
    document.documentElement.setAttribute('data-arb-scanner', '2.2.0');
  } catch {
    /* ignore */
  }

  log.info(`boot ${siteId} ${window === window.top ? 'top' : 'iframe'} ${location.href.slice(0, 80)}`);
  engine.logDiagnostic();

  window.addEventListener('unload', () => {
    clearInterval(slipPoll);
    stop();
    engineRef = null;
    window.__arbScannerBoot = false;
  });
}

main().catch((e) => log.catch('bootstrap', e));
