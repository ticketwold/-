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

function isBcFrameSkippable(url) {
  return /tracker\.html|amazon-ivs|widgets?\.|doubleclick|googlesyndication|hcaptcha|captcha|about:blank$/i.test(url || '');
}

async function waitForBcSportsFrame(tabId, maxMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const frames = await getAllFrames(tabId);
    const hit = frames.find((f) => typeof isBcBetbyFrameUrl === 'function'
      ? isBcBetbyFrameUrl(f.url)
      : /sptsportscdn|cocoesports|betby|renderer|sportsbook/i.test(f.url || ''));
    if (hit && !isBcFrameSkippable(hit.url)) return hit.frameId;
    await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}

async function waitForBetbyRenderer(tabId, maxMs = 5000) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['bc_betby_bridge.js'],
      world: 'MAIN'
    });
    const res = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: (ms) => (typeof window.__bcWaitRenderer === 'function' ? window.__bcWaitRenderer(ms) : null),
      args: [maxMs]
    });
    return res?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function readBcSportsPerFrameDeep(polyTab) {
  if (!polyTab?.id) return null;
  const frames = await getAllFrames(polyTab.id);
  const ordered = await orderBcLeg2FrameIds(polyTab.id, polyTab.url);
  const urlMap = new Map(frames.map((f) => [f.frameId, f.url || '']));
  const allIds = [...new Set([...ordered, ...frames.map((f) => f.frameId)])];
  let best = null;

  for (const frameId of allIds.slice(0, BTI_MAX_FRAMES)) {
    const frameUrl = urlMap.get(frameId) || '';
    if (isBcFrameSkippable(frameUrl)) continue;

    try {
      await ensureBcScrapeScript(polyTab.id, frameId);
      const scrapeRes = await chrome.scripting.executeScript({
        target: { tabId: polyTab.id, frameIds: [frameId] },
        world: 'MAIN',
        func: () => (typeof window.__bcScrapeOdds === 'function' ? window.__bcScrapeOdds() : null)
      });
      const scraped = scrapeRes?.[0]?.result;
      if (scraped?.ok && scraped.odds > 1.01) {
        const slip = { ...scraped, source: 'bcgame', method: 'per-frame-scrape' };
        delete slip.ok;
        if (isTrustedBcSlip(slip)) {
          let s = scorePolySlip(slip);
          if (typeof isBcBetbyFrameUrl === 'function' ? isBcBetbyFrameUrl(frameUrl) : /betby|sptpub|biahosted|sptsportscdn|cocoesports|renderer/i.test(frameUrl)) s += 100;
          if (s > (best?._score ?? -1)) best = { ...slip, frameId, frameUrl, _score: s };
        }
      }

      await chrome.scripting.executeScript({
        target: { tabId: polyTab.id, frameIds: [frameId] },
        files: ['bc_slip_read.js']
      });
      const nativeRes = await chrome.scripting.executeScript({
        target: { tabId: polyTab.id, frameIds: [frameId] },
        func: () => (typeof window.__bcReadNativeSlip === 'function' ? window.__bcReadNativeSlip() : null)
      });
      const hit = nativeRes?.[0]?.result;
      if (hit?.ok && hit.odds > 1.01) {
        const slip = { ...hit };
        delete slip.ok;
        if (isTrustedBcSlip(slip)) {
          let s = scorePolySlip(slip);
          if (typeof isBcBetbyFrameUrl === 'function' ? isBcBetbyFrameUrl(frameUrl) : /betby|sptpub|biahosted|sptsportscdn|cocoesports|renderer/i.test(frameUrl)) s += 100;
          if (s > (best?._score ?? -1)) best = { ...slip, frameId, frameUrl, _score: s };
        }
      }
    } catch (_) {}
  }
  return best?.odds > 1.01 ? best : null;
}

