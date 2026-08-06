(function () {
  const BOARD_SCRAPE_VER = 3;
  if (window.__bcScrapeBoardVer >= BOARD_SCRAPE_VER && typeof window.__bcScrapeBoard === 'function') return;
  window.__bcScrapeBoardVer = BOARD_SCRAPE_VER;

  function openShadow(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return chrome?.dom?.openOrClosedShadowRoot?.(el) || null;
    } catch (_) {
      return null;
    }
  }

  function walk(root, fn, depth) {
    if (!root || depth > 72) return;
    fn(root, depth);
    if (root.nodeType === 1) {
      const sr = openShadow(root);
      if (sr) walk(sr, fn, depth + 1);
      for (const ch of root.childNodes) walk(ch, fn, depth + 1);
    } else if (root.nodeType === 11) {
      for (const ch of root.childNodes) walk(ch, fn, depth + 1);
    }
  }

  function collectAll(selector, scope) {
    const out = [];
    const seen = new Set();
    walk(scope || document.documentElement, (node) => {
      if (node.nodeType !== 1 || !node.querySelectorAll) return;
      try {
        for (const el of node.querySelectorAll(selector)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch (_) {}
    }, 0);
    return out;
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    } catch (_) {}
    return true;
  }

  function parseOdds(text) {
    const n = parseFloat(String(text || '').replace(/,/g, '').trim());
    if (!Number.isFinite(n) || n <= 1.01 || n >= 100) return null;
    return n;
  }

  function readBtnOdds(el) {
    const editorId = (el.getAttribute?.('data-editor-id') || '').toLowerCase();
    if (/odd|coeff|price|decimal/.test(editorId)) {
      const v = parseOdds(el.textContent);
      if (v) return v;
    }
    const oddsEls = el.querySelectorAll?.(
      '[data-editor-id*="odds"], [data-editor-id*="Odds"], [data-editor-id*="coefficient"], [data-editor-id*="Coefficient"], [class*="odds"], [class*="Odds"], [class*="coeff"], [class*="Coeff"], [class*="price"], [class*="Price"]'
    ) || [];
    for (const o of oddsEls) {
      const v = parseOdds(o.textContent);
      if (v) return v;
    }
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const m = t.match(/(\d+\.\d{2,3})\s*$/);
    return m ? parseOdds(m[1]) : null;
  }

  function parseTeamsFromText(t) {
    if (!t) return null;
    const s = String(t).replace(/\s+/g, ' ').trim();
    let m = s.match(/([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48})/i);
    if (m) {
      return {
        home: m[1].trim().replace(/\s+\d+\s*-\s*\d+.*$/, ''),
        away: m[2].trim().replace(/\s+\d+\s*-\s*\d+.*$/, ''),
        title: `${m[1].trim()} vs ${m[2].trim()}`
      };
    }
    m = s.match(/([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48}?)\s*[-–]\s*([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48})/);
    if (m && !/^\d/.test(m[1])) {
      return { home: m[1].trim(), away: m[2].trim(), title: `${m[1].trim()} - ${m[2].trim()}` };
    }
    return null;
  }

  function findCompetitorPair(root) {
    if (!root?.querySelector) return null;
    const homeEl = root.querySelector(
      '[data-editor-id*="competitorHome"], [data-editor-id*="CompetitorHome"], [data-editor-id*="homeCompetitor"], [data-editor-id*="HomeCompetitor"]'
    );
    const awayEl = root.querySelector(
      '[data-editor-id*="competitorAway"], [data-editor-id*="CompetitorAway"], [data-editor-id*="awayCompetitor"], [data-editor-id*="AwayCompetitor"]'
    );
    if (homeEl && awayEl) {
      const home = (homeEl.textContent || '').replace(/\s+/g, ' ').trim();
      const away = (awayEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (home.length >= 2 && away.length >= 2 && !/^\d+\.\d+$/.test(home) && !/^\d+\.\d+$/.test(away)) {
        return { home, away, title: `${home} vs ${away}` };
      }
    }
    const comps = collectAll('[data-editor-id*="competitor"], [data-editor-id*="Competitor"]', root)
      .map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((n) => n.length >= 2 && !/^W[12]$/i.test(n) && !/^\d+\.\d+$/.test(n));
    const uniq = [];
    for (const n of comps) {
      if (!uniq.some((x) => x.toLowerCase() === n.toLowerCase())) uniq.push(n);
    }
    if (uniq.length >= 2) {
      return { home: uniq[0], away: uniq[1], title: `${uniq[0]} vs ${uniq[1]}` };
    }
    return null;
  }

  function findEventNear(el) {
    let node = el;
    for (let i = 0; i < 16 && node; i++) {
      const fromComp = findCompetitorPair(node);
      if (fromComp?.home && fromComp?.away) return fromComp;
      const editorId = (node.getAttribute?.('data-editor-id') || '').toLowerCase();
      if (/eventname|eventcard|eventrow|matchname|fixture/.test(editorId)) {
        const teams = parseTeamsFromText(node.textContent);
        if (teams?.home && teams?.away) return teams;
      }
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 20 && t.length < 900) {
        const teams = parseTeamsFromText(t);
        if (teams?.home && teams?.away) return teams;
      }
      node = node.parentElement;
    }
    for (const sel of ['[data-editor-id*="eventName"]', '[data-editor-id*="EventName"]', '[data-editor-id*="competitor"]', '[class*="eventName"]', '[class*="EventName"]']) {
      const near = el.closest?.(sel) || el.querySelector?.(sel);
      if (!near) continue;
      const root = near.closest?.('[data-editor-id*="event"], [class*="event"], [class*="Event"]') || near.parentElement;
      const teams = parseTeamsFromText((root || near).textContent);
      if (teams?.home && teams?.away) return teams;
    }
    return null;
  }

  function teamFromBtnText(txt, home, away) {
    const t = String(txt || '').replace(/\s+/g, ' ').trim();
    const cleaned = t.replace(/(\d+\.\d{2,3})\s*$/, '').trim();
    if (/^W1$/i.test(cleaned) || /^1$/i.test(cleaned)) return home;
    if (/^W2$/i.test(cleaned) || /^2$/i.test(cleaned)) return away;
    if (/^X$/i.test(cleaned)) return 'Draw';
    if (cleaned.length >= 2) return cleaned;
    return t;
  }

  function pushPick(picks, seen, el, odds, txt, event) {
    const key = `${event.home}|${event.away}|${odds}|${txt}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    picks.push({ odds, txt, event });
  }

  window.__bcScrapeBoard = function scrapeBcSportsBoard() {
    const seen = new Set();
    const picks = [];

    const outcomeSelectors = [
      '[data-editor-id*="outcome"]',
      '[data-editor-id*="Outcome"]',
      '[data-editor-id*="OddsButton"]',
      '[data-editor-id*="oddsButton"]',
      'button[data-editor-id]',
      'button', '[role="button"]',
      '[data-testid*="outcome"]', '[data-testid*="Odds"]',
      '[class*="Outcome"]', '[class*="outcome"]',
      '[class*="Selection"]', '[class*="selection"]',
      '[class*="button__bet"]', '.button__bet__odds',
      'button.sportsbook-Button',
      'button[class*="master_fe_Selections_selection"]'
    ];

    for (const sel of outcomeSelectors) {
      for (const el of collectAll(sel)) {
        if (!visible(el)) continue;
        const odds = readBtnOdds(el);
        if (!odds) continue;
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        if (/login|sign\s*in|deposit|withdraw|cookie|menu|예약|history|내\s*베팅|bet\s*slip/i.test(txt)) continue;
        const event = findEventNear(el);
        if (!event?.home || !event?.away) continue;
        pushPick(picks, seen, el, odds, txt, event);
      }
    }

    const map = new Map();
    for (const p of picks) {
      const key = `${p.event.home}|${p.event.away}`.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          home: p.event.home,
          away: p.event.away,
          title: p.event.title,
          league: '',
          ml: []
        });
      }
      const mu = map.get(key);
      const team = teamFromBtnText(p.txt, p.event.home, p.event.away);
      if (!team || team.length < 2 || team === 'Draw') continue;
      if (mu.ml.some((m) => m.team === team && Math.abs(m.decimal - p.odds) < 0.02)) continue;
      mu.ml.push({
        team,
        side: mu.ml.length ? 'away' : 'home',
        decimal: p.odds,
        price: p.odds
      });
    }

    const matchups = [...map.values()].filter((m) => m.ml.length > 0);
    return {
      ok: matchups.length > 0,
      site: 'bcgame',
      url: location.href,
      matchups,
      buttonCount: picks.length,
      source: 'sports-board'
    };
  };
})();
