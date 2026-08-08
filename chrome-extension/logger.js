const MAX_LOGS = 500;

/** @type {{ realtime: object[], odds: object[], execution: object[], debug: object[] }} */
const buffers = {
  realtime: [],
  odds: [],
  execution: [],
  debug: [],
};

let persistTimer = null;

function pushBuffer(name, entry) {
  const buf = buffers[name];
  buf.push({ ts: Date.now(), ...entry });
  while (buf.length > MAX_LOGS) buf.shift();
  schedulePersist();
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await chrome.storage.local.set({ arb_logs: { ...buffers, saved_at: Date.now() } });
    } catch (_err) {}
  }, 400);
}

export async function restoreLogs() {
  try {
    const data = await chrome.storage.local.get("arb_logs");
    const saved = data.arb_logs;
    if (!saved) return;
    for (const key of Object.keys(buffers)) {
      if (Array.isArray(saved[key])) buffers[key] = saved[key].slice(-MAX_LOGS);
    }
  } catch (_err) {}
}

export function logRealtime(message, fields = {}) {
  pushBuffer("realtime", { message, ...fields });
}

export function logOdds(site, prev, next, fields = {}) {
  pushBuffer("odds", { site, prev, next, ...fields });
}

let firstFailure = null;

export function resetExecutionFlow(flow) {
  firstFailure = null;
  pushBuffer("execution", { flow, step: "BEGIN", ok: true });
}

export function logStakeStep(step, ok, reason = "", fields = {}) {
  const line = { flow: "BC STAKE", step, ok, reason, ...fields };
  pushBuffer("execution", line);
  if (!ok && !firstFailure) {
    firstFailure = `BC STAKE / ${step} / ${reason || "unknown"}`;
    pushBuffer("execution", { flow: "BC STAKE", step: "FIRST_FAILURE", ok: false, reason: firstFailure });
  }
  return line;
}

export function logBetStep(step, ok, reason = "", fields = {}) {
  const line = { flow: "BET", step, ok, reason, ...fields };
  pushBuffer("execution", line);
  if (!ok && !firstFailure) {
    firstFailure = `BET / ${step} / ${reason || "unknown"}`;
    pushBuffer("execution", { flow: "BET", step: "FIRST_FAILURE", ok: false, reason: firstFailure });
  }
  return line;
}

export function logDebug(label, fields = {}) {
  pushBuffer("debug", { label, ...fields });
}

export function getLogs() {
  return { ...buffers, first_failure: firstFailure };
}

export function exportCsv(kind) {
  const rows = buffers[kind] || [];
  if (!rows.length) return "";
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [keys.join(",")];
  for (const row of rows) {
    lines.push(keys.map((k) => esc(row[k])).join(","));
  }
  return lines.join("\n");
}
