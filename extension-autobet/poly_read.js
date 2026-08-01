// poly_read.js — Polymarket DOM 스크랩 + Gamma API 폴백
'use strict';

async function injectReadPoly(tabId, siteKey = 'polymarket') {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (site) => {
        function vis(el) {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        function parseMoney(t) {
          const s = String(t || '').trim();
          let m = s.match(/^\+?\s*([\d,]+(?:\.\d+)?)\s*USDT/i);
          if (m) {
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (Number.isFinite(v) && v > 0) return v;
          }
          m = s.match(/\$?\s*([\d,]+(?:\.\d+)?)/);
          if (m) {
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (Number.isFinite(v) && v > 0) return v;
          }
          return null;
        }
        function findWinIdx(raw) {
          const patterns = [/\bto\s*win\b/i, /우승/, /당첨(?:금)?/];
          let best = -1;
          for (const re of patterns) {
            const m = raw.match(re);
            if (m && (best < 0 || m.index < best)) best = m.index;
          }
          return best;
        }
        function findPanel() {
          let best = null;
          let bestScore = -1;
          for (const el of document.querySelectorAll('div, section, aside, form')) {
            if (!vis(el)) continue;
            const t = el.innerText || '';
            if (!el.querySelector('input, [contenteditable="true"]')) continue;
            const hasToWin = /\bto\s*win\b|우승|당첨|획득/i.test(t);
            const hasAmount = /\bamount\b|금액/i.test(t);
            const hasBuy = /\bbuy\b|매수|구매/i.test(t);
            if (!hasToWin && !hasAmount && !hasBuy) continue;
            let score = 0;
            if (hasAmount) score += 35;
            if (hasBuy) score += 30;
            if (hasToWin) score += 25;
            if (t.length <= 450) score += 160;
            else if (t.length > 2000) score -= 280;
            if (/(?:amount|금액)\s*\(\s*usdt\s*\)/i.test(t)) score += 45;
            if (score > bestScore) { bestScore = score; best = el; }
          }
          return best;
        }
        function readStake(panel) {
          if (!panel) return null;
          for (const inp of panel.querySelectorAll('input, [contenteditable="true"]')) {
            if (!vis(inp)) continue;
            const ph = (inp.placeholder || '').toLowerCase();
            if (/search|검색/.test(ph)) continue;
            const v = parseMoney(inp.value || inp.textContent || inp.getAttribute('value'));
            if (v) return v;
          }
          const m = (panel.innerText || '').match(/(?:Amount|금액)(?:\(USDT\))?\s*\n?\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
          if (m) return parseFloat(m[1].replace(/,/g, '')) || null;
          return null;
        }
        function readToWin(panel) {
          if (!panel) return null;
          const raw = (panel.innerText || '').replace(/\s+/g, ' ');
          const idx = findWinIdx(raw);
          if (idx < 0) return null;
          const section = raw.slice(idx, idx + 220);
          const patterns = [
            /(?:to\s*win|우승|당첨(?:금)?)[\s\S]{0,120}?([+]?\s*[\d,]+(?:\.\d+)?)\s*USDT/i,
            /(?:to\s*win|우승|당첨(?:금)?)[\s\S]{0,120}?≈\s*US?\$?\s*([\d,]+(?:\.\d+)?)/i,
            /(?:to\s*win|우승|당첨(?:금)?)[\s\S]{0,120}?\$\s*([\d,]+(?:\.\d+)?)/i
          ];
          for (const re of patterns) {
            const m = section.match(re);
            if (!m) continue;
            const v = parseFloat(String(m[1]).replace(/,/g, '').replace(/[+,\s]/g, ''));
            if (v > 0) return v;
          }
          return null;
        }

        const panel = findPanel();
        const stake = readStake(panel);
        const toWin = readToWin(panel);
        if (stake && toWin) {
          const total = toWin >= stake ? toWin : stake + toWin;
          const odds = total / stake;
          if (odds > 1.001 && odds <= 100) {
            return {
              source: site,
              odds,
              priceCents: Math.round((stake / total) * 1000) / 10,
              displayLabel: `${odds.toFixed(3)} · 당첨 $${toWin.toFixed(2)}`,
              stake,
              payout: total,
              fromPayout: true,
              marketKind: 'ml'
            };
          }
        }
        return null;
      },
      args: [siteKey]
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function injectScrapePolyCents(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        function vis(el) {
          const r = el?.getBoundingClientRect?.();
          return !!(r && r.width > 2 && r.height > 2);
        }
        function parseCents(t) {
          const s = String(t || '').trim();
          let m = s.match(/(\d+(?:\.\d+)?)\s*¢/);
          if (m) {
            const c = parseFloat(m[1]);
            if (c > 0 && c < 100) return c;
          }
          m = s.match(/(\d+(?:\.\d+)?)\s*%/);
          if (m) {
            const c = parseFloat(m[1]);
            if (c > 0 && c < 100) return c;
          }
          if (/^0\.\d{2,4}$/.test(s)) {
            const c = parseFloat(s) * 100;
            if (c > 0 && c < 100) return c;
          }
          m = s.match(/(\d+\.\d{2,3})\s*$/);
          if (m) {
            const c = parseFloat(m[1]);
            if (c > 1 && c < 99) return c;
          }
          return null;
        }
        function isBuySellTab(btn) {
          const t = (btn?.textContent || '').replace(/\s+/g, ' ').trim();
          return /^(Buy|Sell|매수|매도|구매|판매)$/i.test(t);
        }
        function selScore(btn) {
          let s = 0;
          if (btn.getAttribute('aria-pressed') === 'true') s += 120;
          if (btn.getAttribute('aria-selected') === 'true') s += 110;
          if (btn.getAttribute('data-state') === 'on') s += 110;
          const cls = String(btn.className || '');
          if (/active|selected|checked|pressed|border-primary|ring-/i.test(cls)) s += 80;
          return s;
        }

        const candidates = [];
        for (const btn of document.querySelectorAll('button, [role="button"], [role="radio"]')) {
          if (!vis(btn) || isBuySellTab(btn)) continue;
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 140) continue;
          const cents = parseCents(t);
          if (!cents) continue;
          let score = selScore(btn) + 50;
          if (/^buy\s+/i.test(t)) score += 30;
          if (t.length < 60) score += 10;
          candidates.push({ cents, score, t });
        }

        const panelText = document.body?.innerText || '';
        const avgM = panelText.match(/avg\.?\s*price\s*(\d+(?:\.\d+)?)\s*¢/i);
        if (avgM) {
          const c = parseFloat(avgM[1]);
          if (c > 0 && c < 100) {
            candidates.push({ cents: c, score: 200, t: `avg ${c}¢` });
          }
        }

        if (!candidates.length) return null;
        candidates.sort((a, b) => b.score - a.score);
        const pick = candidates[0];
        const odds = 100 / pick.cents;
        if (!(odds > 1.001 && odds < 100)) return null;

        let team = '';
        const buyM = panelText.match(/(?:Buy|매수|구매)\s+([^\n$¢@%]+?)(?:\s|$)/i);
        if (buyM) team = buyM[1].trim();

        return {
          source: 'poly-scrape',
          odds,
          priceCents: pick.cents,
          price: pick.cents / 100,
          teamLabel: team,
          outcome: team,
          selectionText: pick.t,
          displayLabel: `${pick.cents}¢ (${odds.toFixed(3)})`,
          fromPayout: false,
          liveCents: true,
          marketKind: 'ml'
        };
      }
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

const polyOddsCache = new Map();

function cachePolyOdds(tabId, slip) {
  if (!tabId || !(slip?.odds > 1)) return;
  polyOddsCache.set(tabId, { slip: { ...slip }, at: Date.now() });
}

function getCachedPolyOdds(tabId, maxAgeMs = 60000) {
  const hit = polyOddsCache.get(tabId);
  if (!hit || Date.now() - hit.at > maxAgeMs) return null;
  return hit.slip;
}

function mergePolySlipWithCache(tabId, slip) {
  if (slip?.odds > 1) {
    cachePolyOdds(tabId, slip);
    return slip;
  }
  const cached = getCachedPolyOdds(tabId);
  if (!cached) return slip;
  return {
    ...cached,
    stake: slip?.stake > 0 ? slip.stake : cached.stake,
    pendingToWin: slip?.pendingToWin || slip?.needsStake || false,
    hint: slip?.hint || cached.hint
  };
}

async function readPolySlipFromApi(polyTab) {
  if (!polyTab?.url || typeof fetchPolyEventBySlug !== 'function') return null;
  const slug = slugFromPolyUrl(polyTab.url);
  if (!slug) return null;
  try {
    const event = await fetchPolyEventBySlug(slug);
    if (!event) return null;
    const teamHint = polyTeamHintFromUrl(polyTab.url);
    const siteKey = typeof leg2SiteKey === 'function' ? (leg2SiteKey(polyTab.url) || 'polymarket') : 'polymarket';
    return polyEventToSlip(event, teamHint, siteKey);
  } catch (_) {
    return null;
  }
}

async function readPolyOddsOnce(polyTab) {
  if (!polyTab?.id) return null;
  const siteKey = typeof leg2SiteKey === 'function' ? (leg2SiteKey(polyTab.url) || 'polymarket') : 'polymarket';

  const frames = await getAllFrames(polyTab.id);
  const order = [0];
  for (const f of frames) {
    if (f.frameId !== 0 && !order.includes(f.frameId)) order.push(f.frameId);
  }

  let best = null;
  const toProbe = order.slice(0, 12);
  await Promise.all(toProbe.map((fid) => ensurePolyScript(polyTab.id, fid)));

  const slips = await Promise.all(toProbe.map(async (frameId) => {
    try {
      const res = await withTimeout(sendPoly(polyTab.id, { type: 'READ_SLIP' }, frameId), 4000, 'Poly읽기');
      return res?.slip || null;
    } catch (_) {
      return null;
    }
  }));

  for (const slip of slips) {
    if (!slip) continue;
    if (slip.fromPayout && slip.odds > 1) return mergePolySlipWithCache(polyTab.id, slip);
    if (slip.odds > 1) {
      if (!best || slip.fromPayout || (slip.liveCents && !best.liveCents)) best = slip;
    } else if (slip.needsStake && !best) {
      best = slip;
    }
  }
  if (best?.odds > 1) return mergePolySlipWithCache(polyTab.id, best);

  const injected = await injectReadPoly(polyTab.id, siteKey);
  if (injected?.odds > 1) {
    return mergePolySlipWithCache(polyTab.id, { ...injected, teamLabel: injected.teamLabel || polyTeamHintFromUrl(polyTab.url) });
  }

  const scraped = await injectScrapePolyCents(polyTab.id);
  if (scraped?.odds > 1) return mergePolySlipWithCache(polyTab.id, scraped);

  const apiSlip = await readPolySlipFromApi(polyTab);
  if (apiSlip?.odds > 1) return mergePolySlipWithCache(polyTab.id, apiSlip);

  return mergePolySlipWithCache(polyTab.id, best);
}
