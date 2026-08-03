/**
 * Browser E2E harness — loads scanner in real Chrome on fixture pages
 */
import { ScannerEngine } from '../../src/scanner/scanner-engine';

export type HarnessHandle = {
  read: () => ReturnType<ScannerEngine['readOdds']>;
  emissions: () => unknown[];
  stop: () => void;
};

export function bootScanner(siteId: 'x10' | 'bcgame', href: string): HarnessHandle {
  const emissions: unknown[] = [];
  Object.defineProperty(window, 'location', { value: { href }, writable: true, configurable: true });
  const engine = new ScannerEngine({
    siteId,
    bootstrapSource: siteId === 'x10' ? 'bti' : 'bcgame',
    onOddsChange: (slip) => {
      if (slip) emissions.push({ ...slip, at: Date.now() });
    },
  });
  const stop = engine.start();
  return {
    read: () => engine.readOdds(),
    emissions: () => [...emissions],
    stop,
  };
}

if (typeof window !== 'undefined') {
  (window as unknown as { __scannerHarness: typeof bootScanner }).__scannerHarness = bootScanner;
}
