// Mobile WebView bridge — chrome.runtime shim for content scripts
(function () {
  if (window.__mobileShim) return;
  window.__mobileShim = true;

  const listeners = [];

  if (!window.chrome) window.chrome = {};
  chrome.runtime = {
    onMessage: {
      addListener(fn) {
        listeners.push(fn);
      }
    },
    sendMessage(msg) {
      try {
        if (window.MobileHost && typeof window.MobileHost.onContentEvent === 'function') {
          window.MobileHost.onContentEvent(JSON.stringify(msg));
        }
      } catch (_) {}
    }
  };

  window.__mobileHandleMessage = function (raw) {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    let done = false;
    const sendResponse = function (res) {
      if (done) return;
      done = true;
      try {
        if (window.MobileHost && typeof window.MobileHost.resolveCallback === 'function') {
          window.MobileHost.resolveCallback(String(msg._id || ''), JSON.stringify(res == null ? {} : res));
        }
      } catch (_) {}
    };

    for (const fn of listeners) {
      try {
        const ret = fn(msg, null, sendResponse);
        if (ret === true) return;
      } catch (e) {
        sendResponse({ success: false, reason: e.message });
        return;
      }
    }
    if (!done) sendResponse({ success: false, reason: 'no handler' });
  };
})();
