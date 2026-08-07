/** @typedef {{ type: string, [key: string]: unknown }} BridgeMessage */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18765;
const DEFAULT_PAIR_PORT = 18766;
const PROTOCOL_VERSION = 1;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

/**
 * @param {object} options
 * @param {(message: BridgeMessage) => void} options.onMessage
 * @param {(connected: boolean) => void} [options.onConnectionChange]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {string} [options.credential]
 * @param {string} [options.extensionId]
 */
export function createWebSocketClient({
  onMessage,
  onConnectionChange,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  credential = "",
  extensionId = "",
}) {
  /** @type {WebSocket | null} */
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;
  let authed = false;
  let reconnectAttempt = 0;

  function notifyConnection(connected) {
    onConnectionChange?.(connected);
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(forceRepair = false) {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      reconnectAttempt += 1;
      if (forceRepair || !credential) {
        try {
          await ensurePaired();
        } catch (_err) {
          // app may be offline — retry later
        }
      }
      connect();
    }, delay);
  }

  async function connect() {
    if (stopped) return;
    clearReconnect();
    const config = await loadBridgeConfig();
    const cred = config.credential || credential;
    const extId = config.extensionId || extensionId || chrome.runtime.id;
    if (!cred) {
      notifyConnection(false);
      scheduleReconnect(true);
      return;
    }

    try {
      socket = new WebSocket(`ws://${config.host || host}:${config.port || port}/`);
      console.log(`[WS] connecting ws://${config.host || host}:${config.port || port}/`);
    } catch (_err) {
      notifyConnection(false);
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      authed = false;
      send({
        type: "hello",
        protocol_version: PROTOCOL_VERSION,
        extension_id: extId,
        credential: cred,
        source: "chrome-bridge",
        version: "1.2.0",
      });
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (_err) {
        return;
      }
      if (message.type === "hello_ack" && message.authenticated) {
        authed = true;
        reconnectAttempt = 0;
        console.log("[WS] authenticated");
        notifyConnection(true);
      } else if (message.type === "auth_fail") {
        authed = false;
        notifyConnection(false);
        clearStoredCredential().finally(() => {
          socket?.close();
          scheduleReconnect(true);
        });
      } else if (message.type === "request_status") {
        onMessage({ type: "request_status" });
      } else {
        onMessage(message);
      }
    });

    socket.addEventListener("close", () => {
      authed = false;
      notifyConnection(false);
      socket = null;
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      authed = false;
      notifyConnection(false);
      socket?.close();
    });
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (_err) {
      return false;
    }
  }

  function start() {
    stopped = false;
    reconnectAttempt = 0;
    connect();
  }

  function stop() {
    stopped = true;
    clearReconnect();
    authed = false;
    socket?.close();
    socket = null;
    notifyConnection(false);
  }

  return {
    start,
    stop,
    send,
    isConnected: () => authed,
  };
}

export async function clearStoredCredential() {
  await chrome.storage.local.remove(["bridgeCredential", "bridgeToken"]);
}

export async function loadBridgeConfig() {
  const stored = await chrome.storage.local.get([
    "bridgeHost",
    "bridgePort",
    "bridgeCredential",
    "bridgeToken",
    "bridgeExtensionId",
  ]);
  if (stored.bridgeToken && !stored.bridgeCredential) {
    await chrome.storage.local.remove(["bridgeToken"]);
  }
  return {
    host: stored.bridgeHost || DEFAULT_HOST,
    port: Number(stored.bridgePort || DEFAULT_PORT),
    credential: stored.bridgeCredential || "",
    extensionId: stored.bridgeExtensionId || chrome.runtime.id,
    pairPort: DEFAULT_PAIR_PORT,
  };
}

async function pairRequest(extensionId, pairPort) {
  const resp = await fetch(`http://127.0.0.1:${pairPort}/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extension_id: extensionId }),
  });
  if (!resp.ok) {
    throw new Error(`pair-request-failed:${resp.status}`);
  }
  return resp.json();
}

async function pairConfirm(extensionId, nonce, pairPort) {
  const resp = await fetch(`http://127.0.0.1:${pairPort}/pair/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extension_id: extensionId, nonce }),
  });
  if (!resp.ok) {
    throw new Error(`pair-confirm-failed:${resp.status}`);
  }
  return resp.json();
}

export async function ensurePaired() {
  const extensionId = chrome.runtime.id;
  const config = await loadBridgeConfig();
  if (config.credential) {
    return config;
  }

  const pairPort = config.pairPort || DEFAULT_PAIR_PORT;
  console.log("[PAIR] requesting pairing");
  const request = await pairRequest(extensionId, pairPort);
  if (!request?.ok || !request.nonce) {
    throw new Error("pair-request-invalid");
  }
  const confirmed = await pairConfirm(extensionId, request.nonce, pairPort);
  if (!confirmed?.ok || !confirmed.credential) {
    throw new Error("pair-confirm-invalid");
  }

  await chrome.storage.local.set({
    bridgeHost: confirmed.host || DEFAULT_HOST,
    bridgePort: Number(confirmed.port || DEFAULT_PORT),
    bridgeCredential: confirmed.credential,
    bridgeExtensionId: extensionId,
  });
  await chrome.storage.local.remove(["bridgeToken"]);

  console.log("[PAIR] pairing success");

  return {
    host: confirmed.host || DEFAULT_HOST,
    port: Number(confirmed.port || DEFAULT_PORT),
    credential: confirmed.credential,
    extensionId,
    pairPort,
  };
}
