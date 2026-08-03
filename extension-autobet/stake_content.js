// stake_content.js — Stake.com leg2 content script
'use strict';

function predictionSiteId() {
  return 'stake';
}

function isStakeSportsPage() {
  try {
    return /stake\.com/i.test(location.hostname) && /\/sports/i.test(location.pathname);
  } catch (_) {
    return false;
  }
}

function readLeg2Slip() {
  if (typeof window.__stakeReadNativeSlip === 'function') {
    return window.__stakeReadNativeSlip();
  }
  return null;
}

function probeLeg2BetUi() {
  const slip = readLeg2Slip();
  const inputs = document.querySelectorAll('input[inputmode="decimal"], input[type="number"], input[type="text"]');
  let inputCount = 0;
  for (const inp of inputs) {
    const blob = `${inp.placeholder || ''} ${inp.className || ''}`;
    if (!/search|email|password/i.test(blob)) inputCount++;
  }
  const btn = document.querySelector('button');
  let hasBtn = false;
  let btnDisabled = false;
  walkButtons((node, t) => {
    if (/place\s*bet|bet\s*now|confirm/i.test(t)) {
      hasBtn = true;
      btnDisabled = !!(node.disabled || node.getAttribute('aria-disabled') === 'true');
    }
  });
  return {
    hasInput: inputCount > 0 || !!(slip?.hasInput || slip?.stake > 0),
    hasBtn,
    btnDisabled,
    hasPanel: !!(slip?.odds > 1.01),
    slipOdds: slip?.odds || 0,
    stake: slip?.stake || null,
    team: slip?.teamLabel || '',
    mode: 'stake-sports',
    inputCount
  };
}

function walkButtons(fn) {
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 1) {
      const tag = node.tagName;
      if (tag === 'BUTTON' || tag === 'A' || node.getAttribute?.('role') === 'button') {
        fn(node, (node.textContent || node.getAttribute('aria-label') || '').trim());
      }
      for (const c of node.children || []) walk(c);
      const sr = node.shadowRoot;
      if (sr) walk(sr);
    }
  };
  walk(document.body);
}

async function setLeg2TradeAmount(amount, force) {
  if (typeof window.__stakeSetStake === 'function') {
    return window.__stakeSetStake(amount);
  }
  return { ok: false, reason: 'stake-set-missing' };
}

async function ensureLeg2Panel(team) {
  const probe = probeLeg2BetUi();
  if (probe.hasPanel || probe.hasInput) return { ok: true, alreadyOpen: true };
  return { ok: false, reason: 'Stake 슬립 없음 — 배당 클릭' };
}

async function placeLeg2Bet(amount, opts = {}) {
  if (!opts.skipFill && !opts.fastStrike && typeof window.__stakeSetStake === 'function') {
    const fill = await window.__stakeSetStake(amount);
    if (!fill?.ok && !fill?.partial) return { success: false, reason: fill?.reason || 'stake-fill-fail' };
  }
  if (typeof window.__stakePlaceBet === 'function') {
    return window.__stakePlaceBet(amount);
  }
  return { success: false, reason: 'stake-place-missing' };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, site: predictionSiteId(), version: '1.0' });
    return false;
  }
  if (msg.type === 'READ_SLIP') {
    sendResponse({ slip: readLeg2Slip() });
    return false;
  }
  if (msg.type === 'PROBE_POLY') {
    sendResponse({ ok: true, probe: probeLeg2BetUi() });
    return false;
  }
  if (msg.type === 'SET_POLY_AMOUNT') {
    setLeg2TradeAmount(msg.amount, msg.force !== false).then(sendResponse);
    return true;
  }
  if (msg.type === 'ENSURE_POLY_PANEL') {
    ensureLeg2Panel(msg.team || '').then(sendResponse);
    return true;
  }
  if (msg.type === 'PLACE_BET') {
    placeLeg2Bet(msg.amount, {
      skipFill: !!msg.skipFill,
      fastStrike: !!msg.fastStrike,
      teamHint: msg.teamHint || msg.team || ''
    }).then(sendResponse);
    return true;
  }
});

(function observe() {
  let last = '';
  let pending = false;

  function slipKey(slip) {
    if (!slip) return '';
    const o = slip.odds > 1 ? (Math.round(slip.odds * 100) / 100) : 0;
    return `${o.toFixed(2)}_${slip.teamLabel || ''}`;
  }

  function tick() {
    if (!isStakeSportsPage()) return;
    const slip = readLeg2Slip();
    if (!slip?.odds || slip.odds <= 1) {
      if (last !== '') {
        last = '';
        try { chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: predictionSiteId(), slip: null, suspended: true }); } catch (_) {}
      }
      return;
    }
    const key = slipKey(slip);
    if (key === last) return;
    last = key;
    try { chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', source: predictionSiteId(), slip }); } catch (_) {}
  }

  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; tick(); });
  }

  if (document.body) {
    document.addEventListener('click', schedule, true);
    document.addEventListener('input', schedule, true);
    new MutationObserver(schedule).observe(document.body, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'value', 'aria-pressed', 'aria-selected']
    });
    setInterval(tick, 250);
    tick();
  }
})();

console.log(`[Stake.com] content script — ${isStakeSportsPage() ? 'sports' : 'other'}`);
