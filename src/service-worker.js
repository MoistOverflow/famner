// src/service-worker.js — lets Famner open and show its last data without a connection.
// SvelteKit builds and registers this file itself (it needs https, or localhost).
//
//   • The app's own files are kept on the device (a fresh copy for each new version of the app).
//   • Pages and data (the calendar, chores, groceries…) come from the server when it can be
//     reached, and a copy of each answer is kept. Without a connection the last copy is used,
//     marked with when it was saved (header x-famner-saved), and open pages are told they're offline.
//   • Live updates, downloads and changes (POST) are never cached.
//   • Signing out empties the saved data (the page sends 'clear-data').
//   • Tapping a reminder opens the app at the right page.
/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

const SHELL = `famner-shell-${version}`;
const DATA = 'famner-data';
const ASSETS = new Set([...build, ...files]);
const NEVER = [/\/live$/, /^\/api\/kiosk/, /^\/api\/ics/, /^\/admin\/backups\//, /^\/logout/];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll([...ASSETS])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('famner-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

/** Tell open pages whether the server answered (online) or a saved copy was used (offline). */
async function announce(offline, savedAt = null) {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'famner-net', offline, savedAt });
}

/** Keep a copy of a good answer, stamped with when it was saved. */
async function keep(key, res) {
  if (!res.ok || res.redirected || res.type !== 'basic') return;
  const body = await res.clone().blob();
  const headers = new Headers(res.headers);
  headers.set('x-famner-saved', String(Date.now()));
  await (await caches.open(DATA)).put(key, new Response(body, { status: res.status, statusText: res.statusText, headers }));
}

async function saved(request, fallbackKey) {
  const cache = await caches.open(DATA);
  return (await cache.match(request)) ?? (await cache.match(request, { ignoreSearch: true })) ?? (fallbackKey ? await cache.match(fallbackKey) : undefined);
}

async function networkFirst(event, { page = false } = {}) {
  const { request } = event;
  try {
    const res = await fetch(request);
    // pages: every page is the same app shell (the app renders in the browser), keep one copy as a fallback too
    event.waitUntil(Promise.all([keep(request, res.clone()), page ? keep('/__famner-shell', res.clone()) : null, announce(false)]));
    return res;
  } catch (err) {
    const copy = await saved(request, page ? '/__famner-shell' : null);
    if (!copy) throw err;
    event.waitUntil(announce(true, Number(copy.headers.get('x-famner-saved')) || null));
    return copy;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((re) => re.test(url.pathname))) return;

  // the app's own files: from the device (they only change with a new version)
  if (ASSETS.has(url.pathname)) {
    event.respondWith(caches.open(SHELL).then(async (c) => (await c.match(url.pathname)) ?? fetch(request)));
    return;
  }
  if (request.mode === 'navigate') { event.respondWith(networkFirst(event, { page: true })); return; }
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('/__data.json')) event.respondWith(networkFirst(event));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'clear-data') event.waitUntil(caches.delete(DATA));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) {
          w.navigate?.(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
