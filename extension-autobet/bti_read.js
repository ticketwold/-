// BTI iframe DOM 직접 읽기 (x10x10s 내부 스포츠 iframe)
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

        function isSelected(btn) {
          if (!btn) return false;
          const cls = String(btn.className || '');
          return btn.getAttribute('aria-pressed') === 'true'
            || btn.getAttribute('aria-selected') === 'true'
            || btn.getAttribute('data-selected') === 'true'
            || btn.getAttribute('data-state') === 'on'
            || /selected|active|pressed|highlight/i.test(cls);
        }

        function queryBoardBtns() {
          const sels = [
            'button[class*="master_fe_Selections_selection"]',
            'button[class*="Selections_selection"]',
            'button[class*="Selection"]',
            'button.sportsbook-Button'
          ];
          const seen = new Set();
          const out = [];
          for (const sel of sels) {
            for (const btn of document.querySelectorAll(sel)) {
              if (seen.has(btn) || !vis(btn)) continue;
              seen.add(btn);
              out.push(btn);
            }
          }
          if (!out.length) {
            for (const btn of document.querySelectorAll('button')) {
              if (seen.has(btn) || !vis(btn)) continue;
              const txt = (btn.textContent || '').trim();
              if (!/\d+\.\d{2,3}/.test(txt)) continue;
              seen.add(btn);
              out.push(btn);
            }
          }
          return out;
        }

        function parseBtn(btn) {
          const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          let odds = null;
          const oddsEl = btn.querySelector('[class*="odds"], [class*="Odds"]');
          if (oddsEl) odds = parseOdds(oddsEl.textContent);
          if (!odds) {
            const m = txt.match(/(\d+\.\d{2,3})\s*$/);
            if (m) odds = parseOdds(m[1]);
          }
          if (!odds) {
            const m2 = txt.match(/(\d+\.\d{2,3})/);
            if (m2) odds = parseOdds(m2[1]);
          }
          return odds > 1.01 ? { odds, txt, selected: isSelected(btn), btn } : null;
        }

        function scrapeBoard() {
          const parsed = queryBoardBtns().map(parseBtn).filter(Boolean);
          if (!parsed.length) return null;
          const sel = parsed.find((p) => p.selected) || parsed[0];
          return {
            odds: sel.odds,
            selectionText: sel.txt,
            teamLabel: sel.txt,
            source: 'main-scrape',
            buttonCount: parsed.length,
            hasInput: false
          };
        }

        let hasInput = false;
        for (const inp of document.querySelectorAll('input, textarea')) {
          if (!vis(inp)) continue;
          const blob = `${inp.id || ''} ${inp.className || ''} ${inp.placeholder || ''}`;
          if (/counter|Counter|베팅/i.test(blob)) { hasInput = true; break; }
        }

        function readSlipPanel() {
          const roots = [...document.querySelectorAll('[class*="betslip"], [class*="Betslip"]')];
          if (!roots.length) roots.push(document.body);
          for (const root of roots) {
            for (const card of root.querySelectorAll('[class*="bet"], [class*="Bet"]')) {
              if (!vis(card)) continue;
              const txt = (card.textContent || '').trim();
              if (txt.length < 6 || txt.length > 900) continue;
              if (card.querySelector('input[id="counter"], input[class*="Counter"]')) continue;
              if (!/W[12]|betInformation|우승|winner|맵|map|vs|대/i.test(txt)) continue;

              const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
              const selectionText = titleEls[0]?.textContent?.trim() || (/\bW1\b/i.test(txt) ? 'W1' : /\bW2\b/i.test(txt) ? 'W2' : '');
              const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
              const eventText = eventEl?.textContent?.trim() || '';

              for (const sp of card.querySelectorAll('[class*="odds"], [class*="Odds"], [class*="UpdateNotification"]')) {
                const o = parseOdds(sp.textContent);
                if (o) return { odds: o, selectionText, eventText, source: 'slip-display', hasInput };
              }
              const nums = [];
              for (const sp of card.querySelectorAll('span, div, b, strong')) {
                const t = (sp.textContent || '').trim();
                if (!/^\d+\.\d{2,3}$/.test(t)) continue;
                const o = parseOdds(t);
                if (o) nums.push(o);
              }
              if (nums.length) return { odds: nums[nums.length - 1], selectionText, eventText, source: 'slip-display', hasInput };
            }
          }
          return null;
        }

        const boardFirst = scrapeBoard();
        const slipPanel = readSlipPanel();

        const pick = (slipPanel?.odds > 1.01 && hasInput) ? slipPanel
          : (hasInput && boardFirst?.odds > 1.01 ? boardFirst : slipPanel);
        if (!pick?.odds) return slipPanel || null;

        let homeTeam = '';
        let awayTeam = '';
        const eventText = pick.eventText || '';
        if (eventText) {
          for (const sep of [' vs ', ' VS ', ' 대 ']) {
            if (eventText.includes(sep)) {
              [homeTeam, awayTeam] = eventText.split(sep, 2).map((s) => s.trim());
              break;
            }
          }
        }
        let teamLabel = pick.selectionText || pick.teamLabel || '';
        if (/^W1$/i.test(teamLabel)) teamLabel = homeTeam || teamLabel;
        if (/^W2$/i.test(teamLabel)) teamLabel = awayTeam || teamLabel;

        return {
          ...pick,
          teamLabel,
          homeTeam,
          awayTeam,
          hasInput,
          buttonCount: pick.buttonCount || queryBoardBtns().length
        };
      }
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}
