const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18765;

async function load() {
  const stored = await chrome.storage.local.get(["bridgeHost", "bridgePort", "bridgeToken"]);
  document.getElementById("host").value = stored.bridgeHost || DEFAULT_HOST;
  document.getElementById("port").value = stored.bridgePort || DEFAULT_PORT;
  document.getElementById("token").value = stored.bridgeToken || "";
}

async function save() {
  const host = document.getElementById("host").value.trim() || DEFAULT_HOST;
  const port = Number(document.getElementById("port").value) || DEFAULT_PORT;
  const token = document.getElementById("token").value.trim();
  await chrome.storage.local.set({ bridgeHost: host, bridgePort: port, bridgeToken: token });
  document.getElementById("status").textContent = "저장됨 — 확장을 새로고침하세요.";
}

document.getElementById("save").addEventListener("click", save);
load();
