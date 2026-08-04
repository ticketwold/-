(function () {
  if (window.__bcStakeSetLoaded) return;
  window.__bcStakeSetLoaded = true;

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    } catch (_) {}
    return true;
  }

  function parseStake(text) {
    const m = String(text || '').replace(/,/g, '').match(/([\d]+(?:\.\d+)?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function findSlipRoot() {
    const candidates = document.querySelectorAll(
      'aside, section, div, form, [class*="slip"], [class*="Slip"], [class*="betslip"], [class*="Betslip"], [data-testid*="betslip"], [data-testid*="BetSlip"]'
    );
    let best = null;
    let bestScore = -1;
    for (const el of candidates) {
      if (!visible(el)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 20 || t.length > 8000) continue;
      if (!/베팅\s*슬립|bet\s*slip|betslip|place\s*(a\s*)?bet|베팅하기/i.test(t)) continue;
      let score = 0;
      if (/베팅\s*슬립|bet\s*slip/i.test(t)) score += 80;
      if (/USDT/i.test(t)) score += 60;
      if (el.querySelector('input, textarea, [contenteditable="true"]')) score += 40;
      if (/예상\s*당첨|potential\s*win|total\s*stake|총\s*베팅/i.test(t)) score += 30;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function inputContext(inp) {
    const parts = [
      inp.id || '',
      inp.className || '',
      inp.placeholder || '',
      inp.getAttribute('aria-label') || '',
      inp.getAttribute('name') || '',
      inp.value || '',
      inp.textContent || ''
    ];
    const parent = (inp.closest('[class*="slip"], [class*="Slip"], [class*="counter"], [class*="Counter"], [class*="stake"], [class*="Stake"]')
      || inp.parentElement)?.textContent || '';
    return `${parts.join(' ')} ${parent}`.slice(0, 400);
  }

  function findStakeInput(root) {
    const scope = root || document;
    const fields = scope.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]');
    let best = null;
    let bestScore = -1;

    for (const inp of fields) {
      if (!visible(inp)) continue;
      if (inp.disabled || inp.readOnly) continue;
      const ctx = inputContext(inp).toLowerCase();
      if (/search|검색|email|password/i.test(ctx)) continue;

      let score = 0;
      if (/usdt/i.test(ctx)) score += 120;
      if (/counter|stake|amount|bet|베팅|금액/i.test(ctx)) score += 80;
      if (inp.id === 'counter') score += 100;
      if (root && root.contains(inp)) score += 40;

      const val = inp.value || inp.textContent || '';
      if (/\d/.test(val)) score += 10;

      if (score > bestScore) {
        bestScore = score;
        best = inp;
      }
    }

    if (best) return best;

    const counter = document.getElementById('counter');
    if (counter && visible(counter)) return counter;

    return null;
  }

  function readStake(root) {
    const slip = root || findSlipRoot();
    const inp = findStakeInput(slip || document);
    if (inp) {
      const v = parseStake(inp.value || inp.textContent || inp.getAttribute('value') || '');
      if (v > 0) return v;
    }
    const text = (slip || document.body)?.innerText || '';
    const m = text.match(/총\s*베팅(?:\s*금액)?\s*([\d,]+(?:\.\d+)?)/i)
      || text.match(/total\s*stake[^\d]{0,20}([\d,]+(?:\.\d+)?)/i)
      || text.match(/([\d,]+(?:\.\d+)?)\s*USDT/i);
    return m ? parseStake(m[1]) : 0;
  }

  function setFieldValue(field, value) {
    const s = String(value);
    try { field.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    field.focus?.();
    try { field.click?.(); } catch (_) {}

    if (field.isContentEditable) {
      field.textContent = s;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: s, inputType: 'insertFromPaste' }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    function apply(v) {
      if (setter) setter.call(field, v);
      else field.value = v;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertFromPaste' }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
      field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    }

    apply(s);
    if (Math.abs(readStake() - parseFloat(s)) > 0.05) apply(`${s} USDT`);
    if (Math.abs(readStake() - parseFloat(s)) > 0.05) {
      apply('');
      for (const ch of s) {
        const next = (field.value || '') + ch;
        if (setter) setter.call(field, next);
        else field.value = next;
        field.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      }
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    try { field.dispatchEvent(new FocusEvent('blur', { bubbles: true })); } catch (_) {}
  }

  function clickPresetChip(slip, amount) {
    if (!slip) return 0;
    const presets = [10, 20, 50, 100, 300];
    const target = presets.find((p) => p >= amount) || presets[presets.length - 1];
    let clicked = 0;
    for (const btn of slip.querySelectorAll('button, [role="button"]')) {
      if (!visible(btn)) continue;
      const t = (btn.textContent || '').replace(/\s+/g, '').trim();
      if (t === String(target) || t === `+${target}` || t === `$${target}`) {
        try { btn.click(); } catch (_) {}
        clicked++;
        break;
      }
    }
    return clicked;
  }

  function setStake(amount) {
    const target = Math.max(0.2, Math.round(amount * 100) / 100);
    const slip = findSlipRoot();
    const inp = findStakeInput(slip || document);
    if (!inp) return { ok: false, reason: 'stake-input-missing', method: 'native-bc-slip' };

    setFieldValue(inp, target);
    let stake = readStake(slip);

    if (!stake || Math.abs(stake - target) > 0.15) {
      clickPresetChip(slip, target);
      stake = readStake(slip);
    }

    if (!stake || Math.abs(stake - target) > 0.15) {
      setFieldValue(inp, target);
      stake = readStake(slip);
    }

    const ok = stake > 0 && Math.abs(stake - target) < Math.max(0.15, target * 0.05);
    return {
      ok,
      partial: stake > 0 && !ok,
      stake: stake || 0,
      target,
      method: 'native-bc-slip',
      hasSlip: !!slip
    };
  }

  window.__bcSetStakeNative = setStake;
  window.__bcProbeStakeFrame = function () {
    const slip = findSlipRoot();
    const inp = findStakeInput(slip || document);
    const body = document.body?.innerText || '';
    return {
      hasSlip: !!slip,
      hasInput: !!inp,
      hasUsdt: /USDT/i.test(body),
      stake: readStake(slip),
      score: (slip ? 80 : 0) + (inp ? 60 : 0) + (/베팅\s*슬립|bet\s*slip/i.test(body) ? 40 : 0)
    };
  };

  const prev = window.__bcSetStake;
  window.__bcSetStake = function (amount) {
    const native = setStake(amount);
    if (native.ok || native.partial) return native;
    if (typeof prev === 'function' && prev !== window.__bcSetStake) {
      try {
        const res = prev(amount);
        if (res?.ok || res?.partial || res?.stake > 0) return res;
      } catch (_) {}
    }
    return native;
  };
})();
