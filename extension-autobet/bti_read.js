// BTI iframe — 슬립 카트 우선, 카드에 배당 없을 때만 선택된 보드 버튼
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
          if (!el || el.nodeType !== 1) return false;
          let node = el;
          for (let depth = 0; depth < 4 && node; depth++) {
            try {
              const cs = window.getComputedStyle(node);
              if ((cs.textDecorationLine || '').includes('line-through')) return true;
            } catch (_) {}
            const cn = String(node.className || '');
            if (/\b(old|previous|strike|strikethrough|deprecated|crossed)\b/i.test(cn)) return true;
            node = node.parentElement;
          }
          return false;
        }
        function collectLeafOdds(el, out) {
          if (!el || el.nodeType !== 1 || isStruck(el)) return;
          for (const node of el.childNodes) {
            if (node.nodeType !== 3) continue;
            const o = parseOdds(node.textContent);
            if (o) out.push(o);
          }
          if (!el.children.length) {
            const o = parseOdds(el.textContent);
            if (o) out.push(o);
            return;
          }
          for (const ch of el.children) collectLeafOdds(ch, out);
        }
        function readSlipCardOdds(card) {
          const notifOdds = [];
          for (const notif of card.querySelectorAll('[class*="UpdateNotification"]')) {
            collectLeafOdds(notif, notifOdds);
          }
          if (notifOdds.length) return notifOdds[notifOdds.length - 1];
          const classOdds = [];
          for (const sp of card.querySelectorAll('[class*="odds"], [class*="Odds"]')) {
            collectLeafOdds(sp, classOdds);
          }
          if (classOdds.length) return classOdds[classOdds.length - 1];
          const txt = (card.textContent || '').trim();
          const atM = txt.match(/@\s*(\d+(?:\.\d{1,4})?)/);
          if (atM) return parseOdds(atM[1]);
          const nums = [];
          for (const sp of card.querySelectorAll('span, b, strong')) {
            if (isStruck(sp)) continue;
            const t = (sp.textContent || '').trim();
            if (!/^\d+(\.\d{1,4})?$/.test(t)) continue;
            const o = parseOdds(t);
            if (o) nums.push(o);
          }
          return nums.length ? nums[nums.length - 1] : null;
        }
        function readBoardOddsForSelection(selectionText) {
          const sel = String(selectionText || '').trim();
          if (!sel) return null;
          const btns = document.querySelectorAll('button[class*="master_fe_Selections_selection"]');
          for (const btn of btns) {
            if (!vis(btn)) continue;
            const cls = String(btn.className || '');
            const selected = /selected|active|pressed|highlight/i.test(cls)
              || btn.getAttribute('aria-pressed') === 'true';
            if (!selected) continue;
            const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
            if (!oddsEl) continue;
            const o = parseOdds(oddsEl.textContent);
            if (!o) continue;
            const btnText = (btn.textContent || '').replace(/\s+/g, '');
            const selClean = sel.replace(/\s+/g, '');
            if (btnText.includes(selClean) || selClean.includes(btnText.replace(/[\d.]+$/, ''))) return o;
          }
          for (const btn of btns) {
            if (!vis(btn)) continue;
            const oddsEl = btn.querySelector('[class*="master_fe_Selections_odds"]');
            if (!oddsEl) continue;
            const o = parseOdds(oddsEl.textContent);
            if (!o) continue;
            const btnText = (btn.textContent || '').replace(/\s+/g, '');
            const selClean = sel.replace(/\s+/g, '');
            if (btnText.includes(selClean)) return o;
          }
          return null;
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
            if (!/W[12]|betInformation|우승|winner|맵|map|vs|대|오버|언더|over|under|핸디|handicap|@\s*\d+\.\d/i.test(txt)) continue;
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

        let odds = readSlipCardOdds(card);
        let source = 'slip-card';
        if (!odds) {
          odds = readBoardOddsForSelection(selectionText);
          source = 'board-live';
        }
        if (!odds) return null;
        return { odds, selectionText, eventText, source, fromSlip: source === 'slip-card', hasInput };
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