async function readBcLeg2FromBtiFrames(polyTab) {
  if (!polyTab?.id) return null;
  const frames = await getAllFrames(polyTab.id);
  const ordered = await orderBcLeg2FrameIds(polyTab.id, polyTab.url);
  const frameIds = [...new Set([...ordered, ...frames.map((f) => f.frameId)])];
  let best = null;

  for (const frameId of frameIds.slice(0, BTI_MAX_FRAMES)) {
    const frameUrl = frames.find((f) => f.frameId === frameId)?.url || '';
    if (isBcFrameSkippable(frameUrl)) continue;
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
    if (!isTrustedBcSlip(slip)) continue;
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
let bcOddsLatch = { odds: 0, source: '', at: 0, key: '' };

function isBcSlipOddsSource(slip) {
  if (!slip) return false;
  if (slip.fromSlip === true || slip.source === 'slip-latched') return true;
  const kind = slip.sourceKind || '';
  const method = slip.method || '';
  if (kind === 'sports-board-selected' || kind === 'sports-board') return false;
  if (method === 'board-selected' || method === 'scrape-main') return false;
  return kind === 'bc-native-slip' || kind === 'sports-slip' || kind === 'bc-api'
    || (slip.fromPayout && slip.stake > 0)
    || /shadow-slip|bet-btn|stake-input|near-stake|betby-outcome|coupon|api-cache|slip-root/i.test(method);
}

function acceptBcSlipForScan(slip) {
  slip = normalizePolySlip(slip);
  if (!(slip?.odds > 1.01) || !isTrustedBcSlip(slip)) return null;
  const fin = finalizeBcPolySlip(slip);
  if (fin) return fin;
  return { ...slip, odds: Math.round(slip.odds * 1000) / 1000 };
}

function finalizeBcPolySlip(slip) {
  slip = normalizePolySlip(slip);
  if (!(slip?.odds > 1.01)) {
    if (slip?._slipClosed) bcOddsLatch = { odds: 0, source: '', at: 0, key: '' };
    return slip;
  }
  if (!isBcSlipOddsSource(slip)) return null;
  const o = Math.round(slip.odds * 1000) / 1000;
  const key = `${slip.teamLabel || slip.selectionText || ''}_${slip.eventText || ''}`;
  bcOddsLatch = { odds: o, source: 'slip', at: Date.now(), key };
  return { ...slip, odds: o, fromSlip: true };
}

function cachePolyOdds(tabId, slip) {
  if (!tabId || !isTrustedBcSlip(slip)) return;
  polyOddsCache.set(tabId, { slip: { ...slip }, at: Date.now() });
}

function getCachedPolyOdds(tabId, maxAgeMs = 4000) {
  const hit = polyOddsCache.get(tabId);
  if (!hit || Date.now() - hit.at > maxAgeMs) return null;
  return hit.slip;
}

function mergePolySlipWithCache(tabId, slip) {
  slip = finalizeBcPolySlip(normalizePolySlip(slip));
  if (!slip?.odds || slip.odds <= 1 || slip._slipClosed) {
    polyOddsCache.delete(tabId);
    return slip;
  }
  if (slip?.odds > 1) {
    const cached = getCachedPolyOdds(tabId, 8000);
    if (cached?.odds > 1 && isScanBcSlip(cached) && isScanBcSlip(slip)
      && typeof stabilizeSportsOdds === 'function'
      && oddsDelta(cached.odds, slip.odds) < ODDS_NOISE_EPS) {
      slip = { ...slip, odds: stabilizeSportsOdds(cached.odds, slip.odds) };
    } else if (typeof normalizeSportsOdds === 'function') {
      slip = { ...slip, odds: normalizeSportsOdds(slip.odds) || slip.odds };
    }
  }
  if (slip?.odds > 1 && isScanBcSlip(slip)) {
    cachePolyOdds(tabId, slip);
    return slip;
  }
  if (slip?.odds > 1 && isTrustedBcSlip(slip)) return slip;
  if (!slip?.odds || slip.odds <= 1) {
    polyOddsCache.delete(tabId);
    return slip;
  }
  const pending = slip?.pendingToWin || slip?.needsStake;
  if (!pending) return slip;
  const cached = getCachedPolyOdds(tabId, 2000);
  if (!cached || !isStrikeBcSlip(cached)) return slip;
  return {
    ...cached,
    stake: slip?.stake > 0 ? slip.stake : cached.stake,
    pendingToWin: true,
    hint: slip?.hint || cached.hint
  };
}

function normalizePolySlip(slip) {
  if (!slip) return slip;
  if (slip.odds > 1) {
    const n = typeof normalizeSportsOdds === 'function' ? normalizeSportsOdds(slip.odds) : slip.odds;
    if (n) return { ...slip, odds: n };
    return slip;
  }
  const cents = slip.priceCents || (slip.price > 0 && slip.price < 1 ? slip.price * 100 : null);
  if (cents > 0 && cents < 100) {
    const odds = 100 / cents;
    if (odds > 1.001 && odds < 100) {
      return { ...slip, odds, priceCents: cents, liveCents: true };
    }
  }
  return slip;
}

function isTrustedBcSlip(slip) {
  if (!(slip?.odds > 1.01)) return false;
  const src = slip.source || '';
  const kind = slip.sourceKind || '';
  if (src === 'stake' || kind === 'stake-native-slip' || kind === 'stake-api' || kind === 'stake-board-selected') {
    if (slip.odds > 12 && !(slip.fromPayout && slip.stake > 0)) return false;
    return true;
  }
  if (kind === 'sports-text') return false;
  const confirmed = slip.fromPayout && slip.stake > 0;
  const hasSelection = !!(slip.teamLabel || slip.outcome || slip.selectionText || slip.eventText);
  if (slip.odds > 12 && !confirmed) return false;
  if (slip.odds > 5.5 && !confirmed && (kind === 'sports-board-selected' || slip.method === 'board-selected')) return false;
  if (kind === 'bc-native-slip' && !confirmed && !hasSelection && !(slip.hasInput || slip.inputCount > 0 || slip.method)) return false;
  if (confirmed) return true;
  if (kind === 'bc-native-slip' || kind === 'bc-api' || kind === 'sports-slip') return true;
  if (kind === 'sports-board-selected' || slip.method === 'board-selected') return true;
  if (kind === 'sports-board') return slip.selected === true;
  if ((slip.hasInput || slip.inputCount > 0 || slip.stake > 0) && slip.odds >= 1.01 && slip.odds <= 8) return true;
  if (slip.method && /near-stake|betby-outcome|shadow-slip|bet-btn|stake-input|coupon|api-cache|scrape-main/i.test(slip.method)) return true;
  return false;
}

function isScanBcSlip(slip) {
  return isTrustedBcSlip(slip);
}

/** 자동배팅용 — 슬립 카트에 실제 선택이 있을 때만 (보드/내역/캐시 오탐 제외) */
function isStrikeBcSlip(slip) {
  if (!isTrustedBcSlip(slip)) return false;
  const kind = slip.sourceKind || '';
  const method = slip.method || '';
  if (kind === 'stake-board-selected' || method === 'board-selected') return false;
  if (kind === 'sports-board-selected' || kind === 'sports-board' || method === 'board-selected') return false;
  if (/storage|window-|script-json|all-text|board-selected/i.test(method)) return false;
  if (kind === 'bc-api' && slip.capturedAt && Date.now() - slip.capturedAt > 120000) return false;
  return kind === 'bc-native-slip' || kind === 'sports-slip' || kind === 'bc-api'
    || (slip.fromPayout && slip.stake > 0)
    || /shadow-slip|bet-btn|stake-input|near-stake|betby-outcome|coupon|api-cache/i.test(method);
}

function isRelaxedBcSlip(slip) {
  if (!(slip?.odds > 1.01 && slip.odds <= 8)) return false;
  if (slip.sourceKind === 'sports-text') return false;
  return !!(slip.hasInput || slip.inputCount > 0 || slip.stake > 0 || slip.fromPayout || slip.method);
}

function scorePolySlip(slip) {
  slip = normalizePolySlip(slip);
  if (!(slip?.odds > 1)) return -1;
  let score = 0;
  if (slip.sourceKind === 'bc-native-slip') score += 300;
  else if (slip.sourceKind === 'bc-api') score += 280;
  else if (slip.fromPayout && !slip.pendingToWin) score += 200;
  else if (slip.sourceKind === 'sports-slip') score += 240;
  else if (slip.sourceKind === 'sports-board-selected') score -= 120;
  else if (slip.sourceKind === 'sports-board') score -= 80;
  else if (slip.sourceKind === 'sports-text') score -= 500;
  else if (slip.liveCents || slip.source === 'poly-scrape') score += 40;
  if (slip.fromPayout && slip.stake > 0) score += 150;
  if (slip.stake > 0) score += 30;
  if (slip.pendingToWin) score -= 40;
  if (slip.odds > 8 && !slip.fromPayout) score -= 200;
  else if (slip.odds > 5.5 && !slip.fromPayout) score -= 80;
  if (slip.odds >= 1.05 && slip.odds <= 3.5) score += 15;
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

async function ensureBcApiHook(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['bc_api_hook.js'],
      world: 'MAIN'
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function focusBcTabForRead(tabId, waitMs = 1200) {
  if (!tabId) return null;
  try {
    const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const prevId = cur?.id;
    if (prevId === tabId) {
      await new Promise((r) => setTimeout(r, waitMs));
      return prevId;
    }
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise((r) => setTimeout(r, waitMs));
    return prevId;
  } catch (_) {
    return null;
  }
}

async function readBcApiSlipAllFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        const api = window.__bcApiSlip;
        if (api?.odds > 1.01 && Date.now() - (api.capturedAt || 0) < 180000) {
          return { ...api, sourceKind: 'bc-api' };
        }
        return null;
      }
    });
    let best = null;
    for (const row of results || []) {
      const hit = row?.result;
      if (!isTrustedBcSlip(hit)) continue;
      const s = scorePolySlip(hit);
      if (s > (best?._score ?? -1)) best = { ...hit, frameId: row.frameId, _score: s };
    }
    return isTrustedBcSlip(best) ? best : null;
  } catch (_) {
    return null;
  }
}

