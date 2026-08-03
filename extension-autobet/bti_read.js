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

        const isWidgetsX = /widgets-x/i.test(location.href)
          || /\/api\/sportscenter\/betslip/i.test(location.href)
          || !!document.querySelector('[class*="betslip-root"], [id*="betslip-root"]');

        let hasInput = false;
        let slipPanel = null;
        let slipInput = null;
        for (const inp of document.querySelectorAll('input, textarea')) {
          if (!vis(inp)) continue;
          const blob = `${inp.id || ''} ${inp.className || ''} ${inp.placeholder || ''}`;
          if (!/counter|Counter|베팅/i.test(blob)) continue;
          hasInput = true;
          slipInput = inp;
          slipPanel = inp.closest('[class*="betslip_fe"], [class*="Betslip"]');
          break;
        }

        function isHistoryCard(card) {
          for (const p of document.querySelectorAll(
            '[class*="myBets"], [class*="MyBets"], [class*="openBets"], [class*="OpenBets"], ' +
            '[class*="betHistory"], [class*="BetHistory"], [class*="historyBets"], [class*="HistoryBets"]'
          )) {
            if (p.contains(card)) return true;
          }
          const txt = (card.textContent || '').replace(/\s+/g, ' ');
          if (/mybets|my-bets|openbets|bethistory|내베팅|내\s*베팅|베팅\s*내역|배팅\s*내역/i.test(txt)) return true;
          if (/캐시\s*아웃|cash\s*out|베팅\s*번호|티켓\s*번호|정산\s*완료|미적중|적중금|낙첨/i.test(txt)) return true;
          return false;
        }

        const cards = [];
        const slipRoots = slipPanel ? [slipPanel] : [...document.querySelectorAll('[class*="betslip_fe"], [class*="Betslip"]')];
        const searchRoots = slipRoots.filter((root) => {
          const blob = `${root.className || ''} ${root.id || ''}`;
          return !/mybets|my-bets|openbets|bethistory|historybets/i.test(blob);
        });
        for (const root of searchRoots) {
          for (const card of root.querySelectorAll('[class*="betslip_fe_BetSecondary_bet"], [class*="BetSecondary_bet"], [class*="betInformation__title"]')) {
            const el = card.matches?.('[class*="betInformation__title"]')
              ? (card.closest('[class*="bet"]') || card.closest('[class*="Bet"]') || card.parentElement?.parentElement || card)
              : card;
            if (!vis(el) || isHistoryCard(el)) continue;
            const txt = (el.textContent || '').trim();
            if (txt.length < 6 || txt.length > 900) continue;
            if (el.querySelector('input[id="counter"], input[class*="Counter"]')) continue;
            if (!/W[12]|betInformation|우승|winner|맵|map|vs|대|오버|언더|over|under|핸디|handicap|@\s*\d+\.\d/i.test(txt)) continue;
            if (!cards.includes(el)) cards.push(el);
          }
        }

        let card = null;
        if (slipInput && cards.length) {
          for (const c of cards) {
            if (c.compareDocumentPosition(slipInput) & Node.DOCUMENT_POSITION_FOLLOWING) {
              card = c;
              break;
            }
          }
        }

        if (!card && cards.length) card = cards[cards.length - 1];

        if (!card && isWidgetsX) {
          for (const root of document.querySelectorAll('[class*="betslip"], [class*="Betslip"], main, [role="main"]')) {
            const txt = (root.textContent || '').replace(/\s+/g, ' ');
            if (txt.length < 16 || /내베팅|mybets|cash\s*out/i.test(txt)) continue;
            const at = txt.match(/@\s*(\d+\.\d{2,4})/);
            if (!at) continue;
            const o = parseOdds(at[1]);
            if (!o) continue;
            const sel = root.querySelector('[class*="title"], [class*="selection"]')?.textContent?.trim() || '';
            return { odds: o, selectionText: sel, eventText: '', source: 'widgets-x-at', fromSlip: true, hasInput };
          }
        }

        if (!card) {
          return null;
        }
        const txt = (card.textContent || '').trim();
        const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
        const selectionText = titleEls[0]?.textContent?.trim() || (/\bW1\b/i.test(txt) ? 'W1' : /\bW2\b/i.test(txt) ? 'W2' : '');
        const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
        const eventText = eventEl?.textContent?.trim() || '';

        let odds = readSlipCardOdds(card);
        const source = 'slip-card';
        if (!odds) return null;
        return { odds, selectionText, eventText, source, fromSlip: true, hasInput };
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
