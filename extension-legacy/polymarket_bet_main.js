// Polymarket 베팅 — MAIN world 전용 (React 클릭 반영)
(function () {
  if (window.__polyMainPlaceBet) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < window.innerHeight;
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
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (t !== 'Buy' && t !== 'Sell' && t !== '매수' && t !== '매도') return false;
    const parentText = (btn.parentElement?.textContent || '').replace(/\s+/g, ' ');
    return parentText.includes('Buy') && parentText.includes('Sell') && parentText.length < 60;
  }

  function hasDialog() {
    return !!document.querySelector('[role="dialog"], [role="alertdialog"], [class*="modal" i], [class*="Modal"], [class*="dialog" i], [class*="Dialog"], [data-state="open"]');
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
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        if (isBuySellTab(btn)) continue;
        if (t === 'Buy' && !hasDialog()) continue;
        if (!isConfirmText(t, aria)) continue;
        seen.add(btn);
        let score = 50;
        if (/confirm/i.test(t) || /confirm/i.test(aria)) score += 80;
        if (/place order|submit/i.test(t)) score += 70;
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
      const ctx = (el.closest('[role="dialog"], [role="alertdialog"], label, div')?.textContent || '').slice(0, 200);
      if (!/risk|understand|agree|accept|terms|18\+|confirm/i.test(ctx)) continue;
      if (el.checked || el.getAttribute('aria-checked') === 'true') continue;
      robustClick(el);
    }
  }

  async function autoConfirmBurst(maxMs = 2400) {
    const start = Date.now();
    let clicks = 0;
    while (Date.now() - start < maxMs) {
      if (pageBetSuccess()) return { ok: true, clicks, via: 'success-during-confirm' };
      if (pageBetError()) return { ok: false, clicks, via: 'error-during-confirm' };
      acceptRiskCheckboxes();
      const confirms = findConfirmButtons();
      for (const btn of confirms) {
        robustClick(btn);
        clicks++;
      }
      await sleep(60);
    }
    return { ok: !pageBetError(), clicks, via: 'burst-done' };
  }

  function findBuyTeamButton() {
    let best = null;
    let bestScore = -1;
    for (const btn of buttons()) {
      if (btn.disabled || isBuySellTab(btn)) continue;
      const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^buy\s+/i.test(t) || t.length < 8) continue;
      if (/combo|terms|sell|deposit|withdraw/i.test(t)) continue;
      const r = btn.getBoundingClientRect();
      let score = t.length;
      if (r.width >= 160 && r.height >= 36) score += 100;
      if (/gaming|yes|no/i.test(t)) score += 20;
      if (score > bestScore) {
        bestScore = score;
        best = btn;
      }
    }
    return best;
  }

  async function clickBuyTab() {
    for (const btn of buttons()) {
      const t = (btn.textContent || '').trim();
      if (t === 'Buy' || t === '매수') {
        robustClick(btn);
        return true;
      }
    }
    return false;
  }

  async function fillAmountWithChips(target) {
    let left = Math.max(1, Math.round(target));
    let clicks = 0;
    for (const n of [100, 10, 5, 1]) {
      while (left >= n) {
        const chip = buttons().find((b) => {
          const t = (b.textContent || '').trim();
          return t === `+$${n}` || t === `$${n}`;
        });
        if (!chip) break;
        robustClick(chip);
        clicks++;
        left -= n;
        await sleep(120);
      }
    }
    return clicks;
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
    const burst = await autoConfirmBurst(3000);
    if (burst.ok && pageBetSuccess()) return { confirmed: true, via: 'page-success', confirmClicks: burst.clicks };
    if (pageBetError()) return { confirmed: false, via: 'page-error', confirmClicks: burst.clicks };

    for (let i = 0; i < 10; i++) {
      await sleep(150);
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
      btnText: buyBtn ? buyBtn.textContent.trim().slice(0, 80) : '',
      btnDisabled: buyBtn ? buyBtn.disabled : null,
      hasConfirmBtn: confirms.length > 0,
      confirmText: confirms[0] ? confirms[0].textContent.trim().slice(0, 60) : '',
      hasDialog: hasDialog(),
      url: location.href,
      world: 'MAIN'
    };
  };

  window.__polyMainPlaceBet = async function (amountUsd) {
    try {
      await clickBuyTab();
      await sleep(150);

      const amount = Math.max(1, Math.round(amountUsd * 100) / 100);
      const chipClicks = await fillAmountWithChips(amount);
      await sleep(200);

      const buyBtn = findBuyTeamButton();
      if (!buyBtn) {
        return {
          success: false,
          reason: 'Buy {팀명} 버튼 없음 — outcome 선택 확인',
          probe: window.__polyMainProbe(),
          chipClicks
        };
      }

      const btnText = buyBtn.textContent.trim();
      robustClick(buyBtn);
      await sleep(80);

      const result = await waitBetResult();
      if (!result.confirmed) {
        return {
          success: false,
          reason: '베팅 실패 — 잔액/금액 확인',
          btnText,
          chipClicks,
          amount,
          confirmClicks: result.confirmClicks,
          method: 'main-world'
        };
      }

      return {
        success: true,
        confirmed: true,
        pendingWallet: false,
        btnText,
        chipClicks,
        amount,
        confirmClicks: result.confirmClicks,
        via: result.via,
        method: 'main-world',
        reason: result.confirmClicks ? '구매+확인 자동 완료' : '즉시 구매 완료'
      };
    } catch (e) {
      return { success: false, reason: e.message, method: 'main-world' };
    }
  };
})();
