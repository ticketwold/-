import type { BetSlipNode, OddsResult, ScanContext } from '../types';
import { BaseScanner, pickBestSlipCard } from './base-adapter';
import {
  findBcWinnerCoefElements,
  findBetButtons,
  findSlipCardCandidates,
  findStakeInputs,
  normText,
  parseDecimalOdds,
  readLabelAdjacentNumber,
  readOddsFromElement,
  readSelectionFromGeneric,
  textIncludesAny,
} from '../selector-engine';
import { walkElements } from '../dom-tree';
import { BC_SLIP_ROOT } from '../stable-selectors';
import { isSuspendedOddsElement } from '../odds-parser';

export class BCGameScanner extends BaseScanner {
  readonly siteId = 'bcgame' as const;

  classifyFrame(href: string): string {
    if (!href || href === 'about:blank') return 'junk';
    if (/betby|sptpub|sptsportscdn|biahosted|cocoesports/i.test(href)) return 'betby-widget';
    if (/bc\.game/i.test(href)) return 'bc-top';
    return 'unknown';
  }

  canScan(ctx: ScanContext): boolean {
    if (ctx.frameLabel === 'junk') return false;
    return !!this.findBetSlip(ctx);
  }

  findBetSlip(ctx: ScanContext): BetSlipNode | null {
    const root = ctx.doc.documentElement || ctx.doc.body;
    if (!root) return null;

    const coefEls = findBcWinnerCoefElements(root);
    if (coefEls.length) {
      const anchor = coefEls[coefEls.length - 1]!;
      const container = anchor.closest(BC_SLIP_ROOT) || anchor.parentElement || anchor;
      return this.buildSlipNode(ctx.doc, container, [anchor], 0.95);
    }

    let bestAnchor: Element | null = null;
    let bestScore = 0;

    walkElements(root, (el) => {
      const testId = (el.getAttribute('data-testid') || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const cls = String(el.className || '');
      const text = normText(el.textContent || '');

      let score = 0;
      if (testId.includes('bet-slip') || testId.includes('betslip')) score += 3;
      if (aria.includes('bet slip') || aria.includes('betslip')) score += 3;
      if (cls.includes('betslip') || cls.includes('bet-slip')) score += 3;
      if (textIncludesAny(text, ['total odds', 'combined odds', 'bet slip', '베팅 슬립'])) score += 2;
      if (findStakeInputs(el).length) score += 2;
      if (findBetButtons(el).length) score += 1;

      const r = el.getBoundingClientRect?.();
      if (r && r.width > 80 && r.height > 120) score += 1;

      if (score > bestScore) {
        bestScore = score;
        bestAnchor = el;
      }
    });

    const cards = findSlipCardCandidates(root);
    if (bestAnchor && bestScore >= 2) {
      return this.buildSlipNode(ctx.doc, bestAnchor, cards, Math.min(1, bestScore / 6));
    }

    const card = pickBestSlipCard(cards);
    if (card) return this.buildSlipNode(ctx.doc, card, cards, 0.65);

    const stake = findStakeInputs(root)[0];
    if (stake?.parentElement) {
      return this.buildSlipNode(ctx.doc, stake.parentElement, cards, 0.5);
    }

    return null;
  }

  findOdds(ctx: ScanContext, slip: BetSlipNode): OddsResult | null {
    const coefHit = this.readWinnerCoefOdds(ctx);
    if (coefHit) return coefHit;

    const labeled = this.readLabeledOdds(slip.root);
    if (labeled) {
      return {
        odds: labeled,
        selectionText: readSelectionFromGeneric(slip.cards[slip.cards.length - 1] || slip.root),
        source: 'bc-labeled-odds',
        fromSlip: true,
      };
    }

    for (let i = slip.cards.length - 1; i >= 0; i--) {
      const card = slip.cards[i];
      if (!card || isSuspendedOddsElement(card)) continue;
      const raw = readOddsFromElement(card);
      if (!raw || raw <= 1.01) continue;
      return {
        odds: raw,
        selectionText: readSelectionFromGeneric(card),
        source: 'bc-slip-card',
        fromSlip: true,
      };
    }

    const stake = this.findStake(ctx, slip);
    const payout = this.findPayout(ctx, slip);
    if (stake && payout && stake > 0 && payout > stake) {
      const implied = Math.round((payout / stake) * 1000) / 1000;
      if (implied > 1.01 && implied < 50) {
        return {
          odds: implied,
          selectionText: readSelectionFromGeneric(slip.cards[slip.cards.length - 1] || slip.root),
          source: 'bc-payout-ratio',
          fromSlip: true,
        };
      }
    }

    return null;
  }

  private readWinnerCoefOdds(ctx: ScanContext): OddsResult | null {
    const els = findBcWinnerCoefElements(ctx.doc.documentElement || ctx.doc.body);
    const el = els[els.length - 1];
    if (!el) return null;
    const raw = (el.textContent || '').trim();
    const odds = parseDecimalOdds(raw, 'bet__winner-coef');
    if (!odds) return null;
    return {
      odds,
      selectionText: readSelectionFromGeneric(el.closest('[class*="bet"], [class*="coupon"], aside') || el),
      source: 'bc-winner-coef',
      fromSlip: true,
    };
  }

  findStake(ctx: ScanContext, slip: BetSlipNode): number | null {
    const fromInput = super.findStake(ctx, slip);
    if (fromInput) return fromInput;
    return readLabelAdjacentNumber(slip.root, ['stake', 'wager', 'bet amount', '베팅', '금액', '총 베팅']);
  }

  findPayout(ctx: ScanContext, slip: BetSlipNode): number | null {
    const fromLabel = super.findPayout(ctx, slip);
    if (fromLabel) return fromLabel;
    return readLabelAdjacentNumber(slip.root, ['to win', 'potential', 'payout', 'returns', '당첨금', '예상 당첨']);
  }

  private readLabeledOdds(root: ParentNode): number | null {
    let found: number | null = null;
    walkElements(root, (el) => {
      if (found != null || isSuspendedOddsElement(el)) return;
      const text = normText(el.textContent || '');
      if (text.length > 80) return;
      if (!textIncludesAny(text, ['total odds', 'combined odds', 'odds', '@', 'coefficient'])) return;

      const patterns = [
        /total\s*odds?\s*[:@=]?\s*(\d+\.\d{2,3})/i,
        /combined\s*odds?\s*[:@=]?\s*(\d+\.\d{2,3})/i,
        /@\s*(\d+\.\d{2,3})/,
        /coefficient\s*[:@=]?\s*(\d+\.\d{2,3})/i,
      ];

      for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]) {
          const n = parseDecimalOdds(m[1], 'labeled');
          if (n) {
            found = n;
            return;
          }
        }
      }
    });
    return found;
  }
}
