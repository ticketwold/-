/** 콘솔에서 실행: BTI iframe 구조 확인 */
(function () {
  const frames = [];
  function walk(win, depth) {
    try {
      frames.push({ depth, url: win.location.href, title: win.document.title });
      for (let i = 0; i < win.frames.length; i++) {
        try {
          walk(win.frames[i], depth + 1);
        } catch (e) {
          frames.push({ depth: depth + 1, url: "(cross-origin)", error: String(e) });
        }
      }
    } catch (e) {
      frames.push({ depth, error: String(e) });
    }
  }
  walk(window, 0);
  console.table(frames);
  return frames;
})();
