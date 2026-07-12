const logEl = document.getElementById("log");

function log(obj) {
  logEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendBti(tabId, message) {
  return chrome.runtime.sendMessage({ ...message, tabId });
}

document.getElementById("btnOpen").addEventListener("click", async () => {
  log(await chrome.runtime.sendMessage({ action: "open-pbc00" }));
});

document.getElementById("btnPing").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return log("활성 탭 없음");
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "PING" }, (res) => resolve(res || { error: "no response" }));
    }),
  });
  log(frames.map((f) => f.result).filter(Boolean));
});

document.getElementById("btnBoard").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return log("활성 탭 없음");
  const res = await sendBti(tab.id, { action: "bti-collect", sport: document.getElementById("sport").value });
  log(res);
});

document.getElementById("btnSearch").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return log("활성 탭 없음");
  const query = document.getElementById("query").value.trim();
  const res = await sendBti(tab.id, { action: "bti-search", query, sport: document.getElementById("sport").value });
  log(res);
  if (res && res.hitCount === 0 && res.selectionHitCount === 0) {
    log({
      ...res,
      hint: "0건: BTI 경기 상세 페이지를 열었는지, 배당 버튼(master_fe_Selections_selection)이 보이는지 확인",
    });
  }
});

document.getElementById("btnSlip").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return log("활성 탭 없음");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "READ_SLIP" }, (res) => resolve(res));
    }),
  });
  log(result);
});
