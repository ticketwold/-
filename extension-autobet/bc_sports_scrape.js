// bc_sports_scrape.js — BC.Game 스포츠북(Betby/BTi) MAIN world 스크랩
(function () {
  if (window.__bcScrapeOdds) return;

  function vis(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    try {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    } catch (_) {}
    return true;
  }

  function parseOdds(t) {
    const n = parseFloat(String(t || '').replace(/,/g, '').trim());
    if (!Number.isFinite(n) || n <= 1.01 || n >= 100) return null;
    return n;
  }

  function collectRoots(node, out) {
    if (!node || out.length > 5000) return;
    if (node.nodeType === 1) {
      out.push(node);
      if (node.shadowRoot) collectRoots(node.shadowRoot, out);
      const ch = node.children || [];
      for (let i = 0; i < ch.length; i++) collectRoots(ch[i], out);
    }
  }

  function queryDeep(selector) {
    const roots = [];
    collectRoots(document.documentElement, roots);
    const seen = new Set();
    const hits = [];
    for (const root of roots) {
      if (!root.querySelectorAll) continue;
      try {
        for (const el of root.querySelectorAll(selector)) {
          if (!seen.has(el)) { seen.add(el); hits.push(el); }
        }
      } catch (_) {}
    }
    return hits;
  }

  function isSelected(el) {
    if (!el) return false;
    const cls = String(el.className || '');
    return el.getAttribute('aria-pressed') === 'true'
      || el.getAttribute('aria-selected') === 'true'
      || el.getAttribute('data-selected') === 'true'
      || el.getAttribute('data-state') === 'on'
      || el.getAttribute('data-state') === 'checked'
      || /selected|active|pressed|highlight|checked/i.test(cls);
  }

  function findStakeInput() {
    const inputs = queryDeep('input, textarea');
    for (const inp of inputs) {
      if (!vis(inp)) continue;
      const blob = `${inp.id || ''} ${inp.className || ''} ${inp.placeholder || ''} ${inp.getAttribute('aria-label') || ''}`;
      if (/search|검색|email|password/i.test(blob)) continue;
      if (/counter|Counter|베팅|stake|amount|bet\s*amount|wager/i.test(blob)) return inp;
      const type = (inp.getAttribute('type') || '').toLowerCase();
      if ((type === 'number' || type === 'text' || type === '') && /stake|bet|금액/i.test(blob)) return inp;
    }
    return document.getElementById('counter') || null;
  }

  function readStake() {
    const inp = findStakeInput();
    if (!inp) return 0;
    const raw = String(inp.value || inp.getAttribute('value') || '').replace(/,/g, '').trim();
    const v = parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function parseOddsFromEl(el) {
    if (!el) return null;
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 200) return null;
    const oddsEls = el.querySelectorAll?.('[class*="odds"], [class*="Odds"], [class*="coeff"], [class*="Coeff"], [class*="price"], [class*="Price"]') || [];
    for (const o of oddsEls) {
      const v = parseOdds(o.textContent);
      if (v) return v;
    }
    let m = txt.match(/(\d+\.\d{2,3})\s*$/);
    if (m) return parseOdds(m[1]);
    m = txt.match(/\b(\d+\.\d{2,3})\b/);
    if (m) return parseOdds(m[1]);
    return null;
  }

  function collectOddsCandidates() {
    const selectors = [
      'button',
      '[role="button"]',
      'a[class*="odd"]',
      '[class*="Outcome"]',
      '[class*="outcome"]',
      '[class*="Selection"]',
      '[class*="selection"]',
      '[class*="eventSelection"]',
      '[class*="button__bet"]',
      '.button__bet__odds',
      'button[class*="master_fe_Selections_selection"]',
      'button.sportsbook-Button'
    ];
    const seen = new Set();
    const out = [];
    for (const sel of selectors) {
      for (const el of queryDeep(sel)) {
        if (seen.has(el) || !vis(el)) continue;
        const odds = parseOddsFromEl(el);
        if (!odds) continue;
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (/login|sign\s*in|deposit|withdraw|cookie|menu/i.test(txt)) continue;
        seen.add(el);
        out.push({ odds, txt, selected: isSelected(el), el });
      }
    }
    return out;
  }

  function readSlipFromPanel() {
    const hasInput = !!findStakeInput();
    const cards = queryDeep('[class*="bet"], [class*="Bet"], [class*="betslip"], [class*="Betslip"], [class*="bet-slip"]');
    for (const card of cards) {
      if (!vis(card)) continue;
      const txt = (card.textContent || '').trim();
      if (txt.length < 8 || txt.length > 1200) continue;
      if (card.querySelector('input') && !/betInformation|selection|outcome|W[12]/i.test(txt)) continue;
      if (!/W[12]|betInformation|selection|outcome|winner|우승|vs|대|map|맵|team/i.test(txt)) continue;

      const titleEls = card.querySelectorAll('[class*="betInformation__title"], [class*="selection"], [class*="Selection"]');
      const selectionText = titleEls[0]?.textContent?.trim() || '';
      const eventEl = card.querySelector('[class*="eventName"], [class*="event-name"], [class*="EventName"]');
      const eventText = eventEl?.textContent?.trim() || '';

      for (const sp of card.querySelectorAll('[class*="odds"], [class*="Odds"], [class*="coeff"], span, div, b, strong')) {
        const o = parseOdds(sp.textContent);
        if (o) {
          return { odds: o, selectionText, eventText, hasInput, sourceKind: 'sports-slip' };
        }
      }
    }
    if (!hasInput) return null;
    return null;
  }

  function scrapeBcSportsOdds() {
    const href = location.href || '';
    const bodyLen = (document.body?.innerText || '').length;
    if (bodyLen < 20) return { ok: false, reason: 'empty', href, bodyLen };

    const slip = readSlipFromPanel();
    if (slip?.odds > 1.01) {
      let teamLabel = slip.selectionText || '';
      if (slip.eventText) {
        for (const sep of [' vs ', ' VS ', ' 대 ']) {
          if (slip.eventText.includes(sep)) {
            const [home, away] = slip.eventText.split(sep, 2).map((s) => s.trim());
            if (/^W1$/i.test(teamLabel)) teamLabel = home || teamLabel;
            if (/^W2$/i.test(teamLabel)) teamLabel = away || teamLabel;
            break;
          }
        }
      }
      const stake = readStake();
      return {
        ok: true,
        source: 'bcgame',
        odds: slip.odds,
        teamLabel,
        outcome: teamLabel,
        selectionText: teamLabel,
        displayLabel: `${slip.odds.toFixed(3)}${stake > 0 ? ` · $${stake}` : ''}`,
        stake: stake || null,
        sourceKind: 'sports-slip',
        fromPayout: false,
        hasInput: slip.hasInput,
        href,
        frameTextLen: bodyLen
      };
    }

    const board = collectOddsCandidates();
    if (!board.length) {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const nums = [...text.matchAll(/\b(\d+\.\d{2,3})\b/g)]
        .map((m) => parseOdds(m[1]))
        .filter((n) => n && n > 1.01 && n < 20);
      if (nums.length >= 2) {
        const odds = nums[0];
        return {
          ok: true,
          source: 'bcgame',
          odds,
          teamLabel: '',
          displayLabel: odds.toFixed(3),
          sourceKind: 'sports-text',
          fromPayout: false,
          hasInput: !!findStakeInput(),
          href,
          frameTextLen: bodyLen
        };
      }
      return { ok: false, reason: 'no-odds', href, bodyLen, boardCount: 0 };
    }

    board.sort((a, b) => (b.selected ? 200 : 0) + b.odds - ((a.selected ? 200 : 0) + a.odds));
    const sel = board.find((b) => b.selected) || board[0];
    return {
      ok: true,
      source: 'bcgame',
      odds: sel.odds,
      teamLabel: sel.txt,
      outcome: sel.txt,
      selectionText: sel.txt,
      displayLabel: sel.odds.toFixed(3),
      sourceKind: 'sports-board',
      fromPayout: false,
      hasInput: !!findStakeInput(),
      buttonCount: board.length,
      href,
      frameTextLen: bodyLen
    };
  }

  function clickEl(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    try { if (typeof el.click === 'function') el.click(); } catch (_) {}
    return true;
  }

  function setStakeAmount(amount) {
    const inp = findStakeInput();
    if (!inp) return { ok: false, reason: 'stake-input-missing' };
    const str = String(Math.max(0.01, Math.round(amount * 100) / 100));
    inp.focus?.();
    inp.value = str;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, stake: readStake(), method: 'deep-type' };
  }

  function findBetButton() {
    const btns = queryDeep('button, [role="button"]');
    for (const btn of btns) {
      if (!vis(btn) || btn.disabled) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (/배당\s*수락|place\s*bet|bet\s*now|베팅하기|^bet$/i.test(t)) return btn;
      if ((btn.className || '').includes('sportsbook-Button') && /베팅|bet/i.test(t)) return btn;
    }
    return null;
  }

  async function placeBcSportsBet(amount) {
    const fill = setStakeAmount(amount);
    const btn = findBetButton();
    if (!btn) return { success: false, reason: 'bet-btn-missing', fill };
    clickEl(btn);
    return { success: true, btnText: (btn.textContent || '').trim().slice(0, 60), fillMethod: fill.method || 'deep' };
  }

  window.__bcScrapeOdds = scrapeBcSportsOdds;
  window.__bcSetStake = setStakeAmount;
  window.__bcPlaceSportsBet = placeBcSportsBet;
})();
