(function () {
  if (window.__bcStakeSetLoaded) return;
  window.__bcStakeSetLoaded = true;

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
    if (!root || depth > 64) return;
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
    } catch (_) {}
    return true;
  }

  function parseStake(text) {
    const m = String(text || '').replace(/,/g, '').match(/([\d]+(?:\.\d+)?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function slipText(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function findSlipRoot() {
    const selectors = [
      '[data-testid*="betslip"]',
      '[data-testid*="BetSlip"]',
      '[class*="betslip"]',
      '[class*="Betslip"]',
      '[class*="bet-slip"]',
      'aside',
      'section',
      'form'
    ];
    let best = null;
    let bestScore = -1;

    for (const sel of selectors) {
      for (const el of collectAll(sel)) {
        if (!visible(el)) continue;
        const t = slipText(el);
        if (t.length < 20 || t.length > 8000) continue;
        if (!/베팅\s*슬립|bet\s*slip|betslip|place\s*(a\s*)?bet|베팅하기/i.test(t)) continue;
        let score = 0;
        if (/베팅\s*슬립|bet\s*slip/i.test(t)) score += 80;
        if (/USDT/i.test(t)) score += 60;
        if (collectAll('input, textarea, [contenteditable="true"], [role="textbox"], [role="spinbutton"]', el).length) score += 40;
        if (/예상\s*당첨|potential\s*win|total\s*stake|총\s*베팅/i.test(t)) score += 30;
        if (/vs\.?|승자|winner/i.test(t)) score += 20;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
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
      inp.getAttribute('role') || '',
      inp.value || '',
      inp.textContent || ''
    ];
    let parent = inp.parentElement;
    for (let i = 0; i < 4 && parent; i++) {
      parts.push(parent.textContent || '');
      parent = parent.parentElement;
    }
    return parts.join(' ').slice(0, 500);
  }

  function isStakeCandidate(inp) {
    if (!visible(inp)) return false;
    if (inp.disabled) return false;
    const ctx = inputContext(inp).toLowerCase();
    if (/search|검색|email|password|phone/i.test(ctx)) return false;
    if (inp.id === 'counter') return true;
    if (/countersecondary|counter__input|spinbutton/i.test(ctx)) return true;
    if (/usdt|counter|stake|amount|bet|베팅|금액|wager/i.test(ctx)) return true;
    return false;
  }

  function findStakeInput(root) {
    const scope = root || document;
    const fields = collectAll(
      '#counter, input, textarea, [contenteditable="true"], [role="textbox"], [role="spinbutton"]',
      scope === document ? document.documentElement : scope
    );
    let best = null;
    let bestScore = -1;

    for (const inp of fields) {
      if (!isStakeCandidate(inp)) continue;
      const ctx = inputContext(inp).toLowerCase();
      let score = 0;
      if (inp.id === 'counter') score += 200;
      if (/usdt/i.test(ctx)) score += 120;
      if (/counter|stake|amount|bet|베팅|금액/i.test(ctx)) score += 80;
      if (root && root.contains?.(inp)) score += 40;
      if (inp.getAttribute('role') === 'spinbutton') score += 30;
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

  function findClickableStakeShell(root) {
    const scope = root || document.documentElement;
    let best = null;
    let bestScore = -1;
    walkDeep(scope, (node) => {
      if (node.nodeType !== 1 || !visible(node)) return;
      const t = slipText(node).replace(/\u00a0/g, ' ');
      if (!/\d+(?:\.\d+)?\s*USDT/i.test(t)) return;
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') return;
      if (t.length > 40) return;
      let score = 10;
      if (/^0(?:\.\d+)?\s*USDT$/i.test(t)) score += 80;
      if (/^0(?:\.\d+)?$/i.test(t) && /USDT/i.test(node.parentElement?.textContent || '')) score += 70;
      if (node.closest?.('[class*="slip"], [class*="Slip"], [class*="counter"], [class*="Counter"], [class*="stake"], [class*="Stake"]')) score += 50;
      if (node.getAttribute?.('role') === 'spinbutton') score += 60;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }, 0);
    return best;
  }

  function readStake(root) {
    const slip = root || findSlipRoot();
    const inp = findStakeInput(slip || document);
    if (inp) {
      const v = parseStake(inp.value || inp.textContent || inp.getAttribute('value') || '');
      if (v > 0) return v;
    }
    const text = slipText(slip || document.body);
    const m = text.match(/총\s*베팅(?:\s*금액)?\s*([\d,]+(?:\.\d+)?)/i)
      || text.match(/total\s*stake[^\d]{0,20}([\d,]+(?:\.\d+)?)/i);
    if (m) return parseStake(m[1]);
    const usdtMatches = [...text.matchAll(/([\d,]+(?:\.\d+)?)\s*USDT/gi)];
    for (const um of usdtMatches) {
      const v = parseStake(um[1]);
      if (v >= 0.2 && v <= 50000) return v;
    }
    return 0;
  }

  function activateStakeField(field) {
    try { field.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    try { field.click?.(); } catch (_) {}
    try { field.focus?.(); } catch (_) {}
    const shell = field.closest?.('[class*="counter"], [class*="Counter"], [class*="stake"], [class*="Stake"]');
    if (shell && shell !== field) {
      try { shell.click?.(); } catch (_) {}
    }
  }

  function setFieldValue(field, value) {
    const s = String(value);
    activateStakeField(field);

    if (field.isContentEditable) {
      field.textContent = s;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: s, inputType: 'insertFromPaste' }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    function apply(v) {
      activateStakeField(field);
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
    for (const btn of collectAll('button, [role="button"], div[class*="chip"], span[class*="chip"]', slip)) {
      if (!visible(btn)) continue;
      const t = (btn.textContent || '').replace(/\s+/g, '').trim();
      if (t === String(target) || t === `+${target}` || t === `$${target}` || t === `${target}USDT`) {
        try { btn.click(); } catch (_) {}
        return 1;
      }
    }
    return 0;
  }

  function setStake(amount) {
    const target = Math.max(0.2, Math.round(amount * 100) / 100);
    const slip = findSlipRoot();
    let inp = findStakeInput(slip || document);

    if (!inp) {
      const shell = findClickableStakeShell(slip || document.documentElement);
      if (shell) {
        try { shell.click(); } catch (_) {}
        try { shell.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (_) {}
        inp = findStakeInput(slip || document);
      }
    }

    if (!inp) {
      for (const el of collectAll('[role="spinbutton"], [class*="counter"], [class*="Counter"]', slip || document.documentElement)) {
        if (!visible(el)) continue;
        try { el.click(); } catch (_) {}
        inp = findStakeInput(slip || document);
        if (inp) break;
      }
    }

    if (!inp && target <= 50) {
      clickPresetChip(slip, target);
      const st = readStake(slip);
      if (st > 0 && Math.abs(st - target) < Math.max(0.2, target * 0.15)) {
        return { ok: true, stake: st, target, method: 'preset-chip-early', hasSlip: !!slip };
      }
    }

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
    const isTop = window === window.top;
    const isBcHost = /bc\.game/i.test(location.hostname);
    let score = (slip ? 80 : 0) + (inp ? 60 : 0) + (/베팅\s*슬립|bet\s*slip/i.test(body) ? 40 : 0);
    if (slip && inp) score += 200;
    if (isTop && isBcHost && /sports/i.test(location.pathname || '')) score += 150;
    if (/USDT/i.test(body)) score += 20;
    return {
      hasSlip: !!slip,
      hasInput: !!inp,
      hasUsdt: /USDT/i.test(body),
      stake: readStake(slip),
      score,
      isTop,
      isBcHost
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
