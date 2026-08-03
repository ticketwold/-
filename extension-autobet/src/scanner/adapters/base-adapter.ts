import type { BetSlipNode, OddsResult, ScanContext, SiteAdapter } from '../types';
import {
  findBetSlipContainer,
  findStakeInputs,
  normText,
  parseDecimalOdds,
  parseMoney,
  readLabelAdjacentNumber,
  readOddsFromElement,
  readSelectionFromGeneric,
  readSelectionFromX10Card,
} from '../selector-engine';

export abstract class BaseScanner implements SiteAdapter {
  abstract readonly siteId: ScanContext['siteId'];

  abstract canScan(ctx: ScanContext): boolean;
  abstract findBetSlip(ctx: ScanContext): BetSlipNode | null;
  abstract findOdds(ctx: ScanContext, slip: BetSlipNode): OddsResult | null;

  findStake(_ctx: ScanContext, slip: BetSlipNode): number | null {
    const input = slip.stakeInput;
    if (!input) return null;
    const v = parseMoney(input.value || '');
    return v && v > 0 ? v : null;
  }

  findPayout(_ctx: ScanContext, slip: BetSlipNode): number | null {
    return (
      readLabelAdjacentNumber(slip.root, [
        'payout',
        'potential win',
        'total return',
        '당첨',
        '예상',
        '수익',
      ]) ?? null
    );
  }

  observerAnchor(ctx: ScanContext, slip: BetSlipNode | null): ParentNode {
    if (slip?.root) return slip.root;
    return ctx.doc.body || ctx.doc.documentElement;
  }

  protected buildSlipNode(root: ParentNode, anchor: Element, cards: Element[], confidence: number): BetSlipNode {
    const stakeInputs = findStakeInputs(root);
    const stakeInSlip = findStakeInputs(anchor)[0] ?? stakeInputs[0] ?? null;
    const container = findBetSlipContainer(root, anchor);
    return {
      root: container,
      cards: cards.length ? cards : [anchor],
      stakeInput: stakeInSlip,
      confidence,
    };
  }
}

export function pickBestSlipCard(cards: Element[]): Element | null {
  if (!cards.length) return null;
  for (let i = cards.length - 1; i >= 0; i--) {
    const card = cards[i];
    if (!card) continue;
    const odds = readOddsFromElement(card);
    if (odds && odds > 1.01) return card;
  }
  return cards[cards.length - 1] ?? null;
}

export function readSelectionFromCard(card: Element): string {
  return readSelectionFromX10Card(card) || readSelectionFromGeneric(card);
}

export function readAtOddsFromRoot(root: ParentNode): number | null {
  const text = normText(root.textContent || '');
  return parseDecimalOdds(text);
}
