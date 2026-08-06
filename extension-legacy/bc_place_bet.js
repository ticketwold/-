(function () {
  window.__bcPlaceBetVer = 3;

  function openShadow(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return chrome?.dom?.openOrClosedShadowRoot?.(el) || null;
    } catch (_) {
      return null;
    }
  }

  function walkDeep(root, fn, depth) {
    if (!root || depth > 72) return;
    fn(root, depth);
    if (root.nodeType === 1) {
      const sr = openShadow(root);
      if (sr) walkDeep(sr, fn, depth + 1);
      for (const ch of root.childNodes) walkDeep(ch, fn, depth + 1);
    } else if (root.nodeType === 11) {
      for (const ch of root.childNodes) walkDeep(ch, fn, depth + 1);
    }
  }

  function collectAll(selector, scope) {
    const out = [];
    const seen = new Set();
    walkDeep(scope || document.documentElement, (node) => {
      if (node.nodeType !== 1 || !node.querySelectorAll) return;
      try {
        for (const el of node.querySelectorAll(selector)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch (_) {}
    }, 0);
    return out;
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      if (s.pointerEvents === 'none') return false;
    } catch (_) {}
    return true;
  }

  function slipText(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function findSlipRoot() {
    let best = null;
    let bestScore = -1;
    const vw = window.innerWidth || 1200;
    walkDeep(document.documentElement, (el) => {
      if (el.nodeType !== 1 || !visible(el)) return;
      const t = slipText(el);
      if (t.length < 15 || t.length > 8000) return;
      if (/내\s*베팅|bet\s*history|my\s*bets/i.test(t)) return;
      const hasSlip = /베팅\s*슬립|bet\s*slip|betslip/i.test(t)
        || (/단일|조합|시스템/.test(t) && /USDT|베팅|place\s*bet/i.test(t));
      if (!hasSlip) return;
      if (/슬립이\s*비어|선택한\s*베팅\s*없|베팅금액을\s*입력|베팅\s*옵션을\s*클릭|empty\s*bet\s*slip|no\s*selection/i.test(t)) return;
      let score = /베팅\s*슬립|bet\s*slip/i.test(t) ? 100 : 50;
      if (/vs\.?|승자|winner/i.test(t)) score += 40;
      if (/\d+\.\d{1,3}/.test(t)) score += 30;
      if (el.querySelector?.('input, textarea, [role="spinbutton"]')) score += 50;
      const r = el.getBoundingClientRect();
      if (r.x > vw * 0.35) score += 60;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }, 0);
    return best;
  }

  function isButtonClickable(btn) {
    if (!btn || !visible(btn)) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    const cls = `${btn.className || ''} ${btn.parentElement?.className || ''}`;
    if (/\bMui-disabled\b|disabled/i.test(cls) && btn.getAttribute('aria-disabled') !== 'false') {
      // MUI: class만 disabled일 때 aria 확인
      if (btn.getAttribute('aria-disabled') === 'true') return false;
    }
    return true;
  }

  function findBetslipPlaceBetButton() {
    const selectors = [
      '[data-editor-id="betslipPlaceBetButton"]',
      'button[data-editor-id="betslipPlaceBetButton"]',
      '[data-editor-id*="betslipPlaceBet"]',
      '[data-editor-id*="PlaceBetButton"]'
    ];
    for (const sel of selectors) {
      for (const el of collectAll(sel, document.documentElement)) {
        if (el.tagName !== 'BUTTON' && el.getAttribute?.('role') !== 'button') {
          const innerBtn = el.querySelector?.('button') || (el.closest?.('button') || null);
          if (innerBtn && isButtonClickable(innerBtn)) return innerBtn;
        }
        if (isButtonClickable(el)) return el;
      }
    }
    let found = null;
    walkDeep(document.documentElement, (el) => {
      if (found || el.nodeType !== 1 || el.tagName !== 'BUTTON') return;
      const editorId = el.getAttribute?.('data-editor-id') || '';
      if (editorId === 'betslipPlaceBetButton' || /betslipplacebet/i.test(editorId)) {
        if (isButtonClickable(el)) found = el;
      }
    }, 0);
    return found;
  }

  function isBetButton(btn) {
    if (!isButtonClickable(btn)) return false;
    const editorId = btn.getAttribute?.('data-editor-id') || '';
    if (editorId === 'betslipPlaceBetButton' || /betslipplacebet/i.test(editorId)) return true;
    const t = (btn.textContent || btn.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 120) return false;
    if (/취소|cancel|닫기|close|삭제|delete|clear/i.test(t) && !/베팅|bet/i.test(t)) return false;
    if (/^베팅하기$/i.test(t)) return true;
    if (/^place\s*bet$/i.test(t)) return true;
    if (/베팅하기/i.test(t) && (/USDT|총|total|\d+\.\d/.test(t))) return true;
    if (/^bet\s*now$/i.test(t)) return true;
    if ((btn.className || '').includes('sportsbook-Button') && /베팅|bet/i.test(t)) return true;
    if (/place\s*(a\s*)?bet/i.test(t) && /\d/.test(t)) return true;
    return false;
  }

  function findPlaceBetButton(slip) {
    const direct = findBetslipPlaceBetButton();
    if (direct) return direct;

    const scopes = slip ? [slip, document.documentElement] : [document.documentElement];
    for (const scope of scopes) {
      const candidates = collectAll('button, [role="button"], a', scope);
      for (const btn of candidates) {
        if (!visible(btn)) continue;
        if (isBetButton(btn)) return btn;
      }
    }
    return null;
  }

  function isConfirmButton(btn) {
    const t = (btn?.textContent || btn?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 60) return false;
    return /^(확인|배팅|배팅하기|confirm|yes|ok|place\s*bet|베팅\s*확인)$/i.test(t)
      || (/^bet$/i.test(t) && !/now/i.test(t));
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

  function slipLooksEmpty() {
    const slip = findSlipRoot();
    const t = slip ? slipText(slip) : (document.body?.innerText || '');
    return /슬립이\s*비어|선택한\s*베팅\s*없|베팅금액을\s*입력|베팅\s*옵션을\s*클릭|empty\s*bet\s*slip|no\s*selection/i.test(t);
  }

  function pageBetSuccess() {
    const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return /베팅\s*(이\s*)?완료|베팅\s*성공|bet\s*(has\s*been\s*)?placed|successfully\s*placed|bet\s*accepted|accepted\s*bet/i.test(t);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function clickConfirmDialogs() {
    let clicked = false;
    const scopes = [];
    for (const dlg of collectAll('[role="dialog"], [role="alertdialog"], [class*="modal" i], [class*="Modal"], [class*="dialog" i]', document.documentElement)) {
      if (visible(dlg)) scopes.push(dlg);
    }
    if (!scopes.length) scopes.push(document.body);

    for (const scope of scopes) {
      for (const btn of collectAll('button, [role="button"]', scope)) {
        if (!visible(btn) || btn.disabled) continue;
        if (isConfirmButton(btn)) {
          robustClick(btn);
          clicked = true;
        }
      }
    }
    return clicked;
  }

  async function waitForBetResult(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (pageBetSuccess()) return { ok: true, reason: 'success-text' };
      if (slipLooksEmpty()) return { ok: true, reason: 'slip-cleared' };
      await clickConfirmDialogs();
      await sleep(120);
    }
    if (slipLooksEmpty()) return { ok: true, reason: 'slip-cleared-late' };
    return { ok: false, reason: 'confirm-timeout' };
  }

  async function placeSportsBet(amountUsd) {
    const target = Math.max(0.01, Math.round(amountUsd * 100) / 100);
    const placeBtnEarly = findBetslipPlaceBetButton();
    const slip = findSlipRoot();
    if (!slip && !placeBtnEarly) {
      return { success: false, reason: 'slip-missing' };
    }

    let fillRes = null;
    if (typeof window.__bcSetStake === 'function') {
      try {
        fillRes = await Promise.resolve(window.__bcSetStake(target));
        if (!fillRes?.ok && !fillRes?.partial) {
          await sleep(100);
          fillRes = await Promise.resolve(window.__bcSetStake(target));
        }
      } catch (e) {
        fillRes = { ok: false, reason: String(e) };
      }
    }
    await sleep(200);

    let btn = findBetslipPlaceBetButton();
    if (!btn) btn = findPlaceBetButton(slip);
    if (!btn) btn = findPlaceBetButton(null);
    if (!btn) {
      return { success: false, reason: 'bet-btn-missing', fill: fillRes };
    }
    if (!isButtonClickable(btn)) {
      return {
        success: false,
        reason: 'bet-btn-disabled',
        fill: fillRes,
        btnText: (btn.textContent || '').trim().slice(0, 60),
        editorId: btn.getAttribute?.('data-editor-id') || ''
      };
    }

    robustClick(btn);
    const innerSpan = btn.querySelector?.('span');
    if (innerSpan) robustClick(innerSpan);
    await sleep(200);
    await clickConfirmDialogs();

    const waited = await waitForBetResult(4500);
    if (waited.ok) {
      return {
        success: true,
        btnText: (btn.textContent || '').trim().slice(0, 60),
        fill: fillRes,
        confirm: waited.reason
      };
    }

    // Retry click once if confirm dialog appeared
    const btn2 = findPlaceBetButton(slip) || findPlaceBetButton(null);
    if (btn2 && !btn2.disabled) {
      robustClick(btn2);
      await sleep(250);
      await clickConfirmDialogs();
      const waited2 = await waitForBetResult(3500);
      if (waited2.ok) {
        return { success: true, btnText: (btn2.textContent || '').trim().slice(0, 60), fill: fillRes, confirm: waited2.reason };
      }
    }

    return {
      success: false,
      reason: waited.reason || 'bet-not-confirmed',
      fill: fillRes,
      btnText: (btn.textContent || '').trim().slice(0, 60)
    };
  }

  window.__bcPlaceSportsBetV2 = placeSportsBet;
  window.__bcPlaceSportsBet = placeSportsBet;
})();
