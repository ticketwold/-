import { describe, expect, it, vi } from 'vitest';

/**
 * BC content.ts wrapper pattern — scanner must not replace legacy permanently
 */
describe('Scanner + Legacy coexistence', () => {
  it('wrapper prefers scanner when valid, falls back to legacy', () => {
    const legacyResult = { ok: true, odds: 1.5, method: 'legacy-slip-root' };
    const legacyFn = vi.fn(() => legacyResult);

    const scannerRead = vi.fn(() => ({ odds: 2.0, selectionText: 'W1', source: 'bc-winner-coef', fromSlip: true }));

    const wrapped = () => {
      const scanned = scannerRead();
      if (scanned?.odds && scanned.odds > 1.01) {
        return { ok: true, ...scanned, method: 'dom-scanner' };
      }
      return legacyFn();
    };

    expect(wrapped()).toMatchObject({ odds: 2, method: 'dom-scanner' });
    expect(legacyFn).not.toHaveBeenCalled();

    scannerRead.mockReturnValueOnce(null);
    expect(wrapped()).toBe(legacyResult);
    expect(legacyFn).toHaveBeenCalledOnce();
  });

  it('BTI __btiReadSlipOdds is scanner-only hook (legacy calls it first)', () => {
    const scannerOdds = { odds: 1.16, selectionText: 'W1', source: 'sportscenter-slip', fromSlip: true };
    (globalThis as { __btiReadSlipOdds?: () => typeof scannerOdds }).__btiReadSlipOdds = () => scannerOdds;

    const legacyPath = () => {
      const probed = (globalThis as { __btiReadSlipOdds?: () => typeof scannerOdds }).__btiReadSlipOdds?.();
      if (probed?.odds > 1.01) return probed;
      return { odds: 11.5, fromSlip: false }; // board fallback
    };

    const result = legacyPath();
    expect(result.odds).toBeCloseTo(1.16, 2);
    expect(result.fromSlip).toBe(true);
  });
});
