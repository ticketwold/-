import { installLegacyGlobals } from '../shared/legacy/install-globals';

installLegacyGlobals();

import './bti-read.legacy';
import './poly-read.legacy';
import engineApi from './engine.legacy';

export default engineApi;

export const readSnapshot = (
  ...args: Parameters<typeof globalThis.readSnapshot>
) => globalThis.readSnapshot(...args);

export const findTabs = (...args: Parameters<typeof globalThis.findTabs>) =>
  globalThis.findTabs(...args);

export const strikeBothSides = (
  ...args: Parameters<typeof globalThis.strikeBothSides>
) => globalThis.strikeBothSides(...args);

export const withTimeout = (...args: Parameters<typeof globalThis.withTimeout>) =>
  globalThis.withTimeout(...args);

export const probeBtiFramesDiagnostic = (
  ...args: Parameters<typeof globalThis.probeBtiFramesDiagnostic>
) => globalThis.probeBtiFramesDiagnostic(...args);

export const verifyBtiConnection = (
  ...args: Parameters<typeof globalThis.verifyBtiConnection>
) => globalThis.verifyBtiConnection(...args);

export const diagnoseBtiExtension = (
  ...args: Parameters<typeof globalThis.diagnoseBtiExtension>
) => globalThis.diagnoseBtiExtension(...args);

export const openLeg1Tab = (...args: Parameters<typeof globalThis.openLeg1Tab>) =>
  globalThis.openLeg1Tab(...args);

export const openLeg2Tab = (...args: Parameters<typeof globalThis.openLeg2Tab>) =>
  globalThis.openLeg2Tab(...args);

export const installLeg1ScriptWatcher = () => globalThis.installLeg1ScriptWatcher?.();

export const injectAllOpenLeg1Tabs = () => globalThis.injectAllOpenLeg1Tabs?.();

export const installRecentWebTabTracker = () => globalThis.installRecentWebTabTracker?.();

declare global {
  function readSnapshot(
    leg2Pref: string,
    btiBetKrw: number,
    usdRate: number,
    opts?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  function findTabs(leg2Pref?: string): Promise<Record<string, unknown>>;
  function strikeBothSides(ctx: Record<string, unknown>): Promise<Record<string, unknown>>;
  function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string
  ): Promise<T>;
  function probeBtiFramesDiagnostic(btiTab: chrome.tabs.Tab): Promise<unknown[]>;
  function verifyBtiConnection(leg2Pref?: string): Promise<Record<string, unknown>>;
  function diagnoseBtiExtension(leg2Pref?: string): Promise<Record<string, unknown>>;
  function openLeg1Tab(useAlt?: boolean): Promise<Record<string, unknown>>;
  function openLeg2Tab(leg2Pref?: string): Promise<Record<string, unknown>>;
  function installLeg1ScriptWatcher(): void;
  function injectAllOpenLeg1Tabs(): Promise<void>;
  function installRecentWebTabTracker(): void;
  function isScanBcSlip(slip: unknown): boolean;
  function isTrustedBcSlip(slip: unknown): boolean;
  function readArbBotBridgeState(
    btiTab: chrome.tabs.Tab,
    polyTab: chrome.tabs.Tab
  ): Promise<Record<string, unknown> | null>;
  function verifyStrikeReady(
    found: Record<string, unknown>,
    hint?: Record<string, unknown>,
    poly?: Record<string, unknown> | null,
    opts?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  function checkBtiSlipUi(btiTab: chrome.tabs.Tab): Promise<Record<string, unknown>>;
  function searchBtiBoardFromFrames(
    btiTab: chrome.tabs.Tab,
    query?: string
  ): Promise<Record<string, unknown>>;
  function clearPolyOddsCache(tabId?: number): void;
}
