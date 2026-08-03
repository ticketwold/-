import { isBetslipIframeSrc, isInPlayShellHref, isJunkFrameHref } from '../site-detector';
import type { BetSlipNode, OddsResult, ScanContext } from '../types';
import {
  BaseScanner,
  pickBestSlipCard,
  readAtOddsFromRoot,
} from './base-adapter';
import {
  findSlipCardCandidates,
  findStakeInputs,
  findX10SlipCards,
  readOddsFromElement,
  readSelectionFromX10Card,
} from '../selector-engine';

export class X10Scanner extends BaseScanner {
  readonly siteId = 'x10' as const;

  classifyFrame(href: string, doc: Document): string {
    if (isJunkFrameHref(href)) return 'junk';
    if (/\/api\/sportscenter\/betslip/i.test(href)) return 'sportscenter-betslip';
    if (/widgets-x/i.test(href)) return 'widgets-x';
    if (isInPlayShellHref(href)) return 'shell-top';
    if (isBetslipIframeSrc(href)) return 'betslip-iframe';
    const hasStake = findStakeInputs(doc).length > 0;
    const hasCards = findX10SlipCards(doc).length > 0;
    if (hasStake || hasCards) return 'sportscenter-betslip';
    return 'unknown';
  }

  canScan(ctx: ScanContext): boolean {
    const label = ctx.frameLabel;
    if (label === 'junk') return false;
    if (label === 'shell-top') return false;
    if (label === 'sportscenter-betslip' || label === 'widgets-x' || label === 'betslip-iframe') {
      return true;
    }
    return findStakeInputs(ctx.doc).length > 0 || findX10SlipCards(ctx.doc).length > 0;
  }

  findBetSlip(ctx: ScanContext): BetSlipNode | null {
    const root = ctx.doc.documentElement || ctx.doc.body;
    if (!root) return null;

    const stakeInputs = findStakeInputs(ctx.doc);
    const cards = findX10SlipCards(ctx.doc).length ? findX10SlipCards(ctx.doc) : findSlipCardCandidates(ctx.doc);

    if (stakeInputs.length) {
      const input = stakeInputs[0]!;
      const container =
        input.closest('aside, section, [data-testid*="betslip"], [data-testid*="bet-slip"], [class*="betslip"], [class*="Betslip"]') ||
        input.parentElement ||
        input;
      return this.buildSlipNode(ctx.doc, container, cards, cards.length ? 0.92 : 0.8);
    }

    const best = pickBestSlipCard(cards);
    if (best) return this.buildSlipNode(ctx.doc, best, cards, 0.75);

    const atOdds = readAtOddsFromRoot(slipRootFromDoc(ctx.doc));
    if (atOdds && atOdds > 1.01) {
      return this.buildSlipNode(ctx.doc, root as Element, [], 0.55);
    }

    return null;
  }

  findOdds(ctx: ScanContext, slip: BetSlipNode): OddsResult | null {
    const sourcePrefix =
      ctx.frameLabel === 'sportscenter-betslip'
        ? 'sportscenter'
        : ctx.frameLabel === 'widgets-x'
          ? 'widgets-x'
          : 'x10';

    for (let i = slip.cards.length - 1; i >= 0; i--) {
      const card = slip.cards[i];
      if (!card) continue;
      const raw = readOddsFromElement(card);
      if (!raw || raw <= 1.01) continue;
      return {
        odds: raw,
        selectionText: readSelectionFromX10Card(card),
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

function slipRootFromDoc(doc: Document): ParentNode {
  const input = findStakeInputs(doc)[0];
  if (input) {
    return (
      input.closest('[class*="betslip"], [class*="Betslip"], aside, section') ||
      input.parentElement ||
      doc.body ||
      doc.documentElement
    );
  }
  return doc.body || doc.documentElement;
}
