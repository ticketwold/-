// 양방배팅봇 ↔ 자동배팅 브릿지 (페이지 localStorage 공유)
(function () {
  const KEY = '__arbBotState_v1';
  const EVT = '__arbBotStateUpdate';

  window.__arbAutoReadState = function () {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  };

  window.__arbAutoWriteState = function (state) {
    try {
      const payload = { ...state, ts: Date.now() };
      localStorage.setItem(KEY, JSON.stringify(payload));
      window.dispatchEvent(new CustomEvent(EVT, { detail: payload }));
      return true;
    } catch (_) {
      return false;
    }
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'ARB_BOT_STATE') return;
    window.__arbAutoWriteState(e.data.state || {});
  });
})();
