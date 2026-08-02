// poly_read.js — Polymarket DOM 스크랩 + Gamma API 폴백
'use strict';

async function injectReadBcSports(tabId, frameId = 0) {
  try {
    const target = frameId ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
    const results = await chrome.scripting.executeScript({
      target,
      world: 'MAIN',
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
            || /selected|active|pressed|highlight/i.test(cls);
        }
        function parseBtn(btn) {
          const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          let odds = null;
          const oddsEl = btn.querySelector('[class*="odds"], [class*="Odds"], [class*="Selections_odds"]');
          if (oddsEl) odds = parseOdds(oddsEl.textContent);
          if (!odds) {
            const m = txt.match(/(\d+\.\d{2,3})\s*$/);
            if (m) odds = parseOdds(m[1]);
          }
          if (!odds) {
            const m2 = txt.match(/(\d+\.\d{2,3})/);
            if (m2) odds = parseOdds(m2[1]);
          }
          return odds > 1.01 ? { odds, txt, selected: isSelected(btn) } : null;
        }

        let hasInput = false;
        for (const inp of document.querySelectorAll('input, textarea')) {
          if (!vis(inp)) continue;
          const blob = `${inp.id || ''} ${inp.className || ''} ${inp.placeholder || ''}`;
          if (/search|검색/i.test(blob)) continue;
          if (/counter|Counter|베팅|stake|amount/i.test(blob)) { hasInput = true; break; }
        }

        function readSlipPanel() {
          if (!hasInput) return null;
          const roots = [...document.querySelectorAll('[class*="betslip"], [class*="Betslip"]')];
          if (!roots.length) roots.push(document.body);
          for (const root of roots) {
            for (const card of root.querySelectorAll('[class*="bet"], [class*="Bet"]')) {
              if (!vis(card)) continue;
              const txt = (card.textContent || '').trim();
              if (txt.length < 6 || txt.length > 900) continue;
              if (card.querySelector('input')) continue;
              if (!/W[12]|betInformation|우승|winner|맵|map|team/i.test(txt)) continue;

              const titleEls = card.querySelectorAll('[class*="betInformation__title"]');
              const selectionText = titleEls[0]?.textContent?.trim() || '';
              const eventEl = card.querySelector('[class*="eventName"], [class*="betInformation__eventName"]');
              const eventText = eventEl?.textContent?.trim() || '';

              for (const sp of card.querySelectorAll('[class*="odds"], [class*="Odds"], [class*="UpdateNotification"], [class*="Selections_odds"]')) {
                const o = parseOdds(sp.textContent);
                if (o) return { odds: o, selectionText, eventText, source: 'bc-sports-scrape', hasInput: true, marketKind: 'ml' };
              }
              const nums = [];
              for (const sp of card.querySelectorAll('span, div, b, strong')) {
                const t = (sp.textContent || '').trim();
                if (!/^\d+\.\d{2,3}$/.test(t)) continue;
                const o = parseOdds(t);
                if (o) nums.push(o);
              }
              if (nums.length) {
                return { odds: nums[nums.length - 1], selectionText, eventText, source: 'bc-sports-scrape', hasInput: true };
              }
            }
          }
          return null;
        }

        const slipPanel = readSlipPanel();
        if (slipPanel?.odds > 1.01) {
          let teamLabel = slipPanel.selectionText;
          if (slipPanel.eventText) {
            for (const sep of [' vs ', ' VS ', ' 대 ']) {
              if (slipPanel.eventText.includes(sep)) {
                const [home, away] = slipPanel.eventText.split(sep, 2).map((s) => s.trim());
                if (/^W1$/i.test(teamLabel)) teamLabel = home || teamLabel;
                if (/^W2$/i.test(teamLabel)) teamLabel = away || teamLabel;
                break;
              }
            }
          }
          return {
            ...slipPanel,
            source: 'bcgame',
            sourceKind: 'sports-slip',
            teamLabel,
            outcome: teamLabel,
            displayLabel: slipPanel.odds.toFixed(3),
            fromPayout: false,
            marketKind: 'ml'
          };
        }

        const selectors = [
          'button[class*="master_fe_Selections_selection"]',
          'button[class*="Selections_selection"]',
          'button.sportsbook-Button',
          '.button__bet__odds',
          '[class*="eventSelection"]',
          'button'
        ];
        const seen = new Set();
        const board = [];
        for (const sel of selectors) {
          for (const btn of document.querySelectorAll(sel)) {
            if (seen.has(btn) || !vis(btn)) continue;
            seen.add(btn);
            const parsed = parseBtn(btn);
            if (parsed) board.push(parsed);
          }
        }
        if (!board.length) return null;
        const sel = board.find((b) => b.selected) || board[0];
        return {
          source: 'bcgame',
          odds: sel.odds,
          teamLabel: sel.txt,
          outcome: sel.txt,
          selectionText: sel.txt,
          displayLabel: sel.odds.toFixed(3),
          sourceKind: 'sports-board',
          fromPayout: false,
          hasInput,
          buttonCount: board.length,
          marketKind: 'ml'
        };
      }
    });
    const hits = (results || []).map((r) => r?.result).filter((r) => r?.odds > 1.01);
    if (!hits.length) return null;
    hits.sort((a, b) => {
      const sa = (a.sourceKind === 'sports-slip' ? 200 : 0) + (a.hasInput ? 50 : 0) + a.odds;
      const sb = (b.sourceKind === 'sports-slip' ? 200 : 0) + (b.hasInput ? 50 : 0) + b.odds;
      return sb - sa;
    });
    return hits[0];
  } catch (_) {
    return null;
  }
}

