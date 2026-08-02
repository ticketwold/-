// BTI iframe — 배팅 카트 배당만 읽기 (보드/배당판 사용 안 함)
'use strict';

async function injectReadBtiFrame(tabId, frameId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        function vis(el) {
          const r = el?.getBoundingClientRect?.();
          return !!(r && r.width > 2 && r.height > 2);
        }
        function parseOdds(t) {
          const n = parseFloat(String(t || '').trim());
          if (!n || n <= 1.01 || n >= 100) return null;
          return n;
        }
        function isStruck(el) {
          if (!el) return false;
          try {
            const cs = window.getComputedStyle(el);
            if ((cs.textDecorationLine || '').includes('line-through')) return true;
          } catch (_) {}
          return false;
        }

        let hasInput = false;
        for (const inp of document.querySelectorAll('input, textarea')) {
          if (!vis(inp)) continue;
          const blob = `${inp.id || ''} ${inp.className || ''} ${inp.placeholder || ''}`;
          if (/counter|Counter|베팅/i.test(blob)) { hasInput = true; break; }
        }

        const cards = [];
        for (const root of document.querySelectorAll('[class*="betslip"], [class*="Betslip"]')) {
          for (const card of root.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"], [class*="BetSecondary_bet"], [class*="betInformation"]')) {
            if (!vis(card)) continue;
            const txt = (card.textContent || '').trim();
            if (txt.length < 6 || txt.length > 900) continue;
            if (card.querySelector('input[id="counter"], input[class*="Counter"]')) continue;
            if (!/W[12]|betInformation|우승|winner|맵|map|vs|대|@\s*\d+\.\d/i.test(txt)) continue;
            cards.push(card);
          }
        }

        if (!cards.length) return null;
        const card = cards[cards.length - 1];
        const txt = (card.textContent || '').trim();
        const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
        const selectionText = titleEls[0]?.textContent?.trim() || (/\bW1\b/i.test(txt) ? 'W1' : /\bW2\b/i.test(txt) ? 'W2' : '');
        const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
        const eventText = eventEl?.textContent?.trim() || '';

        for (const sp of card.querySelectorAll('[class*="UpdateNotification"]')) {
          if (isStruck(sp)) continue;
          const o = parseOdds(sp.textContent);
          if (o) return { odds: o, selectionText, eventText, source: 'slip-display', fromSlip: true, hasInput };
        }
        for (const sp of card.querySelectorAll('[class*="odds"], [class*="Odds"]')) {
          if (isStruck(sp)) continue;
          const o = parseOdds(sp.textContent);
          if (o) return { odds: o, selectionText, eventText, source: 'slip-display', fromSlip: true, hasInput };
        }
        const atM = txt.match(/@\s*(\d+(?:\.\d{1,4})?)/);
        if (atM) {
          const o = parseOdds(atM[1]);
          if (o) return { odds: o, selectionText, eventText, source: 'slip-card', fromSlip: true, hasInput };
        }
        return null;
      }
    });
    const hit = results?.[0]?.result;
    if (!(hit?.odds > 1.01)) return null;
    let homeTeam = '';
    let awayTeam = '';
    if (hit.eventText) {
      for (const sep of [' vs ', ' VS ', ' 대 ']) {
        if (hit.eventText.includes(sep)) {
          [homeTeam, awayTeam] = hit.eventText.split(sep, 2).map((s) => s.trim());
          break;
        }
      }
    }
    let teamLabel = hit.selectionText || '';
    if (/^W1$/i.test(teamLabel)) teamLabel = homeTeam || teamLabel;
    if (/^W2$/i.test(teamLabel)) teamLabel = awayTeam || teamLabel;
    return { ...hit, teamLabel, homeTeam, awayTeam };
  } catch (_) {
    return null;
  }
}
