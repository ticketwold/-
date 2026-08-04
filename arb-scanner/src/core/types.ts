/** 지원 사이트 */
export type SiteId = 'x10' | 'bcgame';

/** 배당 출처 */
export type OddsSource = 'slip' | 'board';

/** 공통 배당 인용 */
export interface OddsQuote {
  id: string;
  siteId: SiteId;
  eventName: string;
  league?: string;
  startTime?: string;
  selection: string;
  odds: number;
  source: OddsSource;
  frameUrl: string;
  frameDepth: number;
  inShadowDom: boolean;
  confidence: number;
  timestamp: number;
}

export interface ScanContext {
  doc: Document;
  href: string;
  siteId: SiteId;
  frameLabel: string;
  frameDepth: number;
  isTop: boolean;
}

export interface ArbitrageOpportunity {
  matchKey: string;
  eventName: string;
  legX10: OddsQuote;
  legBc: OddsQuote;
  profitPercent: number;
  viable: boolean;
  detectedAt: number;
}

export interface UserSettings {
  minProfitPercent: number;
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  diagnosticMode: boolean;
  debounceMs: number;
  /** x10 베팅금 (KRW) */
  x10BetKrw: number;
  /** 수동 USDT/KRW (빗썸 실패 시) */
  manualUsdtKrw: number;
  /** 빗썸 자동 시세 */
  autoBithumbRate: boolean;
  /** 금액 동기화 */
  stakeSyncEnabled: boolean;
  /** 자동 베팅 */
  autoBetEnabled: boolean;
  /** 텔레그램 */
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  /** 디스코드 */
  discordEnabled: boolean;
  discordWebhookUrl: string;
  /** 탭 ID (0 = 자동 탐색) */
  x10TabId: number;
  bcTabId: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  minProfitPercent: 1.0,
  notificationsEnabled: true,
  soundEnabled: true,
  diagnosticMode: false,
  debounceMs: 300,
  x10BetKrw: 100_000,
  manualUsdtKrw: 1400,
  autoBithumbRate: true,
  stakeSyncEnabled: true,
  autoBetEnabled: false,
  telegramEnabled: false,
  telegramBotToken: '',
  telegramChatId: '',
  discordEnabled: false,
  discordWebhookUrl: '',
  x10TabId: 0,
  bcTabId: 0,
};

export type SlipState = {
  odds: number;
  selection: string;
  eventName: string;
  stake: number;
  source: OddsSource;
  updatedAt: number;
};

export type RuntimeState = {
  armed: boolean;
  x10Slip: SlipState | null;
  bcSlip: SlipState | null;
  profitPercent: number | null;
  leg2Usdt: number | null;
  usdtKrw: number;
  lastOpportunities: ArbitrageOpportunity[];
  lastStrikeAt: number;
  lastSyncAt: number;
};

export type ContentMessage =
  | { type: 'ODDS_BATCH'; siteId: SiteId; quotes: OddsQuote[]; frameUrl: string }
  | { type: 'SLIP_UPDATE'; siteId: SiteId; slip: SlipState }
  | { type: 'X10_STAKE_CHANGED'; stake: string | number }
  | { type: 'DIAGNOSTIC'; payload: DiagnosticReport }
  | { type: 'PING' };

export type PopupMessage =
  | { type: 'ARM'; armed: boolean }
  | { type: 'MANUAL_STRIKE' }
  | { type: 'SYNC_STAKE' };

export type BgToContentMessage =
  | { type: 'SET_X10_STAKE'; amountKrw: number }
  | { type: 'SET_BC_STAKE'; amountUsdt: number }
  | { type: 'PLACE_X10_BET'; amountKrw: number }
  | { type: 'PLACE_BC_BET'; amountUsdt: number }
  | { type: 'READ_SLIP' };

export type ActionResult = {
  ok: boolean;
  reason?: string;
  stake?: number;
  odds?: number;
  success?: boolean;
};

export type DiagnosticReport = {
  frameUrl: string;
  locationHref: string;
  isTopFrame: boolean;
  frameDepth: number;
  readyState: string;
  origin: string;
  siteId: SiteId;
  winnerCoefCount: number;
  sportscenterCount: number;
  shadowRootCount: number;
  mutationObserverConnected: boolean;
  iframeCount: number;
  quotesFound: number;
  selectors: string[];
  verdict: string[];
  timestamp: string;
};
