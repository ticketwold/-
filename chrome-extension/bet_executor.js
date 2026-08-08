/**
 * Content-script bet execution — immediate click on EXECUTE_BET.
 */
(function initBetExecutor(global) {
  function executeBet(site) {
    const actions = global.ArbStakeActions;
    if (!actions) return { ok: false, reason: "actions-missing", site };
    if (site === "x10") {
      const result = actions.placeX10Bet?.(`exec-${Date.now()}`);
      return {
        ok: !!result?.ok,
        site: "x10",
        outcome: result?.ok ? "CLICKED" : "FAILED",
        reason: result?.reason || result?.error || "",
        frame_url: location.href,
      };
    }
    const result = actions.placeBcBet?.(`exec-${Date.now()}`);
    return {
      ok: !!result?.ok,
      site: "bc",
      outcome: result?.ok ? "CLICKED" : "FAILED",
      reason: result?.reason || result?.error || "",
      frame_url: location.href,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "EXECUTE_BET") {
      const site = message.site === "bc" ? "bc" : "x10";
      try {
        sendResponse(executeBet(site));
      } catch (err) {
        sendResponse({ ok: false, site, outcome: "FAILED", reason: String(err) });
      }
      return true;
    }
    if (message?.type === "SCAN_BET_BUTTON") {
      const actions = global.ArbStakeActions;
      const site = message.site === "bc" ? "bc" : "x10";
      const result = actions?.scanBetButton?.(site) || { ok: false, reason: "not-found" };
      sendResponse({ ...result, site, frame_url: location.href });
      return true;
    }
    return false;
  });

  global.ArbBetExecutor = { executeBet };
})(typeof globalThis !== "undefined" ? globalThis : window);
