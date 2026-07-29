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

  function isBuySellTab(btn) {
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (t !== 'Buy' && t !== 'Sell' && t !== '매수' && t !== '매도') return false;
    const parentText = (btn.parentElement?.textContent || '').replace(/\s+/g, ' ');
    return parentText.includes('Buy') && parentText.includes('Sell') && parentText.length < 60;
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
        btn.click();
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
        chip.click();
        clicks++;
        left -= n;
        await sleep(200);
      }
    }
    return clicks;
  }

  async function clickConfirmIfAny() {
    for (const btn of buttons()) {
      const t = (btn.textContent || '').trim();
      if (/^(confirm|submit|place order|approve|sign|continue)$/i.test(t)) {
        btn.click();
        await sleep(350);
        return true;
      }
    }
    return false;
  }

  window.__polyMainProbe = function () {
    const buyBtn = findBuyTeamButton();
    return {
      hasBuyBtn: !!buyBtn,
      btnText: buyBtn ? buyBtn.textContent.trim().slice(0, 80) : '',
      btnDisabled: buyBtn ? buyBtn.disabled : null,
      url: location.href,
      world: 'MAIN'
    };
  };

  window.__polyMainPlaceBet = async function (amountUsd) {
    try {
      await clickBuyTab();
      await sleep(300);

      const amount = Math.max(1, Math.round(amountUsd * 100) / 100);
      const chipClicks = await fillAmountWithChips(amount);
      await sleep(400);

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
      buyBtn.scrollIntoView({ block: 'center', inline: 'center' });
      await sleep(100);
      buyBtn.click();
      await sleep(500);
      await clickConfirmIfAny();

      return {
        success: true,
        pendingWallet: true,
        confirmed: false,
        btnText,
        chipClicks,
        amount,
        method: 'main-world',
        reason: 'Buy 클릭 완료 — 지갑에서 서명하세요'
      };
    } catch (e) {
      return { success: false, reason: e.message, method: 'main-world' };
    }
  };
})();
