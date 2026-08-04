import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';
import { readBcSlipFromDoc, readX10SlipFromDoc } from '../../src/scanner/slip-reader';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, '../fixtures', name), 'utf8');

function withFixture(html: string) {
  const match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  document.body.innerHTML = match?.[1] ?? html;
  return document;
}

describe('slip-reader', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reads x10 slip fixture', () => {
    const doc = withFixture(fixture('x10-slip.html'));
    const slip = readX10SlipFromDoc(doc);
    expect(slip?.odds).toBeCloseTo(1.16, 2);
    expect(slip?.eventName).toContain('Alpha');
  });

  it('reads bc slip fixture', () => {
    const doc = withFixture(fixture('bc-slip.html'));
    const slip = readBcSlipFromDoc(doc);
    expect(slip?.odds).toBe(2);
    expect(slip?.eventName).toContain('Alpha');
  });
});
