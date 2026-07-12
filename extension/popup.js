const logEl = document.getElementById("log");

function log(obj) {
  logEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.getElementById("btnOpen").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ action: "open-pbc00" });
  log(res);
});

document.getElementById("btnCollect").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return log("활성 탭 없음");
  const sport = document.getElementById("sport").value;
  const res = await chrome.runtime.sendMessage({
    action: "bti-collect",
    tabId: tab.id,
    sport,
  });
  log(res);
  if (!res?.matchCount) {
    log({
      ...res,
      hint: "0건이면: pbc00 로그인 후 BTI 화면이 보이는지 확인. manifest all_frames:true 필수",
    });
  }
});

document.getElementById("btnSearch").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return log("활성 탭 없음");
  const sport = document.getElementById("sport").value;
  const query = document.getElementById("query").value.trim();
  const res = await chrome.runtime.sendMessage({
    action: "bti-search",
    tabId: tab.id,
    sport,
    query,
  });
  log(res);
});