async function injectBcSlipAllFrames(tabId) {
  try {
    const frames = await getAllFrames(tabId);
    await ensureBcApiHook(tabId);
    await ensureBcScrapeScript(tabId);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['bc_slip_read.js']
    });
    const [nativeRows, mainRows] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => (typeof window.__bcReadNativeSlip === 'function' ? window.__bcReadNativeSlip() : null)
      }),
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: () => {
          const hits = [];
          try {
            const scraped = typeof window.__bcScrapeOdds === 'function' ? window.__bcScrapeOdds() : null;
            if (scraped?.ok && scraped.odds > 1.01) {
              hits.push({
                ok: true,
                odds: scraped.odds,
                stake: scraped.stake,
                payout: scraped.payout,
                teamLabel: scraped.teamLabel || scraped.selectionText || '',
                sourceKind: scraped.sourceKind || 'sports-board',
                fromPayout: scraped.fromPayout,
                hasInput: scraped.hasInput,
                method: 'scrape-main'
              });
            }
          } catch (_) {}
          try {
            const api = window.__bcApiSlip;
            if (api?.odds > 1.01 && Date.now() - (api.capturedAt || 0) < 180000) {
              hits.push({ ok: true, ...api, sourceKind: 'bc-api', method: 'api-cache' });
            }
          } catch (_) {}
          if (!hits.length) return null;
          hits.sort((a, b) => scorePolySlip(normalizePolySlip(b)) - scorePolySlip(normalizePolySlip(a)));
          return hits[0];
        }
      })
    ]);

    const byFrame = new Map();
    const absorb = (rows) => {
      for (const row of rows || []) {
        const frameId = row?.frameId ?? 0;
        const hit = row?.result;
        if (!hit?.ok || !(hit.odds > 1.01)) continue;
        const slip = { ...hit };
        delete slip.ok;
        delete slip.reason;
        delete slip.sample;
        delete slip.textLen;
        delete slip.inputCount;
        delete slip.flags;
        delete slip.href;
        if (!isTrustedBcSlip(slip)) continue;
        let s = scorePolySlip(slip);
        const frameUrl = frames.find((f) => f.frameId === frameId)?.url || '';
        if (typeof isBcBetbyFrameUrl === 'function' ? isBcBetbyFrameUrl(frameUrl) : /betby|sptpub|biahosted|sptsportscdn|cocoesports|bti-sports/i.test(frameUrl)) s += 120;
        if (frameId > 0 && (typeof isBcBetbyFrameUrl === 'function' ? isBcBetbyFrameUrl(frameUrl) : /betby|sptpub|biahosted|sptsportscdn|cocoesports/i.test(frameUrl))) s += 80;
        const prev = byFrame.get(frameId);
        if (!prev || s > prev._score) byFrame.set(frameId, { ...slip, frameId, frameUrl, _score: s });
      }
    };
    absorb(nativeRows);
    absorb(mainRows);

    let best = null;
    let relaxed = null;
    for (const v of byFrame.values()) {
      if (v._score > (best?._score ?? -1)) best = v;
      if (isRelaxedBcSlip(v)) {
        const rs = scorePolySlip(v);
        if (rs > (relaxed?._rscore ?? -1)) relaxed = { ...v, _rscore: rs };
      }
    }
    if (best?.odds > 1.01 && isTrustedBcSlip(best)) return finalizeBcPolySlip(best);
    if (relaxed?.odds > 1.01) return finalizeBcPolySlip(relaxed);
    return null;
  } catch (_) {
    return null;
  }
}

