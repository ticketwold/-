/**
 * 양방배팅 확장 — Background Service Worker
 */
importScripts("match_matcher.js", "arb_calculator.js", "pinnacle_api.js");

const BTI_PBC00_URL =
  "https://pbc00.com/game/newDetail/0?gamecode=19&game_child_seq=3659&event=N";

const DEFAULTS = {
  minProfitMargin: 0.5,
  totalStake: 100000,
  sport: "football",
  pbc00TabId: null,
};

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...settings };
}

async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function getAllFrameIds(tabId) {
  if (!chrome.webNavigation?.getAllFrames) return [0];
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      resolve((frames || []).map((f) => f.frameId));
    });
  });
}

async function messageFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

async function broadcastBti(tabId, message) {
  const frameIds = await getAllFrameIds(tabId);
  const responses = [];
  for (const frameId of frameIds) {
    const res = await messageFrame(tabId, frameId, message);
    if (res) responses.push({ ...res, frameId });
  }
  if (!responses.length) {
    return {
      ok: false,
      error: "no_frame_response",
      hint: "pbc00 BTI 화면을 열고 로그인하세요. manifest all_frames:true 확인",
    };
  }
  responses.sort((a, b) => {
    const score = (r) =>
      (r.hitCount || 0) * 1000 +
      (r.selectionHitCount || 0) * 500 +
      (r.eventCount || 0) * 100 +
      (r.buttonCount || 0);
    return score(b) - score(a);
  });
  return { ...responses[0], framesAnswered: responses.length };
}

async function findPbc00Tab() {
  const settings = await loadSettings();
  if (settings.pbc00TabId) {
    try {
      const tab = await chrome.tabs.get(settings.pbc00TabId);
      if (tab?.url?.includes("pbc00.com")) return tab;
    } catch (_) {}
  }
  const tabs = await chrome.tabs.query({ url: ["https://pbc00.com/*", "https://*.pbc00.com/*"] });
  return tabs[0] || null;
}

async function scanArbitrage({ sport, query, minProfit, totalStake }) {
  const settings = await loadSettings();
  const sportKey = sport || settings.sport;
  const min = minProfit ?? settings.minProfitMargin;
  ArbCalculator.minProfitMargin = min;
  ArbCalculator.totalStake = totalStake ?? settings.totalStake;

  const [pinnacle, pbc00Tab] = await Promise.all([
    query
      ? PinnacleAPI.searchMatches(sportKey, query)
      : PinnacleAPI.fetchSport(sportKey),
    findPbc00Tab(),
  ]);

  let bti = { ok: false, events: [], hint: "pbc00 탭 없음 — 'pbc00 열기' 클릭" };
  if (pbc00Tab?.id) {
    bti = await broadcastBti(pbc00Tab.id, {
      type: query ? "BTI_SEARCH" : "SCRAPE_BOARD",
      query: query || "",
    });
    if (settings.pbc00TabId !== pbc00Tab.id) {
      await saveSettings({ pbc00TabId: pbc00Tab.id });
    }
  }

  const pinMatches = query ? (pinnacle.hits || []) : (pinnacle.matches || []);
  const btiEvents = (bti.hits?.length ? bti.hits : null) || bti.events || [];

  const opportunities = ArbCalculator.findOpportunities(pinMatches, btiEvents, min);

  return {
    ok: true,
    sport: sportKey,
    query: query || "",
    pinnacle: {
      total: pinnacle.count || pinnacle.matches?.length || 0,
      matched: pinMatches.length,
    },
    bti: {
      ok: bti.ok !== false,
      buttonCount: bti.buttonCount || 0,
      eventCount: bti.eventCount || 0,
      frameUrl: bti.frameUrl || "",
      hint: bti.hint || "",
    },
    opportunities,
    opportunityCount: opportunities.length,
    scannedAt: new Date().toISOString(),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.action === "get-settings") {
        sendResponse(await loadSettings());
        return;
      }

      if (msg.action === "save-settings") {
        sendResponse(await saveSettings(msg.settings || {}));
        return;
      }

      if (msg.action === "open-pbc00") {
        const tab = await chrome.tabs.create({ url: BTI_PBC00_URL, active: true });
        await saveSettings({ pbc00TabId: tab.id });
        sendResponse({ ok: true, tabId: tab.id, url: BTI_PBC00_URL });
        return;
      }

      if (msg.action === "pinnacle-fetch") {
        const data = msg.query
          ? await PinnacleAPI.searchMatches(msg.sport || "football", msg.query)
          : await PinnacleAPI.fetchSport(msg.sport || "football");
        sendResponse({ ok: true, ...data });
        return;
      }

      if (msg.action === "bti-search") {
        const tab = await findPbc00Tab();
        if (!tab) {
          sendResponse({ ok: false, error: "pbc00_tab_not_found" });
          return;
        }
        sendResponse(await broadcastBti(tab.id, { type: "BTI_SEARCH", query: msg.query || "" }));
        return;
      }

      if (msg.action === "bti-board") {
        const tab = await findPbc00Tab();
        if (!tab) {
          sendResponse({ ok: false, error: "pbc00_tab_not_found" });
          return;
        }
        sendResponse(await broadcastBti(tab.id, { type: "SCRAPE_BOARD" }));
        return;
      }

      if (msg.action === "bti-slip") {
        const tab = await findPbc00Tab();
        if (!tab) {
          sendResponse({ ok: false, error: "pbc00_tab_not_found" });
          return;
        }
        sendResponse(await broadcastBti(tab.id, { type: "READ_SLIP" }));
        return;
      }

      if (msg.action === "scan-arb") {
        sendResponse(await scanArbitrage(msg));
        return;
      }

      if (msg.type === "ODDS_CHANGED") {
        await chrome.storage.local.set({ lastBtiSlip: msg.slip, lastBtiUpdate: Date.now() });
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "unknown_action" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

console.log("[양방확장] background loaded");
