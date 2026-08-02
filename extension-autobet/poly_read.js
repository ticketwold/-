// poly_read.js — Polymarket DOM 스크랩 + Gamma API 폴백
'use strict';

async function ensureBcScrapeScript(tabId, frameId) {
  try {
    const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
    await chrome.scripting.executeScript({
      target,
      files: ['bc_sports_scrape.js'],
      world: 'MAIN'
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function injectReadBcSportsDeep(tabId, frameId) {
  try {
    await ensureBcScrapeScript(tabId, frameId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => (typeof window.__bcScrapeOdds === 'function' ? window.__bcScrapeOdds() : null)
    });
    const hit = results?.[0]?.result;
    if (hit?.ok && hit.odds > 1.01) {
      const slip = { ...hit };
      delete slip.ok;
      delete slip.reason;
      delete slip.href;
      delete slip.frameTextLen;
      delete slip.bodyLen;
      delete slip.boardCount;
      return slip;
    }
    return hit?.reason ? { _fail: hit.reason, _href: hit.href, _bodyLen: hit.bodyLen } : null;
  } catch (e) {
    return { _fail: e.message || 'inject-fail' };
  }
}

async function injectReadBcSports(tabId, frameId = 0) {
  const deep = await injectReadBcSportsDeep(tabId, frameId);
  if (deep?.odds > 1.01) return deep;
  if (deep?._fail) return null;
  return null;
}

async function readBcLeg2FromBtiFrames(polyTab) {
  if (!polyTab?.id) return null;
  const frames = await getAllFrames(polyTab.id);
  const ordered = await orderBcLeg2FrameIds(polyTab.id, polyTab.url);
  const frameIds = [...new Set([...ordered, ...frames.map((f) => f.frameId)])];
  let best = null;

  for (const frameId of frameIds.slice(0, BTI_MAX_FRAMES)) {
    let slip = await injectReadBcSportsDeep(polyTab.id, frameId);
    if (slip?._fail) slip = null;
    if (!(slip?.odds > 1.01)) {
      try {
        const scraped = await injectReadBtiFrame(polyTab.id, frameId);
        if (scraped?.odds > 1.01) slip = scraped;
      } catch (_) {}
    }
    if (!(slip?.odds > 1.01)) {
      try {
        await ensureBtiScript(polyTab.id, frameId);
        const res = await withTimeout(
          sendBti(polyTab.id, frameId, { type: 'READ_BTI_ODDS', hint: { preferActiveSlip: true } }),
          BTI_PROBE_MS,
          'BC iframe 읽기'
        );
        if (res?.slip?.odds > 1.01) slip = res.slip;
      } catch (_) {}
    }
    if (!(slip?.odds > 1.01)) continue;
    const norm = normalizePolySlip({
      ...slip,
      source: 'bcgame',
      sourceKind: slip.sourceKind || (slip.source === 'slip-display' ? 'sports-slip' : 'sports-board')
    });
    const s = scorePolySlip(norm);
    if (s > (best?._score ?? -1)) {
      best = { ...norm, frameId, _score: s };
    }
    if (norm.sourceKind === 'bc-native-slip' || (norm.fromPayout && norm.stake > 0)) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId };
      return best;
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
  if (slip.sourceKind === 'bc-native-slip') score += 300;
  else if (slip.fromPayout && !slip.pendingToWin) score += 200;
  else if (slip.sourceKind === 'sports-slip') score += 240;
  else if (slip.sourceKind === 'sports-board' || slip.sourceKind === 'sports-text') score += 180;
  else if (slip.liveCents || slip.source === 'poly-scrape') score += 40;
  if (slip.stake > 0) score += 30;
  if (slip.pendingToWin) score -= 40;
  return score;
}

async function readPolySlipFromApi(polyTab) {
  return null;
}

async function injectParseBcSlipInline(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['bc_slip_read.js']
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => (typeof window.__bcReadNativeSlip === 'function' ? window.__bcReadNativeSlip() : null)
    });
    const hit = results?.[0]?.result;
    if (hit?.ok && hit.odds > 1.01) {
      const slip = { ...hit };
      delete slip.ok;
      delete slip.reason;
      delete slip.sample;
      delete slip.textLen;
      delete slip.href;
      return slip;
    }
    if (hit?.reason) return { _debug: hit.reason, _sample: hit.sample, _len: hit.textLen };
    return null;
  } catch (e) {
    return { _debug: e.message || 'inject-err' };
  }
}

