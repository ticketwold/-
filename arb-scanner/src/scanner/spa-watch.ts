export type NavCallback = () => void;

export function watchSpaNavigation(onNav: NavCallback): () => void {
  const fire = () => {
    try {
      onNav();
    } catch {
      /* ignore */
    }
  };

  window.addEventListener('popstate', fire);
  window.addEventListener('hashchange', fire);

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = (...args) => {
    origPush(...args);
    fire();
  };
  history.replaceState = (...args) => {
    origReplace(...args);
    fire();
  };

  return () => {
    window.removeEventListener('popstate', fire);
    window.removeEventListener('hashchange', fire);
    history.pushState = origPush;
    history.replaceState = origReplace;
  };
}
