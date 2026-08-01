// Polymarket / BC.Game content script v5 — To win 기반 배당 (텐텐뱃 양방 전용)

function predictionSiteId() {
  try {
    if (/bc\.game/i.test(location.hostname)) return 'bcgame';
  } catch (_) {}
  return 'polymarket';
}

const RE_WIN_LABEL = /\bto\s*win\b|우승|당첨(금)?|획득|예상\s*수익/i;
const RE_AMOUNT_LABEL = /\bamount\b|금액/i;
const RE_BUY_LABEL = /\bbuy\b|매수|구매/i;
const RE_SELL_LABEL = /\bsell\b|매도|판매/i;
const RE_AVG_PRICE = /avg\.?\s*price|average\s*price|평균\s*가격/i;
const RE_AMOUNT_USDT = /(?:amount|금액)\s*\(\s*usdt\s*\)/i;

function parseNumberToken(s) {
  const v = parseFloat(String(s || '').replace(/,/g, '').replace(/[+,\s]/g, ''));
  return Number.isFinite(v) ? v : NaN;
}

function findWinLabelIndex(text) {
  const t = String(text || '');
  const patterns = [/\bto\s*win\b/i, /우승/, /당첨(?:금)?/, /획득/, /예상\s*수익/];
  let best = -1;
  for (const re of patterns) {
    const m = t.match(re);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
}

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function isBuySellTab(btn) {
  const t = (btn?.textContent || '').replace(/\s+/g, ' ').trim();
  return /^(Buy|Sell|매수|매도|구매|판매)$/i.test(t);
}

function isSearchInput(inp) {
  const blob = `${inp?.placeholder || ''} ${inp?.getAttribute?.('aria-label') || ''} ${inp?.id || ''}`.toLowerCase();
  return /search|검색/.test(blob);
}

function parseMoneyValue(text) {
  const t = String(text || '').trim();
  let m = t.match(/^\+?\s*([\d,]+(?:\.\d+)?)\s*USDT/i);
  if (m) {
    const v = parseNumberToken(m[1]);
    if (v > 0) return v;
  }
  m = t.match(/^\$?\s*([\d,]+(?:\.\d+)?)/);
  if (m) {
    const v = parseNumberToken(m[1]);
    if (v > 0) return v;
  }
  m = t.match(/^≈\s*US?\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (m) {
    const v = parseNumberToken(m[1]);
    if (v > 0) return v;
  }
  return null;
}

function scoreTradePanelText(t) {
  const hasToWin = RE_WIN_LABEL.test(t);
  const hasAmount = RE_AMOUNT_LABEL.test(t);
  const hasBuy = RE_BUY_LABEL.test(t);
  const hasShares = /\bshares\b/i.test(t);
  if (!hasToWin && !hasAmount && !(hasBuy && hasShares)) return -1;
  if (hasAmount && !hasBuy && !hasToWin && !hasShares) return -1;

  let score = 0;
  if (hasAmount) score += 35;
  if (hasBuy) score += 30;
  if (hasToWin) score += 25;
  if (hasShares) score += 20;
  if (/\blimit\b/i.test(t) || /\bmarket\b/i.test(t) || /마켓/i.test(t)) score += 15;
  if (RE_AVG_PRICE.test(t)) score += 20;

  if (t.length <= 450) score += 160;
  else if (t.length <= 900) score += 90;
  else if (t.length > 2000) score -= 280;
  else if (t.length > 1200) score -= 120;
  else score += Math.min(t.length / 40, 15);

  if (RE_AMOUNT_USDT.test(t)) score += 45;
  if (/\b(?:buy|구매)\s+(yes|no|예|아니오)\b/i.test(t)) score += 40;
  const amtIdx = t.search(RE_AMOUNT_LABEL);
  const winIdx = findWinLabelIndex(t);
  if (amtIdx >= 0 && winIdx >= 0 && Math.abs(amtIdx - winIdx) < 450) score += 75;

  if (/\+\s*\$1\s*@\s*1\s*¢/i.test(t)) score -= 120;
  if (t.length < 40) score -= 50;
  return score;
}

function findTradePanel() {
  let best = null;
  let bestScore = -1;
  for (const el of document.querySelectorAll('div, section, aside, form')) {
    if (!visible(el)) continue;
    const t = el.innerText || '';
    if (!el.querySelector('input, [contenteditable="true"]')) continue;
    if (t.length > 8000) continue;

    const score = scoreTradePanelText(t);
    if (score < 0) continue;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findButtonByText(pattern, root) {
  const scope = root || document.body;
  for (const btn of scope.querySelectorAll('button, [role="button"], a')) {
    if (!visible(btn) || btn.disabled) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (pattern.test(t)) return btn;
  }
  return null;
}

function findAmountInput(panel) {
  const root = panel || findTradePanel() || document;

  for (const label of root.querySelectorAll('label, span, p, div')) {
    const lt = (label.textContent || '').trim();
    if (!/^amount/i.test(lt) && !/^금액/i.test(lt)) continue;
    const box = label.closest('div') || label.parentElement;
    const inp = box?.querySelector('input, textarea, [contenteditable="true"]');
    if (inp && visible(inp) && !isSearchInput(inp)) return inp;
  }

  const inputs = Array.from(root.querySelectorAll('input, textarea, [contenteditable="true"]'))
    .filter((inp) => visible(inp) && !isSearchInput(inp));
  for (const inp of inputs) {
    const ph = (inp.placeholder || '').toLowerCase();
    const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
    const name = (inp.getAttribute('name') || '').toLowerCase();
    if (ph.includes('amount') || ph.includes('$') || ph.includes('usdt')
      || aria.includes('amount') || name.includes('amount')) {
      return inp;
    }
  }

  const panelInputs = inputs.filter((inp) => !panel || panel.contains(inp));
  for (const inp of panelInputs) {
    const type = (inp.getAttribute('type') || '').toLowerCase();
    if (type === 'number' || type === 'text' || type === '' || inp.isContentEditable) return inp;
  }
  return panelInputs[0] || root.querySelector('input:not([placeholder*="earch" i])');
}

function readFieldValue(el) {
  if (!el) return null;
  const raw = el.isContentEditable ? el.textContent : el.value;
  const v = parseFloat(String(raw || '').replace(/[$,\s]/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function readStake(panel) {
  return readFieldValue(findAmountInput(panel));
}

function readPanelStake(panel) {
  const panelEl = panel || findTradePanel();
  if (!panelEl) return readStake(null);

  const inp = findAmountInput(panelEl);
  if (inp) {
    for (const raw of [
      inp.value,
      inp.getAttribute('value'),
      inp.textContent,
      inp.getAttribute('aria-valuenow'),
      inp.getAttribute('data-value')
    ]) {
      const v = parseFloat(String(raw || '').replace(/[$,\s]/g, ''));
      if (Number.isFinite(v) && v > 0) return v;
    }
    const box = inp.closest('div') || inp.parentElement;
    if (box) {
      const bm = (box.textContent || '').match(/\$\s*([\d,]+(?:\.\d+)?)/);
      if (bm) {
        const v = parseFloat(bm[1].replace(/,/g, ''));
        if (v > 0 && v < 100000) return v;
      }
    }
  }

  const fromInput = readStake(panelEl);
  if (fromInput) return fromInput;

  const text = (panelEl.innerText || '').replace(/\s+/g, ' ');
  const patterns = [
    /(?:Amount|금액)(?:\(USDT\))?\s*\n?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\bamount\b[^$\d]{0,20}\$?\s*([\d,]+(?:\.\d+)?)/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (v > 0 && v < 100000) return v;
  }

  return null;
}

function parseMoneyOnly(text) {
  return parseMoneyValue(text);
}

function isCentPriceContext(ctx, value) {
  if (/¢/.test(ctx)) return true;
  if (/\b(?:avg\.?\s*)?price\b/i.test(ctx) && value > 0 && value <= 99) return true;
  return false;
}

function isValidPayout(value, stake, ctx) {
  if (!value || value <= 0) return false;
  if (stake && Math.abs(value - stake) < 0.02) return false;
  if (isCentPriceContext(ctx, value)) return false;
  const hasDecimals = Math.abs(value - Math.round(value)) > 0.001;
  if (hasDecimals) return true;
  if (stake && value >= stake * 1.35) return true;
  return false;
}

function readToWinNearLabel(panel) {
  const raw = (panel?.innerText || '').replace(/\s+/g, ' ');
  const idx = findWinLabelIndex(raw);
  if (idx < 0) return null;
  const section = raw.slice(idx, idx + 200);
  const patterns = [
    /(?:to\s*win|우승|당첨(?:금)?|획득|예상\s*수익)[\s\S]{0,100}?([+]?\s*[\d,]+(?:\.\d+)?)\s*USDT/i,
    /(?:to\s*win|우승|당첨(?:금)?|획득|예상\s*수익)[\s\S]{0,100}?≈\s*US?\$?\s*([\d,]+(?:\.\d+)?)/i,
    /(?:to\s*win|우승|당첨(?:금)?|획득|예상\s*수익)[\s\S]{0,100}?\$\s*([\d,]+(?:\.\d+)?)/i
  ];
  for (const re of patterns) {
    const m = section.match(re);
    if (!m) continue;
    const v = parseNumberToken(m[1]);
    if (v > 0) return v;
  }
  return null;
}

function readToWinFromPanel(panel) {
  const panelEl = panel || findTradePanel();
  const near = readToWinNearLabel(panelEl);
  if (near) return near;

  const scopes = [panelEl, document.body].filter(Boolean);
  const values = [];

  for (const scope of scopes) {
    const raw = scope.innerText || '';
    const winPatterns = [/\bto\s*win\b/gi, /우승/g, /당첨(?:금)?/g, /획득/g];
    for (const winRe of winPatterns) {
      for (const match of raw.matchAll(winRe)) {
        const section = raw.slice(match.index, match.index + 500);
        for (const m of section.matchAll(/\+?\s*([\d,]+(?:\.\d+)?)\s*USDT/gi)) {
          const v = parseNumberToken(m[1]);
          const ctx = section.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24);
          if (RE_AVG_PRICE.test(ctx) || /(?:amount|금액)\s*\(|사용\s*가능|available|slippage|슬리피지/i.test(ctx)) continue;
          if (v >= 0.01) values.push({ v, score: 135 });
        }
        for (const m of section.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)) {
          const v = parseNumberToken(m[1]);
          const ctx = section.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24);
          if (RE_AVG_PRICE.test(ctx) || /¢|price\s*\d|≈/i.test(ctx)) continue;
          if (v >= 0.5) values.push({ v, score: 120 });
        }
        for (const m of section.matchAll(/\b([\d,]+\.\d{2})\b/g)) {
          const ctx = section.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24);
          if (RE_AVG_PRICE.test(ctx) || /¢|amount|금액/i.test(ctx)) continue;
          const v = parseNumberToken(m[1]);
          if (v >= 0.5) values.push({ v, score: 100 });
        }
      }
    }

    for (const el of scope.querySelectorAll('*')) {
      const own = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^to\s*win$/i.test(own) && !/^우승$/i.test(own) && !/^당첨(?:금)?$/i.test(own)) continue;

      let box = el.parentElement;
      for (let d = 0; d < 6 && box; d++) {
        for (const node of box.querySelectorAll('span, div, p, strong, h1, h2, h3')) {
          if (node.children.length > 3) continue;
          const t = (node.textContent || '').trim();
          if (/avg\.?\s*price|¢/i.test(t)) continue;
          let v = parseMoneyOnly(t);
          if (!v) {
            const m = t.match(/^\$?\s*([\d,]+(?:\.\d+)?)/);
            if (m) v = parseFloat(m[1].replace(/,/g, ''));
          }
          if (!v || v < 0.5) continue;
          let score = 90 - d * 8;
          try {
            const fs = parseFloat(getComputedStyle(node).fontSize || '0');
            if (fs >= 18) score += 40;
          } catch (_) {}
          values.push({ v, score });
        }
        box = box.parentElement;
      }
    }
  }

  if (!values.length) return null;
  values.sort((a, b) => b.score - a.score || b.v - a.v);
  return values[0].v;
}

function readPayoutAmount(panel, stake) {
  const fromNear = readToWinNearLabel(panel || findTradePanel());
  if (fromNear) return fromNear;

  const fromPanel = readToWinFromPanel(panel);
  if (fromPanel) return fromPanel;

  const scopes = [panel, document.body].filter(Boolean);
  const values = [];

  for (const scope of scopes) {
    const raw = scope.innerText || '';
    for (const match of raw.matchAll(/to\s*win/gi)) {
      const section = raw.slice(match.index, match.index + 600);
      for (const m of section.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        const ctx = section.slice(Math.max(0, m.index - 8), m.index + m[0].length + 8);
        if (isValidPayout(v, stake, ctx)) values.push(v);
      }
      for (const m of section.matchAll(/\b([\d,]+\.\d{2})\b/g)) {
        const lineStart = section.lastIndexOf('\n', m.index) + 1;
        const lineEnd = section.indexOf('\n', m.index);
        const line = section.slice(lineStart, lineEnd === -1 ? section.length : lineEnd);
        if (/¢/.test(line)) continue;
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (isValidPayout(v, stake, line)) values.push(v);
      }
    }

    for (const el of scope.querySelectorAll('*')) {
      const own = (el.textContent || '').trim();
      if (!/^to\s*win/i.test(own.replace(/[^\w\s]/gi, ''))) continue;
      let node = el.nextElementSibling;
      for (let i = 0; i < 8 && node; i++) {
        const nt = (node.textContent || '').trim();
        if (/¢|avg\.?\s*price/i.test(nt)) { node = node.nextElementSibling; continue; }
        const v = parseMoneyOnly(nt);
        if (v && isValidPayout(v, stake, nt)) values.push(v);
        node = node.nextElementSibling;
      }
    }
  }

  return values.length ? Math.max(...values) : null;
}

const MIN_POLY_CENTS = 1;
const MAX_POLY_CENTS = 99;

function isValidPolyCents(c) {
  return Number.isFinite(c) && c >= MIN_POLY_CENTS && c < MAX_POLY_CENTS;
}

function readListedPriceCents(panel) {
  const t = (panel?.innerText || '').replace(/\s+/g, ' ');
  const candidates = [];
  const specs = [
    { re: /avg\.?\s*price\s*(\d+(?:\.\d+)?)\s*¢/gi, score: 120 },
    { re: /average\s*price\s*(\d+(?:\.\d+)?)\s*¢/gi, score: 120 },
    { re: /평균\s*가격\s*(\d+(?:\.\d+)?)\s*¢/gi, score: 120 },
    { re: /price\s*(\d+(?:\.\d+)?)\s*¢/gi, score: 60 }
  ];

  for (const { re, score } of specs) {
    let m;
    while ((m = re.exec(t)) !== null) {
      const c = parseFloat(m[1]);
      const ctx = t.slice(Math.max(0, m.index - 16), m.index + m[0].length + 16);
      if (/min|max|slippage|fee|spread|limit|impact/i.test(ctx)) continue;
      if (!isValidPolyCents(c)) continue;
      candidates.push({ cents: c, score });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].cents;
}

function parseCentsFromText(txt) {
  const t = String(txt || '').replace(/\s+/g, ' ').trim();
  if (/^\+\s*\$/.test(t) || /^sell\s+/i.test(t)) return null;
  if (/@\s*\d/.test(t) && /\+\s*\$/.test(t)) return null;

  let m = t.match(/(\d+(?:\.\d+)?)\s*¢/);
  if (m) {
    const c = parseFloat(m[1]);
    if (isValidPolyCents(c)) return c;
  }

  m = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) {
    const c = parseFloat(m[1]);
    if (isValidPolyCents(c)) return c;
  }

  if (/^0\.\d{2,4}$/.test(t)) {
    const c = parseFloat(t) * 100;
    if (isValidPolyCents(c)) return c;
  }

  return null;
}

function isYesNoToken(s) {
  return /^(yes|no)$/i.test(String(s || '').trim());
}

function teamMatchesButton(team, text) {
  if (!team) return true;
  const teamStr = String(team).trim();
  const t = String(text || '');

  if (isYesNoToken(teamStr)) {
    return new RegExp(`\\b${teamStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t);
  }

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  const nt = norm(teamStr);
  const bt = norm(t);
  if (!nt || !bt) return false;
  if (bt.includes(nt) || nt.includes(bt)) return true;

  const first = teamStr.split(/\s+/).filter((w) => w.length >= 2)[0];
  if (first) {
    const nf = norm(first);
    if (nf.length >= 3 && (bt.includes(nf) || nf.includes(bt))) return true;
  }

  const words = teamStr.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length >= 2 && words.every((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t))) return true;
  return words.some((w) => w.length >= 3 && new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t));
}

function readSelectedBoardCents(teamHint) {
  const candidates = [];
  for (const btn of document.querySelectorAll('button, [role="button"], [role="radio"]')) {
    if (!visible(btn) || isBuySellTab(btn)) continue;
    const sel = selectionScore(btn);
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 120) continue;
    const cents = parseCentsFromText(t);
    if (!cents) continue;
    if (teamHint && !teamMatchesButton(teamHint, t)) continue;

    let score = sel + 150;
    if (sel < 30 && !/active|selected|pressed|border-primary|ring-/i.test(String(btn.className || ''))) continue;
    if (teamHint && teamMatchesButton(teamHint, t)) score += 100;
    if (/^yes\b|^no\b/i.test(t)) score += 40;
    candidates.push({ cents, score, t });
  }
  if (!candidates.length) return readPageOutcomeCents(teamHint);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].cents;
}

function getOutcomeSearchRoots() {
  const panel = findTradePanel();
  const roots = [];
  if (panel) {
    let el = panel.parentElement;
    for (let i = 0; i < 10 && el && el !== document.body; i++) {
      const btns = el.querySelectorAll('button, [role="button"]');
      const hasCents = Array.from(btns).some((b) => parseCentsFromText(b.textContent || ''));
      if (hasCents && btns.length >= 2 && btns.length <= 40) {
        roots.push(el);
        break;
      }
      el = el.parentElement;
    }
    roots.push(panel);
  }
  return roots.length ? roots : [document.body];
}

function readCentsForBuyTeam(teamHint) {
  if (!teamHint) return null;

  const candidates = [];
  const roots = getOutcomeSearchRoots();

  for (const root of roots) {
    for (const btn of root.querySelectorAll('button, [role="button"], [role="radio"]')) {
      if (!visible(btn) || isBuySellTab(btn)) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 140) continue;

      const cents = parseCentsFromText(t);
      if (!cents) continue;

      let matched = teamMatchesButton(teamHint, t);
      if (!matched) {
        const row = btn.closest('[class*="outcome"], [class*="Outcome"], li, div');
        const ctx = (row?.textContent || btn.parentElement?.textContent || '').replace(/\s+/g, ' ').trim();
        matched = teamMatchesButton(teamHint, ctx);
      }
      if (!matched) continue;

      const sel = selectionScore(btn);
      let score = 0;
      if (teamMatchesButton(teamHint, t)) score += 120;
      score += sel;
      if (sel >= 80) score += 300;
      if (/^buy\s+/i.test(t)) score += 40;
      score += Math.max(0, 90 - t.length);
      candidates.push({ cents, score, t });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].cents;
}

// Amount + To win(당첨금)만으로 배당 계산 — Polymarket ¢/Avg Price 표시는 사용하지 않음
function calcOddsFromToWin(stake, toWinDisplay) {
  if (!stake || !toWinDisplay || stake <= 0 || toWinDisplay <= 0) return null;
  const totalPayout = toWinDisplay >= stake ? toWinDisplay : stake + toWinDisplay;
  const odds = totalPayout / stake;
  if (!Number.isFinite(odds) || odds <= 1.001 || odds > 100) return null;
  return {
    odds,
    totalPayout,
    profit: totalPayout - stake,
    priceCents: Math.round((stake / totalPayout) * 1000) / 10
  };
}

function resolveTotalPayout(stake, toWinDisplay) {
  if (!stake || !toWinDisplay || toWinDisplay <= 0) return null;
  return toWinDisplay >= stake ? toWinDisplay : stake + toWinDisplay;
}

function centsFromStakePayout(stake, toWinDisplay) {
  const slip = calcOddsFromToWin(stake, toWinDisplay);
  return slip?.priceCents ?? null;
}

function readPageOutcomeCents(teamHint) {
  const candidates = [];
  for (const btn of document.querySelectorAll('button, [role="button"], [role="radio"]')) {
    if (!visible(btn) || isBuySellTab(btn)) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    const cents = parseCentsFromText(t);
    if (!cents) continue;
    if (teamHint && !teamMatchesButton(teamHint, t)) continue;

    let score = 0;
    if (btn.getAttribute('aria-pressed') === 'true') score += 90;
    if (btn.getAttribute('data-state') === 'on' || btn.getAttribute('data-state') === 'checked') score += 90;
    if (btn.getAttribute('aria-selected') === 'true') score += 80;
    const cls = String(btn.className || '');
    if (/active|selected|checked|pressed|border-primary|ring-/i.test(cls)) score += 60;
    if (t.length < 80) score += 10;

    candidates.push({ cents, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].cents;
}

function readOutcomeButtonCents(teamHint) {
  if (!teamHint) return null;

  const candidates = [];
  const roots = [findTradePanel(), document.body].filter(Boolean);

  for (const root of roots) {
    for (const btn of root.querySelectorAll('button, [role="button"], [role="radio"]')) {
      if (!visible(btn) || isBuySellTab(btn)) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!teamMatchesButton(teamHint, t)) continue;
      const cents = parseCentsFromText(t);
      if (!cents) continue;

      let score = selectionScore(btn);
      if (/^buy\s+/i.test(t)) score += 20;

      candidates.push({ cents, score, t });
    }
  }

  if (!candidates.length) return readPageOutcomeCents(teamHint);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].cents;
}

function selectionScore(btn) {
  let score = 0;
  if (btn.getAttribute('aria-pressed') === 'true') score += 120;
  if (btn.getAttribute('aria-selected') === 'true') score += 110;
  if (btn.getAttribute('data-state') === 'on' || btn.getAttribute('data-state') === 'checked') score += 110;
  const cls = String(btn.className || '');
  if (/active|selected|checked|pressed|border-primary|ring-/i.test(cls)) score += 80;
  return score;
}

function stripTeamFromOutcomeText(t) {
  return String(t || '')
    .replace(/\d+(?:\.\d+)?\s*¢/g, '')
    .replace(/\d+(?:\.\d+)?\s*%/g, '')
    .replace(/^(?:buy|구매|sell|매도)\s+/i, '')
    .trim();
}

/** 선택된 outcome 버튼의 팀명 + ¢ (홈/원정·맵 마켓) */
function readActiveMoneylineOutcome() {
  const candidates = [];
  const seen = new Set();

  for (const root of getOutcomeSearchRoots()) {
    for (const btn of root.querySelectorAll('button, [role="button"], [role="radio"]')) {
      if (!visible(btn) || isBuySellTab(btn)) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 120 || seen.has(t)) continue;
      seen.add(t);
      const cents = parseCentsFromText(t);
      if (!cents) continue;
      const team = stripTeamFromOutcomeText(t);
      if (team.length < 2 || team.length > 72) continue;
      if (/^(yes|no|over|under|draw|tie)$/i.test(team)) continue;

      const sel = selectionScore(btn);
      let score = sel;
      if (sel >= 80) score += 220;
      else if (sel >= 50) score += 100;
      else if (sel >= 20) score += 40;
      if (/^buy\s+/i.test(t)) score -= 60;
      candidates.push({ team, cents, score, sel, t });
    }
  }

  if (!candidates.length) return null;
  const selected = candidates.filter((c) => c.sel >= 20).sort((a, b) => b.score - a.score);
  if (selected.length) return selected[0];
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function resolvePolyTeamAndCents(panel, stake, toWinDisplay) {
  const buyTeam = readTeamLabel(panel);
  const activeOutcome = readActiveMoneylineOutcome();
  let team = buyTeam || activeOutcome?.team || '';

  if (buyTeam && activeOutcome && !teamMatchesButton(buyTeam, activeOutcome.team)) {
    team = buyTeam;
  }

  let boardCents = null;
  if (team) {
    boardCents = readCentsForBuyTeam(team)
      || readOutcomeButtonCents(team)
      || readSelectedOutcomeForTeam(team)
      || readSelectedBoardCents(team);
  }
  if (!boardCents && activeOutcome) {
    if (!team || teamMatchesButton(team, activeOutcome.team)) {
      boardCents = activeOutcome.cents;
      if (!team) team = activeOutcome.team;
    }
  }
  if (!boardCents) {
    boardCents = readLiveListedCents(panel, stake, toWinDisplay);
  }
  if (!boardCents && activeOutcome) {
    boardCents = activeOutcome.cents;
    if (!team) team = activeOutcome.team;
  }
  return { team, boardCents };
}

function readSelectedOutcomeForTeam(teamHint) {
  const candidates = [];
  const minSel = teamHint ? 10 : 20;
  for (const btn of document.querySelectorAll('button, [role="button"], [role="radio"]')) {
    if (!visible(btn) || isBuySellTab(btn)) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    const cents = parseCentsFromText(t);
    if (!cents) continue;
    const sel = selectionScore(btn);
    if (sel < minSel) continue;
    if (teamHint && !teamMatchesButton(teamHint, t)) continue;
    candidates.push({ cents, score: sel + (teamHint && teamMatchesButton(teamHint, t) ? 50 : 0), t });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].cents;
}

function readSelectedTeamFromBoard() {
  for (const btn of document.querySelectorAll('button, [role="button"], [role="radio"]')) {
    if (!visible(btn) || isBuySellTab(btn)) continue;
    const pressed = btn.getAttribute('aria-pressed') === 'true'
      || btn.getAttribute('aria-selected') === 'true'
      || btn.getAttribute('data-state') === 'on'
      || btn.getAttribute('data-state') === 'checked';
    if (!pressed) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    const yesNo = t.match(/^(yes|no)\b/i);
    if (yesNo) return yesNo[1];
    const cleaned = t.replace(/\d+(?:\.\d+)?\s*¢/g, '').replace(/\d+(?:\.\d+)?\s*%/g, '').trim();
    if (cleaned.length >= 2 && cleaned.length < 80) return cleaned;
  }
  return '';
}

function readEventBoardCents(teamHint) {
  const candidates = [];
  const roots = [findTradePanel(), document.body].filter(Boolean);

  for (const root of roots) {
    for (const el of root.querySelectorAll('button, [role="button"], [role="radio"], [class*="outcome"], [class*="Outcome"]')) {
      if (!visible(el)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 160) continue;
      const cents = parseCentsFromText(t);
      if (!cents) continue;
      if (teamHint && !teamMatchesButton(teamHint, t)) continue;

      let score = 40;
      if (teamHint && teamMatchesButton(teamHint, t)) score += 120;
      score += selectionScore(el);
      if (/^buy\s+/i.test(t)) score += 30;
      candidates.push({ cents, score });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].cents;
}

function readTeamLabel(panel) {
  const scopes = [panel, findTradePanel(), document.body].filter(Boolean);
  const seen = new Set();

  for (const scope of scopes) {
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);

    for (const btn of scope.querySelectorAll('button, [role="button"]')) {
      if (!visible(btn)) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      const m = t.match(/^(?:buy|구매)\s+(.+)$/i);
      if (m) return m[1].trim();
    }

    const text = scope.innerText || '';
    const buyM = text.match(/(?:Buy|매수|구매)\s+([^\n$¢@%]+?)(?:\s*$|\s+(?:Avg|평균)|\s+(?:To win|우승))/i);
    if (buyM) return buyM[1].trim();
  }

  const selected = readSelectedTeamFromBoard();
  if (selected) return selected;

  return '';
}

function readBuyButtonCents(panel) {
  const scope = panel || findTradePanel() || document.body;
  for (const btn of scope.querySelectorAll('button, [role="button"]')) {
    if (!visible(btn) || isBuySellTab(btn)) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/^buy\s+/i.test(t)) continue;
    const cents = parseCentsFromText(t);
    if (cents) return cents;
    const sibling = btn.parentElement;
    if (sibling) {
      const m = (sibling.textContent || '').match(/(?:avg\.?\s*)?price\s*(\d+(?:\.\d+)?)\s*¢/i);
      if (m) {
        const c = parseFloat(m[1]);
        if (isValidPolyCents(c)) return c;
      }
    }
  }
  return null;
}

function pickListedCents(candidates, hasSlip) {
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const order = hasSlip
    ? ['implied', 'selected-board', 'avg', 'buy-btn', 'selected', 'buy-team', 'team-btn', 'implied-fallback', 'page', 'event-board']
    : ['selected-board', 'avg', 'buy-btn', 'selected', 'buy-team', 'team-btn', 'implied-fallback', 'page', 'event-board'];
  for (const src of order) {
    const hit = candidates.find((c) => c.src === src);
    if (hit) return hit.cents;
  }
  return candidates[0].cents;
}

function readLiveListedCents(panel, stake, toWinDisplay) {
  const panelEl = panel || findTradePanel();
  const team = readTeamLabel(panelEl);
  const candidates = [];
  const hasSlip = stake > 0 && toWinDisplay > 0;

  function add(cents, score, src) {
    if (!isValidPolyCents(cents)) return;
    candidates.push({ cents, score, src });
  }

  const implied = centsFromStakePayout(stake, toWinDisplay);
  if (implied && hasSlip) add(implied, 950, 'implied');

  const selectedBoard = readSelectedBoardCents(team);
  if (selectedBoard) add(selectedBoard, hasSlip ? 880 : 920, 'selected-board');

  const avg = readListedPriceCents(panelEl);
  if (avg) add(avg, hasSlip ? 860 : 800, 'avg');

  if (team) {
    const buyBtn = readBuyButtonCents(panelEl);
    if (buyBtn) add(buyBtn, 500, 'buy-btn');

    const selected = readSelectedOutcomeForTeam(team);
    if (selected) add(selected, 480, 'selected');

    const buyTeam = readCentsForBuyTeam(team);
    if (buyTeam) add(buyTeam, 320, 'buy-team');

    const teamBtn = readOutcomeButtonCents(team);
    if (teamBtn) add(teamBtn, 280, 'team-btn');
  }

  if (!hasSlip && implied) add(implied, 260, 'implied-fallback');

  if (!candidates.length) {
    const page = readPageOutcomeCents(team);
    if (page) add(page, 200, 'page');
    const board = readEventBoardCents(team);
    if (board) add(board, 180, 'event-board');
  }

  return pickListedCents(candidates, hasSlip);
}

function formatCentsLabel(cents) {
  if (!cents) return '';
  return Number.isInteger(cents) ? `${cents}¢` : `${cents.toFixed(1)}¢`;
}

function sanitizePolyOdds(odds, listedCents, stake, payout) {
  if (odds && odds > 1 && odds <= 50) return odds;
  if (isValidPolyCents(listedCents)) return oddsFromCents(listedCents);
  if (stake && payout) {
    const fromPay = calcOddsFromStakeAndPayout(stake, payout);
    if (fromPay && fromPay > 1 && fromPay <= 50) return fromPay;
  }
  if (odds && odds > 50) return null;
  return odds && odds > 1 ? odds : null;
}

function oddsFromCents(cents) {
  if (!isValidPolyCents(cents)) return null;
  const price = cents / 100;
  return price > 0 && price < 1 ? 1 / price : null;
}

function readPolymarketSlip() {
  const panel = findTradePanel();
  const stake = readPanelStake(panel);
  const toWinDisplay = readPayoutAmount(panel, stake);
  const resolved = resolvePolyTeamAndCents(panel, stake, toWinDisplay);
  const team = resolved.team || readTeamLabel(panel);
  const slipOdds = calcOddsFromToWin(stake, toWinDisplay);

  // Amount + To win 있으면 당첨금만으로 배당 (¢ 표시 가격 무시)
  if (slipOdds) {
    const { odds, totalPayout, profit, priceCents } = slipOdds;
    return {
      source: predictionSiteId(),
      odds,
      priceCents,
      price: priceCents / 100,
      teamLabel: team,
      outcome: team,
      selectionText: team || '',
      displayLabel: predictionSiteId() === 'bcgame'
        ? `${odds.toFixed(3)} · 당첨 ${toWinDisplay.toFixed(2)} USDT`
        : `${odds.toFixed(3)} · 당첨 $${toWinDisplay.toFixed(2)}`,
      stake,
      payout: totalPayout,
      toWin: profit,
      hint: predictionSiteId() === 'bcgame'
        ? `우승 ${toWinDisplay.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT ÷ 금액 ${stake.toFixed(2)} USDT`
        : `당첨금 $${toWinDisplay.toFixed(2)} ÷ 베팅 $${stake.toFixed(2)}`,
      marketKind: 'ml',
      period: 'ft',
      marketKey: `poly_ml_${(team || 'out').slice(0, 20)}`,
      fromPayout: true,
      liveCents: false
    };
  }

  // Amount 있으나 To win 없음 — ¢/Avg 배당 유지 (금액 동기화 중 사라짐 방지)
  if (stake > 0 && !toWinDisplay) {
    let listedCents = resolved.boardCents;
    if (!listedCents) listedCents = readLiveListedCents(panel, 0, 0);
    if (!listedCents) listedCents = readPageOutcomeCents(team);
    if (!listedCents && panel) {
      const avgM = (panel.innerText || '').match(/avg\.?\s*price\s*(\d+(?:\.\d+)?)\s*¢/i);
      if (avgM) {
        const c = parseFloat(avgM[1]);
        if (isValidPolyCents(c)) listedCents = c;
      }
    }
    const fallbackOdds = oddsFromCents(listedCents);
    if (fallbackOdds > 1.001) {
      const priceCents = listedCents || decimalToCents(fallbackOdds);
      const centsLabel = formatCentsLabel(priceCents);
      return {
        source: predictionSiteId(),
        odds: fallbackOdds,
        priceCents,
        price: priceCents / 100,
        teamLabel: team,
        outcome: team,
        selectionText: team ? `${team} @ ${centsLabel}` : centsLabel,
        displayLabel: `${centsLabel} (${fallbackOdds.toFixed(3)})`,
        stake,
        payout: null,
        toWin: null,
        hint: 'Amount 입력됨 — To win 계산 중, ¢ 배당 유지',
        marketKind: 'ml',
        period: 'ft',
        marketKey: `poly_ml_${(team || 'out').slice(0, 20)}`,
        fromPayout: false,
        liveCents: true,
        pendingToWin: true
      };
    }
    return {
      source: predictionSiteId(),
      odds: null,
      needsStake: true,
      teamLabel: team,
      stake,
      priceCents: isValidPolyCents(listedCents) ? listedCents : null,
      hint: predictionSiteId() === 'bcgame' ? '우승(당첨) 계산 대기 중...' : 'To win 계산 대기 중...',
      marketKind: 'ml'
    };
  }

  // 금액 없을 때 보드 ¢ / Avg price 참고
  let listedCents = resolved.boardCents;
  if (!listedCents) listedCents = readLiveListedCents(panel, 0, 0);
  if (!listedCents) listedCents = readPageOutcomeCents(team);
  if (!listedCents && panel) {
    const avgM = (panel.innerText || '').match(/avg\.?\s*price\s*(\d+(?:\.\d+)?)\s*¢/i);
    if (avgM) {
      const c = parseFloat(avgM[1]);
      if (isValidPolyCents(c)) listedCents = c;
    }
  }
  const odds = oddsFromCents(listedCents);

  if (!odds || odds <= 1.001) {
    return {
      source: predictionSiteId(),
      odds: null,
      needsStake: true,
      teamLabel: team,
      priceCents: isValidPolyCents(listedCents) ? listedCents : null,
      hint: listedCents
        ? `${formatCentsLabel(listedCents)} — Amount 입력 시 당첨금 기준 배당`
        : 'Polymarket Amount 입력 후 To win 확인',
      marketKind: 'ml'
    };
  }

  const priceCents = listedCents || decimalToCents(odds);
  const centsLabel = formatCentsLabel(priceCents);

  return {
    source: predictionSiteId(),
    odds,
    priceCents,
    price: priceCents / 100,
    teamLabel: team,
    outcome: team,
    selectionText: team ? `${team} @ ${centsLabel}` : centsLabel,
    displayLabel: `${centsLabel} (${odds.toFixed(3)})`,
    stake: stake || null,
    payout: null,
    toWin: null,
    hint: 'Amount 입력 시 To win 기준 배당으로 전환',
    marketKind: 'ml',
    period: 'ft',
    marketKey: `poly_ml_${(team || 'out').slice(0, 20)}`,
    fromPayout: false,
    liveCents: !!listedCents
  };
}

function calcOddsFromStakeAndPayout(stake, totalPayout) {
  if (!stake || !totalPayout || stake <= 0 || totalPayout <= 0) return null;
  return totalPayout / stake;
}

function decimalToCents(decimal) {
  if (!decimal || decimal <= 1) return null;
  const c = Math.round(1000 / decimal) / 10;
  return isValidPolyCents(c) ? c : null;
}

function robustClick(el) {
  if (!el) return false;
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
  try { el.focus({ preventScroll: true }); } catch (_) {}
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
  try { el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse' })); } catch (_) {}
  try { el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse' })); } catch (_) {}
  el.dispatchEvent(new MouseEvent('mousedown', base));
  el.dispatchEvent(new MouseEvent('mouseup', base));
  el.dispatchEvent(new MouseEvent('click', base));
  if (typeof el.click === 'function') el.click();
  return true;
}

async function typeIntoField(el, text) {
  if (!el) return false;
  const str = String(text);
  el.focus();
  try { el.click(); } catch (_) {}

  if (el.isContentEditable) {
    el.textContent = str;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertFromPaste' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(50);
    return true;
  }

  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  try {
    el.select?.();
    document.execCommand?.('selectAll', false, null);
  } catch (_) {}

  if (setter) setter.call(el, str);
  else el.value = str;

  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertFromPaste' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  await sleep(80);
  return true;
}

function ensureBuyTabSelected(panel) {
  const root = panel || findTradePanel() || document.body;
  for (const btn of root.querySelectorAll('button, [role="button"], [role="tab"]')) {
    if (!visible(btn)) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (t !== 'Buy' && t !== '매수' && t !== '구매') continue;
    const pressed = btn.getAttribute('aria-pressed') === 'true'
      || btn.getAttribute('aria-selected') === 'true'
      || btn.getAttribute('data-state') === 'active'
      || /active|selected|bg-/i.test(String(btn.className || ''));
    if (!pressed) robustClick(btn);
    return true;
  }
  return false;
}

function isBuyTabButton(btn) {
  const t = (btn?.textContent || '').replace(/\s+/g, ' ').trim();
  if (t !== 'Buy' && t !== '매수' && t !== 'Sell' && t !== '매도' && t !== '구매' && t !== '판매') return false;
  const parent = btn.parentElement;
  const pt = (parent?.textContent || '').replace(/\s+/g, ' ');
  return /\bBuy\b/.test(pt) && /\bSell\b/.test(pt) && pt.length < 50;
}

function findBuyTeamButton(panel) {
  const scope = panel || findTradePanel() || document.body;
  let best = null;
  let bestScore = -1;

  for (const btn of scope.querySelectorAll('button, [role="button"]')) {
    if (!visible(btn) || btn.disabled) continue;
    if (isBuyTabButton(btn)) continue;

    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/^buy\b/i.test(t) || t.length < 4) continue;
    if (/combo|terms|sell|deposit|withdraw/i.test(t)) continue;

    let score = 100 + t.length;
    if (btn.classList?.contains('trading-button')) score += 500;
    if (btn.querySelector?.('.trading-button-text')) score += 300;
    const r = btn.getBoundingClientRect();
    if (r.width >= 120 && r.height >= 32) score += 60;
    if (panel && panel.contains(btn)) score += 40;

    if (score > bestScore) {
      bestScore = score;
      best = btn;
    }
  }
  return best;
}

function findPlaceOrderButton(panel) {
  const teamBtn = findBuyTeamButton(panel);
  if (teamBtn) return teamBtn;
  const input = findAmountInput(panel);
  if (input) {
    let box = input.parentElement;
    for (let depth = 0; depth < 10 && box; depth++) {
      const local = [];
      for (const btn of box.querySelectorAll('button, [role="button"]')) {
        if (!visible(btn) || btn.disabled) continue;
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        const lower = t.toLowerCase();
        if (!t || t.length > 120) continue;
        if (lower === 'sell' || lower === 'buy' && box.textContent.includes('Sell') && t.length < 6) continue;
        let score = 0;
        if (/^buy\b/i.test(t) && t.length > 4) score += 100;
        if (/\$\d/.test(t)) score += 90;
        if (/place order|submit/i.test(lower)) score += 110;
        if (/yes|no/i.test(t) && /buy/i.test(t)) score += 80;
        const r = btn.getBoundingClientRect();
        if (r.width >= 100 && r.height >= 36) score += 20;
        if (score >= 70) local.push({ btn, score, t });
      }
      if (local.length) {
        local.sort((a, b) => b.score - a.score);
        return local[0].btn;
      }
      box = box.parentElement;
    }
  }

  const roots = [panel, findTradePanel(), document.body].filter(Boolean);
  const seen = new Set();
  const candidates = [];

  for (const root of roots) {
    for (const btn of root.querySelectorAll('button, [role="button"]')) {
      if (!btn || seen.has(btn) || !visible(btn) || btn.disabled) continue;
      seen.add(btn);

      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (btn.getAttribute('aria-label') || '').trim();
      const lower = `${t} ${aria}`.toLowerCase();
      const rect = btn.getBoundingClientRect();

      let score = 0;
      if (/place order|submit order|confirm purchase|confirm buy/i.test(lower)) score += 120;
      if (/^buy\s+.+/i.test(t) && t.length > 6) score += 95;
      if (/buy.*\$\d|^\$\d.*buy/i.test(t)) score += 90;
      if (/buy.*(yes|no)\b/i.test(lower)) score += 85;
      if (aria && /buy/i.test(aria) && !/tab/i.test(aria)) score += 70;
      if (t === 'Buy' || t === '매수') {
        const parentText = (btn.parentElement?.textContent || '').replace(/\s+/g, ' ');
        score += (/\bSell\b/.test(parentText) && parentText.length < 40) ? 5 : 50;
      }
      if (rect.width >= 90 && rect.height >= 32) score += 15;
      if (panel && panel.contains(btn)) score += 25;
      if (/\d+¢|shares/i.test(t)) score += 10;

      if (score >= 45) candidates.push({ btn, score, t: t.slice(0, 60) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.btn || null;
}

function findBuyButton(panel) {
  return findPlaceOrderButton(panel);
}

async function setInputValueRobust(input, value) {
  return typeIntoField(input, value);
}

async function clickAmountChips(panel, target) {
  const scope = panel || findTradePanel() || document.body;
  const want = Math.max(1, Math.round(target));
  const chips = [100, 10, 5, 1];
  let left = want;
  let clicked = 0;

  for (const n of chips) {
    while (left >= n) {
      let btn = null;
      for (const b of scope.querySelectorAll('button, [role="button"]')) {
        if (!visible(b)) continue;
        const t = (b.textContent || '').trim();
        if (t === `+$${n}` || t === `$${n}`) { btn = b; break; }
      }
      if (!btn) break;
      btn.click();
      robustClick(btn);
      clicked++;
      left -= n;
      await sleep(150);
    }
  }
  return clicked;
}

function readAmountFromPanel(panel) {
  return readPanelStake(panel);
}

async function setPolyTradeAmount(amountUsd, force = true) {
  const panel = findTradePanel();
  if (!panel) return { ok: false, reason: '주문 패널 없음 — outcome 클릭 후 Amount 표시' };

  ensureBuyTabSelected(panel);
  await sleep(60);

  const rounded = Math.max(1, Math.round(amountUsd * 100) / 100);
  const existing = readAmountFromPanel(panel);
  if (!force && existing && Math.abs(existing - rounded) < 0.05) {
    return { ok: true, stake: existing, method: 'unchanged' };
  }
  if (existing && Math.abs(existing - rounded) < 0.02) {
    return { ok: true, stake: existing, method: 'skip-same' };
  }

  const field = findAmountInput(panel);
  if (field) {
    await typeIntoField(field, String(rounded));
    await sleep(60);
    const stake = readAmountFromPanel(panel);
    if (stake && stake >= 0.5) {
      return { ok: true, stake, method: 'type', target: rounded };
    }
  }

  return { ok: false, reason: `금액 입력 실패 — Amount에 $${rounded} 직접 입력`, stake: existing || 0 };
}

async function fillTradeAmount(panel, amount) {
  const rounded = Math.max(1, Math.round(amount * 100) / 100);
  const existing = readAmountFromPanel(panel);
  if (existing && existing >= 0.5) return { ok: true, stake: existing, method: 'existing' };

  const chipClicks = await clickAmountChips(panel, rounded);
  await sleep(250);
  let stake = readAmountFromPanel(panel);
  if (stake && stake >= 0.5) return { ok: true, stake, method: 'chips', chipClicks };

  const field = findAmountInput(panel);
  if (field) {
    await typeIntoField(field, String(Math.ceil(rounded)));
    await sleep(200);
    stake = readAmountFromPanel(panel);
    if (stake && stake >= 0.5) return { ok: true, stake, method: 'type', chipClicks };
  }

  const buyBtn = findBuyTeamButton(panel);
  if (chipClicks > 0 || buyBtn) {
    return { ok: true, stake: stake || rounded, method: chipClicks ? 'chips-only' : 'buy-ready', chipClicks };
  }

  return { ok: false, reason: `금액 입력 실패 — +$칩 또는 Amount에 $${rounded} 직접 입력`, stake: stake || 0 };
}

function hasInPageDialog() {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [class*="modal" i], [class*="Modal"], [class*="dialog" i], [class*="Dialog"]');
}

function findModalActionButton() {
  const patterns = [
    /confirm/i,
    /place order/i,
    /submit order/i,
    /complete purchase/i,
    /approve/i,
    /^(submit|continue|yes|확인|승인|주문)$/i
  ];
  const scopes = [];
  for (const dlg of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) scopes.push(dlg);
  if (!scopes.length) scopes.push(document.body);

  for (const scope of scopes) {
    for (const btn of scope.querySelectorAll('button, [role="button"]')) {
      if (!visible(btn) || btn.disabled) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 80) continue;
      if (t === 'Buy' && !hasInPageDialog()) continue;
      if (patterns.some((p) => p.test(t))) return btn;
    }
  }
  return null;
}

function pageHasOrderSuccess() {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
  return /order submitted|purchase complete|shares purchased|bought|trade submitted|order placed|매수 완료|주문 완료|confirmed|successfully purchased/i.test(text);
}

function pageHasOrderError() {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
  return /insufficient (balance|funds)|not enough|failed to (buy|place)|transaction failed|rejected|unable to place|거부|잔액 부족|주문 실패/i.test(text);
}

async function waitAfterBuyClick(panel, btn) {
  for (let i = 0; i < 30; i++) {
    await sleep(80);
    if (pageHasOrderSuccess()) {
      return { success: true, confirmed: true, btnText: (btn?.textContent || '').trim().slice(0, 50) };
    }
    if (pageHasOrderError()) {
      return { success: false, reason: '주문 거부/잔액 부족' };
    }
    for (const inp of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
      if (!visible(inp)) continue;
      const ctx = (inp.closest('[role="dialog"], label, div')?.textContent || '').slice(0, 200);
      if (/risk|understand|agree|accept|terms/i.test(ctx) && !inp.checked && inp.getAttribute('aria-checked') !== 'true') {
        robustClick(inp);
      }
    }
    const modalBtn = findModalActionButton();
    if (modalBtn) robustClick(modalBtn);
  }

  // Polymarket 캐시 잔액: Buy 클릭만으로 주문됨 (지갑 서명 불필요)
  if (!pageHasOrderError()) {
    return {
      success: true,
      confirmed: true,
      pendingWallet: false,
      reason: '베팅 클릭 완료'
    };
  }
  return { success: false, reason: '주문 거부됨' };
}

function probePolyBetUi() {
  const panel = findTradePanel();
  const btn = findBuyTeamButton(panel) || findPlaceOrderButton(panel);
  return {
    hasPanel: !!panel,
    hasInput: !!findAmountInput(panel),
    stake: readAmountFromPanel(panel),
    hasBtn: !!btn,
    btnText: btn ? (btn.textContent || '').trim().slice(0, 60) : '',
    btnDisabled: btn ? !!btn.disabled : null,
    team: readTeamLabel(panel),
    url: location.href
  };
}

function clickBuyButton(btn) {
  if (!btn) return false;
  try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
  try { btn.focus({ preventScroll: true }); } catch (_) {}
  if (typeof btn.click === 'function') btn.click();
  robustClick(btn);
  return true;
}

function findOutcomeButtonForTeam(teamHint) {
  if (!teamHint) return null;
  let best = null;
  let bestScore = 0;
  for (const btn of document.querySelectorAll('button, [role="button"], [role="radio"]')) {
    if (!visible(btn) || isBuySellTab(btn)) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 140) continue;
    const cents = parseCentsFromText(t);
    let matched = teamMatchesButton(teamHint, t);
    if (!matched) {
      const row = btn.closest('[class*="outcome"], [class*="Outcome"], li, div');
      const ctx = (row?.textContent || btn.parentElement?.textContent || '').replace(/\s+/g, ' ').trim();
      matched = teamMatchesButton(teamHint, ctx);
    }
    if (!matched && !cents) continue;
    let score = selectionScore(btn);
    if (matched) score += 120;
    if (cents) score += 30;
    if (score > bestScore) {
      bestScore = score;
      best = btn;
    }
  }
  return best;
}

async function ensurePolyTradePanel(teamHint) {
  if (findTradePanel()) return { ok: true, alreadyOpen: true };

  let btn = teamHint ? findOutcomeButtonForTeam(teamHint) : null;
  if (!btn) {
    const active = readActiveMoneylineOutcome();
    if (active?.team) btn = findOutcomeButtonForTeam(active.team);
  }
  if (!btn) {
    for (const candidate of document.querySelectorAll('button, [role="button"]')) {
      if (!visible(candidate) || isBuySellTab(candidate)) continue;
      if (parseCentsFromText(candidate.textContent || '')) {
        btn = candidate;
        break;
      }
    }
  }
  if (btn) {
    clickBuyButton(btn);
    await sleep(350);
  }

  for (let i = 0; i < 20; i++) {
    if (findTradePanel()) return { ok: true, clicked: !!btn };
    await sleep(100);
  }
  return { ok: false, reason: '주문 패널 없음 — /event/ 페이지에서 outcome 클릭', probe: probePolyBetUi() };
}

async function placePolymarketBet(amountUsd, opts = {}) {
  const skipFill = !!opts.skipFill;
  const panelReady = await ensurePolyTradePanel(opts.teamHint || '');
  if (!panelReady.ok) {
    return { success: false, reason: panelReady.reason || '주문 패널 없음 — /event/ 페이지에서 outcome 클릭', probe: panelReady.probe || probePolyBetUi() };
  }
  const panel = findTradePanel();
  if (!panel) {
    return { success: false, reason: '주문 패널 없음 — /event/ 페이지에서 outcome 클릭', probe: probePolyBetUi() };
  }

  ensureBuyTabSelected(panel);
  if (!skipFill) await sleep(120);

  const amount = Math.max(1, Math.round(amountUsd * 100) / 100);
  let fill = { ok: true, method: 'presynced', stake: readAmountFromPanel(panel) };

  if (!skipFill) {
    fill = await fillTradeAmount(panel, amount);
  } else {
    const existing = readAmountFromPanel(panel);
    if (!existing || Math.abs(existing - amount) > 0.2) {
      fill = await setPolyTradeAmount(amount, true);
    }
  }

  let btn = null;
  let btnText = '';
  const tries = skipFill ? 10 : 25;
  for (let i = 0; i < tries; i++) {
    await sleep(skipFill ? 40 : 100);
    btn = findBuyTeamButton(panel) || findPlaceOrderButton(panel);
    if (btn) {
      btnText = (btn.textContent || '').trim();
      if (!btn.disabled) break;
    }
    btn = null;
  }

  if (!btn) {
    return {
      success: false,
      reason: 'Buy 팀명 버튼 없음 (예: Buy LGD Gaming)',
      probe: probePolyBetUi(),
      fillMethod: fill.method
    };
  }

  if (!fill.ok && !fill.chipClicks) {
    return { success: false, reason: fill.reason || '금액 입력 실패', probe: probePolyBetUi() };
  }

  clickBuyButton(btn);
  await sleep(400);
  const modalBtn = findModalActionButton();
  if (modalBtn) clickBuyButton(modalBtn);

  const result = await waitAfterBuyClick(panel, btn);
  result.btnText = btnText.slice(0, 60);
  result.fillMethod = fill.method;
  result.chipClicks = fill.chipClicks || 0;
  return result;
}

function centsToDecimal(cents) {
  const c = parseFloat(cents);
  if (!Number.isFinite(c) || c <= 0) return null;
  if (c >= 100) return null;
  if (c > 0 && c < 1) return 1 / c;
  return 100 / c;
}

function parsePriceToken(text) {
  const t = String(text || '').trim();
  let m = t.match(/(\d+(?:\.\d+)?)\s*¢/);
  if (m) return parseFloat(m[1]);
  m = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) {
    const p = parseFloat(m[1]);
    if (p > 0 && p < 100) return p;
  }
  return null;
}

function extractVsTeams(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const patterns = [
    /([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48}?)/i,
    /([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48}?)\s+대\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48}?)/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const home = m[1].replace(/\s+\d+\s*-\s*\d+.*$/, '').trim();
    const away = m[2].replace(/\s+\d+\s*-\s*\d+.*$/, '').trim();
    if (home.length >= 2 && away.length >= 2) return { home, away };
  }
  return null;
}

function pushMatchup(matchups, seen, home, away, homeCents, awayCents) {
  const key = `${home}|${away}`.toLowerCase();
  if (seen.has(key)) return;
  const homeDec = centsToDecimal(homeCents);
  const awayDec = centsToDecimal(awayCents);
  if (!homeDec || !awayDec) return;
  seen.add(key);
  matchups.push({
    id: key,
    home,
    away,
    title: `${home} vs ${away}`,
    league: '',
    ml: [
      { team: home, side: 'home', price: homeCents / 100, decimal: homeDec },
      { team: away, side: 'away', price: awayCents / 100, decimal: awayDec }
    ]
  });
}

function scanPredictionsBoard() {
  const matchups = [];
  const seen = new Set();
  const raw = (document.body?.innerText || '').replace(/\r/g, '');

  const rowRe = /([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{2,48}?)\s+([A-Z]{2,8})\s+(\d+)\s*-\s*(\d+)\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{2,48}?)\s+([A-Z]{2,8})\s+\d+\s*-\s*\d+\s+\2\s+([\d.]+)\s*(?:¢|%)[\s\S]{0,40}?\6\s+([\d.]+)\s*(?:¢|%)/g;
  let m;
  while ((m = rowRe.exec(raw)) !== null) {
    pushMatchup(matchups, seen, m[1].trim(), m[5].trim(), parseFloat(m[7]), parseFloat(m[8]));
  }

  if (!matchups.length) {
    for (const el of document.querySelectorAll('div, article, section, a, button, li')) {
      if (!visible(el)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length < 20 || t.length > 600) continue;
      if (!/(?:¢|%\s)/.test(t) && !/\d+\s*-\s*\d+/.test(t)) continue;

      const teams = extractVsTeams(t);
      if (teams) {
        const cents = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:¢|%)/g)]
          .map((x) => parseFloat(x[1]))
          .filter((c) => c > 0 && c < 100);
        if (cents.length >= 2) {
          pushMatchup(matchups, seen, teams.home, teams.away, cents[0], cents[cents.length - 1]);
          if (matchups.length >= 80) break;
          continue;
        }
      }

      const parts = t.split(/\s+\d+\s*-\s*\d+\s+/);
      if (parts.length < 2) continue;
      const homePart = parts[0].trim().split(/\s+/);
      const awayPart = parts[1].trim().split(/\s+/);
      const home = homePart.slice(0, -1).join(' ') || homePart[0];
      const away = awayPart.slice(0, -1).join(' ') || awayPart[0];
      if (!home || !away || home.length < 2) continue;
      const cents = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:¢|%)/g)]
        .map((x) => parseFloat(x[1]))
        .filter((c) => c > 0 && c < 100);
      if (cents.length < 2) continue;
      pushMatchup(matchups, seen, home, away, cents[0], cents[cents.length - 1]);
      if (matchups.length >= 80) break;
    }
  }

  return {
    ok: true,
    site: predictionSiteId(),
    url: location.href,
    matchups,
    hasCart: !!findTradePanel(),
    cartSlip: readPolymarketSlip()
  };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, site: predictionSiteId(), version: '5.3' });
    return false;
  }
  if (msg.type === 'READ_SLIP') {
    sendResponse({ slip: readPolymarketSlip() });
    return false;
  }
  if (msg.type === 'SCAN_BOARD') {
    sendResponse(scanPredictionsBoard());
    return false;
  }
  if (msg.type === 'PROBE_POLY') {
    sendResponse({ ok: true, probe: probePolyBetUi() });
    return false;
  }
  if (msg.type === 'SET_POLY_AMOUNT') {
    setPolyTradeAmount(msg.amount, msg.force !== false).then(sendResponse);
    return true;
  }
  if (msg.type === 'ENSURE_POLY_PANEL') {
    ensurePolyTradePanel(msg.team || '').then(sendResponse);
    return true;
  }
  if (msg.type === 'PLACE_BET') {
    placePolymarketBet(msg.amount, { skipFill: !!msg.skipFill, teamHint: msg.teamHint || msg.team || '' }).then(sendResponse);
    return true;
  }
});

try {
  window.__polyPlaceBet = placePolymarketBet;
  window.__polySetAmount = setPolyTradeAmount;
  window.__polyProbe = probePolyBetUi;
  window.__polyReadSlip = readPolymarketSlip;
} catch (_) {}

(function observe() {
  let last = '';
  let pending = false;

  function slipKey(slip) {
    if (!slip) return '';
    const o = slip.odds > 1 ? slip.odds.toFixed(4) : 'x';
    const c = slip.priceCents > 0 ? slip.priceCents.toFixed(2) : 'c';
    return `${c}_${o}_${slip.stake || ''}_${slip.teamLabel || ''}_${slip.pendingToWin ? 'p' : ''}`;
  }

  function tick() {
    const slip = readPolymarketSlip();
    if (!slip) return;
    const key = slipKey(slip);
    if (key === last) return;
    last = key;
    try { chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: predictionSiteId(), slip }); } catch (_) {}
  }

  function notifyNow() {
    last = ''; // 강제 갱신
    tick();
    requestAnimationFrame(() => {
      tick();
      requestAnimationFrame(tick);
    });
  }

  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      tick();
    });
  }

  if (document.body) {
    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button, [role="button"], [role="radio"], a');
      if (!btn) return;
      notifyNow();
    }, true);

    new MutationObserver(schedule).observe(document.body, {
      subtree: true, childList: true, characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-state', 'aria-pressed', 'aria-selected', 'aria-label', 'value']
    });
    document.addEventListener('input', notifyNow, true);
    document.addEventListener('change', notifyNow, true);
    setInterval(tick, 16);
    notifyNow();
  }
})();

console.log(`[Prediction v5] content script loaded (${predictionSiteId()})`);