async function injectBcSlipAllFrames(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['bc_slip_read.js']
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (typeof window.__bcReadNativeSlip === 'function' ? window.__bcReadNativeSlip() : null)
    });
    let best = null;
    for (const row of results || []) {
      const hit = row?.result;
      const frameId = row?.frameId ?? 0;
      if (hit?.ok && hit.odds > 1.01) {
        const slip = { ...hit };
        delete slip.ok;
        delete slip.reason;
        delete slip.sample;
        delete slip.textLen;
        delete slip.inputCount;
        delete slip.flags;
        delete slip.href;
        const s = scorePolySlip(slip);
        if (s > (best?._score ?? -1)) best = { ...slip, frameId, _score: s };
      }
    }
    return best?.odds > 1.01 ? best : null;
  } catch (_) {
    return null;
  }
}

async function readBcSportsNativeSlip(polyTab) {
  if (!polyTab?.id) return null;
  await ensurePolyScript(polyTab.id);

  for (let attempt = 0; attempt < 4; attempt++) {
    const hit = await injectBcSlipAllFrames(polyTab.id);
    if (hit?.odds > 1.01) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: hit.frameId };
      return hit;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}

async function probeBcSlipFrames(polyTab) {
  if (!polyTab?.id) return [];
  const frames = await getAllFrames(polyTab.id);
  await ensurePolyScript(polyTab.id);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, allFrames: true },
      files: ['bc_slip_read.js']
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, allFrames: true },
      func: () => (typeof window.__bcReadNativeSlip === 'function' ? window.__bcReadNativeSlip() : null)
    });
    const out = [];
    for (const row of results || []) {
      const hit = row?.result;
      const frameId = row?.frameId ?? 0;
      const frame = frames.find((f) => f.frameId === frameId);
      const url = (frame?.url || hit?.href || '').replace(/^https?:\/\//, '').slice(0, 72);
      if (hit?.ok && hit.odds > 1.01) {
        out.push({ frameId, url, odds: hit.odds, kind: hit.sourceKind || hit.method || 'bc-native-slip', inputs: hit.inputCount });
      } else {
        const flags = hit?.flags ? ` slip${hit.flags.slip ? 1 : 0} win${hit.flags.win ? 1 : 0} usdt${hit.flags.usdt ? 1 : 0} btn${hit.flags.betBtn ? 1 : 0}` : '';
        out.push({
          frameId,
          url,
          odds: null,
          kind: hit?.reason || 'miss',
          inputs: hit?.inputCount ?? 0,
          len: hit?.textLen ?? 0,
          flags,
          sample: hit?.sample || ''
        });
      }
    }
    out.sort((a, b) => (b.odds || 0) - (a.odds || 0));
    return out;
  } catch (e) {
    return [{ frameId: -1, url: '', odds: null, kind: e.message || 'probe-fail' }];
  }
}

async function readBcSportsNativeSlip(polyTab) {
  if (!polyTab?.id) return null;
  await ensurePolyScript(polyTab.id);

  const allFramesHit = await injectBcSlipAllFrames(polyTab.id);
  if (allFramesHit?.odds > 1.01) {
    lastBcLeg2Frame = { tabId: polyTab.id, frameId: allFramesHit.frameId };
    return allFramesHit;
  }

  const frames = await getAllFrames(polyTab.id);
  const frameIds = [...new Set([0, ...frames.map((f) => f.frameId)])];

  let best = null;
  for (const frameId of frameIds) {
    const inline = await injectParseBcSlipInline(polyTab.id, frameId);
    if (!(inline?.odds > 1.01)) continue;
    const s = scorePolySlip(inline);
    if (s > (best?._score ?? -1)) best = { ...inline, frameId, _score: s };
  }

  if (best?.odds > 1.01) {
    lastBcLeg2Frame = { tabId: polyTab.id, frameId: best.frameId };
    return best;
  }
  return null;
}

async function readPolyOddsOnce(polyTab) {
  if (!polyTab?.id) return null;
  const siteKey = 'bcgame';
  const isSports = typeof isBcGameSportsUrl === 'function' && isBcGameSportsUrl(polyTab.url);

  if (isSports) {
    const native = await readBcSportsNativeSlip(polyTab);
    if (native?.odds > 1.01) return mergePolySlipWithCache(polyTab.id, native);

    polyOddsCache.delete(polyTab.id);
    return null;
  }

  const frames = await getAllFrames(polyTab.id);
  let order = frames.map((f) => f.frameId);
  const toProbe = order.slice(0, 5);
  await Promise.all(toProbe.map((fid) => ensurePolyScript(polyTab.id, fid)));

  const [slipResults, injected, scraped] = await Promise.all([
    Promise.all(toProbe.map(async (frameId) => {
      try {
        const res = await withTimeout(sendPoly(polyTab.id, { type: 'READ_SLIP' }, frameId), 3500, 'BC읽기');
        return res?.slip || null;
      } catch (_) {
        return null;
      }
    })),
    injectReadPoly(polyTab.id, siteKey).catch(() => null),
    injectScrapePolyCents(polyTab.id).catch(() => null)
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

  for (const slip of [injected, scraped]) {
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
