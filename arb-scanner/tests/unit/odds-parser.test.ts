import { describe, expect, it } from 'vitest';
import { parseOddsText } from '../../src/scanner/odds-parser';

describe('odds-parser', () => {
  it('parses decimal odds', () => {
    expect(parseOddsText('2.00')).toBe(2);
    expect(parseOddsText('@ 1.85')).toBe(1.85);
  });

  it('rejects suspended', () => {
    expect(parseOddsText('정지된')).toBeNull();
    expect(parseOddsText('Suspended')).toBeNull();
  });

  it('rejects out of range', () => {
    expect(parseOddsText('1.00')).toBeNull();
    expect(parseOddsText('150')).toBeNull();
  });
});