async function readBcLeg2FromBtiFrames(polyTab) {
  if (!polyTab?.id) return null;
  const frameIds = await orderBcLeg2FrameIds(polyTab.id, polyTab.url);
  let best = null;

  for (const frameId of frameIds.slice(0, BTI_MAX_FRAMES)) {
    await ensureBtiScript(polyTab.id, frameId);
    let slip = null;
    try {
      const res = await withTimeout(
        sendBti(polyTab.id, frameId, { type: 'READ_BTI_ODDS', hint: { preferActiveSlip: true } }),
        BTI_PROBE_MS,
        'BC iframe 읽기'
      );
      slip = res?.slip || null;
    } catch (_) {}
    if (!(slip?.odds > 1.01)) {
      try {
        const scraped = await injectReadBtiFrame(polyTab.id, frameId);
        if (scraped?.odds > 1.01) slip = scraped;
      } catch (_) {}
    }
    if (!(slip?.odds > 1.01)) continue;
    const norm = normalizePolySlip({
      ...slip,
      source: 'bcgame',
      sourceKind: slip.source === 'slip-display' ? 'sports-slip' : 'sports-board'
    });
    const s = scorePolySlip(norm);
    if (s > (best?._score ?? -1)) {
      best = { ...norm, frameId, _score: s };
    }
  }

  if (best?.frameId != null) lastBcLeg2Frame = { tabId: polyTab.id, frameId: best.frameId };
  return best;
}

