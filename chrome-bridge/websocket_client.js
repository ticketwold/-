/** @typedef {{ type: string, [key: string]: unknown }} BridgeMessage */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18765;
const RECONNECT_MS = 2000;

/**
 * @param {object} options
 * @param {(message: BridgeMessage) => void} options.onMessage
 * @param {(connected: boolean) => void} [options.onConnectionChange]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {string} [options.token]
 */
export function createWebSocketClient({
  onMessage,
  onConnectionChange,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  token = "",
}) {
  /** @type {WebSocket | null} */
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;
  let authed = false;

  function notifyConnection(connected) {
    onConnectionChange?.(connected);
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
  }

  function connect() {
    if (stopped) return;
    clearReconnect();
    try {
      const url = `ws://${host}:${port}/?token=${encodeURIComponent(token)}`;
      socket = new WebSocket(url);
    } catch (_err) {
      notifyConnection(false);
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      authed = false;
      send({ type: "hello", version: "1.0.0", source: "chrome-bridge" });
      if (token) {
        send({ type: "auth", token });
      }
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (_err) {
        return;
      }
      if (message.type === "auth_ok") {
        authed = true;
        notifyConnection(true);
      } else if (message.type === "auth_fail") {
        authed = false;
        notifyConnection(false);
        socket?.close();
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

export async function loadBridgeConfig() {
  const stored = await chrome.storage.local.get(["bridgeHost", "bridgePort", "bridgeToken"]);
  return {
    host: stored.bridgeHost || DEFAULT_HOST,
    port: Number(stored.bridgePort || DEFAULT_PORT),
    token: stored.bridgeToken || "",
  };
}
