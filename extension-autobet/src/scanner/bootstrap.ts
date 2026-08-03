import { ScannerEngine } from './scanner-engine';
import type { ScannerBootstrapOptions } from './types';

export type ScannerHandle = {
  probe: () => ReturnType<ScannerEngine['probe']>;
  readOdds: () => ReturnType<ScannerEngine['readOdds']>;
  stop: () => void;
};

/**
 * Content script 진입점 — 단일 Scanner 인스턴스 부트스트랩
 */
export function startScanner(opts: ScannerBootstrapOptions): ScannerHandle {
  const siteId =
    opts.siteId ??
    (opts.source === 'bti' ? 'x10' : opts.source === 'bcgame' ? 'bcgame' : undefined);

  const engine = new ScannerEngine({
    siteId,
    bootstrapSource: opts.source,
    onOddsChange: opts.onOddsChange,
  });

  const stop = engine.start();

  return {
    probe: () => engine.probe(),
    readOdds: () => engine.readOdds(),
    stop,
  };
}

export { ScannerEngine } from './scanner-engine';
export type * from './types';