async function injectReadPoly(tabId, siteKey = 'bcgame') {
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
          if (btn.getAttribute('data-state') === 'on' || btn.getAttribute('data-state') === 'checked') s += 110;
          const cls = String(btn.className || '');
          if (/active|selected|checked|pressed|border-primary|ring-|bg-primary|text-primary/i.test(cls)) s += 80;
          const style = window.getComputedStyle?.(btn);
          if (style && parseFloat(style.borderWidth) >= 2) s += 30;
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

function getCachedPolyOdds(tabId, maxAgeMs = 4000) {
  const hit = polyOddsCache.get(tabId);
  if (!hit || Date.now() - hit.at > maxAgeMs) return null;
  return hit.slip;
}

function mergePolySlipWithCache(tabId, slip) {
  slip = normalizePolySlip(slip);
  if (slip?.odds > 1) {
    cachePolyOdds(tabId, slip);
    return slip;
  }
  const pending = slip?.pendingToWin || slip?.needsStake;
  if (!pending) return slip;
  const cached = getCachedPolyOdds(tabId);
  if (!cached) return slip;
  return {
    ...cached,
    stake: slip?.stake > 0 ? slip.stake : cached.stake,
    pendingToWin: true,
    hint: slip?.hint || cached.hint
  };
}

function normalizePolySlip(slip) {
  if (!slip) return slip;
  if (slip.odds > 1) return slip;
  const cents = slip.priceCents || (slip.price > 0 && slip.price < 1 ? slip.price * 100 : null);
  if (cents > 0 && cents < 100) {
    const odds = 100 / cents;
    if (odds > 1.001 && odds < 100) {
      return { ...slip, odds, priceCents: cents, liveCents: true };
    }
  }
  return slip;
}

function scorePolySlip(slip) {
  slip = normalizePolySlip(slip);
  if (!(slip?.odds > 1)) return -1;
  let score = slip.odds;
  if (slip.fromPayout && !slip.pendingToWin) score += 200;
  else if (slip.sourceKind === 'sports-slip') score += 220;
  else if (slip.liveCents) score += 150;
  if (slip.stake > 0) score += 30;
  if (slip.pendingToWin) score -= 40;
  return score;
}

async function readPolySlipFromApi(polyTab) {
  return null;
}

async function readPolyOddsOnce(polyTab) {
  if (!polyTab?.id) return null;
  const siteKey = 'bcgame';
  const isSports = typeof isBcGameSportsUrl === 'function' && isBcGameSportsUrl(polyTab.url);

  const frames = await getAllFrames(polyTab.id);
  let order = [0];
  if (isSports && typeof orderBcLeg2FrameIds === 'function') {
    order = await orderBcLeg2FrameIds(polyTab.id, polyTab.url);
  } else {
    for (const f of frames) {
      if (f.frameId !== 0 && !order.includes(f.frameId)) order.push(f.frameId);
    }
  }

  const toProbe = order.slice(0, 16);
  await Promise.all(toProbe.map((fid) => ensurePolyScript(polyTab.id, fid)));

  const btiSlipP = isSports ? readBcLeg2FromBtiFrames(polyTab).catch(() => null) : Promise.resolve(null);
  const scrapeJobs = isSports
    ? toProbe.map((frameId) => injectReadBcSports(polyTab.id, frameId).catch(() => null))
    : [injectReadBcSports(polyTab.id, 0).catch(() => null)];

  const [slipResults, injected, scraped, sportsScrapedList, btiSlip] = await Promise.all([
    Promise.all(toProbe.map(async (frameId) => {
      try {
        const res = await withTimeout(sendPoly(polyTab.id, { type: 'READ_SLIP' }, frameId), 3500, 'BC읽기');
        return res?.slip || null;
      } catch (_) {
        return null;
      }
    })),
    injectReadPoly(polyTab.id, siteKey).catch(() => null),
    injectScrapePolyCents(polyTab.id).catch(() => null),
    Promise.all(scrapeJobs),
    btiSlipP
  ]);

  let best = null;
  for (const slip of slipResults) {
    if (!slip) continue;
    const norm = normalizePolySlip(slip);
    const s = scorePolySlip(norm);
    if (s > (best?._score ?? -1)) {
      best = norm;
      best._score = s;
    }
  }

  const sportsScraped = (sportsScrapedList || []).filter((s) => s?.odds > 1.01)
    .sort((a, b) => scorePolySlip(b) - scorePolySlip(a))[0] || null;

  for (const slip of [btiSlip, injected, scraped, sportsScraped]) {
    if (!slip?.odds || slip.odds <= 1) continue;
    const merged = mergePolySlipWithCache(polyTab.id, slip);
    const s = scorePolySlip(merged);
    if (s > (best?._score ?? -1)) {
      best = merged;
      best._score = s;
    }
  }

  if (best?.odds > 1) return mergePolySlipWithCache(polyTab.id, best);
  return mergePolySlipWithCache(polyTab.id, best);
}
