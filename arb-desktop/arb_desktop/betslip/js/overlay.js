/**
 * Debug overlay — 브라우저 우측 상단 실시간 상태.
 */
(function (payload) {
  const id = 'arb-debug-overlay';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483647',
      'background:rgba(0,0,0,0.82)', 'color:#e8e8e8', 'font:12px/1.45 Consolas,monospace',
      'padding:10px 12px', 'border-radius:8px', 'min-width:180px', 'pointer-events:none',
      'box-shadow:0 4px 16px rgba(0,0,0,0.35)'
    ].join(';');
    document.documentElement.appendChild(el);
  }

  const p = payload || {};
  const line = (label, value) => `<div><span style="color:#9aa">${label}</span> ${value || '-'}</div>`;

  el.innerHTML = [
    '<div style="font-weight:700;margin-bottom:6px">ARB Overlay</div>',
    '<div style="margin-bottom:4px"><span style="color:#9aa">BC.Game</span><br>' + (p.bc_status || '-') + '<br>' + (p.bc_odds || '-') + '</div>',
    '<div style="margin-bottom:4px"><span style="color:#9aa">x10x10s</span><br>' + (p.bti_status || '-') + '<br>' + (p.bti_odds || '-') + '</div>',
    line('Profit', p.profit || '-'),
    line('Match', p.match_ok || '-'),
    line('Network', p.network_ok || '-'),
    line('DOM', p.dom_ok || '-'),
    line('Lock', p.lock_ok || '-'),
    line('Stage', p.stage || '-')
  ].join('');
})();
