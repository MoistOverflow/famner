// src/routes/api/calendar/+server.js — load and save the calendar's data.
//   GET  → { rev, calendars, events }
//   POST → a change set from the browser: { upsertCalendars, deleteCalendars, upsertEvents, deleteEvents }
//          (header X-Calendar-Client identifies the sending browser for the live stream)
//
// The database file defaults to data/calendar.db (relative to where the server runs);
// set CALENDAR_DB in .env to put it elsewhere.
//
// Requests are signed in (see hooks.server.js). Each user only gets calendars they may see, and
// changes are checked against their role and calendar ownership (see calendarDb.js).

import { env } from '$env/dynamic/private';
import { getDb, loadAll, applyChanges, ValidationError, ForbiddenError } from '$lib/server/calendarDb.js';
import { actingUser, KioskLocked } from '$lib/server/auth.js';

const db = () => getDb(env.CALENDAR_DB || 'data/calendar.db');

const reply = (body, status = 200, type = 'application/json') =>
  new Response(body, { status, headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' } });

export function GET({ locals }) {
  return reply(loadAll(db(), locals.user));
}

export async function POST({ request, locals }) {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return reply('Send the changes as JSON.', 415, 'text/plain');
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return reply('That wasn’t valid JSON.', 400, 'text/plain');
  }
  try {
    const origin = (request.headers.get('x-calendar-client') ?? '').slice(0, 100) || null;
    // on the kiosk, changes are made as the person it's unlocked as, with the kiosk's limits
    const user = locals.user.role === 'kiosk' ? { ...actingUser(locals), role: 'kiosk', kioskId: locals.user.id } : locals.user;
    const counts = applyChanges(db(), body, origin, user);
    return reply(JSON.stringify({ ok: true, ...counts }));
  } catch (err) {
    if (err instanceof KioskLocked) return reply('The kiosk locked itself. Enter your PIN again to make changes.', 403, 'text/plain');
    if (err instanceof ValidationError) return reply(err.message, 400, 'text/plain');
    if (err instanceof ForbiddenError) return reply(err.message, 403, 'text/plain');
    console.error('Calendar save failed:', err);
    return reply('The server couldn’t save the changes.', 500, 'text/plain');
  }
}
