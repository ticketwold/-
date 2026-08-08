const $ = (id) => document.getElementById(id);

let activeTab = "realtime";
let lastState = null;

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function fmt(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function renderLogs(state) {
  const logs = state.logs || {};
  const rows = logs[activeTab] || [];
  const panel = $("logPanel");
  panel.innerHTML = rows
    .slice(-80)
    .map((row) => {
      const ts = new Date(row.ts).toLocaleTimeString();
      const cls = row.ok === false ? "fail" : row.ok === true ? "pass" : "";
      const text = Object.entries(row)
        .filter(([k]) => !["ts"].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return `<div class="log-line ${cls}">${ts} ${text}</div>`;
    })
    .join("");
  panel.scrollTop = panel.scrollHeight;
}

function render(state) {
  lastState = state;
  const s = state.settings || {};
  $("watchState").textContent = state.watch_state || "IDLE";
  $("watchState").style.color = state.watch_state === "READY" ? "var(--green)" : state.watch_state === "PARTIAL BET" ? "var(--red)" : "var(--yellow)";

  const x10 = state.sites?.x10 || {};
  const bc = state.sites?.bc || {};
  $("x10Found").textContent = x10.found ? "탭 FOUND" : "탭 없음";
  $("x10Status").textContent = x10.status || "—";
  $("x10Status").className = `badge ${x10.status === "ACTIVE" ? "active" : x10.status === "CLOSED" ? "closed" : ""}`;
  $("x10Odds").textContent = fmt(x10.odds, 3);

  $("bcFound").textContent = bc.found ? "탭 FOUND" : "탭 없음";
  $("bcStatus").textContent = bc.status || "—";
  $("bcStatus").className = `badge ${bc.status === "ACTIVE" ? "active" : bc.status === "CLOSED" ? "closed" : ""}`;
  $("bcOdds").textContent = fmt(bc.odds, 3);

  const stake = state.stake_sync || {};
  $("bcStake").textContent = stake.actual != null ? `${fmt(stake.actual, 1)} USDT` : "—";
  $("calcStake").textContent = fmt(stake.target ?? state.metrics?.bc_stake_usdt, 1);
  $("actualStake").textContent = fmt(stake.actual, 1);
  $("stakeSyncState").textContent = stake.message || stake.state || "—";

  const fx = state.fx || {};
  $("fxRate").textContent = fmt(fx.rate, 1);
  $("fxStatus").textContent = fx.status || "—";
  $("fxStatus").className = `badge ${fx.status === "LIVE" ? "active" : fx.status === "STALE" ? "closed" : ""}`;

  const m = state.metrics;
  if (m) {
    $("profitRate").textContent = `${fmt(m.current_profit_rate, 2)}%`;
    $("profitDelta").textContent = `목표까지 ${fmt(m.target_delta_pct, 2)}%p`;
    $("profitRate").style.color = m.current_profit_rate >= (s.target_profit_pct || 0) ? "var(--green)" : "var(--yellow)";
  } else {
    $("profitRate").textContent = "—%";
    $("profitDelta").textContent = "목표까지 —";
  }

  if (state.partial_bet) {
    $("alert").textContent = "PARTIAL BET — 자동감시 중지됨. 수동 확인 필요.";
    $("alert").classList.remove("hidden");
  } else {
    $("alert").classList.add("hidden");
  }

  renderLogs(state);
}

async function loadSettingsToForm() {
  const state = await send("get_state");
  const s = state.settings || {};
  $("targetProfit").value = s.target_profit_pct ?? 0.5;
  $("btiStake").value = s.bti_stake_krw ?? 10000;
  $("stakeSync").checked = !!s.stake_sync_enabled;
  $("autoWatch").checked = !!s.auto_watch_enabled;
  $("liveExec").checked = !!s.live_execution_enabled;
  $("stabilizeSec").value = s.stabilize_seconds ?? 3;
  render(state);
}

async function saveFromForm() {
  const settings = {
    target_profit_pct: Number($("targetProfit").value),
    bti_stake_krw: Number($("btiStake").value),
    stake_sync_enabled: $("stakeSync").checked,
    auto_watch_enabled: $("autoWatch").checked,
    live_execution_enabled: $("liveExec").checked,
    stabilize_seconds: Number($("stabilizeSec").value),
  };
  await send("save_settings", { settings });
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    $("debugPanel").classList.toggle("hidden", activeTab !== "debug");
    if (lastState) render(lastState);
  });
});

$("btnStartWatch").addEventListener("click", async () => {
  $("autoWatch").checked = true;
  await saveFromForm();
  await send("start_watch");
});

$("btnStopWatch").addEventListener("click", async () => {
  $("autoWatch").checked = false;
  await saveFromForm();
  await send("stop_watch");
});

$("btnManualBet").addEventListener("click", async () => {
  const result = await send("manual_dispatch");
  $("debugResult").textContent = JSON.stringify(result, null, 2);
});

["targetProfit", "btiStake", "stakeSync", "autoWatch", "liveExec", "stabilizeSec"].forEach((id) => {
  $(id).addEventListener("change", saveFromForm);
});

document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const result = await send("debug_action", { action: btn.dataset.action });
    $("debugResult").textContent = JSON.stringify(result, null, 2);
  });
});

$("btnExportLogs").addEventListener("click", async () => {
  const kind = activeTab === "debug" ? "debug" : activeTab;
  const { csv } = await send("export_logs", { kind });
  const blob = new Blob([csv || ""], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `arb-${kind}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "state_update") render(msg.payload);
});

loadSettingsToForm();
setInterval(() => send("get_state").then(render), 2000);
