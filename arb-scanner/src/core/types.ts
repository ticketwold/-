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

/** 스캔 컨텍스트 */
export interface ScanContext {
  doc: Document;
  href: string;
  siteId: SiteId;
  frameLabel: string;
  frameDepth: number;
  isTop: boolean;
}

/** 양방 기회 */
export interface ArbitrageOpportunity {
  matchKey: string;
  eventName: string;
  legX10: OddsQuote;
  legBc: OddsQuote;
  profitPercent: number;
  viable: boolean;
  detectedAt: number;
}

/** 사용자 설정 */
export interface UserSettings {
  minProfitPercent: number;
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  diagnosticMode: boolean;
  debounceMs: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  minProfitPercent: 1.0,
  notificationsEnabled: true,
  soundEnabled: true,
  diagnosticMode: false,
  debounceMs: 300,
};

/** content → background 메시지 */
export type ContentMessage =
  | { type: 'ODDS_BATCH'; siteId: SiteId; quotes: OddsQuote[]; frameUrl: string }
  | { type: 'DIAGNOSTIC'; payload: DiagnosticReport }
  | { type: 'PING' };

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
