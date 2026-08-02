// bc_sports_scrape.js — BC.Game 네이티브 슬립 + Betby/BTi MAIN world 스크랩
(function () {
  const SCRAPE_VER = 10;

  function openShadow(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    return null;
  }

  function collectPageText() {
    const parts = [];
    function walk(node, depth) {
      if (!node || depth > 120) return;
      if (node.nodeType === 3) {
        const t = node.textContent?.trim();
        if (t) parts.push(t);
        return;
      }
      if (node.nodeType !== 1) {
        if (node.nodeType === 11) {
          for (const c of node.childNodes) walk(c, depth + 1);
        }
        return;
      }
      const sr = openShadow(node);
      if (sr) walk(sr, depth + 1);
      for (const c of node.childNodes) walk(c, depth + 1);
    }
    walk(document.documentElement, 0);
    const deep = parts.join(' ').replace(/\s+/g, ' ').trim();
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return deep.length >= body.length ? deep : body;
  }

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

  function parseMoney(t) {
    const m = String(t || '').replace(/,/g, '').match(/([\d]+(?:\.\d+)?)/);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function collectRoots(node, out) {
    if (!node || out.length > 12000) return;
    if (node.nodeType === 1) {
      out.push(node);
      const sr = node.shadowRoot;
      if (sr) collectRoots(sr, out);
      const ch = node.children || [];
      for (let i = 0; i < ch.length; i++) collectRoots(ch[i], out);
    } else if (node.nodeType === 11) {
      for (const c of node.childNodes) collectRoots(c, out);
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
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const looksLikeOdds = /\d+\.\d{1,3}/.test(txt);
    if (!looksLikeOdds) return false;
    const cls = String(el.className || '');
    if (el.getAttribute('aria-pressed') === 'true') return true;
    if (el.getAttribute('aria-selected') === 'true') return true;
    if (el.getAttribute('data-selected') === 'true') return true;
    if (el.getAttribute('data-state') === 'on' || el.getAttribute('data-state') === 'checked') return true;
    if (/selected|active|pressed|highlight|checked|is-active|is-selected/i.test(cls)) return true;
    try {
      const st = getComputedStyle(el);
      if (parseFloat(st.borderWidth) >= 2) return true;
      const bg = st.backgroundColor || '';
      const m = bg.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) {
        const g = parseInt(m[2], 10);
        const r = parseInt(m[1], 10);
        if (g > 100 && g > r + 30) return true;
      }
    } catch (_) {}
    return false;
  }

  function findSlipRoot() {
    let best = null;
    let bestScore = -1;
    for (const el of queryDeep('div, section, aside, form, [class*="slip"], [class*="Slip"], [data-testid*="betslip"], [data-testid*="BetSlip"]')) {
      if (!vis(el)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/베팅\s*슬립|bet\s*slip|betslip|place\s*(a\s*)?bet|total\s*stake/i.test(t)) continue;
      const len = t.length;
      if (len < 25 || len > 6000) continue;
      let score = 0;
      if (/예상\s*당첨|총\s*베팅|potential\s*win|total\s*stake|total\s*odds/i.test(t)) score += 140;
      if (/베팅하기|place\s*(a\s*)?bet/i.test(t)) score += 100;
      if (/USDT/i.test(t)) score += 80;
      if (el.querySelector?.('input')) score += 70;
      if (/vs\.?|승자|맵\s*[-–]/i.test(t)) score += 40;
      if (/\d+\.\d{1,3}/.test(t)) score += 30;
      score += Math.min(len / 35, 60);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function parseNativeSlipText(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!/베팅\s*슬립|bet\s*slip|betslip/i.test(text) && !/place\s*(a\s*)?bet/i.test(text)) return null;
    if (!/예상\s*당첨|총\s*베팅|베팅하기|place\s*(a\s*)?bet|total\s*stake|potential\s*win|total\s*odds|stake/i.test(text)) return null;

    let stake = 0;
    let m = text.match(/총\s*베팅\s*금액\s*([\d,]+(?:\.\d+)?)/i);
    if (m) stake = parseMoney(m[1]);
    if (!stake) {
      m = text.match(/total\s*stake[^\d]{0,20}([\d,]+(?:\.\d+)?)/i);
      if (m) stake = parseMoney(m[1]);
    }
    if (!stake) {
      const usdtMatches = [...text.matchAll(/([\d,]+(?:\.\d+)?)\s*USDT/gi)];
      for (const hit of usdtMatches) {
        const v = parseMoney(hit[1]);
        if (v >= 1 && v <= 50000) { stake = v; break; }
      }
    }

    let payout = 0;
    m = text.match(/예상\s*당첨\s*금액\s*([\d,]+(?:\.\d+)?)/i);
    if (m) payout = parseMoney(m[1]);
    if (!payout) {
      m = text.match(/(?:potential\s*win|to\s*win|total\s*win)[^\d]{0,30}([\d,]+(?:\.\d+)?)/i);
      if (m) payout = parseMoney(m[1]);
    }

    let odds = null;
    if (stake > 0 && payout > stake) odds = Math.round((payout / stake) * 1000) / 1000;
    if (!odds) {
      m = text.match(/(?:total\s*odds?|combined\s*odds?|@)\s*[:=]?\s*(\d+\.\d{2,3})/i);
      if (m) odds = parseOdds(m[1]);
    }

    let teamLabel = '';
    let eventText = '';
    const vsM = text.match(/([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,40}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,40})/i);
    if (vsM) eventText = `${vsM[1].trim()} vs ${vsM[2].trim()}`;

    const afterMap = text.match(/(?:맵\s*[-–]\s*승자|세\s*번째\s*맵|네\s*번째\s*번?\s*맵|승자|winner)[^\dA-Za-z가-힣]{0,30}([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{2,40})/i);
    if (afterMap) teamLabel = afterMap[1].trim();

    if (!odds) {
      const skip = new Set([stake, payout, 10, 20, 50, 100, 300].filter((n) => n > 0));
      const nums = [...text.matchAll(/\b(\d+\.\d{1,3})\b/g)]
        .map((x) => parseOdds(x[1]))
        .filter((n) => n && n < 20 && !skip.has(n) && Math.abs(n - stake) > 0.4);
      if (nums.length) odds = nums[nums.length - 1];
    }

    if (!(odds > 1.01)) return null;
    return { odds, teamLabel, eventText, stake: stake || null, payout: payout || null };
  }

  function readNativeBcGameSlip() {
    const bodyText = collectPageText();
    let parsed = parseNativeSlipText(bodyText);
    if (parsed) {
      return {
        ...parsed,
        hasInput: !!findStakeInput(),
        sourceKind: 'bc-native-slip',
        fromPayout: !!(parsed.stake > 0 && parsed.payout > parsed.stake)
      };
    }

    const slipRoot = findSlipRoot();
    if (!slipRoot) return null;

    const raw = (slipRoot.innerText || slipRoot.textContent || '').replace(/\s+/g, ' ');
    parsed = parseNativeSlipText(raw);
    if (!parsed) return null;

    return {
      ...parsed,
      hasInput: !!findStakeInput(slipRoot),
      sourceKind: 'bc-native-slip',
      fromPayout: !!(parsed.stake > 0 && parsed.payout > parsed.stake)
    };
  }

  function findStakeInput(scope) {
    const root = scope || document;
    const inputs = scope ? Array.from(root.querySelectorAll('input, textarea')) : queryDeep('input, textarea');
    for (const inp of inputs) {
      if (!vis(inp)) continue;
      const blob = `${inp.id || ''} ${inp.className || ''} ${inp.placeholder || ''} ${inp.getAttribute('aria-label') || ''} ${inp.value || ''}`;
      if (/search|검색|email|password/i.test(blob)) continue;
      if (/USDT|usdt|counter|Counter|베팅|stake|amount|bet/i.test(blob)) return inp;
      const parentText = (inp.parentElement?.textContent || '').slice(0, 120);
      if (/USDT|총\s*베팅|베팅\s*금액/i.test(parentText)) return inp;
    }
    const slip = findSlipRoot();
    if (slip) {
      for (const inp of slip.querySelectorAll('input, textarea')) {
        if (vis(inp)) return inp;
      }
    }
    return document.getElementById('counter') || null;
  }

  function readStake(scope) {
    const inp = findStakeInput(scope);
    if (inp) {
      const v = parseMoney(inp.value || inp.getAttribute('value') || '');
      if (v > 0 && v < 100000) return v;
    }
    const raw = ((scope || findSlipRoot() || document.body)?.innerText || '').replace(/\s+/g, ' ');
    const m = raw.match(/총\s*베팅\s*금액\s*([\d,]+(?:\.\d+)?)/i);
    if (m) return parseMoney(m[1]);
    return 0;
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
    let m = txt.match(/(\d+\.\d{1,3})\s*$/);
    if (m) return parseOdds(m[1]);
    m = txt.match(/\b(\d+\.\d{1,3})\b/);
    if (m) return parseOdds(m[1]);
    if (/^\d+\.\d{1,3}$/.test(txt)) return parseOdds(txt);
    return null;
  }

  function collectOddsCandidates() {
    const selectors = [
      'button',
      '[role="button"]',
      '[data-testid*="outcome"]',
      '[data-testid*="Odds"]',
      '[data-testid*="odd"]',
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
        if (/login|sign\s*in|deposit|withdraw|cookie|menu|예약/i.test(txt)) continue;
        seen.add(el);
        out.push({ odds, txt, selected: isSelected(el), el });
      }
    }
    return out;
  }

  function findBetbySlipPanel() {
    for (const el of queryDeep('aside, section, div, form, [class*="betslip"], [class*="BetSlip"], [data-testid*="betslip"]')) {
      if (!vis(el)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 12 || t.length > 5000) continue;
      if (!/place\s*(a\s*)?bet|total\s*stake|bet\s*slip|betslip|베팅|stake/i.test(t)) continue;
      if (!/\d+\.\d{2,3}/.test(t)) continue;
      if (!el.querySelector('input, textarea, [contenteditable="true"]')) continue;
      return el;
    }
    return null;
  }

  function readSlipFromPanel() {
    const native = readNativeBcGameSlip();
    if (native?.odds > 1.01) return native;

    const betbyPanel = findBetbySlipPanel();
    if (betbyPanel) {
      const txt = (betbyPanel.textContent || '').replace(/\s+/g, ' ').trim();
      let odds = null;
      const om = txt.match(/(?:total\s*odds?|@|odds?\s*[:=])\s*(\d+\.\d{2,3})/i);
      if (om) odds = parseOdds(om[1]);
      if (!odds) {
        const nums = [...txt.matchAll(/\b(\d+\.\d{2,3})\b/g)].map((x) => parseOdds(x[1])).filter(Boolean);
        odds = nums.find((n) => n > 1.15 && n < 20) || nums[0];
      }
      if (odds > 1.01) {
        return {
          odds,
          hasInput: !!findStakeInput(betbyPanel),
          sourceKind: 'sports-slip',
          teamLabel: '',
          fromPayout: false
        };
      }
    }

    const hasInput = !!findStakeInput();
    const cards = queryDeep('[class*="bet"], [class*="Bet"], [class*="betslip"], [class*="Betslip"], [class*="bet-slip"]');
    for (const card of cards) {
      if (!vis(card)) continue;
      const txt = (card.textContent || '').trim();
      if (txt.length < 8 || txt.length > 1200) continue;
      const hasSlipMarkers = /W[12]|betInformation|selection|outcome|winner|우승|vs|대|map|맵|team|spirit|mouz|승자/i.test(txt);
      if (card.querySelector('input') && !hasSlipMarkers) continue;
      if (!hasSlipMarkers) continue;

      const titleEls = card.querySelectorAll('[class*="betInformation__title"], [class*="selection"], [class*="Selection"]');
      const selectionText = titleEls[0]?.textContent?.trim() || '';
      const eventEl = card.querySelector('[class*="eventName"], [class*="event-name"], [class*="EventName"]');
      const eventText = eventEl?.textContent?.trim() || '';

      for (const sp of card.querySelectorAll('[class*="odds"], [class*="Odds"], [class*="coeff"], span, div, b, strong')) {
        const own = (sp.textContent || '').trim();
        const o = /^\d+\.\d{1,3}$/.test(own) ? parseOdds(own) : parseOdds(sp.textContent);
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
      let teamLabel = slip.teamLabel || slip.selectionText || '';
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
      const stake = slip.stake || readStake();
      const fromPayout = !!(stake > 0 && slip.payout > stake);
      return {
        ok: true,
        source: 'bcgame',
        odds: slip.odds,
        teamLabel,
        outcome: teamLabel,
        selectionText: teamLabel,
        displayLabel: `${slip.odds.toFixed(3)}${stake > 0 ? ` · ${stake} USDT` : ''}`,
        stake: stake || null,
        payout: slip.payout || (fromPayout ? stake * slip.odds : null),
        sourceKind: slip.sourceKind || 'sports-slip',
        fromPayout,
        hasInput: slip.hasInput,
        href,
        frameTextLen: bodyLen
      };
    }

    const board = collectOddsCandidates();
    const onBcMain = /bc\.game/i.test(location.hostname);
    const bodyHasSlip = /베팅\s*슬립|bet\s*slip/i.test(document.body?.innerText || '');
    if (onBcMain && bodyHasSlip) {
      return { ok: false, reason: 'slip-parse-fail', href, bodyLen, hasInput: !!findStakeInput() };
    }

    if (!board.length) {
      if (onBcMain) {
        return { ok: false, reason: 'no-slip', href, bodyLen, boardCount: 0 };
      }
      return { ok: false, reason: 'no-odds', href, bodyLen, boardCount: 0 };
    }

    const sel = board.find((b) => b.selected);
    if (!sel) {
      return { ok: false, reason: 'no-selection', href, bodyLen, boardCount: board.length };
    }
    return {
      ok: true,
      source: 'bcgame',
      odds: sel.odds,
      teamLabel: sel.txt,
      outcome: sel.txt,
      selectionText: sel.txt,
      displayLabel: sel.odds.toFixed(3),
      sourceKind: 'sports-board-selected',
      selected: true,
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
    const rounded = Math.max(0.01, Math.round(amount * 100) / 100);
    const inp = findStakeInput();
    if (!inp) return { ok: false, reason: 'stake-input-missing' };
    const str = String(rounded);
    inp.focus?.();
    inp.value = str;
    inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertFromPaste' }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    let stake = readStake();
    if (!stake || Math.abs(stake - rounded) > 0.5) {
      inp.value = `${str} USDT`;
      inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertFromPaste' }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      stake = readStake();
    }
    return { ok: stake > 0, stake, method: 'native-usdt', target: rounded };
  }

  function findBetButton() {
    const btns = queryDeep('button, [role="button"]');
    for (const btn of btns) {
      if (!vis(btn) || btn.disabled) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (t === '베팅하기' || /^place\s*bet$/i.test(t)) return btn;
    }
    for (const btn of btns) {
      if (!vis(btn) || btn.disabled) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (/배당\s*수락|bet\s*now|^bet$/i.test(t)) return btn;
      if ((btn.className || '').includes('sportsbook-Button') && /베팅하기|베팅/i.test(t)) return btn;
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

  window.__bcScrapeVer = SCRAPE_VER;
  window.__bcScrapeOdds = scrapeBcSportsOdds;
  window.__bcSetStake = setStakeAmount;
  window.__bcPlaceSportsBet = placeBcSportsBet;

  if (/betby|sptpub|biahosted|sptsportscdn|cocoesports/i.test(location.hostname)) {
    console.log(`[BC.Game BetBy frame scrape v${SCRAPE_VER}] ${location.hostname}`);
  }
})();
