// Polymarket 베팅 — MAIN world (trading-button UI 지원)
(function () {
  const VERSION = '1.0.6';
  if (window.__polyMainVersion === VERSION && window.__polyMainPlaceBet) return;
  window.__polyMainVersion = VERSION;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function btnText(btn) {
    return (btn?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function buttons() {
    return Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  }

  function robustClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    try { el.focus({ preventScroll: true }); } catch (_) {}
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    try { if (typeof el.click === 'function') el.click(); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse' })); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse' })); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
    return true;
  }

  function isBuySellTab(btn) {
    const t = btnText(btn);
    if (t !== 'Buy' && t !== 'Sell' && t !== '매수' && t !== '매도') return false;
    const parentText = (btn.parentElement?.textContent || '').replace(/\s+/g, ' ');
    return parentText.includes('Buy') && parentText.includes('Sell') && parentText.length < 60;
  }

  function isTradingBuyButton(btn) {
    if (!btn || btn.disabled || !visible(btn)) return false;
    if (isBuySellTab(btn)) return false;
    const t = btnText(btn);
    if (!/^buy\b/i.test(t) || t.length < 4) return false;
    if (/combo|terms|sell|deposit|withdraw/i.test(t)) return false;
    if (btn.classList?.contains('trading-button')) return true;
    if (btn.querySelector?.('.trading-button-text')) return true;
    return t.length >= 6;
  }

  function findBuyTeamButton() {
    let best = null;
    let bestScore = -1;

    for (const btn of buttons()) {
      if (!isTradingBuyButton(btn)) continue;
      const t = btnText(btn);
      let score = 200;
      if (btn.classList.contains('trading-button')) score += 500;
      if (btn.querySelector('.trading-button-text')) score += 300;
      const r = btn.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 32) score += 80;
      score += Math.min(t.length, 40);
      if (score > bestScore) { bestScore = score; best = btn; }
    }

    if (best) return best;

    const direct = document.querySelector('button.trading-button[type="button"]');
    if (direct && isTradingBuyButton(direct)) return direct;

    return null;
  }

  function hasDialog() {
    return !!document.querySelector('[role="dialog"], [role="alertdialog"], [class*="modal" i], [class*="Modal"], [data-state="open"]');
  }

  function isConfirmText(t, aria) {
    const s = `${t} ${aria}`.replace(/\s+/g, ' ').trim();
    if (!s || s.length > 100) return false;
    if (/cancel|close|back|edit|dismiss|no thanks|later|skip/i.test(s) && !/confirm/i.test(s)) return false;
    return /confirm|place order|submit order|complete purchase|buy now|approve|continue|yes|확인|승인|주문/i.test(s);
  }

  function findConfirmButtons() {
    const scopes = [];
    for (const dlg of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-state="open"]')) scopes.push(dlg);
    if (!scopes.length && hasDialog()) scopes.push(document.body);

    const found = [];
    const seen = new Set();
    for (const scope of scopes) {
      for (const btn of scope.querySelectorAll('button, [role="button"]')) {
        if (!visible(btn) || btn.disabled || seen.has(btn)) continue;
        const t = btnText(btn);
        const aria = (btn.getAttribute('aria-label') || '').trim();
        if (isBuySellTab(btn)) continue;
        if (t === 'Buy' && !hasDialog()) continue;
        if (!isConfirmText(t, aria)) continue;
        seen.add(btn);
        let score = 50;
        if (/confirm/i.test(t) || /confirm/i.test(aria)) score += 80;
        if (scope.matches('[role="dialog"], [role="alertdialog"], [data-state="open"]')) score += 40;
        found.push({ btn, score });
      }
    }
    found.sort((a, b) => b.score - a.score);
    return found.map((x) => x.btn);
  }

  function acceptRiskCheckboxes() {
    for (const el of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
      if (!visible(el)) continue;
      const ctx = (el.closest('[role="dialog"], label, div')?.textContent || '').slice(0, 200);
      if (!/risk|understand|agree|accept|terms|18\+|confirm/i.test(ctx)) continue;
      if (el.checked || el.getAttribute('aria-checked') === 'true') continue;
      robustClick(el);
    }
  }

  async function autoConfirmBurst(maxMs = 3000) {
    const start = Date.now();
    let clicks = 0;
    while (Date.now() - start < maxMs) {
      if (pageBetSuccess()) return { ok: true, clicks, via: 'success-during-confirm' };
      if (pageBetError()) return { ok: false, clicks, via: 'error-during-confirm' };
      acceptRiskCheckboxes();
      for (const btn of findConfirmButtons()) {
        robustClick(btn);
        clicks++;
      }
      await sleep(60);
    }
    return { ok: !pageBetError(), clicks, via: 'burst-done' };
  }

  async function clickBuyTab() {
    for (const btn of buttons()) {
      const t = btnText(btn);
      if (t === 'Buy' || t === '매수' || t === '구매') {
        robustClick(btn);
        return true;
      }
    }
    return false;
  }

  function findAmountInput() {
    const candidates = [];
    for (const inp of document.querySelectorAll('input, textarea, [contenteditable="true"]')) {
      if (!visible(inp)) continue;
      const ph = (inp.placeholder || '').toLowerCase();
      const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
      const id = (inp.id || '').toLowerCase();
      if (/search|검색/.test(ph) || /search|검색/.test(aria)) continue;
      let score = 0;
      if (/amount|금액|usdt|\$/.test(`${ph} ${aria} ${id} ${inp.className}`)) score += 100;
      if (inp.type === 'number' || inp.inputMode === 'decimal') score += 50;
      const near = inp.closest('[class*="trading"], [class*="Trade"], form, aside') || inp.parentElement;
      if (near?.querySelector?.('button.trading-button')) score += 200;
      if (score > 0) candidates.push({ inp, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.inp || null;
  }

  async function fillAmountExact(target) {
    const amount = Math.max(1, Math.round(target * 100) / 100);
    const str = String(amount);
    const input = findAmountInput();

    if (input) {
      input.focus();
      try { input.click(); } catch (_) {}
      if (input.isContentEditable) {
        input.textContent = str;
      } else {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        try { input.select?.(); } catch (_) {}
        if (setter) setter.call(input, str);
        else input.value = str;
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertFromPaste' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(200);
      return { ok: true, method: 'type', amount };
    }

    let clicks = 0;
    let left = Math.round(amount);
    for (const n of [100, 10, 5, 1]) {
      while (left >= n) {
        const chip = buttons().find((b) => {
          const t = btnText(b);
          return t === `+$${n}` || t === `$${n}`;
        });
        if (!chip) break;
        robustClick(chip);
        clicks++;
        left -= n;
        await sleep(100);
      }
    }
    return { ok: clicks > 0, method: 'chips', amount, chipClicks: clicks };
  }

  function pageBetSuccess() {
    const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return /order (submitted|placed|complete|filled)|purchase complete|successfully purchased|bought|trade submitted|shares purchased|매수 완료|주문 완료|trade complete|you bought/i.test(t);
  }

  function pageBetError() {
    const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return /insufficient (balance|funds)|not enough|failed to|transaction failed|rejected|unable to place|잔액 부족|주문 실패/i.test(t);
  }

  async function waitBetResult() {
    const burst = await autoConfirmBurst(3500);
    if (burst.ok && pageBetSuccess()) return { confirmed: true, via: 'page-success', confirmClicks: burst.clicks };
    if (pageBetError()) return { confirmed: false, via: 'page-error', confirmClicks: burst.clicks };

    for (let i = 0; i < 12; i++) {
      await sleep(120);
      if (pageBetSuccess()) return { confirmed: true, via: 'page-success-late', confirmClicks: burst.clicks };
      if (pageBetError()) return { confirmed: false, via: 'page-error-late', confirmClicks: burst.clicks };
      const confirms = findConfirmButtons();
      if (confirms.length) robustClick(confirms[0]);
    }

    if (!pageBetError()) return { confirmed: true, via: 'instant-buy', confirmClicks: burst.clicks };
    return { confirmed: false, via: 'timeout', confirmClicks: burst.clicks };
  }

  window.__polyMainProbe = function () {
    const buyBtn = findBuyTeamButton();
    const confirms = findConfirmButtons();
    return {
      hasBuyBtn: !!buyBtn,
      btnText: buyBtn ? btnText(buyBtn).slice(0, 80) : '',
      btnClass: buyBtn?.className || '',
      btnDisabled: buyBtn ? buyBtn.disabled : null,
      hasTradingButton: !!document.querySelector('button.trading-button'),
      hasConfirmBtn: confirms.length > 0,
      hasAmountInput: !!findAmountInput(),
      url: location.href,
      world: 'MAIN'
    };
  };

  function readCurrentAmount() {
    const input = findAmountInput();
    if (!input) return 0;
    const raw = input.isContentEditable ? input.textContent : input.value;
    const v = parseFloat(String(raw || '').replace(/[$,\s]/g, ''));
    return Number.isFinite(v) ? v : 0;
  }

  window.__polyMainPlaceBet = async function (amountUsd, opts = {}) {
    const skipFill = !!opts.skipFill;
    let fill = { ok: true, method: skipFill ? 'presynced' : 'pending', amount: amountUsd };
    try {
      if (!skipFill) {
        await clickBuyTab();
        await sleep(60);
        const fillResult = await fillAmountExact(amountUsd);
        fill = fillResult;
        await sleep(80);
        if (!fill.ok && fill.method === 'chips' && !fill.chipClicks) {
          return { success: false, reason: '금액 입력 실패', probe: window.__polyMainProbe(), fill };
        }
      } else {
        const cur = readCurrentAmount();
        const target = Math.max(1, Math.round(amountUsd * 100) / 100);
        if (Math.abs(cur - target) > 0.2) {
          await clickBuyTab();
          await fillAmountExact(target);
          await sleep(60);
        }
      }

      let buyBtn = null;
      for (let i = 0; i < (skipFill ? 8 : 20); i++) {
        buyBtn = findBuyTeamButton();
        if (buyBtn && !buyBtn.disabled) break;
        await sleep(skipFill ? 25 : 80);
        buyBtn = null;
      }

      if (!buyBtn) {
        return {
          success: false,
          reason: 'Buy 버튼 없음 (trading-button) — outcome 선택 확인',
          probe: window.__polyMainProbe(),
          fill
        };
      }

      const label = btnText(buyBtn);
      robustClick(buyBtn);
      if (!skipFill) {
        await sleep(100);
        robustClick(buyBtn);
      }

      const result = await waitBetResult();
      if (!result.confirmed) {
        return {
          success: false,
          reason: '베팅 실패 — 잔액/금액 확인',
          btnText: label,
          fill,
          confirmClicks: result.confirmClicks,
          method: 'main-world'
        };
      }

      return {
        success: true,
        confirmed: true,
        btnText: label,
        fill: skipFill ? { ok: true, method: 'presynced', amount: amountUsd } : fill,
        confirmClicks: result.confirmClicks,
        via: result.via,
        method: skipFill ? 'main-fast' : 'main-world'
      };
    } catch (e) {
      return { success: false, reason: e.message, method: 'main-world' };
    }
  };
})();
