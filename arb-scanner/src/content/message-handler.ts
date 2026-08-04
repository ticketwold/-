import type { BgToContentMessage } from '@core/types';
import { createLogger } from '@core/logger';
import {
  findBcStakeInput,
  findX10StakeInput,
  placeBcBet,
  placeX10Bet,
  readSlipForSite,
  setBcStake,
  setX10Stake,
} from './actions';
import { detectSiteId } from '@scanner/adapters';

const log = createLogger('actions');

export function installActionHandler(onProbe?: () => void): void {
  chrome.runtime.onMessage.addListener((msg: BgToContentMessage | { type: 'PROBE' }, _sender, sendResponse) => {
    if (msg.type === 'PROBE') {
      onProbe?.();
      const siteId = detectSiteId(location.href);
      sendResponse({ ok: !!siteId, slip: siteId ? readSlipForSite(siteId) : null });
      return false;
    }

    const siteId = detectSiteId(location.href);
    if (!siteId) return false;

    try {
      if (msg.type === 'SET_X10_STAKE' && siteId === 'x10') {
        if (!findX10StakeInput()) return false;
        sendResponse(setX10Stake(msg.amountKrw));
        return false;
      }
      if (msg.type === 'SET_BC_STAKE' && siteId === 'bcgame') {
        if (!findBcStakeInput()) return false;
        sendResponse(setBcStake(msg.amountUsdt));
        return false;
      }
      if (msg.type === 'PLACE_X10_BET' && siteId === 'x10') {
        if (!findX10StakeInput()) return false;
        placeX10Bet(msg.amountKrw).then(sendResponse);
        return true;
      }
      if (msg.type === 'PLACE_BC_BET' && siteId === 'bcgame') {
        if (!findBcStakeInput()) return false;
        placeBcBet(msg.amountUsdt).then(sendResponse);
        return true;
      }
      if (msg.type === 'READ_SLIP') {
        sendResponse({ slip: readSlipForSite(siteId) });
        return false;
      }
    } catch (e) {
      log.catch('handler', e);
      sendResponse({ ok: false, reason: String(e) });
    }
    return false;
  });
}