async function autoOpenBcSportsSlip(tabId, teamHint) {
  if (!tabId || !teamHint) return false;
  try {
    await ensurePolyScript(tabId);
    const res = await withTimeout(
      sendPoly(tabId, { type: 'ENSURE_POLY_PANEL', team: teamHint }),
      5000,
      'BC배당클릭'
    );
    return !!(res?.ok || res?.alreadyOpen);
  } catch (_) {
    return false;
  }
}

async function readBcSportsNativeSlip(polyTab, opts = {}) {
  if (!polyTab?.id) return null;
  const fastScan = opts.fastScan === true;
  const focusTab = opts.focusTab === true;
  const waitMs = opts.waitMs || (focusTab && !fastScan ? 2000 : 0);
  const teamHint = opts.teamHint || opts.excludeTeam || '';
  const maxAttempts = fastScan ? 2 : (focusTab ? 6 : 2);

  if (focusTab && waitMs > 0) await focusBcTabForRead(polyTab.id, waitMs);
  if (focusTab) {
    await waitForBetbyRenderer(polyTab.id, fastScan ? 2500 : 8000);
    await waitForBcSportsFrame(polyTab.id, fastScan ? 2000 : 6000);
  }
  await ensurePolyScript(polyTab.id);
  await ensureBcApiHook(polyTab.id);

  let clicked = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const apiHit = await readBcApiSlipAllFrames(polyTab.id);
    if (isTrustedBcSlip(apiHit)) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: apiHit.frameId ?? 0 };
      return apiHit;
    }

    const hit = await injectBcSlipAllFrames(polyTab.id);
    if (isTrustedBcSlip(hit)) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: hit.frameId };
      return hit;
    }
    if (isRelaxedBcSlip(hit) && attempt >= maxAttempts - 2) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: hit.frameId };
      return hit;
    }

    const perFrame = await readBcSportsPerFrameDeep(polyTab);
    if (isTrustedBcSlip(perFrame)) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: perFrame.frameId };
      return perFrame;
    }

    const frames = await orderBcLeg2FrameIds(polyTab.id, polyTab.url);
    for (const frameId of frames.slice(0, 8)) {
      try {
        await ensurePolyScript(polyTab.id, frameId);
        const res = await withTimeout(sendPoly(polyTab.id, { type: 'READ_SLIP' }, frameId), 3500, 'BC cs-read');
        const slip = res?.slip;
        if (isTrustedBcSlip(slip)) {
          lastBcLeg2Frame = { tabId: polyTab.id, frameId };
          return { ...slip, frameId };
        }
      } catch (_) {}
    }

    if (!clicked && teamHint && focusTab && attempt >= 2) {
      clicked = await autoOpenBcSportsSlip(polyTab.id, teamHint);
      if (clicked) await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, focusTab ? 500 : 300));
  }
  return null;
}

