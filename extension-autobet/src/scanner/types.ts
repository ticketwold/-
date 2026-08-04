/** 지원 사이트 식별자 */
export type SiteId = 'x10' | 'bcgame' | 'unknown';

export type ScanVia = 'top' | 'iframe' | 'shadow';

/** 단일 document(또는 shadow root) 탐색 컨텍스트 */
export interface ScanContext {
  doc: Document;
  href: string;
  depth: number;
  siteId: SiteId;
  frameLabel: string;
  via: ScanVia;
}

/** Bet Slip UI 앵커 */
export interface BetSlipNode {
  root: Element;
  cards: Element[];
  stakeInput: HTMLInputElement | null;
  confidence: number;
}

export interface OddsResult {
  odds: number;
  selectionText: string;
  eventText?: string;
  source: string;
  fromSlip: boolean;
}

export interface ScanProbeResult {
  siteId: SiteId;
  frameLabel: string;
  href: string;
  hasBetSlip: boolean;
  slipCardCount: number;
  odds: number;
  selectionText: string;
  stake: number | null;
  payout: number | null;
  shadowHostCount: number;
  iframeCount: number;
  confidence: number;
  winnerCoefCount?: number;
  sessionCount?: number;
  zeroReasons?: string[];
}

export type OddsPayload = OddsResult & {
  stake?: number | null;
  payout?: number | null;
  sourceKind?: string;
  via?: ScanVia | 'native-frame' | 'iframe-child';
  frameLabel?: string;
};

export type OddsChangeCallback = (
  slip: OddsPayload | null,
  cartChange?: boolean
) => void;

export interface ScannerBootstrapOptions {
  source: 'bti' | 'bcgame' | 'stake';
  onOddsChange: OddsChangeCallback;
  siteId?: SiteId;
}

export interface SiteAdapter {
  readonly siteId: SiteId;
  canScan(ctx: ScanContext): boolean;
  findBetSlip(ctx: ScanContext): BetSlipNode | null;
  findOdds(ctx: ScanContext, slip: BetSlipNode): OddsResult | null;
  findStake(ctx: ScanContext, slip: BetSlipNode): number | null;
  findPayout(ctx: ScanContext, slip: BetSlipNode): number | null;
  observerAnchor(ctx: ScanContext, slip: BetSlipNode | null): ParentNode;
  classifyFrame?(href: string, doc: Document): string;
}
