/**
 * BTI 배당 수집 — iframe 포함 모든 프레임에 질의
 */

const BTI_PBC00_URL =
  "https://pbc00.com/game/newDetail/0?gamecode=19&game_child_seq=3659&event=N";

async function getAllFrameIds(tabId) {
  if (!chrome.webNavigation?.getAllFrames) {
    return [0];
  }
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      resolve((frames || []).map((f) => f.frameId));
    });
  });
}

async function messageFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { ...message, target: "bti" },
      { frameId },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response);
      },
    );
  });
}

/** matchCount가 가장 많은 프레임 응답 선택 */
async function broadcastBti(tabId, message) {
  const frameIds = await getAllFrameIds(tabId);
  const responses = [];

  for (const frameId of frameIds) {
    const res = await messageFrame(tabId, frameId, message);
    if (res) responses.push(res);
  }

  if (!responses.length) {
    return { ok: false, error: "no_frame_response", hint: "pbc00 탭에서 BTI 화면이 로드됐는지 확인" };
  }

  responses.sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));
  const best = responses[0];
  return { ...best, framesAnswered: responses.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.action === "bti-collect") {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "no_tab" });
        return;
      }
      sendResponse(
        await broadcastBti(tabId, { action: "collectOdds", sport: msg.sport || "football" }),
      );
      return;
    }

    if (msg.action === "bti-search") {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "no_tab" });
        return;
      }
      sendResponse(
        await broadcastBti(tabId, {
          action: "search",
          query: msg.query || "",
          sport: msg.sport || "football",
        }),
      );
      return;
    }

    if (msg.action === "open-pbc00") {
      const tab = await chrome.tabs.create({ url: BTI_PBC00_URL, active: true });
      sendResponse({ ok: true, tabId: tab.id });
      return;
    }
  })();
  return true;
});
