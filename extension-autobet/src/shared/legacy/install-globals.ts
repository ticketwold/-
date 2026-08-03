import * as calculator from '../utils/calculator';
import * as sites from '../config/sites';

type GlobalRecord = Record<string, unknown>;

function assignToGlobal(scope: GlobalRecord): void {
  for (const [key, value] of Object.entries(scope)) {
    if (key === 'default') continue;
    (globalThis as GlobalRecord)[key] = value;
  }
}

/** Legacy engine/content scripts expect calculator + sites on globalThis */
export function installLegacyGlobals(): void {
  assignToGlobal(calculator as GlobalRecord);
  assignToGlobal(sites as GlobalRecord);
}

export { calculator, sites };
