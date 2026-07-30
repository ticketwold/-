// Polymarket content script v5 — To win 기반 배당 (텐텐뱃 양방 전용)

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function isBuySellTab(btn) {
  const t = (btn?.textContent || '').replace(/\s+/g, ' ').trim();
  return t === 'Buy' || t === 'Sell' || t === '매수' || t === '매도';
}

function findTradePanel() {
  let best = null;
  let bestScore = -1;
  for (const el of document.querySelectorAll('div, section, aside, form')) {
    if (!visible(el)) continue;
    const t = el.innerText || '';
    if (!el.querySelector('input, [contenteditable="true"]')) continue;
    if (t.length > 8000) continue;

    const hasToWin = /to\s*win/i.test(t);
    const hasAmount = /\bamount\b/i.test(t);
    const hasBuy = /\bbuy\b/i.test(t);
    const hasShares = /\bshares\b/i.test(t);
    const hasLimit = /\blimit\b/i.test(t);
    const hasMarket = /\bmarket\b/i.test(t);
    if (!hasToWin && !hasAmount && !(hasBuy && hasShares)) continue;
    if (hasAmount && !hasBuy && !hasToWin && !hasShares) continue;

    let score = 0;
    if (hasAmount) score += 35;
    if (hasBuy) score += 30;
    if (hasToWin) score += 25;
    if (hasShares) score += 20;
    if (hasLimit || hasMarket) score += 15;
    if (/(?:avg\.?\s*)?price\s*\d/i.test(t)) score += 20;
    score += Math.min(t.length / 15, 80);
    if (/\+\s*\$1\s*@\s*1\s*¢/i.test(t)) score -= 120;
    if (t.length < 40) score -= 50;

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
    if (!/^amount$/i.test(lt) && !/^금액$/i.test(lt)) continue;
    const box = label.closest('div') || label.parentElement;
    const inp = box?.querySelector('input, textarea, [contenteditable="true"]');
    if (inp && visible(inp)) return inp;
  }

  const inputs = Array.from(root.querySelectorAll('input, textarea, [contenteditable="true"]')).filter(visible);
  for (const inp of inputs) {
    const ph = (inp.placeholder || '').toLowerCase();
    const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
    const name = (inp.getAttribute('name') || '').toLowerCase();
    if (ph.includes('amount') || ph.includes('$') || aria.includes('amount') || name.includes('amount')) {
      return inp;
    }
  }

  const panelInputs = inputs.filter((inp) => !panel || panel.contains(inp));
  for (const inp of panelInputs) {
    const type = (inp.getAttribute('type') || '').toLowerCase();
    if (type === 'number' || type === 'text' || type === '' || inp.isContentEditable) return inp;
  }
  return panelInputs[0] || root.querySelector('input');
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

function parseMoneyOnly(text) {
  const t = String(text || '').trim();
  const m = t.match(/^\$?\s*([\d,]+(?:\.\d+)?)$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
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

function readPayoutAmount(panel, stake) {
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
  const m = t.match(/(\d+(?:\.\d+)?)\s*¢/);
  if (!m) return null;
  const c = parseFloat(m[1]);
  if (!isValidPolyCents(c)) return null;
  return c;
}

function teamMatchesButton(team, text) {
  if (!team) return true;
  const t = String(text || '');
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  const nt = norm(team);
  const bt = norm(t);
  if (!nt || !bt) return false;
  if (bt.includes(nt) || nt.includes(bt)) return true;

  const first = String(team).split(/\s+/).filter((w) => w.length >= 2)[0];
  if (first) {
    const nf = norm(first);
    if (nf.length >= 3 && (bt.includes(nf) || nf.includes(bt))) return true;
  }

  const words = String(team).split(/\s+/).filter((w) => w.length >= 2);
  if (words.length >= 2 && words.every((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t))) return true;
  return words.some((w) => w.length >= 3 && new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t));
}

function readCentsForBuyTeam(teamHint) {
  if (!teamHint) return null;

  const candidates = [];
  const roots = [findTradePanel(), document.body].filter(Boolean);

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

      let score = 0;
      if (teamMatchesButton(teamHint, t)) score += 120;
      score += selectionScore(btn);
      if (/^buy\s+/i.test(t)) score += 40;
      score += Math.max(0, 90 - t.length);
      candidates.push({ cents, score, t });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].cents;
}

function centsFromStakePayout(stake, payout) {
  if (!stake || !payout || payout <= stake * 1.01) return null;
  const cents = (stake / payout) * 100;
  if (!isValidPolyCents(cents)) return null;
  return Math.round(cents * 10) / 10;
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

function readSelectedOutcomeForTeam(teamHint) {
  const candidates = [];
  const minSel = teamHint ? 10 : 60;
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

function readTeamLabel(panel) {
  const scopes = [panel, findTradePanel(), document.body].filter(Boolean);
  const seen = new Set();

  for (const scope of scopes) {
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);

    for (const btn of scope.querySelectorAll('button, [role="button"]')) {
      if (!visible(btn)) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      const m = t.match(/^buy\s+(.+)$/i);
      if (m) return m[1].trim();
    }

    const text = scope.innerText || '';
    const buyM = text.match(/(?:Buy|매수)\s+([^\n$¢@]+?)(?:\s*$|\s+Avg|\s+To win)/i);
    if (buyM) return buyM[1].trim();
  }

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

function readLiveListedCents(panel, stake, payout) {
  const panelEl = panel || findTradePanel();
  const team = readTeamLabel(panelEl);
  const candidates = [];

  function add(cents, score, src) {
    if (!isValidPolyCents(cents)) return;
    candidates.push({ cents, score, src });
  }

  // 1) Buy {팀} 기준 — 선택 상태 없이도 홈/원정 즉시 반영
  if (team) {
    const buyTeam = readCentsForBuyTeam(team);
    if (buyTeam) add(buyTeam, 620, 'buy-team');

    const buyBtn = readBuyButtonCents(panelEl);
    if (buyBtn) add(buyBtn, 580, 'buy-btn');

    const selected = readSelectedOutcomeForTeam(team);
    if (selected) add(selected, 500, 'selected');

    const teamBtn = readOutcomeButtonCents(team);
    if (teamBtn) add(teamBtn, 450, 'team-btn');
  }

  // 2) Avg price — 팀 전환 직후 stale 할 수 있어 낮은 우선순위
  const avg = readListedPriceCents(panelEl);
  if (avg) add(avg, 200, 'avg');

  // 3) To win / Amount
  const implied = centsFromStakePayout(stake, payout);
  if (implied) add(implied, 100, 'implied');

  if (!candidates.length) {
    const page = readPageOutcomeCents(team);
    if (page) add(page, 420, 'page');
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  // 팀 기준 값이 있으면 stale implied/avg 로 덮어쓰지 않음
  if (best.src === 'buy-team' || best.src === 'buy-btn' || best.src === 'selected' || best.src === 'team-btn' || best.src === 'page') return best.cents;

  const teamPick = candidates.find((c) =>
    c.src === 'buy-team' || c.src === 'buy-btn' || c.src === 'selected' || c.src === 'team-btn' || c.src === 'page'
  );
  if (teamPick && Math.abs(teamPick.cents - best.cents) >= 3) return teamPick.cents;

  return best.cents;
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
  const stake = readStake(panel);
  const payout = readPayoutAmount(panel, stake);
  const team = readTeamLabel(panel);
  const listedCents = readLiveListedCents(panel, stake, payout);

  let odds = oddsFromCents(listedCents);
  let fromPayout = false;

  const implied = centsFromStakePayout(stake, payout);
  if (!odds && implied) {
    odds = oddsFromCents(implied);
    fromPayout = true;
  } else if (odds && implied) {
    const impliedOdds = oddsFromCents(implied);
    if (impliedOdds && Math.abs(implied - listedCents) <= 2) {
      odds = impliedOdds;
      fromPayout = true;
    }
  } else if (!odds && stake && payout) {
    odds = calcOddsFromStakeAndPayout(stake, payout);
    fromPayout = !!(odds && odds > 1.001);
  }

  odds = sanitizePolyOdds(odds, listedCents, stake, payout);

  if (!odds || odds <= 1.001) {
    return {
      source: 'polymarket',
      odds: null,
      needsStake: !listedCents,
      teamLabel: team,
      priceCents: isValidPolyCents(listedCents) ? listedCents : null,
      hint: listedCents ? `${formatCentsLabel(listedCents)} 배당 읽는 중` : 'Polymarket 탭에서 outcome 선택',
      marketKind: 'ml'
    };
  }

  const priceCents = isValidPolyCents(listedCents) ? listedCents : (implied || decimalToCents(odds));
  if (!isValidPolyCents(priceCents)) {
    return {
      source: 'polymarket',
      odds: null,
      needsStake: true,
      teamLabel: team,
      hint: '배당 읽기 실패 — outcome 다시 클릭',
      marketKind: 'ml'
    };
  }

  const profit = fromPayout && payout && stake && payout >= stake ? payout - stake : null;
  const centsLabel = formatCentsLabel(priceCents);

  return {
    source: 'polymarket',
    odds,
    priceCents,
    price: priceCents / 100,
    teamLabel: team,
    outcome: team,
    selectionText: team ? `${team} @ ${centsLabel}` : centsLabel,
    displayLabel: `${centsLabel} (${odds.toFixed(3)})`,
    stake: stake || null,
    payout: fromPayout && payout ? payout : (stake ? stake * odds : null),
    toWin: profit,
    hint: stake && payout
      ? `베팅 $${stake} → 수령 $${payout.toFixed(2)}`
      : (listedCents ? `실시간 ${formatCentsLabel(priceCents)}` : ''),
    marketKind: 'ml',
    period: 'ft',
    marketKey: `poly_ml_${(team || 'out').slice(0, 20)}`,
    fromPayout,
    liveCents: !!listedCents
  };
}

function calcOddsFromStakeAndPayout(stake, payout) {
  if (!stake || !payout) return null;
  if (payout >= stake) return payout / stake;
  return (stake + payout) / stake;
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
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
    await sleep(100);
    return true;
  }

  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  try {
    el.select?.();
    document.execCommand?.('selectAll', false, null);
    document.execCommand?.('delete', false, null);
  } catch (_) {}

  if (setter) setter.call(el, '');
  for (const ch of str) {
    if (setter) setter.call(el, (el.value || '') + ch);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await sleep(25);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  await sleep(150);
  return true;
}

function ensureBuyTabSelected(panel) {
  const root = panel || findTradePanel() || document.body;
  for (const btn of root.querySelectorAll('button, [role="button"], [role="tab"]')) {
    if (!visible(btn)) continue;
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (t !== 'Buy' && t !== '매수') continue;
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
  if (t !== 'Buy' && t !== '매수' && t !== 'Sell' && t !== '매도') return false;
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
    if (!/^buy\s+/i.test(t) || t.length < 8) continue;
    if (/combo|terms|sell/i.test(t)) continue;

    const r = btn.getBoundingClientRect();
    let score = 100 + t.length;
    if (r.width >= 180 && r.height >= 38) score += 60;
    if (panel && panel.contains(btn)) score += 40;
    if (/gaming|yes|no/i.test(t)) score += 10;

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
  const stake = readStake(panel);
  if (stake) return stake;
  const t = (panel?.innerText || '').replace(/\s+/g, ' ');
  const m = t.match(/Amount\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (m) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (v > 0) return v;
  }
  return null;
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

async function placePolymarketBet(amountUsd) {
  const panel = findTradePanel();
  if (!panel) {
    return { success: false, reason: '주문 패널 없음 — /event/ 페이지에서 outcome 클릭', probe: probePolyBetUi() };
  }

  ensureBuyTabSelected(panel);
  await sleep(200);

  const amount = Math.max(1, Math.round(amountUsd * 100) / 100);
  const fill = await fillTradeAmount(panel, amount);

  let btn = null;
  let btnText = '';
  for (let i = 0; i < 25; i++) {
    await sleep(100);
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

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, site: 'polymarket', version: '5.1' });
    return false;
  }
  if (msg.type === 'READ_SLIP') {
    sendResponse({ slip: readPolymarketSlip() });
    return false;
  }
  if (msg.type === 'PROBE_POLY') {
    sendResponse({ ok: true, probe: probePolyBetUi() });
    return false;
  }
  if (msg.type === 'PLACE_BET') {
    placePolymarketBet(msg.amount).then(sendResponse);
    return true;
  }
});

try {
  window.__polyPlaceBet = placePolymarketBet;
  window.__polyProbe = probePolyBetUi;
  window.__polyReadSlip = readPolymarketSlip;
} catch (_) {}

(function observe() {
  let last = '';
  let pending = false;

  function slipKey(slip) {
    if (!slip) return '';
    const o = slip.odds > 1 ? slip.odds.toFixed(4) : 'x';
    return `${slip.priceCents || 'c'}_${o}_${slip.stake || ''}_${slip.teamLabel || ''}`;
  }

  function tick() {
    const slip = readPolymarketSlip();
    if (!slip) return;
    const key = slipKey(slip);
    if (key === last) return;
    last = key;
    try { chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: 'polymarket', slip }); } catch (_) {}
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

console.log('[Poly v5] content script loaded');