async function probeBcSlipFrames(polyTab) {
  if (!polyTab?.id) return [];
  const frames = await getAllFrames(polyTab.id);
  await ensurePolyScript(polyTab.id);
  await ensureBcScrapeScript(polyTab.id);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, allFrames: true },
      files: ['bc_slip_read.js']
    });
    const [isoResults, mainResults] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId: polyTab.id, allFrames: true },
        func: () => {
          const slip = typeof window.__bcReadNativeSlip === 'function' ? window.__bcReadNativeSlip() : null;
          const diag = typeof window.__bcDiagReport === 'function' ? window.__bcDiagReport() : null;
          return { slip, diag };
        }
      }),
      chrome.scripting.executeScript({
        target: { tabId: polyTab.id, allFrames: true },
        world: 'MAIN',
        func: () => {
          const scraped = typeof window.__bcScrapeOdds === 'function' ? window.__bcScrapeOdds() : null;
          const api = window.__bcApiSlip;
          const iframes = typeof window.__bcDiscoverIframes === 'function' ? window.__bcDiscoverIframes() : [];
          const btReady = !!window.BTRenderer;
          return {
            scraped: scraped?.ok ? scraped : null,
            api: api?.odds > 1.01 ? api : null,
            ver: window.__bcScrapeVer || 0,
            iframes,
            btReady
          };
        }
      })
    ]);
    const mainByFrame = new Map((mainResults || []).map((r) => [r.frameId ?? 0, r.result]));
    const out = [];
    for (const row of isoResults || []) {
      const hit = row?.result?.slip;
      const diag = row?.result?.diag;
      const main = mainByFrame.get(row?.frameId ?? 0) || {};
      const frameId = row?.frameId ?? 0;
      const frame = frames.find((f) => f.frameId === frameId);
      const url = (frame?.url || hit?.href || diag?.url || '').replace(/^https?:\/\//, '').slice(0, 72);
      const scrapeOdds = main.scraped?.odds;
      const bestOdds = hit?.ok && hit.odds > 1.01 ? hit.odds : (scrapeOdds > 1.01 ? scrapeOdds : null);
      if (bestOdds > 1.01) {
        const kind = hit?.ok ? (hit.sourceKind || hit.method || 'bc-native-slip') : (main.scraped?.sourceKind || 'sports-board');
        out.push({ frameId, url, odds: bestOdds, kind, inputs: hit?.inputCount ?? diag?.inputCount });
      } else {
        const flags = hit?.flags ? ` slip${hit.flags.slip ? 1 : 0} win${hit.flags.win ? 1 : 0} usdt${hit.flags.usdt ? 1 : 0} btn${hit.flags.betBtn ? 1 : 0}` : '';
        const selOdds = diag?.selectedOdds?.map((b) => b.t).join(', ') || '';
        const apiOdds = main.api?.odds || diag?.apiSlip?.odds;
        const iframeHint = (main.iframes || [])
          .filter((i) => i.w > 40 && i.h > 40 && !/hcaptcha|captcha|tracker/i.test(i.src || ''))
          .map((i) => (i.src || '').replace(/^https?:\/\//, '').slice(0, 55))
          .join(' | ') || (main.btReady ? 'BTRenderer' : '');
        out.push({
          frameId,
          url,
          odds: null,
          kind: hit?.reason || main.scraped?.reason || 'miss',
          inputs: hit?.inputCount ?? diag?.inputCount ?? 0,
          len: hit?.textLen ?? diag?.textLen ?? main.scraped?.frameTextLen ?? 0,
          flags,
          selectedOdds: selOdds,
          scrapeOdds: scrapeOdds > 1.01 ? scrapeOdds : null,
          apiOdds: apiOdds > 1.01 ? apiOdds : null,
          stake: diag?.stake || main.scraped?.stake || null,
          sample: hit?.sample || diag?.sample || '',
          iframeHint,
          shadowIframes: (diag?.shadowIframes || []).slice(0, 2).join('|')
        });
      }
    }
    out.sort((a, b) => (b.odds || 0) - (a.odds || 0));
    const seen = new Set(out.map((p) => p.frameId));
    for (const f of frames) {
      if (seen.has(f.frameId)) continue;
      const url = (f.url || '').replace(/^https?:\/\//, '').slice(0, 72);
      if (f.frameId !== 0 && !/bc\.game|betby|sptpub|biahosted|sptsportscdn|cocoesports|bti-sports/i.test(url)) continue;
      out.push({ frameId: f.frameId, url, odds: null, kind: isBcFrameSkippable(f.url) ? 'skip-tracker' : 'no-inject', inputs: 0, len: 0, flags: '' });
    }
    out.sort((a, b) => (b.odds || 0) - (a.odds || 0));
    return out.filter((p) => p.frameId === 0 || /bc\.game|betby|sptpub|biahosted|sptsportscdn|cocoesports|bti-sports/i.test(p.url || ''));
  } catch (e) {
    return [{ frameId: -1, url: '', odds: null, kind: e.message || 'probe-fail' }];
  }
}

async function ensureStakeApiHook(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['stake_api_hook.js'],
      world: 'MAIN'
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function injectStakeSlipRead(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['stake_slip_read.js']
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => (typeof window.__stakeReadNativeSlip === 'function' ? window.__stakeReadNativeSlip() : null)
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function readStakeSportsSlip(polyTab, opts = {}) {
  if (!polyTab?.id) return null;
  const fastScan = opts.fastScan === true;
  const focusTab = opts.focusTab === true;
  const waitMs = opts.waitMs || (focusTab && !fastScan ? 1500 : 0);
  const maxAttempts = fastScan ? 2 : (focusTab ? 4 : 2);

  if (focusTab && waitMs > 0 && typeof focusBcTabForRead === 'function') {
    await focusBcTabForRead(polyTab.id, waitMs);
  }

  await ensureLeg2Script(polyTab.id, 0, polyTab.url);
  await ensureStakeApiHook(polyTab.id);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await withTimeout(sendPoly(polyTab.id, { type: 'READ_SLIP' }, 0), 3500, 'Stake read');
      if (isTrustedBcSlip(res?.slip)) {
        lastBcLeg2Frame = { tabId: polyTab.id, frameId: 0 };
        return res.slip;
      }
    } catch (_) {}

    const injected = await injectStakeSlipRead(polyTab.id);
    if (isTrustedBcSlip(injected)) {
      lastBcLeg2Frame = { tabId: polyTab.id, frameId: 0 };
      return injected;
    }

    if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, fastScan ? 250 : 400));
  }
  return null;
}

