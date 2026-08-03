import { ScannerEngine } from '../../src/scanner/scanner-engine';

export function bootScanner(siteId: 'x10' | 'bcgame', href: string) {
  const emissions: unknown[] = [];
  const engine = new ScannerEngine({
    siteId,
    bootstrapSource: siteId === 'x10' ? 'bti' : 'bcgame',
    rootHref: href,
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

const site =
  location.pathname.includes('bc') || document.querySelector('.bet__winner-coef')
    ? 'bcgame'
    : 'x10';
const href =
  site === 'x10'
    ? 'https://www.x10x10s.com/api/sportscenter/betslip'
    : 'https://bc.game/sports';

(window as unknown as { __h: ReturnType<typeof bootScanner> }).__h = bootScanner(
  site as 'x10' | 'bcgame',
  href
);
