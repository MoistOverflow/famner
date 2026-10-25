// src/lib/notify.js — reminders shown by the device (while the app is open in a tab or installed).
// Browsers only allow notifications on secure pages: https://… or http://localhost. Over plain
// http on the home network they stay off until nginx serves the app over HTTPS.

const KEY = 'notify';

export const notificationsSupported = () =>
  typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;

export function notificationsOn() {
  try { return notificationsSupported() && Notification.permission === 'granted' && localStorage.getItem(KEY) === '1'; }
  catch { return false; }
}

/** Ask the browser for permission and turn reminders on for this device. Returns the permission. */
export async function enableNotifications() {
  if (!notificationsSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  try { localStorage.setItem(KEY, permission === 'granted' ? '1' : '0'); } catch {}
  if (permission === 'granted') registerServiceWorker();
  return permission;
}

export function disableNotifications() {
  try { localStorage.setItem(KEY, '0'); } catch {}
}

/** SvelteKit registers the service worker (src/service-worker.js) itself; nothing to do here any more. */
export function registerServiceWorker() {}

/** Show a notification; tapping it opens `url`. Does nothing unless reminders are on. */
export async function notify(title, { body = '', url = '/', tag } = {}) {
  if (!notificationsOn()) return;
  const options = { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, options); // works on Android too
  } catch {}
  try {
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); location.href = url; };
  } catch {}
}