async function probeStakeSlipFrames(polyTab) {
  if (!polyTab?.id) return [];
  await ensureLeg2Script(polyTab.id, 0, polyTab.url);
  await ensureStakeApiHook(polyTab.id);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, allFrames: true },
      files: ['stake_slip_read.js']
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: polyTab.id, frameIds: [0] },
      func: () => {
        const slip = typeof window.__stakeReadNativeSlip === 'function' ? window.__stakeReadNativeSlip() : null;
        const diag = typeof window.__stakeDiagReport === 'function' ? window.__stakeDiagReport() : null;
        return { slip, diag };
      }
    });
    const hit = results?.[0]?.result;
    const slip = hit?.slip;
    const diag = hit?.diag;
    const url = (polyTab.url || '').replace(/^https?:\/\//, '').slice(0, 72);
    if (slip?.odds > 1.01) {
      return [{
        frameId: 0,
        url,
        odds: slip.odds,
        kind: slip.sourceKind || slip.method || 'stake-slip',
        inputs: diag?.inputCount || 0,
        len: diag?.textLen || 0,
        stake: slip.stake || null
      }];
    }
    return [{
      frameId: 0,
      url,
      odds: null,
      kind: diag?.hasBetBtn ? 'stake-no-odds' : 'stake-miss',
      inputs: diag?.inputCount || 0,
      len: diag?.textLen || 0,
      rootCount: diag?.rootCount || 0
    }];
  } catch (e) {
    return [{ frameId: 0, url: '', odds: null, kind: e.message || 'stake-probe-fail' }];
  }
}

