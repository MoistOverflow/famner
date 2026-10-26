// src/lib/notify.js — reminders on this device.
// Where the browser supports Web Push (https; on iPhone, once the app is on the Home Screen), turning
// reminders on subscribes the device and the server sends them, even when Famner is closed (see
// $lib/server/push.js). Elsewhere the app shows them itself while it's open (see +layout.svelte).
// Browsers only allow notifications on secure pages: https://… or http://localhost.

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
  if (permission === 'granted') await syncPush();
  return permission;
}

export async function disableNotifications() {
  try { localStorage.setItem(KEY, '0'); } catch {}
  try {
    localStorage.removeItem(PUSH_KEY);
    const sub = await (await navigator.serviceWorker?.ready)?.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
  } catch { /* turned off on this device either way */ }
}

// ---------- Web Push ----------
const PUSH_KEY = 'notify:push'; // the server key this device subscribed with, once the server has the subscription

export const pushSupported = () =>
  notificationsSupported() && 'serviceWorker' in navigator && 'PushManager' in window;

/** Does the server send this device's reminders? (Then the app doesn't show its own.) */
export function pushActive() {
  try { return notificationsOn() && pushSupported() && !!localStorage.getItem(PUSH_KEY); } catch { return false; }
}

function keyBytes(base64url) {
  const s = atob((base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/**
 * Subscribe this device, or refresh its subscription (on every app start: it also follows who's
 * signed in). Returns whether the server can now send to it.
 */
export async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted' || !notificationsOn()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await (await fetch('/api/push', { cache: 'no-store' })).json();
    let sub = await reg.pushManager.getSubscription();
    if (sub && localStorage.getItem(PUSH_KEY) !== publicKey) { await sub.unsubscribe(); sub = null; } // made with other keys
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    const r = await fetch('/api/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), groceries: groceryAlertsOn() })
    });
    if (!r.ok) return false;
    localStorage.setItem(PUSH_KEY, publicKey);
    return true;
  } catch {
    try { localStorage.removeItem(PUSH_KEY); } catch {}
    return false;
  }
}

/** The server sends a test to this device, now or after `delay` seconds. Returns { sent, later?, error? }. */
export async function sendTestPush(delay = 0) {
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (!sub) return { sent: false, error: 'This device isn’t subscribed. Turn reminders off and on again.' };
    const r = await fetch('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, delay }) });
    return await r.json();
  } catch {
    return { sent: false, error: 'Couldn’t reach the server.' };
  }
}

// "Someone added groceries" alerts, on unless turned off on this device
const GROCERY_KEY = 'notify:groceries';
export function groceryAlertsOn() {
  try { return localStorage.getItem(GROCERY_KEY) !== '0'; } catch { return true; }
}
export async function setGroceryAlerts(on) {
  try { localStorage.setItem(GROCERY_KEY, on ? '1' : '0'); } catch {}
  if (!pushActive()) return;
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await fetch('/api/push', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, groceries: on }) });
  } catch { /* sent again with the next refresh */ }
}

/** SvelteKit registers the service worker (src/service-worker.js) itself; nothing to do here any more. */
export function registerServiceWorker() {}

/** Show a notification; tapping it opens `url`. Does nothing unless reminders are on. Returns whether it was shown. */
export async function notify(title, { body = '', url = '/', tag } = {}) {
  if (!notificationsOn()) return false;
  const options = { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, options); return true; } // works on Android too
  } catch {}
  try {
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); location.href = url; };
    return true;
  } catch {
    return false;
  }
}
