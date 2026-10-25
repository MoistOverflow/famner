// src/hooks.server.js — who is signed in, and what they may reach. Runs on every request.
//
//   • Signed out: only /login and /setup work; other pages go to /login, the API answers 401.
//   • A temporary password must be changed (on /account) before anything else works, and then a
//     PIN chosen (on /pin), except by kiosk accounts.
//   • A kiosk is "unlocked" as one person by their PIN for a short while: event.locals.acting.
//   • /admin is for admins only.
//   • What each role may change (parents everything, children only what they added) is checked
//     where the data is saved: calendarDb.js and collections.js.

import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
  authDb, validateSession, sessionCookieOptions, pruneSessions, userCount, touchKiosk, SESSION_COOKIE
} from '$lib/server/auth.js';
import { startBackupSchedule } from '$lib/server/backups.js';

import { closeAll } from '$lib/server/calendarDb.js';

// adapter-node signals a graceful shutdown (e.g. `systemctl stop`): close the database cleanly
if (!globalThis.__shutdownHooked) {
  globalThis.__shutdownHooked = true;
  process.on('sveltekit:shutdown', () => closeAll());
}

const PUBLIC_ROUTES = new Set(['/login', '/setup']);
const ALLOWED_WHILE_CHANGING_PASSWORD = new Set(['/account', '/logout', '/api/me']);
const ALLOWED_WHILE_CHOOSING_PIN = new Set(['/pin', '/logout', '/api/me']);
let lastPrune = 0;

const text = (body, status) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function handle({ event, resolve }) {
  const dbPath = env.CALENDAR_DB || 'data/calendar.db';
  const db = authDb(dbPath);
  startBackupSchedule(db, dbPath); // daily automatic backups (starts once)
  if (Date.now() - lastPrune > 3600000) { lastPrune = Date.now(); pruneSessions(db); }

  const token = event.cookies.get(SESSION_COOKIE);
  const session = token ? validateSession(db, token) : null;
  if (token && !session) event.cookies.delete(SESSION_COOKIE, { path: '/' });
  if (session?.renewedUntil) event.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(event.url, session.renewedUntil));

  event.locals.user = session?.user ?? null;
  event.locals.sessionId = session?.sessionId ?? null;
  event.locals.acting = session?.acting ?? null;

  const path = event.url.pathname;
  const route = event.route.id ?? path;
  const isApi = path.startsWith('/api/');
  const user = event.locals.user;

  if (!user) {
    if (PUBLIC_ROUTES.has(route)) return resolve(event);
    if (isApi) return text('Please sign in.', 401);
    if (route === '/logout') redirect(303, '/login');
    redirect(303, userCount(db) === 0 ? '/setup' : `/login${path === '/' ? '' : `?next=${encodeURIComponent(path + event.url.search)}`}`);
  }

  if (PUBLIC_ROUTES.has(route) && event.request.method === 'GET') redirect(303, '/'); // already signed in

  if (user.mustChangePassword && !ALLOWED_WHILE_CHANGING_PASSWORD.has(route)) {
    if (isApi) return text('Choose a new password first.', 403);
    redirect(303, '/account');
  }

  if (user.needsPin && !user.mustChangePassword && !ALLOWED_WHILE_CHOOSING_PIN.has(route)) { // password first, then the PIN
    if (isApi) return text('Choose your PIN first.', 403);
    redirect(303, `/pin${path === '/' ? '' : `?next=${encodeURIComponent(path + event.url.search)}`}`);
  }

  // an unlocked kiosk stays unlocked while it's being used
  if (event.locals.acting && event.request.method !== 'GET' && route !== '/api/kiosk') {
    const until = touchKiosk(db, event.locals.sessionId);
    if (until) event.locals.acting.until = until;
  }

  if (route.startsWith('/admin') && user.role !== 'admin') {
    if (isApi) return text('Only admins can do that.', 403);
    redirect(303, '/');
  }

  return resolve(event);
}
