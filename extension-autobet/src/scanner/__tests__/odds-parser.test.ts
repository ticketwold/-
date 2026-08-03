import { describe, expect, it } from 'vitest';
import {
  isSuspendedOddsElement,
  isSuspendedOddsText,
  parseOddsString,
} from '../odds-parser';

describe('odds-parser — invalid values never become odds', () => {
  const invalid = ['정지된', '정지됨', 'Suspended', 'closed', '', '   ', 'abc', 'NaN'];

  for (const raw of invalid) {
    it(`rejects "${raw}"`, () => {
      expect(parseOddsString(raw)).toBeNull();
    });
  }

  it('accepts valid decimal', () => {
    expect(parseOddsString('2.00')).toBe(2);
    expect(parseOddsString('@ 1.16')).toBe(1.16);
  });

  it('detects suspended element by class', () => {
    const el = document.createElement('span');
    el.className = 'bet__winner-coef bet__winner-coefSuspended';
    el.textContent = '정지된';
    expect(isSuspendedOddsElement(el)).toBe(true);
    expect(parseOddsString(el.textContent!)).toBeNull();
  });
});
