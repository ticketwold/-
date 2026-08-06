/**
 * BetSlip stake input — 컨테이너 내부만.
 * args: { site: 'bc'|'bti', amount, containerSelector?, stakeSelector? }
 */
(function (args) {
  args = args || {};
  const site = args.site || 'bc';
  const amount = args.amount;
  const tolerance = args.tolerance || 0.01;

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    return r && r.width > 1 && r.height > 1;
  }

  function setNativeValue(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    if (setter) setter.call(el, String(v));
    else el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findBcStake(root) {
    const scope = root || document;
    const sels = [
      '[data-editor-id="betslipStakeInput"]',
      '[data-editor-id*="betslipStake"]',
      '[data-editor-id*="StakeInput"]',
      '[role="spinbutton"]'
    ];
    for (const sel of sels) {
      for (const el of scope.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        const inp = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el : el.querySelector('input,textarea');
        return inp || el;
      }
    }
    return null;
  }

  function findBtiStake(root) {
    const scope = root || document;
    return scope.querySelector('input#counter, input[class*="CounterSecondary_input"], input[placeholder*="베팅"]');
  }

  function findSlipRoot(siteName) {
    if (siteName === 'bti') {
      const roots = [...document.querySelectorAll('[class*="betslip_fe"], [class*="Betslip"], [class*="betslip"]')];
      roots.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length);
      return roots[0] || document.body;
    }
    const roots = [...document.querySelectorAll('[data-editor-id*="betslip"]')];
    return roots[0] || document.body;
  }

  function readValue(el) {
    const raw = String(el.value || el.textContent || '').replace(/,/g, '').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }

  const root = args.containerSelector
    ? document.querySelector(args.containerSelector) || findSlipRoot(site)
    : findSlipRoot(site);

  const input = (() => {
    if (args.stakeSelector) {
      const cached = root.querySelector(args.stakeSelector) || document.querySelector(args.stakeSelector);
      if (cached && visible(cached)) {
        return cached.tagName === 'INPUT' || cached.tagName === 'TEXTAREA' ? cached : cached.querySelector('input,textarea') || cached;
      }
    }
    return site === 'bti' ? findBtiStake(root) : findBcStake(root);
  })();
  if (!input) {
    return { ok: false, reason: 'stake-input-not-found', read: 0, target: amount };
  }

  setNativeValue(input, amount);
  const read = readValue(input);
  const target = parseFloat(amount);
  const ok = read === target;

  return {
    ok,
    reason: ok ? 'ok' : 'input-mismatch',
    read,
    target,
    selector: input.id ? `#${input.id}` : (input.getAttribute('data-editor-id') || input.className || 'input')
  };
})
