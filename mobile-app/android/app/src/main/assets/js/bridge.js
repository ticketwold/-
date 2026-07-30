'use strict';

const MobileBridge = (function () {
  const pending = new Map();
  let seq = 0;

  function hasNative() {
    return typeof window.MobileHost !== 'undefined';
  }

  function resolveCallback(id, json) {
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    try { cb.resolve(JSON.parse(json || '{}')); }
    catch (e) { cb.reject(e); }
  }

  function onContentEvent(json) {
    try {
      const msg = JSON.parse(json || '{}');
      if (msg.type === 'ODDS_CHANGED' && typeof window.__onOddsChanged === 'function') {
        window.__onOddsChanged(msg);
      }
    } catch (_) {}
  }

  function send(site, msg) {
    const id = String(++seq);
    const payload = { ...msg, _id: id };
    if (!hasNative()) {
      return Promise.resolve({ success: false, reason: `${site} WebView 미연결` });
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        window.MobileHost.sendMessage(site, JSON.stringify(payload));
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ success: false, reason: 'timeout' });
        }
      }, 15000);
    });
  }

  async function evalMain(site, code) {
    if (!hasNative()) return null;
    try {
      const raw = window.MobileHost.evalScript(site, 'MAIN', code);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function showSite(site) {
    if (hasNative()) window.MobileHost.showSite(site);
  }

  function isSiteReady(site) {
    if (!hasNative()) return false;
    try { return window.MobileHost.isSiteReady(site) === true; } catch (_) { return false; }
  }

  if (hasNative()) {
    window.MobileHost.resolveCallback = resolveCallback;
    window.MobileHost.onContentEvent = onContentEvent;
  }

  return { send, evalMain, showSite, isSiteReady, hasNative, resolveCallback, onContentEvent };
})();
