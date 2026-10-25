// src/lib/offline.svelte.js — whether Famner can reach its server right now, and the data kept on
// this device for when it can't (see src/service-worker.js).
//
//   net.offline   true while the server can't be reached (no signal, or away from home)
//   net.savedAt   when the data being shown was saved (ms), while offline
//   watchNetwork()            call once (the layout does): listens to the browser and the service worker
//   rememberUser(id)          a different person signed in on this device → forget the last one's data
//   clearOfflineData()        forget everything kept on this device (signing out)

export const net = $state({ offline: false, savedAt: null });

const PREFIX = 'famner:';

export function watchNetwork() {
  if (typeof window === 'undefined') return () => {};
  net.offline = navigator.onLine === false;
  const onMessage = (e) => {
    if (e.data?.type !== 'famner-net') return;
    net.offline = e.data.offline;
    net.savedAt = e.data.offline ? e.data.savedAt : null;
  };
  const off = () => (net.offline = true);
  const on = () => { net.offline = false; net.savedAt = null; };
  navigator.serviceWorker?.addEventListener('message', onMessage);
  window.addEventListener('offline', off);
  window.addEventListener('online', on);
  return () => {
    navigator.serviceWorker?.removeEventListener('message', onMessage);
    window.removeEventListener('offline', off);
    window.removeEventListener('online', on);
  };
}

/** Mark offline/online from the page itself (e.g. a request failed, or a saved copy was used). */
export function noteOffline(savedAt = null) { net.offline = true; if (savedAt) net.savedAt = savedAt; }
export function noteOnline() { net.offline = false; net.savedAt = null; }

// ---------- small saved values on this device ----------
export function keepLocal(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* full or blocked: just not kept */ }
}
export function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? 'null'); } catch { return null; }
}

export function clearOfflineData() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {}
  navigator.serviceWorker?.controller?.postMessage({ type: 'clear-data' });
}

export function rememberUser(id) {
  if (!id) return;
  const last = readLocal('user');
  if (last && last !== id) clearOfflineData();
  keepLocal('user', id);
}
