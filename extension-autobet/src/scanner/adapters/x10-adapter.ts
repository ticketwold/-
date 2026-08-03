import { isBetslipIframeSrc, isInPlayShellHref, isJunkFrameHref } from '../site-detector';
import type { BetSlipNode, OddsResult, ScanContext } from '../types';
import {
  BaseScanner,
  pickBestSlipCard,
  readAtOddsFromRoot,
  readSelectionFromCard,
} from './base-adapter';
import { findSlipCardCandidates, findStakeInputs, readOddsFromElement } from '../selector-engine';

export class X10Scanner extends BaseScanner {
  readonly siteId = 'x10' as const;

  classifyFrame(href: string, doc: Document): string {
    if (isJunkFrameHref(href)) return 'junk';
    if (/\/api\/sportscenter\/betslip/i.test(href)) return 'sportscenter-betslip';
    if (/widgets-x/i.test(href)) return 'widgets-x';
    if (isInPlayShellHref(href)) return 'shell-top';
    if (isBetslipIframeSrc(href)) return 'betslip-iframe';
    const hasStake = findStakeInputs(doc).length > 0;
    const hasCards = findSlipCardCandidates(doc).length > 0;
    if (hasStake && hasCards) return 'sportscenter-betslip';
    if (hasStake) return 'sportscenter-betslip';
    return 'unknown';
  }

  canScan(ctx: ScanContext): boolean {
    const label = ctx.frameLabel;
    if (label === 'junk' || label === 'shell-top') return false;
    if (label === 'sportscenter-betslip' || label === 'widgets-x' || label === 'betslip-iframe') {
      return true;
    }
    const stake = findStakeInputs(ctx.doc);
    const cards = findSlipCardCandidates(ctx.doc);
    return stake.length > 0 || cards.length > 0;
  }

  findBetSlip(ctx: ScanContext): BetSlipNode | null {
    const root = ctx.doc.documentElement || ctx.doc.body;
    if (!root) return null;

    const stakeInputs = findStakeInputs(ctx.doc);
    const cards = findSlipCardCandidates(ctx.doc);

    if (stakeInputs.length) {
      const input = stakeInputs[0]!;
      const container = input.closest('aside, section, [data-testid*="betslip"], [data-testid*="bet-slip"]') || input.parentElement || input;
      const confidence = cards.length ? 0.9 : 0.75;
      return this.buildSlipNode(ctx.doc, container, cards, confidence);
    }

    const best = pickBestSlipCard(cards);
    if (best) {
      return this.buildSlipNode(ctx.doc, best, cards, 0.7);
    }

    const atOdds = readAtOddsFromRoot(root);
    if (atOdds && atOdds > 1.01) {
      return this.buildSlipNode(ctx.doc, root as Element, [], 0.5);
    }

    return null;
  }

  findOdds(ctx: ScanContext, slip: BetSlipNode): OddsResult | null {
    const frame = ctx.frameLabel;
    const sourcePrefix =
      frame === 'sportscenter-betslip' ? 'sportscenter' : frame === 'widgets-x' ? 'widgets-x' : 'x10';

    for (let i = slip.cards.length - 1; i >= 0; i--) {
      const card = slip.cards[i];
      if (!card) continue;
      const raw = readOddsFromElement(card);
      if (!raw || raw <= 1.01) continue;
      return {
        odds: raw,
        selectionText: readSelectionFromCard(card),
        source: `${sourcePrefix}-slip-card`,
        fromSlip: true,
      };
    }

    const at = readAtOddsFromRoot(slip.root);
    if (at && at > 1.01) {
      return {
        odds: at,
        selectionText: '',
        source: `${sourcePrefix}-at`,
        fromSlip: true,
      };
    }

    return null;
  }
}
