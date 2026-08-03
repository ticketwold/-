export type Leg2Pref = 'bcgame' | 'stake';

export interface AutoBetConfig {
  minProfit: number;
  leg2: Leg2Pref;
  leg2Synced: boolean;
  leg2SyncedSite: string;
  btiBetKrw: number;
  usdRate: number;
  cooldownMs: number;
  useArbBotBridge: boolean;
  preSyncAmount: boolean;
  armed?: boolean;
  btiSynced?: boolean;
}

export interface LogEntry {
  time: number;
  text: string;
  level: 'info' | 'ok' | 'err' | '';
}

export type RuntimeMessage =
  | { type: 'AUTOBET_ARM'; armed: boolean }
  | { type: 'AUTOBET_GET_STATE' }
  | { type: 'AUTOBET_SET_CONFIG'; config: Partial<AutoBetConfig> }
  | { type: 'AUTOBET_STRIKE_RESULT'; result: Record<string, unknown> }
  | { type: 'AUTOBET_ARMED'; armed: boolean }
  | { type: 'AUTOBET_LOG'; entry: LogEntry }
  | { type: 'VERIFY_BTI'; leg2?: Leg2Pref }
  | { type: 'DIAGNOSE_BTI'; leg2?: Leg2Pref }
  | { type: 'FIND_TABS'; leg2?: Leg2Pref }
  | { type: 'OPEN_LEG1_TAB'; useAlt?: boolean }
  | { type: 'OPEN_LEG2_TAB'; leg2?: Leg2Pref }
  | { type: 'OPEN_AUTOBET_PANEL' }
  | {
      type: 'READ_SNAPSHOT';
      leg2?: Leg2Pref;
      btiBetKrw?: number;
      usdRate?: number;
      opts?: Record<string, unknown>;
    }
  | {
      type: 'ODDS_CHANGED';
      source: string;
      slip?: Record<string, unknown> | null;
      suspended?: boolean;
      cartChange?: boolean;
    }
  | { type: 'BTI_STAKE_CHANGED'; stake: number };

export const STORAGE_KEYS = {
  config: 'autoBetConfig',
  log: 'autoBetLog',
  tabBind: 'autoBetTabBind',
} as const;

export const DEFAULT_CONFIG: AutoBetConfig = {
  minProfit: 1,
  leg2: 'bcgame',
  leg2Synced: false,
  leg2SyncedSite: '',
  btiBetKrw: 10000,
  usdRate: 1400,
  cooldownMs: 0,
  useArbBotBridge: true,
  preSyncAmount: true,
};