async function probeLeg2SlipFrames(polyTab, leg2Pref) {
  const pref = leg2Pref || leg2SiteKey(polyTab?.url) || 'bcgame';
  if (pref === 'stake') return probeStakeSlipFrames(polyTab);
  return probeBcSlipFrames(polyTab);
}

async function readPolyOddsOnce(polyTab, opts = {}) {
  if (!polyTab?.id) return null;
  const siteKey = leg2SiteKey(polyTab.url) || opts.leg2Pref || 'bcgame';
  if (siteKey === 'stake') {
    const native = await readStakeSportsSlip(polyTab, opts);
    if (isStrikeBcSlip(native)) return mergePolySlipWithCache(polyTab.id, native);
    const scanHit = acceptBcSlipForScan(native);
    if (scanHit) return scanHit;
    polyOddsCache.delete(polyTab.id);
    return null;
  }

  const isSports = typeof isBcGameSportsUrl === 'function' && isBcGameSportsUrl(polyTab.url);

  if (isSports) {
    const native = await readBcSportsNativeSlip(polyTab, opts);
    if (isStrikeBcSlip(native)) return mergePolySlipWithCache(polyTab.id, native);
    const scanHit = acceptBcSlipForScan(native);
    if (scanHit) return scanHit;

    const leg2 = await readBcLeg2FromBtiFrames(polyTab);
    if (isStrikeBcSlip(leg2)) return mergePolySlipWithCache(polyTab.id, leg2);
    const leg2Scan = acceptBcSlipForScan(leg2);
    if (leg2Scan) return leg2Scan;

    const apiHit = await readBcApiSlipAllFrames(polyTab.id);
    const apiScan = acceptBcSlipForScan(apiHit);
    if (apiScan) return apiScan;

    const injected = await injectBcSlipAllFrames(polyTab.id);
    const injScan = acceptBcSlipForScan(injected);
    if (injScan) return injScan;

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
