(function () {
  if (window.__bcScrapeBoard) return;

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
    const oddsEls = el.querySelectorAll?.(
      '[class*="odds"], [class*="Odds"], [class*="coeff"], [class*="Coeff"], [class*="price"], [class*="Price"]'
    ) || [];
    for (const o of oddsEls) {
      const v = parseOdds(o.textContent);
      if (v) return v;
    }
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const m = t.match(/(\d+\.\d{2,3})\s*$/);
    return m ? parseOdds(m[1]) : null;
  }

  function findEventNear(el) {
    let node = el;
    for (let i = 0; i < 14 && node; i++) {
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 20 && t.length < 900) {
        const vs = t.match(
          /([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48})/i
        );
        if (vs) {
          return {
            home: vs[1].trim().replace(/\s+\d+\s*-\s*\d+.*$/, ''),
            away: vs[2].trim().replace(/\s+\d+\s*-\s*\d+.*$/, ''),
            title: `${vs[1].trim()} vs ${vs[2].trim()}`
          };
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function teamFromBtnText(txt, home, away) {
    const t = String(txt || '').replace(/\s+/g, ' ').trim();
    const cleaned = t.replace(/(\d+\.\d{2,3})\s*$/, '').trim();
    if (/^W1$/i.test(cleaned) || /^W1$/i.test(t)) return home;
    if (/^W2$/i.test(cleaned) || /^W2$/i.test(t)) return away;
    if (cleaned.length >= 2) return cleaned;
    return t;
  }

  window.__bcScrapeBoard = function scrapeBcSportsBoard() {
    const sels = [
      'button', '[role="button"]', '[data-testid*="outcome"]', '[data-testid*="Odds"]',
      '[class*="Outcome"]', '[class*="outcome"]', '[class*="Selection"]', '[class*="selection"]',
      '[class*="button__bet"]', '.button__bet__odds', 'button.sportsbook-Button',
      'button[class*="master_fe_Selections_selection"]'
    ];
    const seen = new Set();
    const picks = [];

    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const odds = readBtnOdds(el);
        if (!odds) continue;
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        if (/login|sign\s*in|deposit|withdraw|cookie|menu|예약|history|내\s*베팅/i.test(txt)) continue;
        const event = findEventNear(el);
        if (!event?.home || !event?.away) continue;
        picks.push({ odds, txt, event });
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
      if (!team || team.length < 2) continue;
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
