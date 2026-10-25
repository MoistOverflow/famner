// src/lib/liveStream.js — listen to one of the app's live streams (/api/…/live) in the browser.
// Calls onChange(data) for every "change" message and onHello(rev) on every (re)connect,
// reconnects with backoff, and goes to the sign-in page if the session has ended.
// Returns a function that stops listening.
export function listen(url, { onChange, onHello, onStatus } = {}) {
  let es = null, stopped = false, timer = 0, tries = 0;
  const connect = () => {
    es = new EventSource(url);
    es.addEventListener('hello', (e) => { tries = 0; onHello?.(JSON.parse(e.data).rev); });
    es.addEventListener('change', (e) => onChange?.(JSON.parse(e.data)));
    es.onopen = () => onStatus?.(true);
    es.onerror = () => {
      onStatus?.(false);
      if (es.readyState === EventSource.CLOSED && !stopped) {
        fetch('/api/me', { cache: 'no-store' }).then((r) => {
          if (r.status === 401 && !stopped) location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
        }).catch(() => {});
        clearTimeout(timer);
        timer = setTimeout(connect, Math.min(30000, 2000 * 2 ** tries++));
      }
    };
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && es?.readyState === EventSource.CLOSED && !stopped) {
      clearTimeout(timer);
      connect();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    es?.close();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
